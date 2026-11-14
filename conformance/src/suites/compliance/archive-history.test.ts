import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { v7 as uuidv7 } from "uuid";
import { MarfaClient } from "../../client/api.js";
import type {
  MarfaItem,
  MarfaVersion,
  TestContext,
} from "../../client/types.js";
import {
  archiveLines,
  carriedFiles,
  editLineFile,
  itemFields,
  itemsArchive,
  listEntries,
  ndjson,
  notCarried,
} from "../../utils/archive.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  stopFreshServers,
  type FreshServer,
} from "../../utils/fresh-server.js";
import {
  cleanup,
  createTestContext,
  getOwnerClient,
  trackItem,
  trackKey,
} from "../../utils/setup.js";

/**
 * What an archive does with an item's history: the snapshots an export carries
 * and the restore that writes them back. The items that must be refused are
 * built by hand, because no export writes a snapshot whose date is no date.
 */
let client: MarfaClient;
let ownerClient: MarfaClient;
let ctx: TestContext;
let apiUrl: string;
/** A server that has never seen the items, to restore into. */
let fresh: FreshServer | undefined;
let freshOwner: MarfaClient;
let freshReader: MarfaClient;

beforeAll(async () => {
  ({ client, ctx, apiUrl } = await createTestContext(
    "compliance",
    "archive-history",
  ));
  ownerClient = getOwnerClient();
  fresh = await bootFreshServer("archive-history");
  freshOwner = new MarfaClient({
    baseUrl: fresh.apiUrl,
    apiKey: "",
    controlSocket: fresh.controlSocket,
  });
  freshReader = new MarfaClient({
    baseUrl: fresh.apiUrl,
    apiKey: fresh.workingKey,
  });
}, FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  await stopFreshServers();
  await cleanup(ctx);
}, FRESH_SERVER_TIMEOUT_MS);

interface ArchivedLine {
  item: MarfaItem;
  metadata: { tags: string[]; extensions: Record<string, unknown> };
}

function itemLines(archive: Uint8Array): ArchivedLine[] {
  return archiveLines<ArchivedLine>(archive, "items");
}

/** The earlier versions of `itemId` an archive carries on their own lines. */
function versionLines(archive: Uint8Array, itemId: string): MarfaVersion[] {
  return archiveLines<MarfaVersion>(archive, "versions").filter(
    (line) => line.item_id === itemId,
  );
}

/** The archive with the `name` line file rewritten by `change`, and nothing else. */
function withLines(
  archive: Uint8Array,
  name: "items" | "versions",
  change: (lines: Record<string, unknown>[]) => Record<string, unknown>[],
): Uint8Array {
  return editLineFile(archive, name, (text) =>
    change(
      text
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => JSON.parse(line) as Record<string, unknown>),
    )
      .map((line) => `${JSON.stringify(line)}\n`)
      .join(""),
  );
}

async function allVersions(
  reader: MarfaClient,
  id: string,
): Promise<MarfaVersion[]> {
  const all: MarfaVersion[] = [];
  let cursor: string | undefined;
  do {
    const page = await reader.getVersions(id, { limit: 100, cursor });
    expect(page.status, JSON.stringify(page.error)).toBe(200);
    all.push(...page.data.data);
    cursor = page.data.next_cursor ?? undefined;
  } while (cursor);
  return all;
}

async function note(
  properties: Record<string, unknown> = { body: "first" },
  extra: { source_id?: string; tier?: "library" | "feed" } = {},
): Promise<MarfaItem> {
  const made = await client.createItem({
    type: "core.note",
    source: ctx.source,
    properties,
    ...extra,
  });
  expect(made.ok, JSON.stringify(made.error)).toBe(true);
  trackItem(ctx, made.data.item.id);
  return made.data.item;
}

