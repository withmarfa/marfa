import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  hydrateTypeRegistry,
  registerTypeSchema,
  validateProperties,
} from "@withmarfa/shared";
import {
  hydrateTypeRegistry as hydrateFromPackageRoot,
  validateProperties as validateFromPackageRoot,
} from "./index.js";
import { createBootstrappedFixture } from "./test-harness.js";
import type { MarfaClient } from "./client.js";

// The claim under test is agreement with the server, so the types are
// registered over the real `POST /types` and read back over the real
// `GET /types` rather than from a payload written here. A payload written
// here would test this file's idea of the shape.

const PARENT = "parity.parent";
const CHILD = "parity.child";

// `@withmarfa/shared` is external to the server's bundle, so the in-process
// server and this file share one module-level registry: registering over HTTP
// already puts the schemas in the registry these assertions would read, and
// hydrating re-registers the same schemas over them. What the assertions
// measure is that the two halves agree, which is the claim.
const TRANSIENT = "parity.transient";

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
let workingKey: string;
let cleanup: () => void;

beforeAll(async () => {
  const fixture = await createBootstrappedFixture();
  client = fixture.client;
  fetchFn = fixture.fetch;
  workingKey = fixture.workingKey;
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
  // The registry outlives this file inside a reused worker, so the server's
  // own registrations go, and the delete unregisters them here too.
  await client.types.delete(CHILD, { force: true });
  await client.types.delete(PARENT, { force: true });
  cleanup();
});

/** What the server does with a create, as a plain accepted / refused. */
async function serverAccepts(
  properties: Record<string, unknown>,
  type: string = CHILD,
): Promise<boolean> {
  const res = await fetchFn("http://localhost/items", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${workingKey}`,
    },
    body: JSON.stringify({ type, properties }),
  });
  return res.ok;
}

describe("the package root", () => {
  // Everything else in this file imports from `@withmarfa/shared`, so the
  // re-export could be missing entirely and every assertion below would still
  // pass. `index.test.ts` makes the same argument about namespaces.
  //
  // Identity, not just reachability. These two read and write one
  // module-level registry, so a consumer whose tree resolved two copies of
  // the shared package would hydrate one and validate against the other, and
  // every type would come back unknown with nothing reporting an error.
  // Re-exporting both from this root is what puts them beyond that, and this
  // is the assertion that says they are the same instance.
  it("offers the pair, and offers the same instances", () => {
    expect(hydrateFromPackageRoot).toBe(hydrateTypeRegistry);
    expect(validateFromPackageRoot).toBe(validateProperties);
  });
});

describe("hydrateTypeRegistry against a live type payload", () => {
  it("validates a hydrated custom type exactly as the server does", async () => {
    const payload = await client.types.list();

    // Child ahead of parent, which is the shape the helper has to cope with
    // and the one a server that holds them in that order hands back.
    const reordered = [
      ...payload.filter((schema) => schema.id !== PARENT),
      ...payload.filter((schema) => schema.id === PARENT),
    ];
    const childAt = reordered.findIndex((schema) => schema.id === CHILD);
    const parentAt = reordered.findIndex((schema) => schema.id === PARENT);
    expect(childAt).toBeGreaterThanOrEqual(0);
    expect(parentAt).toBeGreaterThan(childAt);

    const result = hydrateTypeRegistry(reordered);
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
        local: validateProperties(CHILD, probe.properties).success,
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

describe("a hydration that follows a server-side delete", () => {
  it("stops validating against a type the listing no longer carries", async () => {
    // The delete is the real one over `DELETE /types`, and the second
    // listing is the real `GET /types` after it. Nothing here writes the
    // payload, because the claim is about what a deletion looks like on the
    // wire: it is not a tombstone, it is an absence, and absence is the only
    // signal a client gets.
    await client.types.register({
      id: TRANSIENT,
      version: 1,
      fields: { headline: { type: "string", required: true } },
    });

    const before = hydrateTypeRegistry(await client.types.list());
    expect(before.registered).toContain(TRANSIENT);
    expect(before.removed).toEqual([]);

    // Both sides accept the write while the type exists, which is what makes
    // the disagreement below a change of answer rather than a constant one.
    const probe = { headline: "set" };
    expect(await serverAccepts(probe, TRANSIENT)).toBe(true);
    expect(validateProperties(TRANSIENT, probe).success).toBe(true);

    await client.types.delete(TRANSIENT, { force: true });
    // The in-process server shares this registry, so its delete already
    // evicted the type here, and it lists from the same registry. A real
    // client holds its own copy across the deletion, which is the shape
    // convergence exists for: take the listing, put the stale copy back, and
    // the hydration of that listing is what has to remove it.
    const listing = await client.types.list();
    registerTypeSchema({
      id: TRANSIENT,
      version: 1,
      fields: { headline: { type: "string", required: true } },
    });

    const after = hydrateTypeRegistry(listing);

    expect(after.removed).toEqual([TRANSIENT]);
    // The agreement that matters. A local `true` here is a write queued
    // against a type the server has forgotten, refused on arrival, and
    // refused in a way that reads as permanent.
    const serverNow = await serverAccepts(probe, TRANSIENT);
    const localNow = validateProperties(TRANSIENT, probe).success;
    expect(serverNow).toBe(false);
    expect(localNow).toBe(serverNow);
  });
});
