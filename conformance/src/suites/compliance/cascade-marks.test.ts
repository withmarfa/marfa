// Each absence sits beside a presence on the same door, and frames are read
// live and replayed, because different code writes the two.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { CreateItemInput } from "../../client/api.js";
import type {
  BulkActionInput,
  BulkActionJob,
  MarfaItem,
  TestContext,
} from "../../client/types.js";
import {
  createTestContext,
  getOperatorClient,
  trackFolder,
  trackItem,
  trackKey,
  trackWebhook,
  cleanup,
} from "../../utils/setup.js";
import { createNote, createTask } from "../../generators/items.js";
import { readTarGzEntry } from "../../utils/archive.js";
import type { SseEvent } from "../../utils/sse.js";
import { collectUntil, withStream } from "../../utils/stream.js";
import { startReceiver, type Receiver } from "../../utils/webhook-receiver.js";

let client: MarfaClient;
let ctx: TestContext;
let apiUrl: string;
let apiKey: string;
// Reads only `core.note`, so a `core.task` root is a row it can't read.
let noteKey: string;
let noteClient: MarfaClient;
// Claims this file's source, so it may resend a create for a note it can't
// see the `core.task` root of.
let noteWriter: MarfaClient;
let receiver: Receiver;

beforeAll(async () => {
  ({ ctx, client, apiUrl, apiKey } = await createTestContext(
    "compliance",
    "cascade-marks",
  ));
  const minted = await client.createKey({
    label: "note-reader",
    source: `${ctx.source}-note-reader`,
    type_permissions: { "core.note": "read" },
    permissions: [],
  });
  expect(minted.ok).toBe(true);
  trackKey(ctx, minted.data.id);
  noteKey = minted.data.key;
  noteClient = new MarfaClient({ baseUrl: apiUrl, apiKey: noteKey });
  const writer = await client.createKey({
    label: "note-writer",
    source: `${ctx.source}-note-writer`,
    sources: [ctx.source],
    type_permissions: { "core.note": "write" },
    permissions: [],
  });
  expect(writer.ok, JSON.stringify(writer.error)).toBe(true);
  trackKey(ctx, writer.data.id);
  noteWriter = new MarfaClient({ baseUrl: apiUrl, apiKey: writer.data.key });
  receiver = await startReceiver();
});

afterAll(async () => {
  await receiver.close();
  await cleanup(ctx);
});

interface FrameData {
  item?: MarfaItem;
  edge?: { id: string };
  restored_with?: string;
  purged_with?: string;
}

type Paths = [string, SseEvent[]][];

async function note(
  body: string,
  tag: string,
  extra: Partial<CreateItemInput> = {},
): Promise<string> {
  const r = await client.createItem(
    createNote({
      source: ctx.source,
      properties: { body },
      tags: [tag],
      ...extra,
    }),
  );
  expect(r.ok).toBe(true);
  trackItem(ctx, r.data.item.id);
  return r.data.item.id;
}

async function task(tag: string): Promise<string> {
  const r = await client.createItem(
    createTask({ source: ctx.source, tags: [tag] }),
  );
  expect(r.ok).toBe(true);
  trackItem(ctx, r.data.item.id);
  return r.data.item.id;
}

async function edge(
  source_id: string,
  target_id: string,
  edge_type: string,
): Promise<string> {
  const r = await client.createEdge({ source_id, target_id, edge_type });
  expect(r.ok).toBe(true);
  return r.data.edge.id;
}

async function listed(
  tag: string,
  state: string,
  reader: MarfaClient = client,
): Promise<Map<string, MarfaItem>> {
  const r = await reader.listItems({ tags: [tag], state, limit: 100 });
  expect(r.ok).toBe(true);
  return new Map(r.data.data.map((item) => [item.id, item]));
}

async function listedWithMetadata(
  tag: string,
): Promise<Map<string, MarfaItem>> {
  const query = new URLSearchParams({
    tags: tag,
    state: "trashed",
    include: "metadata",
    limit: "100",
  });
  const r = await client.rawRequest<{ data: { item: MarfaItem }[] }>(
    `/items?${query.toString()}`,
  );
  expect(r.ok).toBe(true);
  return new Map(r.data.data.map(({ item }) => [item.id, item]));
}