async function patch(
  id: string,
  changes: Omit<Parameters<MarfaClient["updateItem"]>[1], "version">,
): Promise<MarfaItem> {
  const read = await client.getItem(id);
  const patched = await client.updateItem(id, {
    ...changes,
    version: read.data.item.version,
  });
  expect(patched.ok, JSON.stringify(patched.error)).toBe(true);
  return patched.data.item;
}

describe("the history an archive carries", () => {
  it("carries every stored snapshot below an item's version, across more than one page of history", async () => {
    // A page of history is 200 snapshots, so 201 writes leave one on a second.
    const item = await note();
    let current = item;
    for (let write = 0; write < 201; write++) {
      const patched = await client.updateItem(item.id, {
        properties: { body: `write ${String(write)}` },
        version: current.version,
      });
      expect(patched.ok, JSON.stringify(patched.error)).toBe(true);
      current = patched.data.item;
    }
    expect(current.version).toBe(202);

    const archive = await client.exportArchive({ source: ctx.source });
    expect(archive.status).toBe(200);
    const line = itemLines(archive.data).find((l) => l.item.id === item.id);
    expect(line?.item.version).toBe(202);
    const carried = versionLines(archive.data, item.id);
    expect(carried).toHaveLength(201);
    expect(carried.map((v) => v.version).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 201 }, (_, i) => i + 1),
    );
    // The snapshots the server lists are the ones the archive carries.
    const listed = await allVersions(client, item.id);
    expect(listed).toHaveLength(201);
    expect(carried.map((v) => v.id).sort()).toEqual(
      listed.map((v) => v.id).sort(),
    );
  }, 120_000);

  it("puts each snapshot on its own line of versions.ndjson.gz, in the order of its item and then of its version", async () => {
    const made = [await note(), await note(), await note()];
    for (const item of made) {
      await patch(item.id, { properties: { body: "second" } });
      await patch(item.id, { properties: { body: "third" } });
    }

    const archive = await client.exportArchive({ source: ctx.source });
    expect(archive.status).toBe(200);
    const ours = new Set(made.map((item) => item.id));
    const order = itemLines(archive.data)
      .map((line) => line.item.id)
      .filter((id) => ours.has(id));
    expect([...order].sort()).toEqual([...ours].sort());
    for (const line of archiveLines(archive.data, "items")) {
      expect(line).not.toHaveProperty("versions");
    }
    const carried = archiveLines<MarfaVersion>(archive.data, "versions")
      .filter((line) => ours.has(line.item_id))
      .map((line) => `${line.item_id}/${String(line.version)}`);
    expect(carried).toEqual(order.flatMap((id) => [`${id}/1`, `${id}/2`]));
  });

  it("carries only the snapshots the exporting key may read under the type each had", async () => {
    // A bookmark that became a note: its first snapshot is a bookmark's.
    const made = await client.createItem({
      type: "core.bookmark",
      source: ctx.source,
      properties: { url: "https://example.com/history", title: "a bookmark" },
    });
    expect(made.ok, JSON.stringify(made.error)).toBe(true);
    const id = made.data.item.id;
    trackItem(ctx, id);
    const retyped = await client.updateItem(id, {
      type: "core.note",
      retype: true,
      properties: { body: "now a note" },
      properties_mode: "replace",
      version: made.data.item.version,
    });
    expect(retyped.ok, JSON.stringify(retyped.error)).toBe(true);

    const minted = await client.createKey({
      label: "history-reads-notes",
      source: `${ctx.source}-notes-reader`,
      permissions: [],
      type_permissions: { "core.note": "read" },
    });
    expect(minted.ok, JSON.stringify(minted.error)).toBe(true);
    trackKey(ctx, minted.data.id);
    const noteReader = new MarfaClient({
      baseUrl: apiUrl,
      apiKey: minted.data.key,
    });

    const versionsFor = async (reader: MarfaClient) => {
      const archive = await reader.exportArchive({ source: ctx.source });
      expect(archive.status).toBe(200);
      const line = itemLines(archive.data).find((l) => l.item.id === id);
      expect(line, "the item is carried").toBeDefined();
      return versionLines(archive.data, id).map((v) => v.type);
    };
    // The witness: a key that may read both types is carried the snapshot.
    expect(await versionsFor(client)).toEqual(["core.bookmark"]);
    expect(await versionsFor(noteReader)).toEqual([]);
  });

  it("carries the bytes only a snapshot names when the exporting key could read them through the blob doors, and names as not carried only a file's it could not", async () => {
    const stranger = await client.createKey({
      label: "history-other-uploader",
      source: `${ctx.source}-other-uploader`,
      permissions: [],
      type_permissions: { "*": "write" },
    });
    expect(stranger.ok, JSON.stringify(stranger.error)).toBe(true);
    trackKey(ctx, stranger.data.id);
    const other = new MarfaClient({
      baseUrl: apiUrl,
      apiKey: stranger.data.key,
    });

    const readable = new Uint8Array(Buffer.from(`readable ${ctx.runId}`));
    const hidden = new Uint8Array(Buffer.from(`hidden ${ctx.runId}`));
    const up = await client.uploadBlob(readable, "text/plain");
    const upHidden = await other.uploadBlob(hidden, "text/plain");
    expect(up.status, JSON.stringify(up.error)).toBe(201);
    expect(upHidden.status, JSON.stringify(upHidden.error)).toBe(201);
    // An item naming the first lends it to the key that wrote the item.
    const lender = await client.createItem({
      type: "core.file",
      source: ctx.source,
      properties: { blob_ref: up.data.hash, mime_type: "text/plain" },
    });
    expect(lender.ok, JSON.stringify(lender.error)).toBe(true);
    trackItem(ctx, lender.data.item.id);
    expect((await client.downloadBlob(up.data.hash)).status).toBe(200);
    expect((await client.downloadBlob(upHidden.data.hash)).status).toBe(404);

    // Both digests are in the first snapshot and in no current item.
    const item = await note({
      body: `${up.data.hash} ${upHidden.data.hash}`,
    });
    await patch(item.id, {
      properties: { body: "named nothing" },
      properties_mode: "replace",
    });

    // A file whose first version names bytes the key sent and whose current
    // version names others, so only the snapshot names the first.
    const earlier = await client.uploadBlob(
      new Uint8Array(Buffer.from(`earlier file ${ctx.runId}`)),
      "text/plain",
    );
    const current = await client.uploadBlob(
      new Uint8Array(Buffer.from(`current file ${ctx.runId}`)),
      "text/plain",
    );
    expect(earlier.status, JSON.stringify(earlier.error)).toBe(201);
    expect(current.status, JSON.stringify(current.error)).toBe(201);
    const file = await client.createItem({
      type: "core.file",
      source: ctx.source,
      properties: { blob_ref: earlier.data.hash, mime_type: "text/plain" },
    });
    expect(file.ok, JSON.stringify(file.error)).toBe(true);
    trackItem(ctx, file.data.item.id);
    await patch(file.data.item.id, {
      properties: { blob_ref: current.data.hash, mime_type: "text/plain" },
    });
    expect((await client.downloadBlob(earlier.data.hash)).status).toBe(404);

    const archive = await client.exportArchive({ source: ctx.source });
    expect(archive.status).toBe(200);
    const carried = listEntries(archive.data)
      .filter((e) => e.name.startsWith("blobs/"))
      .map((e) => e.name);
    expect(carried).toContain(`blobs/${up.data.hash}`);
    expect(carried).not.toContain(`blobs/${upHidden.data.hash}`);
    expect(carried).toContain(`blobs/${current.data.hash}`);
    expect(carried).not.toContain(`blobs/${earlier.data.hash}`);
    const listed = Object.keys(carriedFiles(archive.data));
    expect(listed).toContain(up.data.hash);
    expect(listed).not.toContain(upHidden.data.hash);
    expect(listed).not.toContain(earlier.data.hash);
    // The file's earlier blob is named with nothing of its record, and the
    // note's, which only the instance's record makes a blob, is not named.
    expect(notCarried(archive.data)).toEqual({
      [earlier.data.hash]: { mime_type: null, size_bytes: null },
    });
  });
});

