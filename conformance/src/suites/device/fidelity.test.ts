import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import {
  createTestContext,
  trackItem,
  trackKey,
  cleanup,
} from "../../utils/setup.js";
import { openEventStream, parseSse } from "../../utils/sse.js";
import { answers } from "../../device/marfa-answers.js";
import type { Answer } from "../../device/scripted-server.js";

/**
 * The control on the scripted server.
 *
 * Every other file here drives a device against answers this suite writes, and
 * a suite that writes its own answers can write wrong ones: the device would
 * then pass against a server nobody runs, and the contract would be describing
 * the fixtures rather than Marfa. So for every case the real server can be
 * made to produce, the scripted answer is held against the real one, field by
 * field, for the fields a device reads.
 *
 * What the real server cannot be made to produce is listed in `spec/device.md`
 * with a reason for each entry. Those are the cases this file cannot check,
 * and naming them is the whole of what makes the rest of the scripting
 * trustworthy.
 */

let client: MarfaClient;
let ctx: TestContext;
let apiUrl: string;
let apiKey: string;

beforeAll(async () => {
  ({ ctx, client, apiUrl, apiKey } = await createTestContext(
    "device",
    "fidelity",
  ));
});

afterAll(async () => {
  await cleanup(ctx);
});

interface Observed {
  status: number;
  body: unknown;
}

function scriptedBody(answer: Answer): unknown {
  if (answer.kind !== "json")
    throw new Error("only a JSON answer has a body to compare");
  return answer.body;
}

function scriptedStatus(answer: Answer): number {
  if (answer.kind !== "json")
    throw new Error("only a JSON answer has a status to compare");
  return answer.status;
}

function at(value: unknown, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>(
      (node, key) => (node as Record<string, unknown> | undefined)?.[key],
      value,
    );
}

/** `undefined` reads as absent; everything else reads as its JSON type. */
function kindAt(value: unknown, path: string): string {
  const found = at(value, path);
  if (found === undefined) return "absent";
  if (found === null) return "null";
  return Array.isArray(found) ? "array" : typeof found;
}

/**
 * The scripted answer and the real one have to agree on the status and on
 * every field a device reads out of them. A field the device reads that the
 * script carries and the server does not is a device built against a server
 * that does not exist; one the server carries and the script does not is a
 * fixture that cannot reach the behavior it claims to test.
 */
function expectFidelity(
  name: string,
  real: Observed,
  scripted: Answer,
  paths: string[],
): void {
  expect(
    scriptedStatus(scripted),
    `the scripted answer for ${name} carries a status the server does not give, so every fixture that reads it is testing a server nobody runs`,
  ).toBe(real.status);
  const body = scriptedBody(scripted);
  for (const path of paths) {
    expect(
      kindAt(body, path),
      `the scripted answer for ${name} and the server disagree about \`${path}\`, so a device satisfying this suite would meet something else in production`,
    ).toBe(kindAt(real.body, path));
  }
}

async function note(
  properties: Record<string, unknown>,
): Promise<{ id: string; version: number }> {
  const created = await client.createItem({
    type: "core.note",
    source: ctx.source,
    properties,
  });
  expect(
    created.ok,
    `the fixture could not seed a note: ${JSON.stringify(created.error)}`,
  ).toBe(true);
  trackItem(ctx, created.data.item.id);
  return { id: created.data.item.id, version: created.data.item.version };
}