function itemLines(ndjson: string): Map<string, MarfaItem> {
  const lines = new Map<string, MarfaItem>();
  for (const line of ndjson.split("\n")) {
    if (line.trim() === "") continue;
    const parsed = JSON.parse(line) as { item?: MarfaItem };
    if (parsed.item) lines.set(parsed.item.id, parsed.item);
  }
  return lines;
}

async function exported(
  reader: MarfaClient = client,
): Promise<Map<string, MarfaItem>> {
  const r = await reader.exportItems({ source: ctx.source, state: "any" });
  expect(r.ok).toBe(true);
  return itemLines(r.data);
}

async function runJob(input: BulkActionInput): Promise<void> {
  const res = await client.bulkAction(input);
  expect(res.status).toBe(202);
  const final = await client.pollBulkActionToTerminal(
    (res.data as BulkActionJob).id,
  );
  expect(final.status).toBe("completed");
}

/** Settles each read on a sentinel written after `act`, not a quiet spell,
 *  so the wait isn't timing-dependent. */
async function framesFor<L extends string>(
  readers: Record<L, string>,
  tag: string,
  act: () => Promise<void>,
  signal: AbortSignal,
): Promise<Record<L, Paths>> {
  const labels = Object.keys(readers) as L[];
  const cursors = new Map<L, string | undefined>();
  const live = new Map<L, SseEvent[]>();
  let sentinel = "";
  const reached = (events: SseEvent[]): boolean =>
    events.some((e) => (e.data as FrameData).item?.id === sentinel);
  const open = async ([label, ...rest]: L[]): Promise<void> => {
    if (label === undefined) {
      await act();
      sentinel = await note("sentinel", tag);
      return;
    }
    await withStream(apiUrl, readers[label], {}, async (stream) => {
      const opened = await collectUntil(
        stream,
        (events) => events.some((e) => e.event === "stream_live"),
        `${label}: the stream to go live`,
        signal,
      );
      const announced = opened.events.find((e) => e.event === "stream_cursor");
      cursors.set(
        label,
        (announced?.data as { cursor?: string } | undefined)?.cursor,
      );
      await open(rest);
      live.set(
        label,
        (
          await collectUntil(
            stream,
            reached,
            `${label}: sentinel ${sentinel}`,
            signal,
          )
        ).events,
      );
    });
  };
  await open(labels);
  const out = {} as Record<L, Paths>;
  for (const label of labels) {
    const cursor = cursors.get(label);
    expect(
      cursor,
      `${label}: the stream announced no cursor to replay from`,
    ).toBeTruthy();
    const replay = await withStream(
      apiUrl,
      readers[label],
      { lastEventId: cursor },
      async (stream) =>
        (
          await collectUntil(
            stream,
            reached,
            `${label}: replayed sentinel ${sentinel}`,
            signal,
          )
        ).events,
    );
    out[label] = [
      [`${label} live`, live.get(label) ?? []],
      [`${label} replay`, replay],
    ];
  }
  return out;
}

async function framesOf(
  tag: string,
  act: () => Promise<void>,
  signal: AbortSignal,
): Promise<Paths> {
  return (await framesFor({ full: apiKey }, tag, act, signal)).full;
}

function frame(
  events: SseEvent[],
  name: string,
  id: string,
): FrameData | undefined {
  const found = events.find((e) => {
    const data = e.data as FrameData;
    return e.event === name && (data.item?.id === id || data.edge?.id === id);
  });
  return found?.data as FrameData | undefined;
}

