import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { FieldDefinition, TestContext } from "../../client/types.js";
import {
  createTestContext,
  trackItem,
  trackKey,
  cleanup,
} from "../../utils/setup.js";
import { collectUntil, withStream } from "../../utils/stream.js";
import {
  answers,
  itemEvent,
  itemsPage,
  replay,
  scriptedType,
  snapshotType,
  wireItem,
  wireType,
  writeAnswers,
} from "../../device/marfa-answers.js";
import {
  BUILT_FOR,
  CONTRACT_HEADER,
  type Answer,
} from "../../device/scripted-server.js";

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

interface Fields {
  /** Paths whose value has to be the same on both sides. */
  same?: string[];
  /** Paths where only the JSON kind can be compared, because a run mints the value. */
  shape?: string[];
  /**
   * Keys the two sides deliberately differ on, each one a decision rather
   * than an oversight.
   *
   * Written as a list because the check below is otherwise total: every key
   * one side returns must be one the other returns too. Without that, the
   * control only ever compared the paths somebody remembered to list, and a
   * field the server grew — or one nobody thought of — was invisible to it.
   * A device reading such a field is green here and meets something else in
   * production, which is the single thing this file exists to prevent.
   *
   * An entry covers the path and everything under it, so a subtree the
   * scripted server has no reason to mirror is one line rather than sixty.
   */
  absent?: string[];
}

/** Every key path in an object, depth-first, arrays counted as leaves. */
function keyPaths(value: unknown, prefix = ""): string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return [];
  }
  const paths: string[] = [];
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const path = prefix === "" ? key : `${prefix}.${key}`;
    paths.push(path);
    paths.push(...keyPaths(child, path));
  }
  return paths;
}

/**
 * The scripted answer and the real one have to agree on the status, on the
 * value of every field a device decides something by, and on the presence and
 * kind of every field a run mints for itself.
 *
 * Comparing kinds alone is not enough: a scripted `error.code` of "nope" is a
 * string, so is the server's, and the code is the one field the device
 * classifies a refusal by. Comparing values alone is not possible either,
 * because an id, a version and an instant differ every run — hence the two
 * lists.
 */
