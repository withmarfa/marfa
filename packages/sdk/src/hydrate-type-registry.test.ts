import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  hydrateTypeRegistry,
  unregisterTypeSchema,
  validateProperties,
} from "@withmarfa/shared";
import { createKeysModeFixture } from "./test-harness.js";
import type { MarfaClient } from "./client.js";

// The claim under test is agreement with the server, so the types are
// registered over the real `POST /types` and read back over the real
// `GET /types` rather than from a payload written here. A payload written
// here would test this file's idea of the shape.

const PARENT = "parity.parent";
const CHILD = "parity.child";

// `@withmarfa/shared` is external to the server's bundle, so the in-process
// server and this file share one module-level registry: registering over HTTP
// already puts the schemas in the registry these assertions would read.
// Hydrating into a space of its own is what makes the local half measure the
// hydrated copy instead of the server's own registration.
const CLIENT_SPACE = "01a02000-0000-7000-8000-0000000000f2";

interface Probe {
  name: string;
  properties: Record<string, unknown>;
}

const PROBES: Probe[] = [
  { name: "inherited required field omitted", properties: {} },
  { name: "every declared field satisfied", properties: { headline: "set" } },
  {
    name: "inherited field given the wrong type",
    properties: { headline: "set", rank: "not-a-number" },
  },
  {
    name: "the type's own field given the wrong type",
    properties: { headline: "set", note: 7 },
  },
  {
    name: "an undeclared property, which loose validation passes through",
    properties: { headline: "set", extra: true },
  },
];

let client: MarfaClient;
let fetchFn: typeof globalThis.fetch;
let adminKey: string;
let cleanup: () => void;
let hydrated: string[] = [];

beforeAll(async () => {
  const fixture = await createKeysModeFixture();
  client = fixture.client;
  fetchFn = fixture.fetch;
  adminKey = fixture.adminKey;
  cleanup = fixture.cleanup;

  await client.types.register({
    id: PARENT,
    version: 1,
    fields: {
      headline: { type: "string", required: true },
      rank: { type: "number" },
    },
  });
  await client.types.register({
    id: CHILD,
    version: 1,
    parent: PARENT,
    fields: { note: { type: "string" } },
  });
});

afterAll(async () => {
  for (const id of hydrated.reverse()) unregisterTypeSchema(id, CLIENT_SPACE);
  // The registry outlives this file inside a reused worker, so the server's
  // own registrations go too.
  await client.types.delete(CHILD, { force: true });
  await client.types.delete(PARENT, { force: true });
  cleanup();
});

/** What the server does with a create, as a plain accepted / refused. */
async function serverAccepts(
  properties: Record<string, unknown>,
): Promise<boolean> {
  const res = await fetchFn("http://localhost/items", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${adminKey}`,
    },
    body: JSON.stringify({ type: CHILD, properties }),
  });
  return res.ok;
}

describe("hydrateTypeRegistry against a live type payload", () => {
  it("validates a hydrated custom type exactly as the server does", async () => {
    const payload = await client.types.list();

    // Child ahead of parent, which is the shape the helper has to cope with
    // and the one a space that registered them in that order gets back.
    const reordered = [
      ...payload.filter((schema) => schema.id !== PARENT),
      ...payload.filter((schema) => schema.id === PARENT),
    ];
    const childAt = reordered.findIndex((schema) => schema.id === CHILD);
    const parentAt = reordered.findIndex((schema) => schema.id === PARENT);
    expect(childAt).toBeGreaterThanOrEqual(0);
    expect(parentAt).toBeGreaterThan(childAt);

    const result = hydrateTypeRegistry(reordered, { spaceId: CLIENT_SPACE });
    hydrated = [...result.registered];
    expect(result.registered).toContain(CHILD);
    expect(result.unresolvedParents).toEqual([]);
    expect(result.cycles).toEqual([]);

    // One at a time: concurrent creates against the in-process SQLite
    // database answer 500 on contention, which is a fact about the fixture
    // rather than about the type, and would read here as a refusal.
    const verdicts: { name: string; server: boolean; local: boolean }[] = [];
    for (const probe of PROBES) {
      verdicts.push({
        name: probe.name,
        server: await serverAccepts(probe.properties),
        local: validateProperties(CHILD, probe.properties, {
          spaceId: CLIENT_SPACE,
        }).success,
      });
    }

    // A table the server accepted in full, or refused in full, would agree
    // with a local half that always answered the same way. Both directions
    // have to be present for the agreement below to mean anything.
    expect(verdicts.some((v) => v.server)).toBe(true);
    expect(verdicts.some((v) => !v.server)).toBe(true);

    expect(verdicts.map((v) => ({ name: v.name, verdict: v.local }))).toEqual(
      verdicts.map((v) => ({ name: v.name, verdict: v.server })),
    );
  });
});