describe("a cascaded trash names its root", () => {
  it("marks a row a cascade trashed with the row named, and no row trashed on its own", async ({
    signal,
  }) => {
    const tag = `mark-${ctx.runId}`;
    const parent = await note("parent", tag);
    const child = await note("child", tag);
    const alone = await note("alone", tag);
    await edge(parent, child, "parent-of");

    const paths = await framesOf(
      tag,
      async () => {
        expect((await client.deleteItem(parent)).ok).toBe(true);
        expect((await client.deleteItem(alone)).ok).toBe(true);
      },
      signal,
    );
    for (const [path, events] of paths) {
      const taken = frame(events, "item.deleted", child)?.item;
      expect(taken?.trashed_with, `${path}: the child's item.deleted`).toBe(
        parent,
      );
      expect(taken?.trashed_by_cascade, path).toBe(true);
      for (const own of [parent, alone]) {
        const deleted = frame(events, "item.deleted", own);
        expect(deleted, `${path}: item.deleted for ${own}`).toBeDefined();
        expect(deleted?.item).not.toHaveProperty("trashed_with");
        expect(deleted?.item).not.toHaveProperty("trashed_by_cascade");
      }
    }

    const listings: [string, Map<string, MarfaItem>][] = [
      ["state=trashed", await listed(tag, "trashed")],
      ["state=any", await listed(tag, "any")],
      ["include=metadata", await listedWithMetadata(tag)],
    ];
    for (const [door, rows] of listings) {
      expect(rows.get(child)?.trashed_with, door).toBe(parent);
      expect(rows.get(child)?.trashed_by_cascade, door).toBe(true);
      for (const own of [parent, alone]) {
        expect(rows.get(own), `${door}: ${own}`).toBeDefined();
        expect(rows.get(own)).not.toHaveProperty("trashed_with");
        expect(rows.get(own)).not.toHaveProperty("trashed_by_cascade");
      }
    }

    const lines = await exported();
    expect(lines.get(child)?.trashed_with).toBe(parent);
    expect(lines.get(child)?.trashed_by_cascade).toBe(true);
    for (const own of [parent, alone]) {
      expect(lines.get(own), `export: ${own}`).toBeDefined();
      expect(lines.get(own)).not.toHaveProperty("trashed_with");
      expect(lines.get(own)).not.toHaveProperty("trashed_by_cascade");
    }
  });

  it("answers the marks on POST /items/lookup, to each reader as it may be told", async () => {
    const tag = `lookup-${ctx.runId}`;
    const root = await task(tag);
    const child = await note("child", tag);
    const alone = await note("alone", tag);
    await edge(root, child, "parent-of");
    expect((await client.deleteItem(root)).ok).toBe(true);
    expect((await client.deleteItem(alone)).ok).toBe(true);

    const ids = [child, alone];
    const full = await client.lookupItems({ type: "core.note", ids });
    expect(full.status).toBe(200);
    const fullRows = new Map(full.data.data.map((row) => [row.id, row]));
    expect(fullRows.get(child)?.trashed_by_cascade).toBe(true);
    expect(fullRows.get(child)?.trashed_with).toBe(root);
    // The witness: a row trashed on its own is answered, unmarked.
    expect(fullRows.get(alone)?.state).toBe("trashed");
    expect(fullRows.get(alone)).not.toHaveProperty("trashed_by_cascade");

    const notes = await noteClient.lookupItems({ type: "core.note", ids });
    expect(notes.status).toBe(200);
    const noteRows = new Map(notes.data.data.map((row) => [row.id, row]));
    expect(noteRows.get(child)?.trashed_by_cascade).toBe(true);
    expect(noteRows.get(child)).not.toHaveProperty("trashed_with");
  });

  it("names the row trashed only to a key that may read its type, and says a cascade took the row to any key that reads it", async ({
    signal,
  }) => {
    const tag = `narrow-${ctx.runId}`;
    const root = await task(tag);
    const child = await note("child", tag);
    const alone = await note("alone", tag);
    await edge(root, child, "parent-of");
    const readers = { full: apiKey, notes: noteKey };

    const deleted = await framesFor(
      readers,
      tag,
      async () => {
        expect((await client.deleteItem(root)).ok).toBe(true);
        expect((await client.deleteItem(alone)).ok).toBe(true);
      },
      signal,
    );
    for (const [path, events] of deleted.full) {
      const taken = frame(events, "item.deleted", child)?.item;
      expect(taken?.trashed_with, `${path}: the child's item.deleted`).toBe(
        root,
      );
      expect(taken?.trashed_by_cascade, path).toBe(true);
    }
    for (const [path, events] of deleted.notes) {
      const taken = frame(events, "item.deleted", child)?.item;
      expect(
        taken?.trashed_by_cascade,
        `${path}: the child's item.deleted`,
      ).toBe(true);
      expect(taken, path).not.toHaveProperty("trashed_with");
      const own = frame(events, "item.deleted", alone);
      expect(own, `${path}: item.deleted for ${alone}`).toBeDefined();
      expect(own?.item).not.toHaveProperty("trashed_by_cascade");
    }

    const full = await listed(tag, "trashed");
    expect(full.get(child)?.trashed_with).toBe(root);
    expect(full.get(child)?.trashed_by_cascade).toBe(true);
    const notes = await listed(tag, "trashed", noteClient);
    expect(notes.get(child)?.trashed_by_cascade).toBe(true);
    expect(notes.get(child)).not.toHaveProperty("trashed_with");
    expect(notes.get(alone)).toBeDefined();
    expect(notes.get(alone)).not.toHaveProperty("trashed_by_cascade");

    expect((await exported()).get(child)?.trashed_with).toBe(root);
    const noteLines = await exported(noteClient);
    expect(noteLines.get(child)?.trashed_by_cascade).toBe(true);
    expect(noteLines.get(child)).not.toHaveProperty("trashed_with");

    const purged = await framesFor(
      readers,
      tag,
      async () => {
        expect((await client.purgeItem(child)).ok).toBe(true);
      },
      signal,
    );
    for (const [path, events] of purged.full) {
      const gone = frame(events, "item.purged", child)?.item;
      expect(gone?.trashed_with, `${path}: the child's item.purged`).toBe(root);
      expect(gone?.trashed_by_cascade, path).toBe(true);
    }
    for (const [path, events] of purged.notes) {
      const gone = frame(events, "item.purged", child)?.item;
      expect(gone?.trashed_by_cascade, `${path}: the child's item.purged`).toBe(
        true,
      );
      expect(gone, path).not.toHaveProperty("trashed_with");
    }
  });

  it("keeps the mark through a purge of the row named, and drops it when the row leaves the bin", async ({
    signal,
  }) => {
    const tag = `keep-${ctx.runId}`;
    const parent = await note("parent", tag);
    const child = await note("child", tag);
    const grandchild = await note("grandchild", tag);
    const sibling = await note("sibling", tag);
    await edge(parent, child, "parent-of");
    await edge(child, grandchild, "parent-of");
    await edge(parent, sibling, "parent-of");
    expect((await client.transitionItem(sibling, "archived")).ok).toBe(true);
    expect((await client.deleteItem(parent)).ok).toBe(true);
    expect((await client.purgeItem(parent)).ok).toBe(true);

    const binned = await listed(tag, "trashed");
    for (const id of [child, grandchild, sibling]) {
      expect(binned.get(id)?.trashed_with, id).toBe(parent);
      expect(binned.get(id)?.trashed_by_cascade, id).toBe(true);
    }

    // The purge made the child its own trash's root, so the grandchild comes
    // back naming the child, not the parent its mark named.
    const paths = await framesOf(
      tag,
      async () => {
        expect((await client.restoreItem(child)).ok).toBe(true);
      },
      signal,
    );
    for (const [path, events] of paths) {
      expect(
        frame(events, "item.restored", grandchild)?.restored_with,
        `${path}: grandchild`,
      ).toBe(child);
    }
    expect((await client.transitionItem(sibling, "active")).ok).toBe(true);

    // A mark shows only while its row is in the bin, so each is trashed again:
    // the grandchild by a cascade, the witness that a mark is written.
    expect((await client.deleteItem(sibling)).ok).toBe(true);
    expect((await client.deleteItem(child)).ok).toBe(true);
    const again = await listed(tag, "trashed");
    expect(again.get(grandchild)?.trashed_with, "grandchild").toBe(child);
    expect(again.get(grandchild)?.trashed_by_cascade, "grandchild").toBe(true);
    for (const [id, door] of [
      [child, "a restore"],
      [sibling, "a transition"],
    ] as const) {
      const own = again.get(id);
      expect(own?.state, `out of the bin by ${door}, then trashed`).toBe(
        "trashed",
      );
      expect(own, door).not.toHaveProperty("trashed_by_cascade");
      expect(own, door).not.toHaveProperty("trashed_with");
    }
  });

  it("names the row whose trash took it on the purge of a row a cascade trashed", async ({
    signal,
  }) => {
    const tag = `purged-${ctx.runId}`;
    const parent = await note("parent", tag);
    const child = await note("child", tag);
    await edge(parent, child, "parent-of");
    expect((await client.deleteItem(parent)).ok).toBe(true);

    const paths = await framesOf(
      tag,
      async () => {
        expect((await client.purgeItem(child)).ok).toBe(true);
        expect((await client.purgeItem(parent)).ok).toBe(true);
      },
      signal,
    );
    for (const [path, events] of paths) {
      const gone = frame(events, "item.purged", child)?.item;
      expect(gone?.trashed_with, `${path}: the child's item.purged`).toBe(
        parent,
      );
      expect(gone?.trashed_by_cascade, path).toBe(true);
      const own = frame(events, "item.purged", parent);
      expect(own, `${path}: the parent's item.purged`).toBeDefined();
      expect(own?.item).not.toHaveProperty("trashed_with");
      expect(own?.item).not.toHaveProperty("trashed_by_cascade");
    }
  });

  it("names the row whose trash took it on each row a bulk purge purges, only to a key that may read its type", async ({
    signal,
  }) => {
    const tag = `bulk-purge-${ctx.runId}`;
    // Tagged apart, so the purge takes the child and not the row named.
    const root = await task(`${tag}-root`);
    const child = await note("child", tag);
    const alone = await note("alone", tag);
    await edge(root, child, "parent-of");
    expect((await client.deleteItem(root)).ok).toBe(true);
    expect((await client.deleteItem(alone)).ok).toBe(true);

    const paths = await framesFor(
      { full: apiKey, notes: noteKey },
      tag,
      () =>
        runJob({
          action: "purge",
          confirm: "PURGE",
          filter: { tags: [tag], state: "trashed" },
        }),
      signal,
    );
    for (const [path, events] of paths.full) {
      const gone = frame(events, "item.purged", child)?.item;
      expect(gone?.trashed_with, `${path}: the child's item.purged`).toBe(root);
      expect(gone?.trashed_by_cascade, path).toBe(true);
      const own = frame(events, "item.purged", alone);
      expect(own, `${path}: item.purged for ${alone}`).toBeDefined();
      expect(own?.item).not.toHaveProperty("trashed_with");
      expect(own?.item).not.toHaveProperty("trashed_by_cascade");
    }
    for (const [path, events] of paths.notes) {
      const gone = frame(events, "item.purged", child)?.item;
      expect(gone?.trashed_by_cascade, `${path}: the child's item.purged`).toBe(
        true,
      );
      expect(gone, path).not.toHaveProperty("trashed_with");
    }
  });

  it("marks no row a cascade revokes rather than trashes", async ({
    signal,
  }) => {
    const tag = `revoke-${ctx.runId}`;
    const folder = await client.createFolder({
      title: `cascade marks ${ctx.runId}`,
    });
    expect(folder.ok, JSON.stringify(folder.error)).toBe(true);
    const folderId = folder.data.item.id;
    trackFolder(ctx, folderId);
    const parent = await note("parent", tag);
    const child = await note("child", tag);
    await edge(parent, child, "parent-of");
    await edge(parent, folderId, "parent-of");

    const paths = await framesOf(
      tag,
      async () => {
        expect((await client.deleteItem(parent)).ok).toBe(true);
      },
      signal,
    );
    for (const [path, events] of paths) {
      expect(
        frame(events, "item.deleted", child)?.item?.trashed_with,
        `${path}: the child's item.deleted`,
      ).toBe(parent);
      const revoked = frame(events, "item.deleted", folderId)?.item;
      expect(revoked?.state, `${path}: the folder's item.deleted`).toBe(
        "revoked",
      );
      expect(revoked, path).not.toHaveProperty("trashed_by_cascade");
      expect(revoked, path).not.toHaveProperty("trashed_with");
    }
  });
});