function expectFidelity(
  name: string,
  real: Observed,
  scripted: Answer,
  fields: Fields,
): void {
  expect(
    scriptedStatus(scripted),
    `the scripted answer for ${name} carries a status the server does not give, so every fixture that reads it is testing a server nobody runs`,
  ).toBe(real.status);
  const body = scriptedBody(scripted);
  for (const path of fields.same ?? []) {
    expect(
      at(body, path),
      `the scripted answer for ${name} and the server disagree about the value at \`${path}\`, and a device decides on that value`,
    ).toEqual(at(real.body, path));
  }
  for (const path of fields.shape ?? []) {
    expect(
      kindAt(body, path),
      `the scripted answer for ${name} and the server disagree about whether \`${path}\` is there and what kind of thing it is, so a device satisfying this suite would meet something else in production`,
    ).toBe(kindAt(real.body, path));
  }
  // Total over the keys, in both directions, rather than over the ones this
  // call listed. The two lists above say what has to agree; these say that
  // nothing on either side went unnoticed, which is the failure the lists
  // cannot catch, because a field nobody listed is a field nobody compared.
  const declared = fields.absent ?? [];
  // A declared path covers its own subtree: `error.details` stands for
  // `error.details` and everything below it.
  const isDeclared = (path: string): boolean =>
    declared.some((entry) => path === entry || path.startsWith(`${entry}.`));
  const scriptedKeys = new Set(keyPaths(body));
  const realKeys = new Set(keyPaths(real.body));
  const missing = [...realKeys].filter(
    (path) => !scriptedKeys.has(path) && !isDeclared(path),
  );
  expect(
    missing,
    `the server answers ${name} with ${missing.join(", ")}, and the scripted server does not. A device that reads one of those is green against this suite and meets something else in production. Model the field, or list it under \`absent\` with the reason it is not modeled.`,
  ).toEqual([]);
  // The other direction, and it is the one the harness already worried about
  // for the `state` parameter: a scripted server more generous than the real
  // one lets a device depend on a field production never sends, and the
  // suite stays green the whole time.
  const invented = [...scriptedKeys].filter(
    (path) => !realKeys.has(path) && !isDeclared(path),
  );
  expect(
    invented,
    `the scripted server answers ${name} with ${invented.join(", ")}, and the real server does not. A device may come to depend on one of those and find nothing there in production. Drop the field, or list it under \`absent\` with the reason the two differ.`,
  ).toEqual([]);
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
      answers.created(
        wireItem({
          id: created.data.item.id,
          version: 1,
          properties: { title: "fidelity", body: "created" },
          source: ctx.source,
        }),
      ),
      { same: ["item.id", "metadata.tags"], shape: ["item.version"] },
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
      answers.updated(
        wireItem({
          id: updated.data.item.id,
          version: 2,
          properties: { title: "fidelity", body: "updated" },
          source: ctx.source,
        }),
      ),
      { same: ["item.id", "metadata.tags"], shape: ["item.version"] },
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
        {
          version: 2,
          properties: { title: "winner", body: "winner" },
          tier: "library",
          occurred_at: "2026-01-01T00:00:00.000Z",
          source_id: null,
        },
        {
          version: 1,
          properties: { title: "base", body: "base" },
          tier: "library",
          occurred_at: "2026-01-01T00:00:00.000Z",
          source_id: null,
        },
        ["body", "title"],
        // core.note declares both of its text fields keep-both
        // (`versions.md` 12); a policy naming one of them would send a device
        // looking for a sibling it was never told to expect.
        {
          fields: { body: "keep_both_copies", notes: "keep_both_copies" },
          default: "last_writer_wins",
        },
      ),
      {
        same: [
          "error.code",
          "error.status",
          "conflicting_fields",
          "merge_policy.fields",
          "merge_policy.default",
        ],
        shape: [
          "current.version",
          "current.properties",
          "current.tier",
          "current.occurred_at",
          "current.source_id",
          "ancestor.version",
          "ancestor.properties",
          "ancestor.tier",
          "ancestor.occurred_at",
          "ancestor.source_id",
        ],
      },
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
      answers.ancestorUnavailable(
        {
          version: 1,
          properties: { title: "base", body: "base" },
          tier: "library",
          occurred_at: "2026-01-01T00:00:00.000Z",
          source_id: null,
        },
        0,
      ),
      {
        same: ["error.code", "error.status", "requested_version", "ancestor"],
        shape: [
          "current.version",
          "current.properties",
          "current.tier",
          "current.occurred_at",
          "current.source_id",
        ],
      },
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
        wireItem({
          id: both.id,
          version: 3,
          properties: { title: "winner", body: "winner" },
          source: ctx.source,
        }),
        { body: "keep_both_copies", title: "last_writer_wins" },
        "a-sibling-id",
      ),
      {
        same: ["item.id", "conflict_resolution.strategy"],
        shape: ["item.version", "conflict_resolution.conflicted_copy_id"],
      },
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
        wireItem({
          id: lww.id,
          version: 3,
          properties: { title: "winner", body: "untouched" },
          source: ctx.source,
        }),
        { title: "last_writer_wins" },
      ),
      {
        same: [
          "item.id",
          "conflict_resolution.strategy",
          "conflict_resolution.conflicted_copy_id",
        ],
      },
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
      {
        same: ["error.code"],
        shape: ["error.message"],
        // The server's diagnostics for a validation refusal, naming the
        // field that failed. Not mirrored because a device classifies a
        // refusal by its code (`queue-and-verdicts.md` 12) and reports the
        // envelope whole (15), so nothing in the device reads inside it; a
        // scripted `details` on the shared refusal builder would put it on
        // every refusal, and the server puts it on this one.
        absent: ["error.details"],
      },
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
      { same: ["error.code"], shape: ["error.message"] },
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
      { same: ["error.code"], shape: ["error.message"] },
    );
  });

  /**
   * The doors that answer something other than an item.
   *
   * Every sendable write kind that does not answer with an item goes to one
   * of these, and none of their answers carries an `item`. Scripting them
   * with item-shaped bodies, which no server returns, would hide a device
   * reading every one of them as an answer it could not understand —
   * counting a refusal against a write the server had already taken.
   */
  it("matches the write doors that do not answer with an item", async () => {
    const seeded = await note({ title: "sidecar", body: "sidecar" });
    const other = await note({ title: "other end", body: "other end" });

    const tagged = await client.rawRequest(`/items/${seeded.id}/tags`, {
      method: "POST",
      body: { tags: ["fidelity"] },
    });
    expect(
      tagged.ok,
      `the fixture could not put a tag on: ${JSON.stringify(tagged.error)}`,
    ).toBe(true);
    expectFidelity(
      "a tag written",
      { status: tagged.status, body: tagged.data },
      writeAnswers.metadata(seeded.id, ["fidelity"]),
      { same: ["metadata.item_id", "metadata.tags", "metadata.extensions"] },
    );

    const merged = await client.rawRequest(`/items/${seeded.id}/metadata`, {
      method: "PATCH",
      body: { tags: ["also"] },
    });
    expect(merged.ok).toBe(true);
    expectFidelity(
      "a metadata write",
      { status: merged.status, body: merged.data },
      writeAnswers.metadata(seeded.id, ["fidelity", "also"]),
      {
        same: ["metadata.item_id"],
        shape: ["metadata.tags", "metadata.extensions"],
      },
    );

    const extended = await client.rawRequest(
      `/items/${seeded.id}/extensions/app.fidelity`,
      { method: "PUT", body: { pinned: true } },
    );
    expect(extended.ok).toBe(true);
    expectFidelity(
      "an extension written",
      { status: extended.status, body: extended.data },
      writeAnswers.extensions({ "app.fidelity": { pinned: true } }),
      { same: ["extensions.app.fidelity.pinned"] },
    );

    const linked = await client.rawRequest("/edges", {
      method: "POST",
      body: {
        source_id: seeded.id,
        target_id: other.id,
        edge_type: "references",
      },
    });
    expect(
      linked.ok,
      `the fixture could not link two items: ${JSON.stringify(linked.error)}`,
    ).toBe(true);
    expectFidelity(
      "an edge created",
      { status: linked.status, body: linked.data },
      writeAnswers.edge({
        id: "01a00000-0000-7000-8000-0000000000ee",
        source_id: seeded.id,
        target_id: other.id,
      }),
      {
        same: [
          "edge.source_id",
          "edge.target_id",
          "edge.edge_type",
          "edge.properties",
        ],
        shape: [
          "edge.id",
          "edge.version",
          "edge.created_at",
          "edge.updated_at",
        ],
      },
    );

    const removed = await client.rawRequest(`/items/${other.id}`, {
      method: "DELETE",
    });
    expect(removed.ok).toBe(true);
    expectFidelity(
      "an item deleted",
      { status: removed.status, body: removed.data },
      writeAnswers.ok(),
      { same: ["ok"] },
    );
  });

  it("matches an upload, and the link to the bytes it names", async () => {
    const bytes = Buffer.from(`fidelity ${ctx.source}\n`);
    const sent = await fetch(`${apiUrl}/blobs`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "text/plain",
      },
      body: bytes,
    });
    const uploaded = (await sent.json()) as { hash: string };
    expect(
      sent.status,
      `the fixture could not upload bytes: ${JSON.stringify(uploaded)}`,
    ).toBe(201);
    expectFidelity(
      "an upload",
      { status: sent.status, body: uploaded },
      writeAnswers.uploaded(uploaded.hash, "text/plain", bytes.length),
      { same: ["hash", "mime_type", "size_bytes"] },
    );

    const linked = await client.rawRequest(`/blobs/${uploaded.hash}/url`, {
      method: "GET",
    });
    expect(
      linked.ok,
      `the fixture could not ask for a link: ${JSON.stringify(linked.error)}`,
    ).toBe(true);
    expectFidelity(
      "a link to a blob's bytes",
      { status: linked.status, body: linked.data },
      writeAnswers.link("http://127.0.0.1/links/fidelity"),
      { same: ["expires_in"], shape: ["url"] },
    );
    // What the scripted link does, the real one does: it serves the bytes
    // with no credential at all.
    const url = (linked.data as { url: string }).url;
    const fetched = await fetch(url);
    expect(fetched.status).toBe(200);
    expect(Buffer.from(await fetched.arrayBuffer())).toEqual(bytes);
  });

  it("matches the root status reads, and the contract every answer names", async () => {
    const response = await fetch(`${apiUrl}/`);
    const body = (await response.json()) as { contract: number };
    expectFidelity(
      "the root",
      { status: response.status, body },
      answers.root(Number(BUILT_FOR)),
      {
        same: ["name", "contract"],
        shape: ["version", "instance_id", "features"],
      },
    );
    // The scripted server names the contract of the document the binary was
    // generated from on every answer; the real one names the root's, on a
    // success and a refusal alike.
    const refused = await fetch(`${apiUrl}/items`);
    expect(refused.status).toBe(401);
    for (const answered of [response, refused]) {
      expect(answered.headers.get(CONTRACT_HEADER)).toBe(String(body.contract));
    }
    expect(BUILT_FOR).toBe(String(body.contract));
  });

  it("matches the items page a hydration walks", async () => {
    const seeded = await note({ title: "page shape", body: "page shape" });
    const page = await client.rawRequest(
      `/items?type=core.note&tier=library&state=any&include=edges,metadata&source=${encodeURIComponent(ctx.source)}`,
    );
    expect(page.ok).toBe(true);
    expect(
      (page.data as { data: unknown[] }).data.length,
      "the listing answered nothing, so the comparison below is between two empty envelopes",
    ).toBeGreaterThan(0);

    expectFidelity(
      "the items page",
      { status: page.status, body: page.data },
      itemsPage([{ item: wireItem({ id: seeded.id }) }]),
      {
        same: ["next_cursor", "data.0.metadata.tags"],
        shape: [
          "data.0.item.id",
          "data.0.item.type",
          "data.0.item.properties",
          "data.0.item.state",
          "data.0.item.tier",
          "data.0.item.version",
          "data.0.item.schema_version",
          "data.0.item.source",
          // Absent rather than null on a row that has neither, which is a
          // difference `kindAt` can see and a device reads as two different
          // things.
          "data.0.item.source_id",
          "data.0.item.occurred_at",
          "data.0.item.created_at",
          "data.0.item.updated_at",
        ],
      },
    );
  });

  it("matches the type registry a device resolves a subtree with", async () => {
    const registry = await client.rawRequest("/types");
    expect(registry.ok).toBe(true);
    const served = registry.data as { data?: unknown; next_cursor?: unknown };
    expect(
      Array.isArray(served.data) && served.next_cursor === null,
      "the registry is not one whole page, so a device decoding one would read nothing at all",
    ).toBe(true);
    const rows = served.data as Array<Record<string, unknown>>;

    const rootType = rows.find((row) => row.id === "core.note");
    const childType = rows.find((row) => row.id === "core.entity.person");
    expect(
      [rootType, childType].every((row) => row !== undefined),
      "the registry does not carry the two types this comparison is built on",
    ).toBe(true);

    expectFidelity(
      "a type with no parent",
      { status: registry.status, body: { row: rootType } },
      {
        kind: "json",
        status: registry.status,
        body: { row: scriptedType("core.note") },
      },
      {
        same: ["row.id", "row.display_hints.title_field"],
        // A type with no parent carries no `parent` at all. A scripted `null`
        // there is a shape the server never sends, and a device walking a
        // parent chain meets it on the first type it reads.
        shape: ["row.parent", "row.label", "row.fields"],
      },
    );
    expectFidelity(
      "a type with a parent",
      { status: registry.status, body: { row: childType } },
      {
        kind: "json",
        status: registry.status,
        body: {
          row: wireType("core.entity.person", {
            parent: "core.entity",
            titleField: "name",
          }),
        },
      },
      {
        same: ["row.id", "row.parent", "row.display_hints.title_field"],
        // `row.fields` by kind, so the two sides agree there is a field
        // schema and not on what is in it.
        shape: ["row.label", "row.fields"],
        // A type's own field schema is the deployment's rather than the
        // protocol's: `core.entity.person` carries twenty fields here and
        // would carry a different twenty elsewhere. A device reads a type
        // for its parent and its title field and nothing else (`device.md`
        // 15), so mirroring the schema would be this file holding a copy of
        // a seed that changes without it.
        absent: [
          "row.fields",
          "row.merge_policy",
          "row.description",
          "row.version",
        ],
      },
    );
  });

  it("matches a registered type that declares a thumbnail", async () => {
    const id = `user.snapshot-${ctx.runId}`;
    const scripted = snapshotType(id);
    const registered = await client.registerType({
      id,
      fields: scripted.fields as Record<string, FieldDefinition>,
      display_hints: { title_field: "title" },
    });
    expect(registered.ok, JSON.stringify(registered.error)).toBe(true);
    const registry = await client.rawRequest("/types");
    expect(registry.ok).toBe(true);
    const row = (
      registry.data as { data: Array<Record<string, unknown>> }
    ).data.find((candidate) => candidate.id === id);
    expect(
      row,
      "the registry does not list the type just registered",
    ).toBeDefined();

    expectFidelity(
      "a registered type declaring a thumbnail",
      { status: registry.status, body: { row } },
      { kind: "json", status: registry.status, body: { row: scripted } },
      {
        // What a device reads from a type to find its thumbnail.
        same: [
          "row.id",
          "row.display_hints.title_field",
          "row.fields.thumbnail.type",
        ],
        shape: ["row.label", "row.fields"],
      },
    );
  });

  it("matches an item frame on the event stream", async (context) => {
    const marker = `fidelity-frame-${ctx.runId}`;
    const frames = await withStream(apiUrl, apiKey, {}, async (stream) => {
      await new Promise((resolve) => setTimeout(resolve, 250));
      const created = await client.createItem({
        type: "core.note",
        source: ctx.source,
        properties: { title: marker, body: marker },
      });
      expect(created.ok).toBe(true);
      trackItem(ctx, created.data.item.id);
      const seen = await collectUntil(
        stream,
        (events) =>
          events.some(
            (event) =>
              event.event === "item.created" &&
              (event.data as { item?: { properties?: { title?: string } } })
                .item?.properties?.title === marker,
          ),
        `item.created for ${marker}`,
        context.signal,
      );
      return seen.events;
    });

    const announced = frames.find(
      (event) =>
        (event.data as { item?: { properties?: { title?: string } } }).item
          ?.properties?.title === marker,
    );
    expect(
      announced,
      "the write was never announced, so there is no frame to compare",
    ).toBeDefined();
    expect(
      typeof announced!.id,
      "the frame carried no id, so a device applying it has nothing to move its cursor to",
    ).toBe("string");

    const scripted = itemEvent(
      announced!.id!,
      "item.created",
      wireItem({ id: "an-item" }),
    );
    expectFidelity(
      "an item frame",
      { status: 200, body: announced!.data },
      { kind: "json", status: 200, body: scripted.data },
      {
        // The sidecar rides on every item frame. A scripted frame without it
        // is a frame a device could never learn a cleared tag from.
        same: ["type", "metadata.tags"],
        shape: [
          "item.id",
          "item.type",
          "item.properties",
          "item.state",
          "item.tier",
          "item.version",
          "item.source",
          "item.source_id",
          "item.created_at",
          "item.updated_at",
        ],
      },
    );
  });

  it("matches the refusal a spent idempotency key gets", async () => {
    const key = `fidelity-spent-${ctx.runId}`;
    const first = await client.rawRequest("/items", {
      method: "POST",
      headers: { "Idempotency-Key": key },
      body: {
        type: "core.note",
        properties: { title: "first", body: "first" },
      },
    });
    expect(
      first.ok,
      `the first write under the key was refused: ${JSON.stringify(first.error)}`,
    ).toBe(true);
    trackItem(ctx, (first.data as { item: { id: string } }).item.id);

    const reused = await client.rawRequest("/items", {
      method: "POST",
      headers: { "Idempotency-Key": key },
      body: {
        type: "core.note",
        properties: { title: "second", body: "second" },
      },
    });
    expect(
      reused.status,
      "a key answered for one request served a different one, so the refusal this compares against was never produced",
    ).toBe(422);

    expectFidelity(
      "a key answered for a different request",
      { status: reused.status, body: reused.error },
      answers.keyReused(),
      { same: ["error.code"], shape: ["error.message"] },
    );
  });

  it("matches the replay a cursor of zero gets against a log that begins at one", async (context) => {
    // Every device that hydrated an empty instance holds `0` (`device.md`
    // 35), so the scripted `replay` a cursor of zero is answered with has
    // to be the real server's answer: the head, then the events, and no
    // terminal frame. The run's server has written since its first event,
    // so the replay is read until a row this case wrote arrives.
    const marker = `fidelity-zero-${ctx.runId}`;
    const seeded = await note({ title: marker, body: marker });
    const frames = await withStream(
      apiUrl,
      apiKey,
      { lastEventId: "0" },
      async (stream) =>
        (
          await collectUntil(
            stream,
            (events) =>
              events.some(
                (event) =>
                  (event.data as { item?: { id?: string } }).item?.id ===
                  seeded.id,
              ),
            `the replay from zero to reach ${seeded.id}`,
            context.signal,
          )
        ).events,
    );
    expect(frames.length).toBeGreaterThan(1);
    expect(
      frames.some((event) => event.event === "catchup_too_old"),
      "a cursor of zero was refused as too old, which is the refusal every device that hydrated an empty instance would meet on its first catch-up",
    ).toBe(false);

    const scripted = replay("1", [
      itemEvent("1", "item.created", wireItem({ id: seeded.id })),
    ]);
    const scriptedFrames = scripted.kind === "sse" ? scripted.frames : [];
    const head = frames[0]!;
    const scriptedHead = scriptedFrames.find(
      (frame) => frame.event === "stream_cursor",
    )!;
    expect(head.event).toBe("stream_cursor");
    expect(head.id, "the head frame carries no id").toBeUndefined();
    expectFidelity(
      "the head of a replay",
      { status: 200, body: head.data },
      { kind: "json", status: 200, body: scriptedHead.data },
      { same: ["type"], shape: ["cursor"] },
    );
    const first = frames[1]!;
    expect(
      typeof first.id,
      "the first replayed frame carried no id, so a device applying it has nothing to move its cursor to",
    ).toBe("string");
    expect(
      first.event.startsWith("item.") ||
        first.event.startsWith("edge.") ||
        first.event === "metadata.changed",
    ).toBe(true);
  });
});