describe("the history a restore writes", () => {
  it("restores each snapshot field for field into an instance that has never seen the item", async () => {
    // Snapshots that differ in every field a snapshot records.
    const item = await note(
      { title: "first", body: "one" },
      { source_id: `history-one-${ctx.runId}` },
    );
    await patch(item.id, {
      properties: { body: "two" },
      source_id: `history-two-${ctx.runId}`,
      tier: "feed",
      occurred_at: "2031-05-06T07:08:09.000Z",
    });
    await patch(item.id, {
      type: "core.bookmark",
      retype: true,
      properties: { url: "https://example.com/three", title: "three" },
      properties_mode: "replace",
    });
    await patch(item.id, { properties: { title: "four" } });

    const before = await client.getItem(item.id);
    const history = await allVersions(client, item.id);
    expect(history.map((v) => v.version)).toEqual([1, 2, 3]);
    expect(new Set(history.map((v) => v.type))).toEqual(
      new Set(["core.note", "core.bookmark"]),
    );

    const archive = await client.exportArchive({ source: ctx.source });
    const restored = await freshOwner.restoreArchive(archive.data);
    expect(restored.ok, JSON.stringify(restored.error)).toBe(true);
    expect(restored.data.imported).toBeGreaterThanOrEqual(1);

    expect((await freshReader.getItem(item.id)).data.item).toEqual(
      before.data.item,
    );
    expect(await allVersions(freshReader, item.id)).toEqual(history);
  });

  it("restores a snapshot the type's current shape would refuse, as it was", async () => {
    const typeId = `user.historyshape${ctx.runId}`;
    const registered = await client.registerType({
      id: typeId,
      fields: { label: { type: "string" } },
    });
    expect(registered.ok, JSON.stringify(registered.error)).toBe(true);
    const made = await client.createItem({
      type: typeId,
      source: ctx.source,
      properties: { label: "kept as written" },
    });
    expect(made.ok, JSON.stringify(made.error)).toBe(true);
    trackItem(ctx, made.data.item.id);

    // A requirement the first snapshot does not meet, added while the item
    // is at its second version.
    const replaced = await client.replaceType(typeId, {
      id: typeId,
      version: 2,
      fields: {
        label: { type: "string" },
        owner: { type: "string", required: true },
      },
    });
    expect(replaced.status, JSON.stringify(replaced.error)).toBe(200);
    const second = await client.updateItem(made.data.item.id, {
      properties: { owner: "someone" },
      version: made.data.item.version,
    });
    expect(second.ok, JSON.stringify(second.error)).toBe(true);
    const history = await allVersions(client, made.data.item.id);
    expect(history[0]?.properties).toEqual({ label: "kept as written" });

    const archive = await client.exportArchive({ source: ctx.source });
    const restored = await freshOwner.restoreArchive(archive.data);
    expect(restored.ok, JSON.stringify(restored.error)).toBe(true);
    expect(await allVersions(freshReader, made.data.item.id)).toEqual(history);
  });

  it("leaves an existing item, its tags, its extensions and its history alone when the archive's copy is a duplicate", async () => {
    const item = await note({ body: "as archived" });
    expect((await client.addTags(item.id, ["archived-tag"])).ok).toBe(true);
    expect(
      (await client.setItemExtension(item.id, `history.${ctx.runId}`, { a: 1 }))
        .ok,
    ).toBe(true);
    await patch(item.id, { properties: { body: "second" } });
    const archive = await client.exportArchive({ source: ctx.source });

    // The item moves on after the archive was taken.
    await patch(item.id, { properties: { body: "third" } });
    expect((await client.addTags(item.id, ["later-tag"])).ok).toBe(true);
    expect(
      (await client.setItemExtension(item.id, `history.${ctx.runId}`, { a: 2 }))
        .ok,
    ).toBe(true);
    const row = await client.getItem(item.id);
    const history = await allVersions(client, item.id);
    expect(history).toHaveLength(2);

    const restored = await ownerClient.restoreArchive(archive.data);
    expect(restored.ok, JSON.stringify(restored.error)).toBe(true);
    expect(restored.data.duplicates).toBeGreaterThanOrEqual(1);
    const after = await client.getItem(item.id);
    expect(after.data).toEqual(row.data);
    expect(await allVersions(client, item.id)).toEqual(history);
  });
});