describe("a create answered with the row it names says a cascade took it", () => {
  async function resent(
    writer: MarfaClient,
    input: Partial<CreateItemInput>,
  ): Promise<MarfaItem> {
    const r = await writer.createItem(
      createNote({
        source: ctx.source,
        properties: { body: "resent" },
        ...input,
      }),
    );
    expect(r.status, JSON.stringify(r.error)).toBe(200);
    expect(r.data.acknowledged).toBe(true);
    expect(r.data.item.state).toBe("trashed");
    return r.data.item;
  }

  it("marks a row a cascade trashed on the acknowledgement of a create naming its source and source id, and names the row trashed only to a key that may read its type", async () => {
    const tag = `acknowledged-${ctx.runId}`;
    const childKey = { source_id: `${tag}-child` };
    const aloneKey = { source_id: `${tag}-alone` };
    const root = await task(tag);
    const child = await note("child", tag, childKey);
    const alone = await note("alone", tag, aloneKey);
    await edge(root, child, "parent-of");
    expect((await client.deleteItem(root)).ok).toBe(true);
    expect((await client.deleteItem(alone)).ok).toBe(true);

    const full = await resent(client, childKey);
    expect(full.id).toBe(child);
    expect(full.trashed_with).toBe(root);
    expect(full.trashed_by_cascade).toBe(true);
    const narrowed = await resent(noteWriter, childKey);
    expect(narrowed.id).toBe(child);
    expect(narrowed.trashed_by_cascade).toBe(true);
    expect(narrowed).not.toHaveProperty("trashed_with");
    const own = await resent(client, aloneKey);
    expect(own.id).toBe(alone);
    expect(own).not.toHaveProperty("trashed_by_cascade");
    expect(own).not.toHaveProperty("trashed_with");
  });

  it("marks a row a cascade trashed on the answer to a create repeated under its id, and names the row trashed only to a key that may read its type", async () => {
    const tag = `repeated-${ctx.runId}`;
    const root = await task(tag);
    const child = await note("child", tag);
    const alone = await note("alone", tag);
    await edge(root, child, "parent-of");
    expect((await client.deleteItem(root)).ok).toBe(true);
    expect((await client.deleteItem(alone)).ok).toBe(true);

    const full = await resent(client, { id: child });
    expect(full.trashed_with).toBe(root);
    expect(full.trashed_by_cascade).toBe(true);
    const narrowed = await resent(noteWriter, { id: child });
    expect(narrowed.trashed_by_cascade).toBe(true);
    expect(narrowed).not.toHaveProperty("trashed_with");
    const own = await resent(client, { id: alone });
    expect(own).not.toHaveProperty("trashed_by_cascade");
    expect(own).not.toHaveProperty("trashed_with");
  });
});

