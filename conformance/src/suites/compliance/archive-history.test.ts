import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { v7 as uuidv7 } from "uuid";
import { MarfaClient } from "../../client/api.js";
import type {
  MarfaItem,
  MarfaVersion,
  TestContext,
} from "../../client/types.js";
import {
  itemsArchive,
  listTarGzEntries,
  readTarGzEntry,
  tarGz,
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
 * and the restore that writes them back. The rows that must be refused are
 * built by hand, because no export writes a snapshot whose date is no date.
 */
let client: MarfaClient;
let operator: MarfaClient;
let ctx: TestContext;
let apiUrl: string;
/** A server that has never seen the rows, to restore into. */
let fresh: FreshServer | undefined;
let freshOperator: MarfaClient;
let freshReader: MarfaClient;

beforeAll(async () => {
  ({ client, ctx, apiUrl } = await createTestContext(
    "compliance",
    "archive-history",
  ));
  operator = getOwnerClient();
  fresh = await bootFreshServer("archive-history");
  freshOperator = new MarfaClient({
    baseUrl: fresh.apiUrl,
    apiKey: fresh.managementKey,
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
  versions: MarfaVersion[];
}

function itemLines(archive: Uint8Array): ArchivedLine[] {
  return (readTarGzEntry(archive, "items.ndjson") ?? "")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as ArchivedLine);
}

/** The archive with `items.ndjson` rewritten by `change`, and nothing else. */
function withItemLines(
  archive: Uint8Array,
  change: (lines: Record<string, unknown>[]) => Record<string, unknown>[],
): Uint8Array {
  return tarGz(
    listTarGzEntries(archive).map((entry) =>
      entry.name === "items.ndjson"
        ? {
            name: entry.name,
            body: change(
              entry.body
                .toString("utf8")
                .split("\n")
                .filter((line) => line.trim() !== "")
                .map((line) => JSON.parse(line) as Record<string, unknown>),
            )
              .map((line) => `${JSON.stringify(line)}\n`)
              .join(""),
          }
        : { name: entry.name, body: entry.body },
    ),
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
    const carried = line?.versions ?? [];
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
      expect(line, "the row is carried").toBeDefined();
      return line?.versions.map((v) => v.type);
    };
    // The witness: a key that may read both types is carried the snapshot.
    expect(await versionsFor(client)).toEqual(["core.bookmark"]);
    expect(await versionsFor(noteReader)).toEqual([]);
  });

  it("carries the bytes only a snapshot names when the exporting key could read them through the blob doors, and no others", async () => {
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
    // A row naming the first lends it to the key that wrote the row.
    const lender = await client.createItem({
      type: "core.file",
      source: ctx.source,
      properties: { blob_ref: up.data.hash, mime_type: "text/plain" },
    });
    expect(lender.ok, JSON.stringify(lender.error)).toBe(true);
    trackItem(ctx, lender.data.item.id);
    expect((await client.downloadBlob(up.data.hash)).status).toBe(200);
    expect((await client.downloadBlob(upHidden.data.hash)).status).toBe(404);

    // Both digests are in the first snapshot and in no current row.
    const item = await note({
      body: `${up.data.hash} ${upHidden.data.hash}`,
    });
    await patch(item.id, {
      properties: { body: "named nothing" },
      properties_mode: "replace",
    });

    const archive = await client.exportArchive({ source: ctx.source });
    expect(archive.status).toBe(200);
    const carried = listTarGzEntries(archive.data)
      .filter((e) => e.name.startsWith("blobs/"))
      .map((e) => e.name);
    expect(carried).toContain(`blobs/${up.data.hash}`);
    expect(carried).not.toContain(`blobs/${upHidden.data.hash}`);
    const manifest = JSON.parse(
      readTarGzEntry(archive.data, "manifest.json") ?? "{}",
    ) as { blobs: Record<string, unknown> };
    expect(Object.keys(manifest.blobs)).toContain(up.data.hash);
    expect(Object.keys(manifest.blobs)).not.toContain(upHidden.data.hash);
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
    const restored = await freshOperator.restoreArchive(archive.data);
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
    const restored = await freshOperator.restoreArchive(archive.data);
    expect(restored.ok, JSON.stringify(restored.error)).toBe(true);
    expect(await allVersions(freshReader, made.data.item.id)).toEqual(history);
  });

  it("leaves an existing row, its tags, its extensions and its history alone when the archive's copy is a duplicate", async () => {
    const item = await note({ body: "as archived" });
    expect((await client.addTags(item.id, ["archived-tag"])).ok).toBe(true);
    expect(
      (await client.setItemExtension(item.id, `history.${ctx.runId}`, { a: 1 }))
        .ok,
    ).toBe(true);
    await patch(item.id, { properties: { body: "second" } });
    const archive = await client.exportArchive({ source: ctx.source });

    // The row moves on after the archive was taken.
    await patch(item.id, { properties: { body: "third" } });
    expect((await client.addTags(item.id, ["later-tag"])).ok).toBe(true);
    expect(
      (await client.setItemExtension(item.id, `history.${ctx.runId}`, { a: 2 }))
        .ok,
    ).toBe(true);
    const row = await client.getItem(item.id);
    const history = await allVersions(client, item.id);
    expect(history).toHaveLength(2);

    const restored = await operator.restoreArchive(archive.data);
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

/** One archive of two rows, the second carrying `versions` and a version 3. */
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
      id: first,
      type: "core.note",
      source: ctx.source,
      version: 2,
      properties: { body: "a valid row ahead of the other" },
    } as Record<string, unknown>,
    second: {
      id: second,
      type: "core.note",
      source: ctx.source,
      version: 3,
      properties: { body: "the row under test" },
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
      properties: { body: "a placeholder the rows replace" },
    },
  ]);
  const archive = tarGz(
    listTarGzEntries(base).map((entry) =>
      entry.name === "items.ndjson"
        ? {
            name: entry.name,
            body:
              [
                { item: rows.first, versions: rows.firstVersions },
                { item: rows.second, versions: rows.secondVersions },
              ]
                .map((l) =>
                  JSON.stringify({
                    ...l,
                    metadata: { tags: [], extensions: {} },
                  }),
                )
                .join("\n") + "\n",
          }
        : { name: entry.name, body: entry.body },
    ),
  );
  return { archive, first, second };
}

