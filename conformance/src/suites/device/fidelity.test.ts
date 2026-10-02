import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { FieldDefinition, TestContext } from "../../client/types.js";
import {
  createTestContext,
  trackFolder,
  trackItem,
  trackKey,
  cleanup,
} from "../../utils/setup.js";
import { collectUntil, withStream } from "../../utils/stream.js";
import {
  answers,
  edgesPage,
  itemEvent,
  liveReplay,
  itemsPage,
  replay,
  scriptedType,
  snapshotType,
  SCRIPTED_EDGE_TYPES,
  edgeType,
  type WireEdgeType,
  wireEdge,
  wireItem,
  wireType,
  writeAnswers,
} from "../../device/marfa-answers.js";
import {
  BUILT_FOR,
  CONTRACT_HEADER,
  type Answer,
} from "../../device/scripted-server.js";
import { v7 as uuidv7 } from "uuid";
import { FolderDoor, type DoorCreate } from "../../device/folder-door.js";
import { CliDevice, newStore } from "../../device/cli-adapter.js";
import { requireBinary } from "./harness.js";

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

  it("matches a retype and a tier move sent as one update", async () => {
    const created = await client.createItem({
      type: "core.note",
      source: ctx.source,
      properties: { title: "fidelity retype", body: "created" },
    });
    expect(created.ok).toBe(true);
    trackItem(ctx, created.data.item.id);
    // The body the device sends (`queue.test.ts` asserts it goes out so).
    const moved = await client.rawRequest<Record<string, unknown>>(
      `/items/${created.data.item.id}?conflict=auto`,
      {
        method: "PATCH",
        body: {
          properties: { title: "fidelity retype" },
          version: created.data.item.version,
          type: "core.bookmark",
          retype: true,
          tier: "feed",
        },
      },
    );
    expect(moved.ok, JSON.stringify(moved.error)).toBe(true);
    const item = (moved.data as { item: { type: string; tier: string } }).item;
    expect(item.type).toBe("core.bookmark");
    expect(item.tier).toBe("feed");
    expectFidelity(
      "a retype and a tier move",
      { status: moved.status, body: moved.data },
      answers.updated(
        wireItem({
          id: created.data.item.id,
          version: 2,
          type: "core.bookmark",
          tier: "feed",
          properties: { title: "fidelity retype", body: "created" },
          source: ctx.source,
        }),
      ),
      { same: ["item.id", "metadata.tags"], shape: ["item.version"] },
    );
  });

  it("matches a create onto a natural key a row holds: named by id, and not", async () => {
    // What a device meets when a create it queued carries a key another
    // device's create already landed under (`queue-and-verdicts.md` 38).
    const sourceId = `fidelity-${ctx.runId}.md`;
    const first = await client.createItem({
      type: "core.note",
      source: ctx.source,
      source_id: sourceId,
      properties: { title: "first", body: "first" },
    });
    expect(first.status, JSON.stringify(first.error)).toBe(201);
    trackItem(ctx, first.data.item.id);

    // A body naming an id that is not the row the key resolves.
    const named = "01a00000-0000-7000-8000-0000000000fd";
    const refused = await client.rawRequest("/items", {
      method: "POST",
      body: {
        id: named,
        type: "core.note",
        source: ctx.source,
        source_id: sourceId,
        properties: { title: "second", body: "second" },
      },
    });
    expect(
      refused.status,
      "a create naming another id was taken onto the row its key resolves, so the refusal this case compares was never produced",
    ).toBe(400);
    expectFidelity(
      "a create whose id is not the row its natural key resolves",
      { status: refused.status, body: refused.error },
      answers.idNotTheKeys(named, first.data.item.id, ctx.source, sourceId),
      {
        same: [
          "error.code",
          "error.details.field",
          "error.details.requested_id",
          "error.details.existing_id",
          "error.details.source",
          "error.details.source_id",
        ],
        shape: ["error.message"],
      },
    );

    // The same create naming no id lands on that row, under its id.
    const upserted = await client.rawRequest("/items", {
      method: "POST",
      body: {
        type: "core.note",
        source: ctx.source,
        source_id: sourceId,
        version: first.data.item.version,
        properties: { title: "second", body: "second" },
      },
    });
    expect(upserted.status, JSON.stringify(upserted.error)).toBe(200);
    const body = upserted.data as { item: { id: string; version: number } };
    expect(body.item.id).toBe(first.data.item.id);
    expectFidelity(
      "a create with no id whose natural key resolves a row",
      { status: upserted.status, body: upserted.data },
      answers.upserted(
        wireItem({
          id: first.data.item.id,
          version: 2,
          properties: { title: "second", body: "second" },
          source: ctx.source,
          source_id: sourceId,
        }),
      ),
      {
        same: [
          "item.id",
          "item.source",
          "item.source_id",
          "item.version",
          "metadata.tags",
        ],
        shape: ["item.properties"],
      },
    );
  });

  it("holds the scripted folder door's decisions to the server's", async () => {
    // A folder fixture's server decides with `FolderDoor` (`folders.test.ts`),
    // and so does a queue fixture about an edit behind an edit
    // (`queue.test.ts`), so each decision it makes is made here by both, on
    // the same request, and has to come out the same: a door that decided
    // differently would have a device passing against rules nobody runs.
    const door = new FolderDoor();
    const sourceId = `door-${ctx.runId}.md`;
    const decide = async (
      name: string,
      body: DoorCreate,
      fields: Fields,
      scripted: FolderDoor = door,
      sender: MarfaClient = client,
    ) => {
      const real = await sender.rawRequest<Record<string, unknown>>("/items", {
        method: "POST",
        body,
      });
      const answer = scripted.create(body).answer;
      const observed = {
        status: real.status,
        body: real.ok ? real.data : real.error,
      };
      expectFidelity(name, observed, answer, fields);
      return { real: observed.body, scripted: scriptedBody(answer) };
    };
    const keyed = {
      type: "core.note",
      source: ctx.source,
      source_id: sourceId,
    };

    // Nothing under the key: the create makes a row.
    const minted = await decide(
      "a create onto a natural key nothing holds",
      { ...keyed, version: 0, properties: { title: "door", body: "door" } },
      {
        same: [
          "item.source",
          "item.source_id",
          "item.version",
          "item.properties",
        ],
        shape: ["item.id"],
      },
    );
    const realId = String(at(minted.real, "item.id"));
    const doorId = String(at(minted.scripted, "item.id"));
    trackItem(ctx, realId);

    // A create naming an id and no natural key makes that row. The same
    // create again, once somebody has edited the row, is acknowledged with
    // the row as it now stands.
    const ownId = {
      type: "core.note",
      id: uuidv7(),
      properties: { title: "named", body: "named" },
    };
    await decide("a create naming its own id", ownId, {
      same: ["item.id", "item.version", "item.properties", "acknowledged"],
      shape: ["item.source"],
    });
    trackItem(ctx, ownId.id);
    const movedOn = { properties: { title: "moved on" }, version: 1 };
    const editedReal = await client.rawRequest(`/items/${ownId.id}`, {
      method: "PATCH",
      body: movedOn,
    });
    expect(
      editedReal.ok,
      `the fixture could not edit the row it named: ${JSON.stringify(editedReal.error)}`,
    ).toBe(true);
    door.update(ownId.id, movedOn);
    await decide("the same create again, after an edit", ownId, {
      same: ["item.id", "item.version", "item.properties", "acknowledged"],
      shape: ["item.source"],
    });
    // And again carrying a natural key nothing holds: the key resolves no
    // row, so the id decides, and the create is still a repeat.
    await decide(
      "the same create again, carrying a natural key nothing holds",
      { ...ownId, source: ctx.source, source_id: `unkeyed-${ctx.runId}` },
      {
        same: [
          "item.id",
          "item.version",
          "item.properties",
          "item.source_id",
          "acknowledged",
        ],
        shape: ["item.source"],
      },
    );

    // The version the row is at: the create lands on it.
    const upserted = await decide(
      "a create carrying the version its natural key's row is at",
      { ...keyed, version: 1, properties: { title: "door, again" } },
      {
        same: [
          "item.source",
          "item.source_id",
          "item.version",
          "item.properties",
        ],
        shape: ["item.id"],
      },
    );
    expect(
      [at(upserted.real, "item.id"), at(upserted.scripted, "item.id")],
      "a create onto the key's row landed somewhere else on one side",
    ).toEqual([realId, doorId]);

    // An id that is not the key's row: refused on both.
    const named = "01a00000-0000-7000-8000-0000000000fe";
    const refused = await decide(
      "a create naming an id that is not its natural key's row",
      { ...keyed, id: named, properties: { title: "named" } },
      {
        same: [
          "error.code",
          "error.details.field",
          "error.details.requested_id",
          "error.details.source",
          "error.details.source_id",
        ],
        shape: ["error.message", "error.details.existing_id"],
      },
    );
    expect([
      at(refused.real, "error.details.existing_id"),
      at(refused.scripted, "error.details.existing_id"),
    ]).toEqual([realId, doorId]);

    // Zero, which says nothing was read: refused, naming the row.
    const zero = await decide(
      "a create carrying version zero onto a natural key a row holds",
      { ...keyed, version: 0, properties: { title: "zero" } },
      {
        same: [
          "error.code",
          "error.status",
          "requested_version",
          "current.version",
          "current.properties",
          "current.source_id",
        ],
        shape: [
          "error.message",
          "current.id",
          "current.tier",
          "current.occurred_at",
        ],
      },
    );
    expect(
      [at(zero.real, "current.id"), at(zero.scripted, "current.id")],
      "the refusal did not name the key's row on one side",
    ).toEqual([realId, doorId]);

    // A version the row has moved past, colliding with what moved it.
    const stale = await decide(
      "a create carrying a version the row has moved past",
      { ...keyed, version: 1, properties: { title: "stale" } },
      {
        same: [
          "error.code",
          "error.status",
          "conflicting_fields",
          "merge_policy.fields",
          "merge_policy.default",
          "current.version",
          "current.properties",
          "ancestor.version",
          "ancestor.properties",
        ],
        shape: [
          "error.message",
          "current.id",
          "current.tier",
          "current.occurred_at",
          "current.source_id",
          "ancestor.id",
          "ancestor.tier",
          "ancestor.occurred_at",
          "ancestor.source_id",
        ],
      },
    );
    expect([
      at(stale.real, "current.id"),
      at(stale.scripted, "current.id"),
    ]).toEqual([realId, doorId]);

    // An update and a read, decided by both on the row each holds.
    const patch = async (
      name: string,
      ids: [string, string],
      body: { properties: Record<string, unknown>; version: number },
      fields: Fields,
      resolve = false,
    ) => {
      const real = await client.rawRequest<Record<string, unknown>>(
        `/items/${ids[0]}${resolve ? "?conflict=auto" : ""}`,
        { method: "PATCH", body },
      );
      expectFidelity(
        name,
        { status: real.status, body: real.ok ? real.data : real.error },
        door.update(ids[1], body, { resolve }),
        fields,
      );
    };
    const readBoth = async (
      name: string,
      ids: [string, string],
      fields: Fields,
    ) => {
      const real = await client.rawRequest<Record<string, unknown>>(
        `/items/${ids[0]}`,
      );
      expectFidelity(
        name,
        { status: real.status, body: real.ok ? real.data : real.error },
        door.read(ids[1]),
        fields,
      );
    };
    const missing = "01a00000-0000-7000-8000-0000000000fc";
    await patch(
      "an update naming the version the row is at",
      [realId, doorId],
      { properties: { title: "patched" }, version: 2 },
      {
        same: ["item.version", "item.properties", "item.source_id"],
        shape: ["item.id"],
      },
    );
    // Stale, at version 2 of a row since moved on: a change nobody else made
    // is merged, a collision on a last-writer field is refused, and resolved
    // where the caller asks.
    const merged = {
      same: ["item.version", "item.properties", "item.source_id"],
      shape: ["item.id"],
    };
    await patch(
      "a stale update of a field nobody changed since",
      [realId, doorId],
      { properties: { body: "only here" }, version: 2 },
      merged,
      true,
    );
    await patch(
      "a stale update colliding on a last-writer field",
      [realId, doorId],
      { properties: { title: "stale title" }, version: 2 },
      {
        same: [
          "error.code",
          "conflicting_fields",
          "current.version",
          "ancestor.version",
        ],
        shape: [
          "error.message",
          "error.status",
          "current.id",
          "current.properties",
          "current.tier",
          "current.occurred_at",
          "current.source_id",
          "ancestor.id",
          "ancestor.properties",
          "ancestor.tier",
          "ancestor.occurred_at",
          "ancestor.source_id",
          "merge_policy",
        ],
      },
    );
    await patch(
      "the same collision, resolved by the server",
      [realId, doorId],
      { properties: { title: "stale title" }, version: 2 },
      {
        ...merged,
        same: [...merged.same, "conflict_resolution"],
      },
      true,
    );
    // A collision on a keep-both property, resolved: the row keeps its own
    // value and the losing one goes to a sibling, which both sides then read.
    const keptBoth = { properties: { body: "stale body" }, version: 2 };
    const keptReal = await client.rawRequest<Record<string, unknown>>(
      `/items/${realId}?conflict=auto`,
      { method: "PATCH", body: keptBoth },
    );
    const keptDoor = door.update(doorId, keptBoth, { resolve: true });
    const realCopy = at(
      keptReal.data,
      "conflict_resolution.conflicted_copy_id",
    );
    if (typeof realCopy === "string") trackItem(ctx, realCopy);
    expectFidelity(
      "a stale update colliding on a keep-both property, resolved by the server",
      {
        status: keptReal.status,
        body: keptReal.ok ? keptReal.data : keptReal.error,
      },
      keptDoor,
      {
        same: [
          ...merged.same,
          "conflict_resolution.fields",
          "conflict_resolution.strategy",
        ],
        shape: [...merged.shape, "conflict_resolution.conflicted_copy_id"],
      },
    );
    await readBoth(
      "a read of the sibling a keep-both resolution wrote",
      [
        String(realCopy),
        String(
          at(scriptedBody(keptDoor), "conflict_resolution.conflicted_copy_id"),
        ),
      ],
      {
        same: [
          "item.type",
          "item.source",
          "item.version",
          "item.properties",
          "item.state",
          "metadata.tags",
        ],
        shape: [
          "item.id",
          "item.source_id",
          "item.occurred_at",
          "item.created_at",
          "item.updated_at",
          "metadata.item_id",
        ],
      },
    );
    // A create naming a version the row has moved past, changing only what
    // nobody changed since: merged over the row as it stands, and answered
    // as an upsert onto it.
    const beforeMerge = door.rows.get(doorId);
    const mergedCreate = await decide(
      "a create carrying a version the row has moved past, colliding with nothing",
      { ...keyed, version: 5, properties: { title: "created stale" } },
      {
        same: [
          "item.source",
          "item.source_id",
          "item.version",
          "item.properties",
        ],
        shape: ["item.id"],
      },
    );
    expect([
      at(mergedCreate.real, "item.id"),
      at(mergedCreate.scripted, "item.id"),
    ]).toEqual([realId, doorId]);
    // The same again on the version before that create, carrying the title
    // as it stood there, which that create has changed since: the title is
    // no change of this create's, so the row keeps the one written since,
    // and only the body it changed is applied.
    const echoed = await decide(
      "a stale create carrying a property changed since at the value it named",
      {
        ...keyed,
        version: beforeMerge?.version ?? 0,
        properties: {
          title: String(beforeMerge?.properties.title),
          body: "created again",
        },
      },
      {
        same: [
          "item.source",
          "item.source_id",
          "item.version",
          "item.properties",
        ],
        shape: ["item.id"],
      },
    );
    expect([
      at(echoed.real, "item.properties.title"),
      at(echoed.real, "item.properties.body"),
    ]).toEqual(["created stale", "created again"]);
    await patch(
      "an update of a row nobody holds",
      [missing, missing],
      { properties: { title: "nowhere" }, version: 1 },
      { same: ["error.code"], shape: ["error.message"] },
    );
    await readBoth("a read of a row held", [realId, doorId], {
      same: ["item.version", "item.properties", "item.state"],
      shape: ["item.id"],
    });
    await readBoth("a read of a row nobody holds", [missing, missing], {
      same: ["error.code"],
      shape: ["error.message"],
    });

    // The row in the bin: an update is refused, a read finds nothing, and a
    // keyed create is acknowledged and not written.
    const binned = await client.deleteItem(realId);
    expect(binned.ok, JSON.stringify(binned.error)).toBe(true);
    door.trash(doorId);
    await patch(
      "an update of a row in the bin",
      [realId, doorId],
      { properties: { title: "binned" }, version: 3 },
      {
        same: ["error.code"],
        shape: ["error.message"],
        // The server says the row is in the bin (`errors.md` 12). No device
        // reads it yet; the device change that keeps a refused write where
        // the person can get it back models it here when it starts to.
        absent: ["error.details"],
      },
    );
    await readBoth("a read of a row in the bin", [realId, doorId], {
      same: ["error.code"],
      shape: ["error.message"],
    });
    const acknowledged = await decide(
      "a keyed create onto a row in the bin",
      { ...keyed, version: 0, properties: { title: "after the bin" } },
      {
        same: [
          "acknowledged",
          "item.state",
          "item.version",
          "item.properties",
          "item.source_id",
        ],
        shape: ["item.id"],
      },
    );
    expect([
      at(acknowledged.real, "item.id"),
      at(acknowledged.scripted, "item.id"),
    ]).toEqual([realId, doorId]);

    // A source the credential's key does not claim: refused, naming it.
    await decide(
      "a create naming a source its key does not claim",
      {
        ...keyed,
        source: `unclaimed-${ctx.runId}`,
        version: 0,
        properties: { title: "unclaimed" },
      },
      { same: ["error.code", "error.details"], shape: ["error.message"] },
      new FolderDoor([], () => false),
    );

    // A row of a type the key may not read, reached through a source it
    // claims: refused without the row named, on both.
    const hidden = `door-hidden-${ctx.runId}`;
    const bookmark = await client.createItem({
      type: "core.bookmark",
      source: ctx.source,
      source_id: hidden,
      properties: { url: "https://example.com/door", title: "door" },
    });
    expect(bookmark.status, JSON.stringify(bookmark.error)).toBe(201);
    trackItem(ctx, bookmark.data.item.id);
    const doorKey = await client.createKey({
      label: `${ctx.source}-door-notes`,
      source: `${ctx.source}-door-notes`,
      sources: [ctx.source],
      type_permissions: { "core.note": "write" },
    });
    expect(doorKey.ok, JSON.stringify(doorKey.error)).toBe(true);
    trackKey(ctx, doorKey.data.id);
    const notesOnly = new MarfaClient({
      baseUrl: apiUrl,
      apiKey: doorKey.data.key,
    });
    const hiddenDoor = new FolderDoor(
      [
        [
          "01a00000-0000-7000-8000-0000000000bb",
          {
            properties: { url: "https://example.com/door", title: "door" },
            source: ctx.source,
            source_id: hidden,
            type: "core.bookmark",
            version: 1,
          },
        ],
      ],
      () => true,
      (type) => type === "core.note",
    );
    const unreadable = await decide(
      "a create whose natural key resolves a row of a type its key may not read",
      { ...keyed, source_id: hidden, version: 0, properties: { title: "x" } },
      { same: ["error.code", "error.message"] },
      hiddenDoor,
      notesOnly,
    );
    expect(
      JSON.stringify(unreadable.real),
      "the server named a row its key may not read",
    ).not.toContain(bookmark.data.item.id);

    // The same row in the bin: the type is asked of it before the bin is,
    // so the key learns no more than it did of the live row.
    const hiddenBinned = await client.deleteItem(bookmark.data.item.id);
    expect(hiddenBinned.ok, JSON.stringify(hiddenBinned.error)).toBe(true);
    hiddenDoor.trash("01a00000-0000-7000-8000-0000000000bb");
    await decide(
      "a create whose natural key resolves a row in the bin of a type its key may not read",
      { ...keyed, source_id: hidden, version: 0, properties: { title: "x" } },
      { same: ["error.code", "error.message"] },
      hiddenDoor,
      notesOnly,
    );
  });

  it("holds the scripted folder door's whole-properties edits, moves and lifecycle to the server's", async () => {
    // What a folder sends from a file's frontmatter (`folders.md` 7): its
    // whole properties from a versioned file, a retype, and a state.
    const door = new FolderDoor();
    const id = uuidv7();
    const created: DoorCreate = {
      id,
      type: "core.note",
      properties: {
        title: "whole",
        body: "b",
        status: "draft",
        language: "en",
      },
    };
    const made = await client.rawRequest("/items", {
      method: "POST",
      body: created,
    });
    expect(made.status, JSON.stringify(made.error)).toBe(201);
    trackItem(ctx, id);
    door.create(created);
    const both = async (
      name: string,
      path: string,
      method: "PATCH" | "POST",
      body: Record<string, unknown>,
      scripted: () => Answer,
      same: string[],
    ) => {
      const real = await client.rawRequest<Record<string, unknown>>(path, {
        method,
        body,
      });
      expectFidelity(
        name,
        { status: real.status, body: real.ok ? real.data : real.error },
        scripted(),
        { same, shape: ["item.id", "conflict_resolution.conflicted_copy_id"] },
      );
      const copy = at(real.data, "conflict_resolution.conflicted_copy_id");
      if (typeof copy === "string") trackItem(ctx, copy);
      return real.data;
    };
    const edit = (body: Parameters<FolderDoor["update"]>[1]) => ({
      path: `/items/${id}?conflict=auto`,
      body,
      scripted: () => door.update(id, body, { resolve: true }),
    });
    const whole = ["item.version", "item.properties", "item.type", "item.tier"];

    const current = edit({
      properties: { title: "whole", body: "b", language: "en" },
      properties_mode: "replace",
      version: 1,
    });
    await both(
      "whole properties at the version the row is at",
      current.path,
      "PATCH",
      current.body,
      current.scripted,
      whole,
    );
    const movedOn = edit({ properties: { title: "moved on" }, version: 2 });
    await both(
      "an edit moving the row on",
      movedOn.path,
      "PATCH",
      movedOn.body,
      movedOn.scripted,
      whole,
    );
    const stale = edit({
      properties: { title: "whole", body: "b2" },
      properties_mode: "replace",
      version: 2,
    });
    await both(
      "whole properties at a version since moved past, clearing a field nobody changed",
      stale.path,
      "PATCH",
      stale.body,
      stale.scripted,
      whole,
    );
    // Whole properties at a stale version leaving out a field another
    // writer changed since: a clear that collides, resolved by the policy.
    const resolved = [
      ...whole,
      "conflict_resolution.fields",
      "conflict_resolution.strategy",
    ];
    for (const [field, value, version, keep] of [
      ["title", "theirs", 4, { body: "b3" }],
      ["body", "theirs body", 6, { language: "en" }],
    ] as const) {
      const theirs = edit({ properties: { [field]: value }, version });
      await both(
        `another writer's ${field}`,
        theirs.path,
        "PATCH",
        theirs.body,
        theirs.scripted,
        whole,
      );
      const cleared = edit({
        properties: keep,
        properties_mode: "replace",
        version,
      });
      const answered = await both(
        `whole properties at a stale version clearing ${field}, which another writer changed`,
        cleared.path,
        "PATCH",
        cleared.body,
        cleared.scripted,
        resolved,
      );
      expect(
        at(answered, "conflict_resolution.fields"),
        "the clear did not collide, so no resolution was compared",
      ).toEqual([field]);
    }
    const retype = edit({
      properties: {},
      type: "core.bookmark",
      retype: true,
      version: 8,
    });
    await both(
      "a retype",
      retype.path,
      "PATCH",
      retype.body,
      retype.scripted,
      whole,
    );
    await both(
      "an archive",
      `/items/${id}/transition`,
      "POST",
      { state: "archived" },
      () => door.transition(id, "archived"),
      ["item.version", "item.state", "item.type"],
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
          id: seeded.id,
          version: 2,
          properties: { title: "winner", body: "winner" },
          tier: "library",
          occurred_at: "2026-01-01T00:00:00.000Z",
          source_id: null,
          type: "core.note",
        },
        {
          id: seeded.id,
          version: 1,
          properties: { title: "base", body: "base" },
          tier: "library",
          occurred_at: "2026-01-01T00:00:00.000Z",
          source_id: null,
          type: "core.note",
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
          "current.id",
          "current.type",
          "ancestor.id",
          "ancestor.type",
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
          id: seeded.id,
          version: 1,
          properties: { title: "base", body: "base" },
          tier: "library",
          occurred_at: "2026-01-01T00:00:00.000Z",
          source_id: null,
          type: "core.note",
        },
        0,
      ),
      {
        same: [
          "error.code",
          "error.status",
          "current.id",
          "current.type",
          "requested_version",
          "ancestor",
        ],
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
      {
        same: ["error.code"],
        shape: ["error.message"],
        // The grant the key lacks (`errors.md` 11). No device reads it yet;
        // the device change that holds a write a narrowed key refused models
        // it here when it starts to.
        absent: ["error.details"],
      },
    );

    // A hydration reads a pinned row this way, and keeps the pin over it.
    const note = await client.createItem({
      type: "core.note",
      source: ctx.source,
      properties: { body: "out of reach" },
    });
    expect(note.ok).toBe(true);
    trackItem(ctx, note.data.item.id);
    const unread = await narrowed.rawRequest(
      `/items/${note.data.item.id}?include=edges,metadata`,
    );
    expect(unread.status).toBe(404);
    expectFidelity(
      "a row of a type the key does not hold, read by id",
      { status: unread.status, body: unread.error },
      answers.itemNotFound(note.data.item.id),
      { same: ["error.code", "error.message"] },
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

    // An edit of the edge on the version it is at, and one on the version it
    // has since left: taken and moved on, then refused naming the edge as
    // it stands.
    const edgeId = String(at(linked.data, "edge.id"));
    const edgeAt = (version: number, properties: Record<string, unknown>) => ({
      id: edgeId,
      source_id: seeded.id,
      target_id: other.id,
      version,
      properties,
    });
    const edited = await client.rawRequest(`/edges/${edgeId}`, {
      method: "PATCH",
      body: { properties: { weight: 2 }, version: 1 },
    });
    expect(
      edited.ok,
      `the fixture could not edit the edge: ${JSON.stringify(edited.error)}`,
    ).toBe(true);
    expectFidelity(
      "an edge updated",
      { status: edited.status, body: edited.data },
      writeAnswers.edge(edgeAt(2, { weight: 2 }), 200),
      {
        same: [
          "edge.id",
          "edge.source_id",
          "edge.target_id",
          "edge.edge_type",
          "edge.properties",
          "edge.version",
        ],
        shape: ["edge.created_at", "edge.updated_at"],
      },
    );
    const staleEdge = await client.rawRequest(`/edges/${edgeId}`, {
      method: "PATCH",
      body: { properties: { weight: 3 }, version: 1 },
    });
    expect(
      staleEdge.status,
      "a stale edge edit was taken, so the refusal this case exists to compare was never produced",
    ).toBe(409);
    expectFidelity(
      "a stale edge update",
      { status: staleEdge.status, body: staleEdge.error },
      answers.edgeVersionConflict(wireEdge(edgeAt(2, { weight: 2 }))),
      {
        same: [
          "error.code",
          "error.status",
          "current.id",
          "current.version",
          "current.properties",
        ],
        shape: [
          "error.message",
          "current.source_id",
          "current.target_id",
          "current.edge_type",
          "current.created_at",
          "current.updated_at",
        ],
      },
    );

    // The same edge again, under the id it was made with: a repeat,
    // answered with the edge as it now stands.
    const repeatedEdge = await client.rawRequest(`/edges`, {
      method: "POST",
      body: {
        id: edgeId,
        source_id: seeded.id,
        target_id: other.id,
        edge_type: "references",
      },
    });
    expectFidelity(
      "an edge created again under its own id",
      {
        status: repeatedEdge.status,
        body: repeatedEdge.ok ? repeatedEdge.data : repeatedEdge.error,
      },
      writeAnswers.edgeRepeated(edgeAt(2, { weight: 2 })),
      {
        same: [
          "acknowledged",
          "edge.id",
          "edge.source_id",
          "edge.target_id",
          "edge.edge_type",
          "edge.properties",
          "edge.version",
        ],
        shape: ["edge.created_at", "edge.updated_at"],
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

    // A link is answered for bytes an item names (`blobs.md` 15), as a
    // device asks for one only for an item it holds.
    const naming = await client.createItem({
      type: "core.note",
      source: ctx.source,
      properties: { body: `![bytes](${uploaded.hash})` },
    });
    expect(naming.ok, JSON.stringify(naming.error)).toBe(true);
    trackItem(ctx, naming.data.item.id);

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

  it("matches the edge listing a hydration walks for a type held whole", async () => {
    const parent = await note({ title: "above", body: "above" });
    const child = await note({ title: "beneath", body: "beneath" });
    const linked = await client.rawRequest("/edges", {
      method: "POST",
      body: {
        source_id: parent.id,
        target_id: child.id,
        edge_type: "parent-of",
      },
    });
    expect(
      linked.ok,
      `the fixture could not put one item beneath another: ${JSON.stringify(linked.error)}`,
    ).toBe(true);
    const edgeId = String(at(linked.data, "edge.id"));

    // The query a hydration sends, so a key the server refuses is one the
    // device would meet too.
    const page = await client.rawRequest(
      "/edges?edge_type=parent-of&limit=200",
    );
    expect(page.ok, JSON.stringify(page.error)).toBe(true);
    const listed = (page.data as { data: { id: string }[] }).data;
    expect(
      listed.map((edge) => edge.id),
      "the listing left out the edge this case made, so the comparison below is against some other page",
    ).toContain(edgeId);

    expectFidelity(
      "the edge listing",
      { status: page.status, body: page.data },
      edgesPage([
        wireEdge({
          id: edgeId,
          source_id: parent.id,
          target_id: child.id,
          edge_type: "parent-of",
        }),
      ]),
      {
        same: ["next_cursor", "data.0.edge_type"],
        shape: [
          "data.0.id",
          "data.0.source_id",
          "data.0.target_id",
          "data.0.properties",
          "data.0.version",
          "data.0.created_at",
          "data.0.updated_at",
        ],
      },
    );
  });

  it("matches the refusal of a second placement of one item in one folder", async () => {
    const made = await client.rawRequest("/folders", {
      method: "POST",
      body: { title: "fidelity", search: { types: ["core.note"] } },
    });
    expect(
      made.ok,
      `the fixture could not make a folder: ${JSON.stringify(made.error)}`,
    ).toBe(true);
    const folderId = String(at(made.data, "item.id"));
    trackFolder(ctx, folderId);
    const placed = await note({ title: "placed", body: "placed" });
    const place = (path: string) =>
      client.rawRequest("/edges", {
        method: "POST",
        body: {
          source_id: placed.id,
          target_id: folderId,
          edge_type: "in-folder",
          properties: { path },
        },
      });
    const first = await place("placed.md");
    expect(first.ok, JSON.stringify(first.error)).toBe(true);
    const again = await place("elsewhere/placed.md");
    expect(
      again.status,
      "a second placement of one item in one folder was taken, so there is no refusal to compare",
    ).toBe(400);
    expectFidelity(
      "a second placement",
      { status: again.status, body: again.error },
      answers.edgeDuplicate({
        source_id: placed.id,
        target_id: folderId,
        edge_type: "in-folder",
      }),
      {
        same: [
          "error.code",
          "error.details.constraint",
          "error.details.source_id",
          "error.details.target_id",
          "error.details.edge_type",
        ],
        shape: ["error.message"],
      },
    );
  });

  it("matches the edge types a working copy holds and a folder reads its frontmatter lines by", async () => {
    const listed = await client.rawRequest("/edge-types");
    expect(listed.ok, JSON.stringify(listed.error)).toBe(true);
    const served = (
      listed.data as {
        data: Array<Record<string, unknown>>;
        next_cursor: unknown;
      }
    ).data;
    expect((listed.data as { next_cursor: unknown }).next_cursor).toBeNull();
    // Every field the device reads (`device.md` 47), the description apart:
    // it is prose the device passes through and nothing here asserts.
    const read = (row: Record<string, unknown> | WireEdgeType | undefined) => ({
      label: row?.label,
      cardinality: row?.cardinality,
      source_type_constraints: row?.source_type_constraints,
      target_type_constraints: row?.target_type_constraints,
      cascade_on_delete: row?.cascade_on_delete,
      property_schema: row?.property_schema,
      reverse_name: row?.reverse_name,
      written_at: row?.written_at,
      shipped: row?.shipped,
    });
    for (const scripted of SCRIPTED_EDGE_TYPES) {
      const real = served.find((row) => row.id === scripted.id);
      expect(
        real,
        `the server lists no ${scripted.id}, which the scripted catalog serves`,
      ).toBeDefined();
      expect(
        read(real),
        `the scripted ${scripted.id} and the server's disagree on a field the device reads`,
      ).toEqual(read(scripted));
    }
    const id = `fidelity-${uuidv7().slice(-12)}`;
    const registered = await client.rawRequest("/edge-types", {
      method: "POST",
      body: { id, cardinality: "many-to-many" },
    });
    expect(registered.ok, JSON.stringify(registered.error)).toBe(true);
    const again = await client.rawRequest("/edge-types");
    expect(again.ok, JSON.stringify(again.error)).toBe(true);
    const real = (
      again.data as { data: Array<Record<string, unknown>> }
    ).data.find((row) => row.id === id);
    expect(
      read(real),
      "an edge type the scripted catalog registers is not the one the server lists after the same registration",
    ).toEqual(read(edgeType(id)));
  });

  it("matches the name lookup a folder asks the server for a typed name", async () => {
    const name = `Lookup ${uuidv7()}`;
    const kept = await note({ title: name, body: "kept" });
    const shouting = await note({ title: name.toUpperCase(), body: "loud" });
    const archived = await client.rawRequest(
      `/items/${shouting.id}/transition`,
      { method: "POST", body: { state: "archived" } },
    );
    expect(archived.ok, JSON.stringify(archived.error)).toBe(true);
    const lookup = await client.rawRequest(
      `/items?filter=${encodeURIComponent(`properties.title contains "${name.toLowerCase()}"`)}&state=any&include=metadata&limit=200`,
    );
    expect(lookup.ok, JSON.stringify(lookup.error)).toBe(true);
    const ids = (lookup.data as { data: Array<{ item: { id: string } }> }).data
      .map((row) => row.item.id)
      .sort();
    expect(
      ids,
      "the lookup did not answer every item under the name whatever its case and state, so a folder would read one of two as the only one",
    ).toEqual([kept.id, shouting.id].sort());
    expectFidelity(
      "the name lookup",
      { status: lookup.status, body: lookup.data },
      itemsPage([{ item: wireItem({ id: kept.id }) }]),
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
          "data.0.item.source_id",
          "data.0.item.occurred_at",
          "data.0.item.created_at",
          "data.0.item.updated_at",
        ],
        // A listing that names no include hydrates no edges.
        absent: ["data.0.item.edges"],
      },
    );

    // The grammar escapes only a quote, so a closing backslash never closes.
    const unclosed = await client.rawRequest(
      `/items?filter=${encodeURIComponent('properties.title contains "Back\\"')}&state=any`,
    );
    expect(unclosed.status).toBe(400);
    expect(at(unclosed.error, "error.code")).toBe("validation_error");
  });

  it("matches the refusal of a second parent, a parent moved in one step, and each refusal of a move", async () => {
    const first = await note({ title: "first parent", body: "first" });
    const second = await note({ title: "second parent", body: "second" });
    const child = await note({ title: "moving child", body: "child" });
    const parent = (source: string) =>
      client.rawRequest("/edges", {
        method: "POST",
        body: {
          source_id: source,
          target_id: child.id,
          edge_type: "parent-of",
        },
      });
    const held = await parent(first.id);
    expect(held.ok, JSON.stringify(held.error)).toBe(true);
    const again = await parent(second.id);
    expect(
      again.status,
      "a second parent was taken, so there is no refusal to compare",
    ).toBe(400);
    expectFidelity(
      "a second parent",
      { status: again.status, body: again.error },
      answers.edgeCardinality({ target_id: child.id, edge_type: "parent-of" }),
      {
        same: [
          "error.code",
          "error.details.constraint",
          "error.details.target_id",
          "error.details.edge_type",
        ],
        shape: ["error.message"],
      },
    );

    // What a folder sends: the edge's other end moved, in one write.
    const edgeId = String(at(held.data, "edge.id"));
    const moved = await client.rawRequest(`/edges/${edgeId}`, {
      method: "PATCH",
      body: { source_id: second.id, version: 1 },
    });
    expect(moved.status, JSON.stringify(moved.error)).toBe(200);
    const movedEdge = {
      id: edgeId,
      source_id: second.id,
      target_id: child.id,
      edge_type: "parent-of",
      version: 2,
    };
    expectFidelity(
      "a parent moved",
      { status: moved.status, body: moved.data },
      writeAnswers.edge(movedEdge, 200),
      {
        same: [
          "edge.id",
          "edge.source_id",
          "edge.target_id",
          "edge.edge_type",
          "edge.version",
          "edge.properties",
        ],
        shape: ["edge.created_at", "edge.updated_at"],
      },
    );

    // Stale and naming the end its type holds many at: the version is judged first.
    const stale = await client.rawRequest(`/edges/${edgeId}`, {
      method: "PATCH",
      body: { target_id: first.id, version: 1 },
    });
    expect(
      stale.status,
      "a stale move was taken, so there is no refusal to compare",
    ).toBe(409);
    expectFidelity(
      "a stale move",
      { status: stale.status, body: stale.error },
      answers.edgeVersionConflict(wireEdge(movedEdge)),
      {
        same: [
          "error.code",
          "error.status",
          "current.id",
          "current.source_id",
          "current.target_id",
          "current.version",
        ],
        shape: [
          "error.message",
          "current.edge_type",
          "current.properties",
          "current.created_at",
          "current.updated_at",
        ],
      },
    );

    // A child's end holds one parent-of and a parent's many, so only the
    // parent moves.
    const wrongEnd = await client.rawRequest(`/edges/${edgeId}`, {
      method: "PATCH",
      body: { target_id: first.id, version: 2 },
    });
    expect(
      wrongEnd.status,
      "a move of the end its type holds many at was taken, so there is no refusal to compare",
    ).toBe(400);
    expectFidelity(
      "a move of the end that holds many",
      { status: wrongEnd.status, body: wrongEnd.error },
      answers.edgeMoveRefused("target_id", "none to replace"),
      {
        same: ["error.code", "error.details.errors.0.path"],
        shape: ["error.message", "error.details.errors.0.message"],
      },
    );

    const nothing = await client.rawRequest(`/edges/${edgeId}`, {
      method: "PATCH",
      body: { version: 2 },
    });
    expect(nothing.status, "an update changing nothing was taken").toBe(400);
    expectFidelity(
      "an update changing nothing",
      { status: nothing.status, body: nothing.error },
      answers.edgeChangesNothing(),
      { same: ["error.code", "error.message", "error.details.field"] },
    );

    const missing = uuidv7();
    const nowhere = await client.rawRequest(`/edges/${edgeId}`, {
      method: "PATCH",
      body: { source_id: missing, version: 2 },
    });
    expect(nowhere.status, "a move to no item was taken").toBe(404);
    expectFidelity(
      "a move to an item the server does not hold",
      { status: nowhere.status, body: nowhere.error },
      answers.edgeEndNotFound("source", missing),
      { same: ["error.code", "error.message"] },
    );

    // The stand-in the folder fixtures refuse a move with: a key that reads
    // `parent-of`, as a device holding the edge does, and does not write it.
    const minted = await client.createKey({
      label: "fidelity-no-parent-of",
      source: `${ctx.source}-fidelity-no-parent-of`,
      type_permissions: { "*": "write" },
      edge_permissions: { about: "write", "parent-of": "read" },
      permissions: [],
    });
    expect(minted.ok, JSON.stringify(minted.error)).toBe(true);
    trackKey(ctx, minted.data.id);
    const narrow = new MarfaClient({
      baseUrl: apiUrl,
      apiKey: minted.data.key,
    });
    const denied = await narrow.rawRequest(`/edges/${edgeId}`, {
      method: "PATCH",
      body: { source_id: first.id, version: 2 },
    });
    expect(denied.status, "a key without parent-of moved one").toBe(403);
    expectFidelity(
      "a move the edge type's gate refuses",
      { status: denied.status, body: denied.error },
      answers.edgePermissionDenied("parent-of"),
      {
        same: [
          "error.code",
          "error.message",
          "error.details.edge_type",
          "error.details.required",
        ],
        // The grant the key lacks (`errors.md` 11), for the reason the type
        // refusal above gives.
        absent: ["error.details.grant"],
      },
    );
  });

  it("matches the key a folder asks about when it is added", async () => {
    const current = await client.rawRequest("/keys/current");
    expect(current.ok, JSON.stringify(current.error)).toBe(true);
    expectFidelity(
      "the calling key",
      { status: current.status, body: current.data },
      answers.currentKey("fixture-key", { "*": "write" }),
      {
        shape: ["id", "is_operator", "edge_permissions"],
        // Grants differ by key, so each map is compared by its kind above,
        // and its entries are not.
        absent: [
          "type_permissions",
          "edge_permissions",
          "extension_permissions",
          "metadata_permissions",
          "profile_permissions",
          "permissions",
          "sources",
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
        same: [
          "row.id",
          "row.display_hints.title_field",
          "row.display_hints.body_field",
        ],
        // A type with no parent carries no `parent` at all. A scripted `null`
        // there is a shape the server never sends, and a device walking a
        // parent chain meets it on the first type it reads.
        shape: ["row.parent", "row.label", "row.fields"],
      },
    );
    // A folder writes a file's body and name to the properties these name
    // (`folders.md` 7), so the ones the fixtures lean on are held here.
    for (const id of ["core.event", "core.highlight", "core.bookmark"]) {
      expectFidelity(
        `the display hints of ${id}`,
        {
          status: registry.status,
          body: { row: rows.find((row) => row.id === id) },
        },
        {
          kind: "json",
          status: registry.status,
          body: { row: scriptedType(id) },
        },
        {
          same: [
            "row.id",
            "row.display_hints.title_field",
            "row.display_hints.body_field",
          ],
          shape: ["row.label", "row.fields"],
          // The deployment's field schema, not the protocol's, as for
          // `core.entity.person` below.
          absent: [
            "row.fields",
            "row.merge_policy",
            "row.description",
            "row.version",
            "row.required",
          ],
        },
      );
    }
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
        // for its parent, its title and body fields and the names it declares
        // (`device.md` 15, `folders.md` 7), so mirroring the schema would be
        // this file holding a copy of a seed that changes without it.
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

  it("reads a registered type and edge type from a working copy as the server answers them", async () => {
    const base = `user.base-${ctx.runId}`;
    const leaf = `user.leaf-${ctx.runId}`;
    const mentor = `mentor-${ctx.runId}`;
    for (const schema of [
      {
        id: base,
        label: "Base of a family",
        fields: { name: { type: "string", required: true } },
        display_hints: { title_field: "name" },
      },
      {
        id: leaf,
        parent: base,
        fields: {
          rating: { type: "number", description: "Out of five" },
          name: { type: "string", required: true },
        },
      },
    ]) {
      const registered = await client.registerType(
        schema as unknown as Parameters<typeof client.registerType>[0],
      );
      expect(registered.ok, JSON.stringify(registered.error)).toBe(true);
    }
    const registeredEdge = await client.rawRequest("/edge-types", {
      method: "POST",
      body: {
        id: mentor,
        cardinality: "one-to-many",
        reverse_name: `mentee-${ctx.runId}`,
        written_at: "target",
        property_schema: { since: { type: "string" } },
      },
    });
    expect(registeredEdge.ok, JSON.stringify(registeredEdge.error)).toBe(true);

    const device = new CliDevice({
      binary: requireBinary(),
      store: newStore("fidelity-catalog"),
      url: apiUrl,
      key: apiKey,
    });
    const hydrated = await device.hydrate([leaf], "library");
    expect(hydrated.ok, JSON.stringify(hydrated)).toBe(true);

    const served = await client.getType(leaf);
    expect(served.ok, JSON.stringify(served.error)).toBe(true);
    const resolved = served.data as unknown as Record<string, unknown> & {
      fields: Record<string, unknown>;
      display_hints?: { title_field?: string; body_field?: string };
    };
    const read = await device.itemType(leaf);
    expect(read.ok, JSON.stringify(read)).toBe(true);
    if (!read.ok) return;
    expect(
      {
        label: read.value.label,
        parent: read.value.parent,
        title_field: read.value.title_field,
        body_field: read.value.body_field,
        fields: Object.fromEntries(
          read.value.fields.map((field) => [field.name, field.definition]),
        ),
      },
      "the copy resolved the type's inheritance otherwise than the server's own read of it",
    ).toEqual({
      label: resolved.label ?? null,
      parent: resolved.parent ?? null,
      title_field: resolved.display_hints?.title_field ?? null,
      body_field: resolved.display_hints?.body_field ?? null,
      fields: resolved.fields,
    });
    expect(
      read.value.fields.map((field) => [field.name, field.declared_by]),
      "the copy did not say which type declares each field",
    ).toEqual([
      ["name", leaf],
      ["rating", leaf],
    ]);

    const listed = await client.rawRequest("/edge-types");
    expect(listed.ok, JSON.stringify(listed.error)).toBe(true);
    const row = (
      listed.data as { data: Array<Record<string, unknown>> }
    ).data.find((candidate) => candidate.id === mentor);
    const edge = await device.edgeType(mentor);
    expect(edge.ok, JSON.stringify(edge)).toBe(true);
    if (!edge.ok) return;
    expect(
      {
        label: edge.value.label,
        cardinality: edge.value.cardinality,
        reverse_name: edge.value.reverse_name,
        written_at: edge.value.written_at,
        source_type_constraints: edge.value.source_type_constraints,
        target_type_constraints: edge.value.target_type_constraints,
        cascade_on_delete: edge.value.cascade_on_delete,
        property_schema: Object.fromEntries(
          edge.value.properties.map((field) => [field.name, field.definition]),
        ),
        shipped: edge.value.shipped,
      },
      "the copy holds the registered edge type otherwise than the server lists it",
    ).toEqual({
      label: row?.label ?? null,
      cardinality: row?.cardinality,
      reverse_name: row?.reverse_name,
      written_at: row?.written_at,
      source_type_constraints: row?.source_type_constraints,
      target_type_constraints: row?.target_type_constraints,
      cascade_on_delete: row?.cascade_on_delete,
      property_schema: row?.property_schema,
      shipped: row?.shipped,
    });
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

  it("matches the marker that ends a replay whose rows were withheld", async (context) => {
    // A type filter withholds here in place of a credential, which the
    // server's marker treats the same (`events.md` 2).
    const marker = `fidelity-live-${ctx.runId}`;
    await note({ title: marker, body: marker });
    const frames = await withStream(
      apiUrl,
      apiKey,
      { lastEventId: "0", query: [["type", "core.bookmark"]] },
      async (stream) =>
        (
          await collectUntil(
            stream,
            (events) => events.some((event) => event.event === "stream_live"),
            "the marker that ends the replay",
            context.signal,
          )
        ).events,
    );
    const live = frames.find((event) => event.event === "stream_live")!;
    const head = frames.find((event) => event.event === "stream_cursor")!;
    expect(live.id, "the marker carries no id").toBeUndefined();
    const cursor = (live.data as { cursor?: unknown }).cursor;
    expect(typeof cursor).toBe("string");
    expect(
      BigInt(cursor as string) >=
        BigInt((head.data as { cursor: string }).cursor),
      "the marker's cursor fell short of the head it announced, so a device adopting it would read the withheld rows again",
    ).toBe(true);

    const scripted = liveReplay("1", []);
    const scriptedLive = (scripted.kind === "sse" ? scripted.frames : []).find(
      (frame) => frame.event === "stream_live",
    )!;
    expectFidelity(
      "the marker that ends a replay",
      { status: 200, body: live.data },
      { kind: "json", status: 200, body: scriptedLive.data },
      { same: ["type"], shape: ["cursor"] },
    );
  });
});

/**
 * The listing grammar a device answers from its copy (`device.md` 24 and
 * 36), held against the server that defines it. A device hydrates a slice of
 * one type the run registers, so the server's answer and the device's are
 * about the same four rows and no others, and each expression is asked of
 * both.
 */
describe("a local read answers the listing grammar as the server does", () => {
  it("answers each filter expression with the ids the server answers", async () => {
    const type = `user.filtered-${ctx.runId}`;
    const registered = await client.registerType({
      id: type,
      fields: {
        title: { type: "string" },
        status: { type: "string" },
        rating: { type: "number" },
        flag: { type: "boolean" },
        note: { type: "string" },
      },
      display_hints: { title_field: "title" },
    });
    expect(registered.ok, JSON.stringify(registered.error)).toBe(true);

    const seed = async (
      properties: Record<string, unknown>,
      tags: string[],
      edges?: Record<string, string[]>,
      sourceId?: string,
    ): Promise<string> => {
      const created = await client.createItem({
        type,
        source: ctx.source,
        properties,
        tags,
        ...(edges === undefined ? {} : { edges }),
        ...(sourceId === undefined ? {} : { source_id: sourceId }),
      });
      expect(
        created.ok,
        `the fixture could not seed a row: ${JSON.stringify(created.error)}`,
      ).toBe(true);
      trackItem(ctx, created.data.item.id);
      return created.data.item.id;
    };
    const grandchild = await seed(
      {
        title: "marsh grandchild",
        status: "open",
        flag: false,
        note: "a heron by the pond",
        t: 5,
      },
      ["birds", "garden"],
    );
    const stranger = await seed(
      {
        title: "marsh stranger",
        status: "open",
        rating: 9,
        flag: true,
        t: "5.0",
      },
      [],
      undefined,
      "5.0",
    );
    const child = await seed(
      {
        title: "marsh child",
        status: "closed",
        rating: 2,
        flag: true,
        t: "1.0",
      },
      ["birds"],
      { "parent-of": [grandchild], references: [stranger] },
      "5",
    );
    const root = await seed(
      { title: "marsh root", status: "open", rating: 5, t: 1 },
      ["garden"],
      { "parent-of": [child] },
    );
    // Text a numeric bound casts, text a REAL matches by affinity (source_id)
    // or never (`t`), and floats in a container JavaScript spells in full.
    const five = await seed({ title: "five", s: "5" }, [], undefined, "1.0");
    const ten = await seed({ title: "ten", s: "10" }, [], undefined, "1");
    const letters = await seed(
      { title: "letters", s: "abc", list: [1e20] },
      [],
    );
    const blank = await seed({ title: "blank", s: "", list: [0.0000015] }, []);
    const names = new Map([
      [root, "root"],
      [child, "child"],
      [grandchild, "grandchild"],
      [stranger, "stranger"],
      [five, "five"],
      [ten, "ten"],
      [letters, "letters"],
      [blank, "blank"],
    ]);
    const named = (ids: string[]): string[] =>
      ids.map((id) => names.get(id) ?? id).sort();

    const device = new CliDevice({
      binary: requireBinary(),
      store: newStore("fidelity-filter"),
      url: apiUrl,
      key: apiKey,
    });
    const hydrated = await device.hydrate([type], "library");
    expect(
      hydrated.ok,
      `the device could not hydrate from the server: ${JSON.stringify(hydrated)}`,
    ).toBe(true);

    const expressions = [
      'properties.status eq "open"',
      'properties.note contains "HERON"',
      'properties.status starts_with "clo"',
      "properties.rating gt 4",
      "properties.rating lte 5",
      "properties.rating not_exists",
      "properties.flag eq true",
      "properties.flag eq false",
      "properties.status eq null",
      'tags contains "birds"',
      "tags not_exists",
      `edge[parent-of] eq "${child}"`,
      `edge[parent-of] neq "${child}"`,
      "edge[references] exists",
      "edge[parent-of] not_exists",
      "properties.s gt 4",
      "source_id eq true",
      "properties.t eq 5",
      "properties.t eq true",
      'properties.list contains "100000000000000000000"',
      'properties.list contains "0.0000015"',
      `id eq "${stranger}"`,
      // The server binds every number as a REAL, which a text column reads
      // as `5.0`: this selects the row spelled that way, not the one
      // spelled `5`.
      "source_id eq 5",
      "version gte 1",
      'state eq "archived"',
      'properties.status eq "open" AND tags contains "garden"',
      'properties.status eq "closed" OR tags not_exists',
    ];
    const selective: string[] = [];
    for (const filter of expressions) {
      const served = await client.listItems({ type, filter, limit: 100 });
      expect(
        served.ok,
        `the server refused ${filter}: ${JSON.stringify(served.error)}`,
      ).toBe(true);
      const local = await device.list({ filter });
      expect(
        local.ok,
        `the device refused ${filter}, which the server answers: ${JSON.stringify(local)}`,
      ).toBe(true);
      const expected = named(served.data.data.map((item) => item.id));
      expect(
        named(local.ok ? local.value.map((item) => item.id) : []),
        `the device answers ${filter} with other rows than the server does`,
      ).toEqual(expected);
      if (expected.length > 0 && expected.length < names.size) {
        selective.push(filter);
      }
    }
    // The witness: agreement on expressions that select everything or
    // nothing would be agreement a device that ignored the filter, or
    // matched nothing, reaches too.
    expect(
      selective.length,
      "too few expressions select some rows and not others for the agreement above to mean anything",
    ).toBeGreaterThanOrEqual(expressions.length - 3);
    // And the rows that tell a cast, a REAL and a number's text apart.
    for (const [filter, rows] of [
      ["properties.s gt 4", ["five", "ten"]],
      ["source_id eq true", ["five"]],
      ["properties.t eq 5", ["grandchild"]],
      ["properties.t eq true", ["root"]],
      ['properties.list contains "100000000000000000000"', ["letters"]],
      ['properties.list contains "0.0000015"', ["blank"]],
    ] as const) {
      const served = await client.listItems({ type, filter, limit: 100 });
      expect(
        named(served.ok ? served.data.data.map((item) => item.id) : []),
        `the server answers ${filter} otherwise than this case assumes`,
      ).toEqual(rows);
    }

    for (const filter of [
      'properties.status eq "open"',
      `edge[parent-of] eq "${child}"`,
      'properties.status eq "closed" OR tags not_exists',
    ]) {
      const served = await client.search("marsh", { type, filter });
      expect(
        served.ok,
        `the server refused a search by ${filter}: ${JSON.stringify(served.error)}`,
      ).toBe(true);
      const local = await device.search("marsh", { filter });
      expect(local.ok).toBe(true);
      expect(
        named(local.ok ? local.value.map((hit) => hit.item.id) : []),
        `the device searches by ${filter} and answers other rows than the server does`,
      ).toEqual(named(served.data.data.map((hit) => hit.item.id)));
    }

    for (const filter of [
      'properties.meta.author eq "x"',
      'title eq "x"',
      "",
      Array.from({ length: 11 }, () => "tags exists").join(" AND "),
      `properties.title eq "${"x".repeat(2049 - 'properties.title eq ""'.length)}"`,
      `properties.rating gt 1${"0".repeat(400)}`,
    ]) {
      const served = await client.listItems({ type, filter });
      expect(served.status, `the server answered ${filter} with no 400`).toBe(
        400,
      );
      const local = await device.list({ filter });
      expect(local.ok, `the device accepted ${filter}`).toBe(false);
      if (local.ok) continue;
      // The binary's class is its own closed set; the code beside it is the
      // one the server answers with, and that is what has to agree.
      const envelope = JSON.parse(local.refusal.raw) as {
        error: { server: { code: string | null } | null };
      };
      expect(
        envelope.error.server?.code,
        `the device refuses ${filter} otherwise than the server does`,
      ).toBe(served.error?.error.code);
    }
  });

  it("answers from the copy an edge term the server refuses to a key that may not read its type", async () => {
    const type = `user.edge-unread-${ctx.runId}`;
    const registered = await client.registerType({
      id: type,
      fields: { title: { type: "string" } },
      display_hints: { title_field: "title" },
    });
    expect(registered.ok, JSON.stringify(registered.error)).toBe(true);
    const seed = async (
      title: string,
      edges?: Record<string, string[]>,
    ): Promise<string> => {
      const created = await client.createItem({
        type,
        source: ctx.source,
        properties: { title },
        ...(edges === undefined ? {} : { edges }),
      });
      expect(created.ok, JSON.stringify(created.error)).toBe(true);
      trackItem(ctx, created.data.item.id);
      return created.data.item.id;
    };
    const target = await seed("target");
    const linked = await seed("linked", { references: [target] });

    // The key reads the type and `parent-of`, not `references`.
    const minted = await client.createKey({
      label: `${ctx.source}-edge-unread`,
      source: `${ctx.source}-edge-unread`,
      type_permissions: { [type]: "read" },
      edge_permissions: { "parent-of": "read" },
    });
    expect(minted.ok, JSON.stringify(minted.error)).toBe(true);
    trackKey(ctx, minted.data.id);
    const narrow = new MarfaClient({
      baseUrl: apiUrl,
      apiKey: minted.data.key,
    });

    // The witnesses: the edge is there, and the key's listing answers a term
    // naming an edge type it may read.
    const drawn = await client.listItems({
      type,
      filter: "edge[references] exists",
    });
    expect(drawn.ok && drawn.data.data.map((item) => item.id)).toEqual([
      linked,
    ]);
    const readable = await narrow.listItems({
      type,
      filter: "edge[parent-of] not_exists",
    });
    expect(readable.status).toBe(200);
    const refused = await narrow.listItems({
      type,
      filter: "edge[references] not_exists",
    });
    expect(
      [refused.status, refused.error?.error.code],
      "the server answered a term naming an edge type the key may not read",
    ).toEqual([403, "edge_permission_denied"]);

    // The device keeps nothing of the key's edge permissions, and holds no
    // edge of that type, so it answers the term from what it holds.
    const device = new CliDevice({
      binary: requireBinary(),
      store: newStore("fidelity-edge-unread"),
      url: apiUrl,
      key: minted.data.key,
    });
    const hydrated = await device.hydrate([type], "library");
    expect(hydrated.ok, JSON.stringify(hydrated)).toBe(true);
    const absent = await device.list({ filter: "edge[references] not_exists" });
    expect(
      absent.ok ? absent.value.map((item) => item.id).sort() : absent,
    ).toEqual([linked, target].sort());
    const present = await device.list({ filter: "edge[references] exists" });
    expect(present.ok ? present.value : present).toEqual([]);
    const other = await device.list({
      filter: `edge[references] neq "${target}"`,
    });
    expect(
      other.ok ? other.value.map((item) => item.id).sort() : other,
    ).toEqual([linked, target].sort());
    const to = await device.list({ filter: `edge[references] eq "${target}"` });
    expect(to.ok ? to.value : to).toEqual([]);
  });

  it("answers an edge term naming a target the key cannot read as the server does", async () => {
    const type = `user.edge-hidden-target-${ctx.runId}`;
    const hiddenType = `user.edge-hidden-kept-${ctx.runId}`;
    for (const id of [type, hiddenType]) {
      const registered = await client.registerType({
        id,
        fields: { title: { type: "string" } },
        display_hints: { title_field: "title" },
      });
      expect(registered.ok, JSON.stringify(registered.error)).toBe(true);
    }
    const seed = async (
      of: string,
      title: string,
      edges?: Record<string, string[]>,
    ): Promise<string> => {
      const created = await client.createItem({
        type: of,
        source: ctx.source,
        properties: { title },
        ...(edges === undefined ? {} : { edges }),
      });
      expect(created.ok, JSON.stringify(created.error)).toBe(true);
      trackItem(ctx, created.data.item.id);
      return created.data.item.id;
    };
    const kept = await seed(hiddenType, "kept");
    const pointer = await seed(type, "pointer", { references: [kept] });
    const bystander = await seed(type, "bystander");

    const minted = await client.createKey({
      label: `${ctx.source}-edge-hidden-target`,
      source: `${ctx.source}-edge-hidden-target`,
      type_permissions: { [type]: "read" },
      edge_permissions: { "*": "read" },
    });
    expect(minted.ok, JSON.stringify(minted.error)).toBe(true);
    trackKey(ctx, minted.data.id);
    const narrow = new MarfaClient({
      baseUrl: apiUrl,
      apiKey: minted.data.key,
    });
    // The witness that the target is hidden from this key.
    expect((await narrow.getItem(kept)).status).toBe(404);

    const device = new CliDevice({
      binary: requireBinary(),
      store: newStore("fidelity-edge-hidden-target"),
      url: apiUrl,
      key: minted.data.key,
    });
    const hydrated = await device.hydrate([type], "library");
    expect(hydrated.ok, JSON.stringify(hydrated)).toBe(true);
    for (const filter of [
      `edge[references] eq "${kept}"`,
      `edge[references] neq "${kept}"`,
      "edge[references] exists",
    ]) {
      const served = await narrow.listItems({ type, filter, limit: 100 });
      expect(served.ok, JSON.stringify(served.error)).toBe(true);
      const local = await device.list({ filter });
      expect(local.ok, JSON.stringify(local)).toBe(true);
      expect(
        (local.ok ? local.value.map((item) => item.id) : []).sort(),
        `the device answers ${filter} with other rows than the server does`,
      ).toEqual(served.data.data.map((item) => item.id).sort());
    }
    const to = await narrow.listItems({
      type,
      filter: `edge[references] eq "${kept}"`,
    });
    expect(to.data.data.map((item) => item.id)).toEqual([pointer]);
    expect(bystander).not.toBe(pointer);
  });
});