describe("a restore says what brought a row back", () => {
  it("names the row restored on each row its restore brings back, and not on the row itself", async ({
    signal,
  }) => {
    const tag = `restore-${ctx.runId}`;
    const parent = await note("parent", tag);
    const child = await note("child", tag);
    const alone = await note("alone", tag);
    await edge(parent, child, "parent-of");
    expect((await client.deleteItem(parent)).ok).toBe(true);
    expect((await client.deleteItem(alone)).ok).toBe(true);

    const paths = await framesOf(
      tag,
      async () => {
        expect((await client.restoreItem(parent)).ok).toBe(true);
        expect((await client.restoreItem(alone)).ok).toBe(true);
      },
      signal,
    );
    for (const [path, events] of paths) {
      expect(
        frame(events, "item.restored", child)?.restored_with,
        `${path}: the child's item.restored`,
      ).toBe(parent);
      for (const own of [parent, alone]) {
        const restored = frame(events, "item.restored", own);
        expect(restored, `${path}: item.restored for ${own}`).toBeDefined();
        expect(restored).not.toHaveProperty("restored_with");
      }
    }
  });

  it("names the row restored only to a key that may read its type", async ({
    signal,
  }) => {
    const tag = `narrow-restore-${ctx.runId}`;
    const root = await task(tag);
    const child = await note("child", tag);
    await edge(root, child, "parent-of");
    expect((await client.deleteItem(root)).ok).toBe(true);

    const paths = await framesFor(
      { full: apiKey, notes: noteKey },
      tag,
      async () => {
        expect((await client.restoreItem(root)).ok).toBe(true);
      },
      signal,
    );
    for (const [path, events] of paths.full) {
      expect(
        frame(events, "item.restored", child)?.restored_with,
        `${path}: the child's item.restored`,
      ).toBe(root);
    }
    for (const [path, events] of paths.notes) {
      const back = frame(events, "item.restored", child);
      expect(back, `${path}: the child's item.restored`).toBeDefined();
      expect(back, path).not.toHaveProperty("restored_with");
    }
  });

  it("names the row moved on each row a transition out of the bin brings back, only to a key that may read its type", async ({
    signal,
  }) => {
    const tag = `transition-${ctx.runId}`;
    const root = await task(tag);
    const child = await note("child", tag);
    await edge(root, child, "parent-of");
    expect((await client.deleteItem(root)).ok).toBe(true);

    const paths = await framesFor(
      { full: apiKey, notes: noteKey },
      tag,
      async () => {
        expect((await client.transitionItem(root, "active")).ok).toBe(true);
      },
      signal,
    );
    for (const [path, events] of paths.full) {
      expect(
        frame(events, "item.restored", child)?.restored_with,
        `${path}: the child's item.restored`,
      ).toBe(root);
      const own = frame(events, "item.state_changed", root);
      expect(own, `${path}: the root's item.state_changed`).toBeDefined();
      expect(own).not.toHaveProperty("restored_with");
    }
    for (const [path, events] of paths.notes) {
      const back = frame(events, "item.restored", child);
      expect(back, `${path}: the child's item.restored`).toBeDefined();
      expect(back, path).not.toHaveProperty("restored_with");
    }
  });

  it("names the row moved on each row a bulk transition out of the bin brings back, only to a key that may read its type", async ({
    signal,
  }) => {
    const tag = `bulk-${ctx.runId}`;
    const root = await task(tag);
    // Tagged apart, so the child comes back by the root's move alone.
    const child = await note("child", `${tag}-under`);
    await edge(root, child, "parent-of");
    expect((await client.deleteItem(root)).ok).toBe(true);

    const paths = await framesFor(
      { full: apiKey, notes: noteKey },
      tag,
      () =>
        runJob({
          action: "transition",
          state: "active",
          filter: { tags: [tag], state: "trashed" },
        }),
      signal,
    );
    for (const [path, events] of paths.full) {
      expect(
        frame(events, "item.restored", child)?.restored_with,
        `${path}: the child's item.restored`,
      ).toBe(root);
      const own = frame(events, "item.state_changed", root);
      expect(own, `${path}: the root's item.state_changed`).toBeDefined();
      expect(own).not.toHaveProperty("restored_with");
    }
    for (const [path, events] of paths.notes) {
      const back = frame(events, "item.restored", child);
      expect(back, `${path}: the child's item.restored`).toBeDefined();
      expect(back, path).not.toHaveProperty("restored_with");
    }
  });
});