describe("the scripted answers match the server's", () => {
  it("matches a create and an update", async () => {
    const created = await client.createItem({
      type: "core.note",
      source: ctx.source,
      properties: { title: "fidelity", body: "created" },
    });
    expect(created.ok).toBe(true);
    trackItem(ctx, created.data.item.id);
    expectFidelity(
      "a create",
      { status: created.status, body: created.data },
      answers.created({ id: created.data.item.id, version: 1, properties: {} }),
      ["item.id", "item.version", "metadata.tags"],
    );

    const updated = await client.updateItem(created.data.item.id, {
      properties: { body: "updated" },
      version: created.data.item.version,
    });
    expect(updated.ok).toBe(true);
    expect(
      updated.data.item.version,
      "an accepted update did not move the version, so nothing downstream can tell one write from the next",
    ).toBeGreaterThan(created.data.item.version);
    expectFidelity(
      "an update",
      { status: updated.status, body: updated.data },
      answers.updated({ id: updated.data.item.id, version: 2, properties: {} }),
      ["item.id", "item.version", "metadata.tags"],
    );
  });

  it("matches the version_conflict envelope, field for field", async () => {
    const seeded = await note({ title: "base", body: "base" });
    const winner = await client.updateItem(seeded.id, {
      properties: { title: "winner", body: "winner" },
      version: seeded.version,
    });
    expect(winner.ok).toBe(true);

    const stale = await client.rawRequest(`/items/${seeded.id}`, {
      method: "PATCH",
      body: {
        properties: { title: "loser", body: "loser" },
        version: seeded.version,
      },
    });
    expect(
      stale.status,
      "a stale write was accepted, so the envelope this case exists to compare was never produced",
    ).toBe(409);

    expectFidelity(
      "a stale write with a retained base",
      { status: stale.status, body: stale.error },
      answers.versionConflict(
        { version: 2, properties: {} },
        { version: 1, properties: {} },
        ["body", "title"],
        { fields: { body: "keep_both_copies" }, default: "last_writer_wins" },
      ),
      [
        "error.code",
        "error.status",
        "current.version",
        "current.properties",
        "ancestor.version",
        "ancestor.properties",
        "conflicting_fields",
        "merge_policy.fields",
        "merge_policy.default",
      ],
    );
  });

  it("matches the ancestor_unavailable envelope, including the ancestor it does not carry", async () => {
    const seeded = await note({ title: "no ancestor", body: "no ancestor" });
    const refused = await client.rawRequest(`/items/${seeded.id}`, {
      method: "PATCH",
      body: { properties: { body: "rebased" }, version: 0 },
    });
    expect(refused.status).toBe(409);

    expectFidelity(
      "a write naming a version with no snapshot",
      { status: refused.status, body: refused.error },
      answers.ancestorUnavailable({ version: 1, properties: {} }, 0),
      [
        "error.code",
        "error.status",
        "current.version",
        "requested_version",
        "ancestor",
      ],
    );
  });

  it("matches a resolution that names a sibling and one that does not", async () => {
    const both = await note({ title: "base", body: "base" });
    expect(
      (
        await client.updateItem(both.id, {
          properties: { title: "winner", body: "winner" },
          version: both.version,
        })
      ).ok,
    ).toBe(true);
    const resolved = await client.rawRequest(
      `/items/${both.id}?conflict=auto`,
      {
        method: "PATCH",
        body: {
          properties: { title: "loser", body: "loser" },
          version: both.version,
        },
      },
    );
    expect(
      resolved.ok,
      `a colliding write sent with the server asked to resolve was refused: ${JSON.stringify(resolved.error)}`,
    ).toBe(true);
    const siblingId = (
      resolved.data as { conflict_resolution?: { conflicted_copy_id?: string } }
    ).conflict_resolution?.conflicted_copy_id;
    if (siblingId !== undefined) trackItem(ctx, siblingId);
    expectFidelity(
      "a resolution keeping both copies",
      { status: resolved.status, body: resolved.data },
      answers.resolved(
        { id: both.id, version: 3, properties: {} },
        { body: "keep_both_copies", title: "last_writer_wins" },
        "a-sibling-id",
      ),
      [
        "item.id",
        "item.version",
        "conflict_resolution.strategy",
        "conflict_resolution.conflicted_copy_id",
      ],
    );

    // The other arm: a collision on a last-writer-wins field alone resolves
    // with no sibling to name, and a device has to tell the two apart.
    const lww = await note({ title: "base", body: "untouched" });
    expect(
      (
        await client.updateItem(lww.id, {
          properties: { title: "winner" },
          version: lww.version,
        })
      ).ok,
    ).toBe(true);
    const resolvedLww = await client.rawRequest(
      `/items/${lww.id}?conflict=auto`,
      {
        method: "PATCH",
        body: { properties: { title: "loser" }, version: lww.version },
      },
    );
    expect(resolvedLww.ok).toBe(true);
    const lwwSibling = (
      resolvedLww.data as {
        conflict_resolution?: { conflicted_copy_id?: string };
      }
    ).conflict_resolution?.conflicted_copy_id;
    if (lwwSibling !== undefined) trackItem(ctx, lwwSibling);
    expectFidelity(
      "a resolution on a last-writer-wins field alone",
      { status: resolvedLww.status, body: resolvedLww.data },
      answers.resolved(
        { id: lww.id, version: 3, properties: {} },
        { title: "last_writer_wins" },
      ),
      [
        "item.id",
        "conflict_resolution.strategy",
        "conflict_resolution.conflicted_copy_id",
      ],
    );
  });

  it("matches the refusals a device must not retry", async () => {
    const missing = await client.rawRequest("/items", {
      method: "POST",
      body: { properties: { body: "no type" } },
    });
    expect(missing.status).toBe(400);
    expectFidelity(
      "a body missing a required field",
      { status: missing.status, body: missing.error },
      answers.validation("missing_required_field", "type is required"),
      ["error.code", "error.message"],
    );

    const scoped = await client.createKey({
      label: `${ctx.source}-scoped`,
      source: `${ctx.source}-scoped`,
      type_permissions: { "core.bookmark": "write" },
    });
    expect(
      scoped.ok,
      `the fixture could not mint a narrowed key: ${JSON.stringify(scoped.error)}`,
    ).toBe(true);
    trackKey(ctx, scoped.data.id);
    const narrowed = new MarfaClient({
      baseUrl: apiUrl,
      apiKey: scoped.data.key,
    });
    const denied = await narrowed.createItem({
      type: "core.note",
      source: `${ctx.source}-scoped`,
      properties: { body: "out of scope" },
    });
    expect(denied.status).toBe(403);
    expectFidelity(
      "a type the key does not hold",
      { status: denied.status, body: denied.error },
      answers.forbidden("type_not_permitted"),
      ["error.code", "error.message"],
    );

    const bare = new MarfaClient({ baseUrl: apiUrl, apiKey: "" });
    const unauthorized = await bare.getItem(
      ctx.trackedItems[0] ?? "01a00000-0000-7000-8000-000000000000",
    );
    expect(unauthorized.status).toBe(401);
    expectFidelity(
      "a request with no credential",
      { status: unauthorized.status, body: unauthorized.error },
      answers.unauthorized(),
      ["error.code", "error.message"],
    );
  });

  it("matches the terminal frame an aged-out cursor gets", async () => {
    const seeded = await note({ title: "aged out", body: "aged out" });
    expect(seeded.id).toBeTruthy();

    const stream = await openEventStream(apiUrl, apiKey, { lastEventId: "0" });
    expect(stream.response.status).toBe(200);
    const raw = await stream.response.text();
    await stream.close();

    const terminal = parseSse(raw).find(
      (frame) => frame.event === "catchup_too_old",
    );
    expect(
      terminal,
      "the server did not answer an aged-out cursor with its terminal frame, so the re-hydration the device chapter demands was never produced here",
    ).toBeDefined();
    const payload = terminal!.data as Record<string, unknown>;
    expect(payload.type).toBe("catchup_too_old");
    expect(
      typeof payload.min_retained_id,
      "the frame did not carry the oldest id the log still holds as a string, which is the field the scripted frame carries",
    ).toBe("string");
    expect(typeof payload.requested).toBe("string");
  });
});