/** A snapshot of `itemId` at `version`, valid in every field. */
function snapshot(
  itemId: string,
  version: number,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: uuidv7(),
    item_id: itemId,
    version,
    properties: { body: `snapshot ${String(version)}` },
    type: "core.note",
    tier: "library",
    occurred_at: "2030-01-01T00:00:00.000Z",
    source_id: null,
    created_at: "2030-01-01T00:00:00.000Z",
    ...extra,
  };
}

/**
 * One archive of two items, the second at version 3, and their earlier
 * versions on lines of their own: the first's, then the second's.
 */
interface Rows {
  first: Record<string, unknown>;
  second: Record<string, unknown>;
  firstVersions: Record<string, unknown>[];
  secondVersions: Record<string, unknown>[];
}

function twoRows(edit: (rows: Rows) => void): {
  archive: Uint8Array;
  first: string;
  second: string;
} {
  const first = uuidv7();
  const second = uuidv7();
  const rows = {
    first: {
      ...itemFields(),
      id: first,
      type: "core.note",
      source: ctx.source,
      version: 2,
      properties: { body: "a valid item ahead of the other" },
    } as Record<string, unknown>,
    second: {
      ...itemFields(),
      id: second,
      type: "core.note",
      source: ctx.source,
      version: 3,
      properties: { body: "the item under test" },
    } as Record<string, unknown>,
    firstVersions: [snapshot(first, 1)],
    secondVersions: [snapshot(second, 1), snapshot(second, 2)],
  };
  edit(rows);
  const base = itemsArchive([
    {
      id: first,
      type: "core.note",
      source: ctx.source,
      properties: { body: "a placeholder the items replace" },
    },
  ]);
  const items = editLineFile(base, "items", () =>
    ndjson(
      [rows.first, rows.second].map((item) => ({
        item,
        metadata: { tags: [], extensions: {} },
      })),
    ),
  );
  const archive = editLineFile(items, "versions", () =>
    ndjson([...rows.firstVersions, ...rows.secondVersions]),
  );
  return { archive, first, second };
}