describe("a purge says which edges it took", () => {
  it("names the purged item on each edge its purge took, and on no edge deleted by its own door", async ({
    signal,
  }) => {
    const tag = `edges-${ctx.runId}`;
    const doomed = await note("doomed", tag);
    const target = await note("target", tag);
    const pointing = await note("pointing", tag);
    const outbound = await edge(doomed, target, "references");
    const inbound = await edge(pointing, doomed, "about");
    const direct = await edge(pointing, target, "references");
    expect((await client.deleteItem(doomed)).ok).toBe(true);

    const paths = await framesOf(
      tag,
      async () => {
        expect((await client.deleteEdge(direct)).ok).toBe(true);
        expect((await client.purgeItem(doomed)).ok).toBe(true);
      },
      signal,
    );
    for (const [path, events] of paths) {
      for (const id of [outbound, inbound]) {
        expect(
          frame(events, "edge.deleted", id)?.purged_with,
          `${path}: edge.deleted for ${id}`,
        ).toBe(doomed);
      }
      const own = frame(events, "edge.deleted", direct);
      expect(own, `${path}: edge.deleted for the direct delete`).toBeDefined();
      expect(own).not.toHaveProperty("purged_with");
    }
  });

  it("names the purged item on each edge a bulk purge took", async ({
    signal,
  }) => {
    const tag = `bulk-edges-${ctx.runId}`;
    const doomed = await note("doomed", tag);
    const other = `${tag}-kept`;
    const target = await note("target", other);
    const pointing = await note("pointing", other);
    const outbound = await edge(doomed, target, "references");
    const inbound = await edge(pointing, doomed, "about");
    await runJob({
      action: "transition",
      state: "trashed",
      filter: { tags: [tag] },
    });

    const paths = await framesOf(
      other,
      () =>
        runJob({
          action: "purge",
          confirm: "PURGE",
          filter: { tags: [tag], state: "trashed" },
        }),
      signal,
    );
    for (const [path, events] of paths) {
      for (const id of [outbound, inbound]) {
        expect(
          frame(events, "edge.deleted", id)?.purged_with,
          `${path}: edge.deleted for ${id}`,
        ).toBe(doomed);
      }
    }
  });
});