describe("an archive's dates and history, refused before anything is written", () => {
  const invalidInstant = "not-a-date";
  const cases: [string, string, (rows: Rows) => void][] = [];
  const add = (path: string, edit: (rows: Rows) => void, label = path) =>
    cases.push([label, path, edit]);

  add("created_at", ({ second }) => {
    second.created_at = invalidInstant;
  });
  add("updated_at", ({ second }) => {
    second.updated_at = invalidInstant;
  });
  add("versions", (rows) => {
    rows.secondVersions = "none" as never;
  });
  add("versions.0", ({ secondVersions }) => {
    secondVersions[0] = 5 as never;
  });
  add("versions.0.id", ({ secondVersions }) => {
    secondVersions[0]!.id = "not an id";
  });
  add(
    "versions.1.id",
    ({ secondVersions }) => {
      secondVersions[1]!.id = secondVersions[0]!.id;
    },
    "versions.1.id repeating one of the same row",
  );
  add(
    "versions.0.id",
    ({ firstVersions, secondVersions }) => {
      secondVersions[0]!.id = firstVersions[0]!.id;
    },
    "versions.0.id repeating one of another row",
  );
  add("versions.0.item_id", ({ secondVersions }) => {
    secondVersions[0]!.item_id = uuidv7();
  });
  add(
    "versions.0.version",
    ({ secondVersions }) => {
      secondVersions[0]!.version = 0;
    },
    "versions.0.version at 0",
  );
  add(
    "versions.0.version",
    ({ secondVersions }) => {
      secondVersions[0]!.version = 1.5;
    },
    "versions.0.version fractional",
  );
  add(
    "versions.1.version",
    ({ secondVersions }) => {
      secondVersions[1]!.version = 3;
    },
    "versions.1.version equal to the item's",
  );
  add(
    "versions.1.version",
    ({ secondVersions }) => {
      secondVersions[1]!.version = 1;
    },
    "versions.1.version repeating one of the same row",
  );
  add("versions.0.properties", ({ secondVersions }) => {
    secondVersions[0]!.properties = "text";
  });
  add("versions.0.type", ({ secondVersions }) => {
    secondVersions[0]!.type = "Not A Type";
  });
  add("versions.0.tier", ({ secondVersions }) => {
    secondVersions[0]!.tier = "other";
  });
  add("versions.0.occurred_at", ({ secondVersions }) => {
    secondVersions[0]!.occurred_at = invalidInstant;
  });
  add("versions.0.created_at", ({ secondVersions }) => {
    secondVersions[0]!.created_at = invalidInstant;
  });
  add("versions.0.source_id", ({ secondVersions }) => {
    secondVersions[0]!.source_id = 5;
  });

  it.each(cases)(
    "refuses a row whose %s is malformed, and writes the row ahead of it nowhere",
    async (_label, path, edit) => {
      const bad = twoRows(edit);
      const refused = await operator.restoreArchive(bad.archive);
      expect(refused.status, JSON.stringify(refused.error)).toBe(400);
      expect(refused.error?.error.code).toBe("validation_error");
      expect(refused.error?.error.message).toContain(bad.second);
      expect(refused.error?.error.message).toContain(path);
      expect((await client.getItem(bad.first)).status).toBe(404);
      expect((await client.getItem(bad.second)).status).toBe(404);

      // The witness: the same two rows with nothing malformed restore.
      const good = twoRows(() => undefined);
      const accepted = await operator.restoreArchive(good.archive);
      expect(accepted.ok, JSON.stringify(accepted.error)).toBe(true);
      expect(accepted.data.imported).toBe(2);
      trackItem(ctx, good.first);
      trackItem(ctx, good.second);
    },
  );

  it("refuses a malformed date or history even when the row is one the instance already holds", async () => {
    const good = twoRows(() => undefined);
    const accepted = await operator.restoreArchive(good.archive);
    expect(accepted.ok, JSON.stringify(accepted.error)).toBe(true);
    trackItem(ctx, good.first);
    trackItem(ctx, good.second);
    // Both rows exist now, so each would be counted a duplicate.
    const again = await operator.restoreArchive(good.archive);
    expect(again.ok, JSON.stringify(again.error)).toBe(true);
    expect(again.data).toMatchObject({ imported: 0, duplicates: 2 });

    for (const damage of [
      (line: Record<string, unknown>) => {
        (line.item as Record<string, unknown>).created_at = invalidInstant;
      },
      (line: Record<string, unknown>) => {
        (line.versions as Record<string, unknown>[])[0]!.tier = "other";
      },
    ]) {
      const refused = await operator.restoreArchive(
        withItemLines(good.archive, (lines) => {
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
      return tarGz(
        listTarGzEntries(base).map((entry) =>
          entry.name === "edges.ndjson"
            ? {
                name: entry.name,
                body: `${JSON.stringify({ edge: edge(extra) })}\n`,
              }
            : { name: entry.name, body: entry.body },
        ),
      );
    };

    // The witness: with readable dates the edge is skipped for its missing
    // endpoint, and the row ahead of it is written.
    const skipped = await operator.restoreArchive(archive({}));
    expect(skipped.ok, JSON.stringify(skipped.error)).toBe(true);
    trackItem(ctx, first);
    expect(skipped.data).toMatchObject({ imported: 1, edges_skipped: 1 });

    for (const field of ["created_at", "updated_at"]) {
      const refused = await operator.restoreArchive(
        archive({ [field]: invalidInstant }),
      );
      expect(refused.status, field).toBe(400);
      expect(refused.error?.error.code, field).toBe("validation_error");
      expect(refused.error?.error.message, field).toContain(field);
    }
  });

  it("writes a row's dates in UTC to the millisecond and keeps a snapshot's dates as the archive spelled them", async () => {
    const id = uuidv7();
    const archived = "2020-02-28T23:30:00+02:00";
    const spelled = "2019-12-31T23:59:59+01:00";
    const { archive } = twoRows(({ first, firstVersions }) => {
      first.id = id;
      first.created_at = archived;
      first.updated_at = "2020-03-01T00:00:00+02:00";
      firstVersions[0] = snapshot(id, 1, {
        created_at: spelled,
        occurred_at: spelled,
      });
    });
    const restored = await operator.restoreArchive(archive);
    expect(restored.ok, JSON.stringify(restored.error)).toBe(true);
    trackItem(ctx, id);
    const row = await client.getItem(id);
    expect(row.data.item.created_at).toBe("2020-02-28T21:30:00.000Z");
    expect(row.data.item.updated_at).toBe("2020-02-29T22:00:00.000Z");
    const [kept] = await allVersions(client, id);
    expect(kept?.created_at).toBe(spelled);
    expect(kept?.occurred_at).toBe(spelled);
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
    const refused = await operator.restoreArchive(clash.archive);
    expect(refused.status, JSON.stringify(refused.error)).toBe(409);
    expect(refused.error?.error.code).toBe("conflict");
    expect(await allVersions(client, owner.id)).toEqual(held);
    expect((await client.getItem(clash.first)).status).toBe(404);
    expect((await client.getItem(clash.second)).status).toBe(404);

    // The witness: the same archive under a snapshot ID nothing holds.
    const free = twoRows(() => undefined);
    const accepted = await operator.restoreArchive(free.archive);
    expect(accepted.ok, JSON.stringify(accepted.error)).toBe(true);
    trackItem(ctx, free.first);
    trackItem(ctx, free.second);
  });
});