describe("an archive's dates and history, refused before anything is written", () => {
  const invalidInstant = "not-a-date";
  /**
   * A case's label, the text its refusal holds, whether that refusal names
   * the second item, and the damage done.
   */
  const cases: [string, string, boolean, (rows: Rows) => void][] = [];
  const add = (
    label: string,
    names: string,
    edit: (rows: Rows) => void,
    namesSecond = true,
  ) => cases.push([label, names, namesSecond, edit]);
  const field = (path: string, edit: (rows: Rows) => void) =>
    add(path, path, edit);

  field("created_at", ({ second }) => {
    second.created_at = invalidInstant;
  });
  field("updated_at", ({ second }) => {
    second.updated_at = invalidInstant;
  });
  field("last_activity_at", ({ second }) => {
    second.last_activity_at = invalidInstant;
  });
  add(
    "version line that is no object",
    "versions.ndjson.gz must be an object",
    ({ secondVersions }) => {
      secondVersions[0] = 5 as never;
    },
    false,
  );
  field("versions.1.id", ({ secondVersions }) => {
    secondVersions[0]!.id = "not an id";
  });
  add(
    "versions.2.id repeating one of the same item",
    "which another version in the archive has",
    ({ secondVersions }) => {
      secondVersions[1]!.id = secondVersions[0]!.id;
    },
  );
  add(
    "versions.1.id repeating one of another item",
    "which another version in the archive has",
    ({ firstVersions, secondVersions }) => {
      secondVersions[0]!.id = firstVersions[0]!.id;
    },
  );
  add(
    "version line naming an item the archive does not hold",
    "which the archive does not hold",
    ({ secondVersions }) => {
      secondVersions[0]!.item_id = uuidv7();
    },
    false,
  );
  add(
    "version at 0",
    "version must be a whole number",
    ({ secondVersions }) => {
      secondVersions[0]!.version = 0;
    },
  );
  add(
    "version fractional",
    "version must be a whole number",
    ({ secondVersions }) => {
      secondVersions[0]!.version = 1.5;
    },
  );
  add(
    "version equal to the item's",
    "is not below the version of item",
    ({ secondVersions }) => {
      secondVersions[1]!.version = 3;
    },
  );
  add(
    "version repeating one of the same item",
    "does not come after the line before it",
    ({ secondVersions }) => {
      secondVersions[1]!.version = 1;
    },
  );
  add(
    "versions out of their order",
    "does not come after the line before it",
    (rows) => {
      rows.secondVersions.reverse();
    },
  );
  add(
    "versions ahead of an earlier item's",
    "does not come after the line before it",
    (rows) => {
      [rows.firstVersions, rows.secondVersions] = [
        rows.secondVersions,
        rows.firstVersions,
      ];
    },
    false,
  );
  field("versions.1.properties", ({ secondVersions }) => {
    secondVersions[0]!.properties = "text";
  });
  field("versions.1.type", ({ secondVersions }) => {
    secondVersions[0]!.type = "Not A Type";
  });
  field("versions.1.tier", ({ secondVersions }) => {
    secondVersions[0]!.tier = "other";
  });
  field("versions.1.occurred_at", ({ secondVersions }) => {
    secondVersions[0]!.occurred_at = invalidInstant;
  });
  field("versions.1.created_at", ({ secondVersions }) => {
    secondVersions[0]!.created_at = invalidInstant;
  });
  field("versions.1.source_id", ({ secondVersions }) => {
    secondVersions[0]!.source_id = 5;
  });

  it.each(cases)(
    "refuses an archive whose %s is malformed, and writes the item ahead of it nowhere",
    async (_label, names, namesSecond, edit) => {
      const bad = twoRows(edit);
      const refused = await ownerClient.restoreArchive(bad.archive);
      expect(refused.status, JSON.stringify(refused.error)).toBe(400);
      expect(refused.error?.error.code).toBe("validation_error");
      if (namesSecond) {
        expect(refused.error?.error.message).toContain(bad.second);
      }
      expect(refused.error?.error.message).toContain(names);
      expect((await client.getItem(bad.first)).status).toBe(404);
      expect((await client.getItem(bad.second)).status).toBe(404);

      // The witness: the same two items with nothing malformed restore.
      const good = twoRows(() => undefined);
      const accepted = await ownerClient.restoreArchive(good.archive);
      expect(accepted.ok, JSON.stringify(accepted.error)).toBe(true);
      expect(accepted.data.imported).toBe(2);
      trackItem(ctx, good.first);
      trackItem(ctx, good.second);
    },
  );

  it("refuses a malformed date or history even when the item is one the instance already holds", async () => {
    const good = twoRows(() => undefined);
    const accepted = await ownerClient.restoreArchive(good.archive);
    expect(accepted.ok, JSON.stringify(accepted.error)).toBe(true);
    trackItem(ctx, good.first);
    trackItem(ctx, good.second);
    // Both items exist now, so each would be counted a duplicate.
    const again = await ownerClient.restoreArchive(good.archive);
    expect(again.ok, JSON.stringify(again.error)).toBe(true);
    expect(again.data).toMatchObject({ imported: 0, duplicates: 2 });

    const damages: [
      "items" | "versions",
      (line: Record<string, unknown>) => void,
    ][] = [
      [
        "items",
        (line) => {
          (line.item as Record<string, unknown>).created_at = invalidInstant;
        },
      ],
      [
        "versions",
        (line) => {
          line.tier = "other";
        },
      ],
    ];
    for (const [name, damage] of damages) {
      const refused = await ownerClient.restoreArchive(
        withLines(good.archive, name, (lines) => {
          damage(lines[1]!);
          return lines;
        }),
      );
      expect(refused.status).toBe(400);
      expect(refused.error?.error.code).toBe("validation_error");
    }
  });

  it("refuses an edge whose date is malformed even when an endpoint is missing", async () => {
    const first = uuidv7();
    const missing = uuidv7();
    const edge = (extra: Record<string, unknown>) => ({
      id: uuidv7(),
      source_id: first,
      target_id: missing,
      edge_type: "references",
      ...extra,
    });
    const archive = (extra: Record<string, unknown>) => {
      const base = itemsArchive([
        {
          id: first,
          type: "core.note",
          source: ctx.source,
          properties: { body: "ahead of an edge" },
        },
      ]);
      return editLineFile(
        base,
        "edges",
        () => `${JSON.stringify({ edge: edge(extra) })}\n`,
      );
    };

    // The witness: with readable dates the edge is skipped for its missing
    // endpoint, and the item ahead of it is written.
    const skipped = await ownerClient.restoreArchive(archive({}));
    expect(skipped.ok, JSON.stringify(skipped.error)).toBe(true);
    trackItem(ctx, first);
    expect(skipped.data).toMatchObject({ imported: 1, edges_skipped: 1 });

    for (const field of ["created_at", "updated_at"]) {
      const refused = await ownerClient.restoreArchive(
        archive({ [field]: invalidInstant }),
      );
      expect(refused.status, field).toBe(400);
      expect(refused.error?.error.code, field).toBe("validation_error");
      expect(refused.error?.error.message, field).toContain(field);
    }
  });

  it("writes an item's dates in UTC to the millisecond", async () => {
    const id = uuidv7();
    const archived = "2020-02-28T23:30:00+02:00";
    const { archive } = twoRows(({ first, firstVersions }) => {
      first.id = id;
      first.created_at = archived;
      first.updated_at = "2020-03-01T00:00:00+02:00";
      firstVersions[0] = snapshot(id, 1);
    });
    const restored = await ownerClient.restoreArchive(archive);
    expect(restored.ok, JSON.stringify(restored.error)).toBe(true);
    trackItem(ctx, id);
    const row = await client.getItem(id);
    expect(row.data.item.created_at).toBe("2020-02-28T21:30:00.000Z");
    expect(row.data.item.updated_at).toBe("2020-02-29T22:00:00.000Z");
  });

  it("refuses a snapshot ID the instance's history already holds, answering 409 and leaving that history as it was", async () => {
    const owner = await note({ body: "first" });
    await patch(owner.id, { properties: { body: "second" } });
    const held = await allVersions(client, owner.id);
    expect(held).toHaveLength(1);
    const heldId = held[0]!.id;

    const clash = twoRows(({ secondVersions }) => {
      secondVersions[0]!.id = heldId;
    });
    const refused = await ownerClient.restoreArchive(clash.archive);
    expect(refused.status, JSON.stringify(refused.error)).toBe(409);
    expect(refused.error?.error.code).toBe("conflict");
    expect(await allVersions(client, owner.id)).toEqual(held);
    expect((await client.getItem(clash.first)).status).toBe(404);
    expect((await client.getItem(clash.second)).status).toBe(404);

    // The witness: the same archive under a snapshot ID nothing holds.
    const free = twoRows(() => undefined);
    const accepted = await ownerClient.restoreArchive(free.archive);
    expect(accepted.ok, JSON.stringify(accepted.error)).toBe(true);
    trackItem(ctx, free.first);
    trackItem(ctx, free.second);
  });
});