describe("an archive carries neither what a trash took nor its mark", () => {
  it("restores a row a cascade trashed as its own trash, which its parent's restore leaves in the bin", async () => {
    const tag = `archive-${ctx.runId}`;
    const parent = await note("parent", tag);
    const child = await note("child", tag);
    await edge(parent, child, "parent-of");
    expect((await client.deleteItem(parent)).ok).toBe(true);
    expect((await listed(tag, "trashed")).get(child)?.trashed_with).toBe(
      parent,
    );

    const archive = await client.exportArchive({
      source: ctx.source,
      state: "any",
    });
    expect(archive.ok).toBe(true);
    const line = itemLines(
      readTarGzEntry(archive.data, "items.ndjson") ?? "",
    ).get(child);
    expect(line?.trashed_with, "the child's items.ndjson line").toBe(parent);
    expect(line?.trashed_by_cascade).toBe(true);
    expect((await client.purgeItem(child)).ok).toBe(true);
    expect((await client.purgeItem(parent)).ok).toBe(true);
    const restored = await getOperatorClient().restoreArchive(archive.data);
    expect(restored.ok).toBe(true);

    const back = await listed(tag, "trashed");
    expect(back.get(child)?.state).toBe("trashed");
    expect(back.get(child)).not.toHaveProperty("trashed_with");
    expect(back.get(child)).not.toHaveProperty("trashed_by_cascade");
    expect((await client.restoreItem(parent)).ok).toBe(true);
    expect((await listed(tag, "trashed")).get(child)?.state).toBe("trashed");
  });
});

describe("a webhook delivery carries the marks", () => {
  it("delivers the item.deleted of a row a cascade trashed with its mark, and the row trashed's own without one", async () => {
    const subscription = await client.createWebhook({
      url: receiver.hookUrl("cascade-marks"),
      events: ["item.deleted"],
    });
    expect(subscription.status).toBe(201);
    trackWebhook(ctx, subscription.data.id, client);
    const tag = `hook-${ctx.runId}`;
    const parent = await note("parent", tag);
    const child = await note("child", tag);
    await edge(parent, child, "parent-of");
    expect((await client.deleteItem(parent)).ok).toBe(true);

    // Matched on the item's id: the child's body names the parent too.
    const delivered = async (id: string): Promise<MarfaItem> => {
      const itemOf = (body: string) =>
        (JSON.parse(body) as { item?: MarfaItem }).item;
      const hit = await receiver.waitFor(
        (r) =>
          r.path === "/hook/cascade-marks" &&
          r.headers["x-marfa-event-type"] === "item.deleted" &&
          itemOf(r.body)?.id === id,
      );
      return itemOf(hit.body) as MarfaItem;
    };
    const taken = await delivered(child);
    expect(taken.trashed_by_cascade, "the child's delivery").toBe(true);
    expect(taken.trashed_with, "the child's delivery").toBe(parent);
    const own = await delivered(parent);
    expect(own).not.toHaveProperty("trashed_by_cascade");
    expect(own).not.toHaveProperty("trashed_with");
  });
});
