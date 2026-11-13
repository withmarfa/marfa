import { readFileSync, statSync, writeFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { v7 as uuidv7 } from "uuid";
import { MarfaClient } from "../../client/api.js";
import type { ApiResponse } from "../../client/types.js";
import {
  tar,
  listEntries,
  editLineFile,
  itemsArchive,
  blobHash,
} from "../../utils/archive.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import {
  clientsFor,
  diskPath,
  DISK_ONLY,
  runJob,
} from "../../utils/own-blob-server.js";
import {
  diskHolds,
  loseBlobs,
  spooled as spooledOn,
} from "../../utils/store-faults.js";
import { parseSse, type SseEvent } from "../../utils/sse.js";
import {
  baselineEventId,
  collectUntil,
  withStream,
} from "../../utils/stream.js";
import { waitFor } from "../../utils/wait.js";

/**
 * What a restore leaves when it does not finish, and what other requests see
 * while it writes, on a server of the fixture's own. The fixtures stop a
 * restore where the target interface's faults say (`conformance/TARGET-INTERFACE.md`,
 * "Faults"): `hold:restore:before-commit` makes it wait with every item
 * written and nothing committed, `fail:audit`, `fail:commit` and
 * `fail:commit-full` fail the write that would commit it, and a `SIGKILL`
 * while it waits ends the process.
 *
 * Each case restores an archive of its own, so the items, types, blobs and
 * events of one never stand for another's.
 */
let server: FreshServer;
let operator: MarfaClient;
let working: MarfaClient;

beforeAll(async () => {
  // On the disk store alone: with a second store, replication reads and
  // writes blob bytes in the background and can take a blob fault armed for
  // the request under test.
  server = await bootFreshServer("restore-faults", DISK_ONLY);
  ({ operator, working } = clientsFor(server));
}, FRESH_SERVER_TIMEOUT_MS);

afterEach(async () => {
  await server.clearFault();
});

afterAll(async () => {
  await server.stop();
}, FRESH_SERVER_TIMEOUT_MS);

function ownerClient(): MarfaClient {
  return new MarfaClient({
    baseUrl: server.apiUrl,
    controlSocket: server.controlSocket,
  });
}

const edgeTypeOf = (id: string) => ({
  id,
  label: "Test edge type",
  cardinality: "many-to-many",
  source_type_constraints: ["*"],
  target_type_constraints: ["*"],
  cascade_on_delete: "orphan",
  property_schema: {},
  written_at: "source",
});

/** What an archive carries: a type, an edge type, a blob, two items and an edge. */
interface Carried {
  a: string;
  b: string;
  edgeId: string;
  type: string;
  source: string;
  edgeType: string;
  bytes: Uint8Array;
  hash: string;
  archive: Uint8Array;
}

let serial = 0;

function carrying(bytes?: Uint8Array): Carried {
  serial += 1;
  const tag = `${String(Date.now())}${String(serial)}`;
  const a = uuidv7();
  const b = uuidv7();
  const edgeId = uuidv7();
  const type = `user.restorefault${tag}`;
  const edgeType = `restorefault.x${tag}`;
  const blob =
    bytes ??
    new TextEncoder().encode(`bytes a restore carries, ${tag}, ${uuidv7()}`);
  const hash = blobHash(blob);
  const source = `restore-faults-${tag}`;
  const schema = {
    id: type,
    label: "Restore fault",
    version: 1,
    fields: { label: { type: "string" }, blob: { type: "string" } },
  };
  const base = itemsArchive(
    [a, b].map((id) => ({
      id,
      type,
      source,
      properties: { label: `row ${id}`, blob: hash },
    })),
    [{ data: blob, mime_type: "application/octet-stream" }],
    [schema],
  );
  const archive = editLineFile(
    editLineFile(
      base,
      "edges",
      () =>
        `${JSON.stringify({
          edge: { id: edgeId, source_id: a, target_id: b, edge_type: edgeType },
        })}\n`,
    ),
    "instance",
    () =>
      `${JSON.stringify({ type: schema })}\n${JSON.stringify({ edge_type: edgeTypeOf(edgeType) })}\n`,
  );
  return {
    a,
    b,
    edgeId,
    type,
    source,
    edgeType,
    bytes: blob,
    hash,
    archive,
  };
}

/** The audit entries the instance has recorded since `since` for the kinds of thing a restore writes. */
async function restoreAudit(since: string): Promise<string[]> {
  const listed = await working.listAudit({ created_after: since, limit: 200 });
  expect(listed.status, JSON.stringify(listed.error)).toBe(200);
  return listed.data.data
    .map((entry) => entry.action)
    .filter((action) =>
      /^(restore_archive|blob\.|type\.|edge_type\.|item\.|edge\.)/.test(action),
    );
}

async function expectNothingOf(rows: Carried, since: string): Promise<void> {
  expect((await working.getItem(rows.a)).status).toBe(404);
  expect((await working.getItem(rows.b)).status).toBe(404);
  expect((await working.getType(rows.type)).status).toBe(404);
  const edgeTypes = await operator.listEdgeTypes();
  expect(edgeTypes.status, JSON.stringify(edgeTypes.error)).toBe(200);
  expect(edgeTypes.data.data.map((one) => one.id)).not.toContain(rows.edgeType);
  expect((await operator.downloadBlob(rows.hash)).status).toBe(404);
  expect(await restoreAudit(since)).toEqual([]);
}

/** Everything the restore writes is on the instance. */
async function expectAllOf(rows: Carried): Promise<void> {
  expect((await working.getItem(rows.a)).status).toBe(200);
  expect((await working.getItem(rows.b)).status).toBe(200);
  expect((await working.getType(rows.type)).status).toBe(200);
  const edgeTypes = await operator.listEdgeTypes();
  expect(edgeTypes.data.data.map((one) => one.id)).toContain(rows.edgeType);
  const read = await operator.downloadBlob(rows.hash);
  expect(read.status).toBe(200);
  expect(new Uint8Array(read.data)).toEqual(rows.bytes);
}

/** The id of the newest event in the log, taken by writing one. */
async function eventCursor(): Promise<string> {
  const { eventId } = await baselineEventId(
    server.apiUrl,
    server.workingKey,
    async () => {
      const marker = await working.createItem({
        type: "core.note",
        properties: { body: "before the restore" },
      });
      expect(marker.status).toBe(201);
      return marker.data.item.id;
    },
  );
  return eventId;
}

function edgeIdOf(event: SseEvent): string | undefined {
  return (event.data as { edge?: { id?: string } } | undefined)?.edge?.id;
}

/**
 * The log from `eventId` to a write made now holds no event of the restore's
 * items or edge. The sentinel's own event settles the absence.
 */
async function expectNoEventsOf(rows: Carried, eventId: string): Promise<void> {
  await withStream(
    server.apiUrl,
    server.workingKey,
    { lastEventId: eventId },
    async (stream) => {
      const sentinel = await working.createItem({
        type: "core.note",
        properties: { body: "after the restore that did not finish" },
      });
      expect(sentinel.status).toBe(201);
      const { events } = await collectUntil(
        stream,
        (seen) => seen.some((one) => itemIdOf(one) === sentinel.data.item.id),
        "the sentinel write's event",
      );
      expect(
        events.filter(
          (one) =>
            [rows.a, rows.b].includes(itemIdOf(one) ?? "") ||
            edgeIdOf(one) === rows.edgeId,
        ),
      ).toEqual([]);
    },
  );
}

/** What is in the folder the restore spools into. */
function spooled(): Promise<string[]> {
  return spooledOn(server.controlSocket);
}

/** The events a stream has delivered, each with when it arrived. */
interface Watch {
  seen: { event: SseEvent; at: number }[];
}

function watching(response: Response): Watch {
  const watch: Watch = { seen: [] };
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  void (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      pending += decoder.decode(value, { stream: true });
      const end = pending.lastIndexOf("\n\n");
      if (end < 0) continue;
      for (const event of parseSse(pending.slice(0, end + 2))) {
        watch.seen.push({ event, at: performance.now() });
      }
      pending = pending.slice(end + 2);
    }
  })().catch(() => undefined);
  return watch;
}

function itemIdOf(event: SseEvent): string | undefined {
  return (event.data as { item?: { id?: string } } | undefined)?.item?.id;
}

describe("a restore that does not finish", () => {
  it("is the witness: the same archive restores whole once nothing stops it", async () => {
    const rows = carrying();
    const done = await ownerClient().restoreArchive(rows.archive);
    expect(done.status, JSON.stringify(done.error)).toBe(200);
    await expectAllOf(rows);
    expect(await diskHolds(server.controlSocket, rows.hash)).toBe(true);
  });

  it.each([
    { fault: "fail:audit=restore_archive", status: 500 },
    { fault: "fail:commit=restore_archive", status: 500 },
    { fault: "fail:commit-full=restore_archive", status: 507 },
    { fault: "fail:blob-write", status: 507 },
  ])(
    "leaves no item, type, edge type, event or audit record when a write fails ($fault), the next blob-integrity run removes the bytes it placed, and it restores whole when tried again",
    async ({ fault, status }) => {
      const rows = carrying();
      const eventId = await eventCursor();
      const since = new Date().toISOString();
      await server.setFault(fault);
      const refused = await ownerClient().restoreArchive(rows.archive);
      expect(refused.status, JSON.stringify(refused.error)).toBe(status);
      expect(
        (await server.faults()).find((one) => one.name === fault.split("=")[0])
          ?.fired,
      ).toBe(1);
      await server.clearFault();

      await expectNothingOf(rows, since);
      // Bytes it placed stay unrecorded, so nothing serves them, and the next
      // copy cleanup removes them.
      await runJob(operator, "blob-integrity");
      expect(await diskHolds(server.controlSocket, rows.hash)).toBe(false);
      expect(await spooled()).toEqual([]);

      await expectNoEventsOf(rows, eventId);

      const again = await ownerClient().restoreArchive(rows.archive);
      expect(again.status, JSON.stringify(again.error)).toBe(200);
      await expectAllOf(rows);
    },
  );

  it("leaves no item, type, edge type, event or audit record when the process stops while it writes, and the next copy cleanup removes the bytes it placed", async () => {
    const rows = carrying();
    const eventId = await eventCursor();
    const since = new Date().toISOString();
    await server.setFault("hold:restore:before-commit");
    const restoring = ownerClient()
      .restoreArchive(rows.archive)
      .then(
        (answer) => answer.status,
        () => 0,
      );
    await server.waitForHold("hold:restore:before-commit");
    // The witness that there is something to leave: the bytes are in place
    // before the items are committed.
    expect(await diskHolds(server.controlSocket, rows.hash)).toBe(true);

    await server.restart({ signal: "SIGKILL" });
    // A restore the process died under is never answered.
    expect(await restoring).toBe(0);
    ({ operator, working } = clientsFor(server));

    await expectNothingOf(rows, since);
    await expectNoEventsOf(rows, eventId);
    // No item names the bytes, so the cleanup of the next run removes them.
    await runJob(operator, "blob-integrity");
    expect(await diskHolds(server.controlSocket, rows.hash)).toBe(false);
    expect(await spooled()).toEqual([]);

    const again = await ownerClient().restoreArchive(rows.archive);
    expect(again.status, JSON.stringify(again.error)).toBe(200);
    await expectAllOf(rows);
  });
});

describe("a restore that is still writing", () => {
  it("shows other requests none of its items, registrations, blobs or events until it commits", async () => {
    const rows = carrying();
    const since = new Date().toISOString();
    await withStream(server.apiUrl, server.workingKey, {}, async (stream) => {
      const watch = watching(stream.response);
      // Record this key's use before the restore holds the write lock:
      // authentication can write last_used_at even for a read request.
      expect((await operator.listEdgeTypes()).status).toBe(200);
      await server.setFault("hold:restore:before-commit");
      const restoring = ownerClient().restoreArchive(rows.archive);
      await server.waitForHold("hold:restore:before-commit");

      // Every item is written, and the bytes are in place, and none of it shows.
      expect(await diskHolds(server.controlSocket, rows.hash)).toBe(true);
      await expectNothingOf(rows, since);
      const listed = await working.listItems({ source: rows.source });
      expect(listed.status).toBe(200);
      expect(listed.data.data).toEqual([]);
      expect(
        watch.seen.some((one) =>
          [rows.a, rows.b].includes(itemIdOf(one.event) ?? ""),
        ),
      ).toBe(false);

      const released = performance.now();
      await server.clearFault();
      const done = await restoring;
      expect(done.status, JSON.stringify(done.error)).toBe(200);

      await expectAllOf(rows);
      expect(
        (await working.listItems({ source: rows.source })).data.data,
      ).toHaveLength(2);
      await waitFor("the restore's events", () =>
        Promise.resolve(
          [rows.a, rows.b].every((id) =>
            watch.seen.some((one) => itemIdOf(one.event) === id),
          )
            ? true
            : undefined,
        ),
      );
      for (const one of watch.seen) {
        if ([rows.a, rows.b].includes(itemIdOf(one.event) ?? "")) {
          expect(one.at).toBeGreaterThanOrEqual(released);
        }
      }
    });
  });
});

describe("an archive whose blob the instance holds", () => {
  it("keeps the copy the disk holds and writes the bytes no second time", async () => {
    const rows = carrying();
    const first = await ownerClient().restoreArchive(rows.archive);
    expect(first.status, JSON.stringify(first.error)).toBe(200);
    const placed = statSync(diskPath(server, rows.hash));
    // The witness that a restore writes the bytes it carries: the first did.
    expect(placed.size).toBe(rows.bytes.length);
    await new Promise((resolve) => setTimeout(resolve, 50));

    const again = await ownerClient().restoreArchive(rows.archive);
    expect(again.status, JSON.stringify(again.error)).toBe(200);
    expect(again.data.blobs_imported).toBe(1);
    const held = statSync(diskPath(server, rows.hash));
    expect(held.ino).toBe(placed.ino);
    expect(held.mtimeMs).toBe(placed.mtimeMs);
    const copies = await operator.listBlobCopies(rows.hash);
    expect(copies.data.data.map((copy) => copy.kind)).toEqual(["disk"]);
  });

  it("replaces a disk copy that has rotted at the same size with the bytes the archive carries", async () => {
    const rows = carrying();
    const first = await ownerClient().restoreArchive(rows.archive);
    expect(first.status, JSON.stringify(first.error)).toBe(200);
    const path = diskPath(server, rows.hash);
    const rotted = new Uint8Array(rows.bytes.length).fill(0x2a);
    writeFileSync(path, rotted);

    const again = await ownerClient().restoreArchive(rows.archive);
    expect(again.status, JSON.stringify(again.error)).toBe(200);
    expect(new Uint8Array(readFileSync(path))).toEqual(rows.bytes);
    const read = await operator.downloadBlob(rows.hash);
    expect(read.status).toBe(200);
    expect(new Uint8Array(read.data)).toEqual(rows.bytes);
  });
});

describe("a writer while a restore writes", () => {
  it("refuses each kind of write at once, naming the restore, while reads and the restore itself go on", async () => {
    const rows = carrying();
    const source = (await working.getCurrentKey()).data.source as string;
    // Everything a write below needs exists before the restore takes the
    // writer, so a refusal is the restore's and not a missing piece's.
    const edgeType = `restorewriters.x${String(Date.now())}`;
    const registered = await ownerClient().registerEdgeType({
      id: edgeType,
      label: "Restore writers",
      cardinality: "many-to-many",
    });
    expect(registered.status, JSON.stringify(registered.error)).toBe(201);
    const ends: string[] = [];
    for (let at = 0; at < 2; at += 1) {
      const made = await working.createItem({
        type: "core.note",
        source,
        properties: { body: `before the restore ${String(at)}` },
      });
      expect(made.status, JSON.stringify(made.error)).toBe(201);
      ends.push(made.data.item.id);
    }
    const held = await working.getItem(ends[0]!);
    expect(held.status).toBe(200);
    const ledgerType = `user.restorewriters${String(Date.now())}`;
    const typed = await working.registerType({
      id: ledgerType,
      fields: { title: { type: "string" } },
      tables: { lines: { columns: { amount: { type: "number" } } } },
    } as never);
    expect(typed.status, JSON.stringify(typed.error)).toBe(201);
    const ledger = await working.createItem({
      type: ledgerType,
      properties: { title: "a ledger" },
    } as never);
    expect(ledger.status, JSON.stringify(ledger.error)).toBe(201);

    const writes: Record<string, () => Promise<ApiResponse<unknown>>> = {
      "POST /items": () =>
        working.createItem({
          type: "core.note",
          source,
          properties: { body: "refused: create" },
        }),
      "PATCH /items/{id}": () =>
        working.updateItem(ends[0]!, {
          version: held.data.item.version,
          properties: { body: "refused: update" },
        }),
      "POST /items/bulk": () =>
        working.bulkItems({
          items: [
            {
              type: "core.note",
              source,
              properties: { body: "refused: bulk" },
            },
          ],
        }),
      "POST /edges": () =>
        working.createEdge({
          source_id: ends[0]!,
          target_id: ends[1]!,
          edge_type: edgeType,
        }),
      "POST /edges/bulk": () =>
        working.bulkEdges({
          edges: [
            { source_id: ends[1]!, target_id: ends[0]!, edge_type: edgeType },
          ],
        }),
      "POST /blobs": () =>
        working.uploadBlob(
          new TextEncoder().encode(`refused: upload ${uuidv7()}`),
          "application/octet-stream",
        ),
      "POST /items/{id}/tables/{table}/rows": () =>
        working.writeRows(ledger.data.item.id, "lines", {
          operations: [{ op: "put", values: { amount: 1 } }],
        }),
      "POST /keys": () =>
        operator.createKey({
          label: "refused: key",
          source: `restore-writers-${uuidv7()}`,
          permissions: ["audit.read"],
        }),
      "PATCH /config": () => operator.patchConfig({ disk_reserve_bytes: 1 }),
    };

    const baseline = await working.listItems({ source });
    expect(baseline.status, JSON.stringify(baseline.error)).toBe(200);
    const keptIds = baseline.data.data.map((item) => item.id).sort();
    expect(keptIds).toEqual(
      expect.arrayContaining([...ends, ledger.data.item.id]),
    );
    await server.setFault("hold:restore:before-commit");
    const restoring = ownerClient().restoreArchive(rows.archive);
    await server.waitForHold("hold:restore:before-commit");
    try {
      for (const [door, write] of Object.entries(writes)) {
        const started = performance.now();
        const answer = await write();
        const took = performance.now() - started;
        const where = `${door}: ${JSON.stringify(answer.error)}`;
        expect(answer.status, where).toBe(503);
        expect(answer.error?.error.code, where).toBe("write_contention");
        const details = answer.error?.error.details as
          Record<string, unknown> | undefined;
        expect(details?.reason, where).toBe("restore_running");
        expect(details?.retry_after, where).toBe(5);
        expect(answer.headers.get("retry-after"), where).toBe("5");
        // The write wait is five seconds, so a refusal that waited it out
        // would take longer than this.
        expect(took, where).toBeLessThan(1_000);
      }

      // Reads go on.
      const listed = await working.listItems({ source });
      expect(listed.status, JSON.stringify(listed.error)).toBe(200);
      expect(listed.data.data.map((item) => item.id).sort()).toEqual(keptIds);

      // Health names the restore to a credential that may read the reasons.
      const health = await operator.rawRequest<{
        status: string;
        components: Record<string, { status: string; error?: string }>;
      }>("/health");
      expect(health.status).toBe(200);
      expect(health.data.components.database_write?.status).toBe("degraded");
      expect(health.data.components.database_write?.error).toMatch(/restore/i);
    } finally {
      await server.clearFault();
    }
    const done = await restoring;
    expect(done.status, JSON.stringify(done.error)).toBe(200);
    await expectAllOf(rows);

    // The witness that each refusal was the restore's: the same writes land
    // once it has committed, and nothing a refused write carried was kept.
    const after = await working.listItems({ source });
    expect(after.data.data.map((item) => item.id).sort()).toEqual(keptIds);
    for (const [door, write] of Object.entries(writes)) {
      const landed = await write();
      expect(
        landed.status,
        `${door}: ${JSON.stringify(landed.error)}`,
      ).toBeLessThan(300);
    }
  });
});

describe("a restore that does not commit and removes the bytes it placed", () => {
  it("keeps the bytes a committed item names, and removes those no item names", async () => {
    // A blob the instance holds an item for whose bytes are gone from the disk:
    // the restore brings them back, and the item is what names them.
    const kept = new TextEncoder().encode(`named by an item, ${uuidv7()}`);
    const keptHash = blobHash(kept);
    const upload = await working.uploadBlob(kept, "application/octet-stream");
    expect(upload.status, JSON.stringify(upload.error)).toBe(201);
    expect(await diskHolds(server.controlSocket, keptHash)).toBe(true);
    await loseBlobs(server, [keptHash]);

    const rows = carrying();
    const both = carryingBoth(rows, kept);
    await server.setFault("fail:commit=restore_archive");
    const refused = await ownerClient().restoreArchive(both);
    expect(refused.status, JSON.stringify(refused.error)).toBe(500);

    // The witness that bytes are taken back: the restore's own are, by the
    // next copy cleanup, which leaves those a committed item names.
    await runJob(operator, "blob-integrity");
    expect(await diskHolds(server.controlSocket, rows.hash)).toBe(false);
    expect(await diskHolds(server.controlSocket, keptHash)).toBe(true);
    // Placing the bytes again ended the loss, so the store reads them now.
    const read = await operator.downloadBlob(keptHash);
    expect(read.status).toBe(200);
    expect(new Uint8Array(read.data)).toEqual(kept);
    await server.clearFault();
  });

  it("keeps the bytes of an upload requested while the failed restore ran", async () => {
    const shared = new TextEncoder().encode(`sent twice, ${uuidv7()}`);
    const rows = carryingBoth(carrying(), shared);
    const sharedHash = blobHash(shared);
    await server.setFault("hold:restore:before-commit");
    await server.setFault("fail:commit=restore_archive");
    const restoring = ownerClient().restoreArchive(rows);
    await server.waitForHold("hold:restore:before-commit");
    expect(await diskHolds(server.controlSocket, sharedHash)).toBe(true);

    // The upload meets the bytes the restore placed, and waits for the restore
    // as it does for any request for the same bytes.
    // The held restore's own spool files are already in the folder, so the
    // upload is the one that adds a file.
    const restoreSpools = new Set(await spooled());
    const uploading = working.uploadBlob(shared, "application/octet-stream");
    await waitFor("the upload to be spooled behind the restore", async () =>
      (await spooled()).some((name) => !restoreSpools.has(name))
        ? true
        : undefined,
    );
    await server.clearFault("hold:restore:before-commit");

    expect((await restoring).status).toBe(500);
    const stored = await uploading;
    expect(stored.status, JSON.stringify(stored.error)).toBe(201);
    const read = await operator.downloadBlob(sharedHash);
    expect(read.status).toBe(200);
    expect(new Uint8Array(read.data)).toEqual(shared);
  });
});

function carryingBoth(rows: Carried, extra: Uint8Array): Uint8Array {
  const extraHash = blobHash(extra);
  const entries = listEntries(rows.archive).map((entry) => {
    if (entry.name === "manifest.json") {
      const manifest = JSON.parse(entry.body.toString("utf8")) as {
        blob_count: number;
        blobs: Record<string, unknown>;
      };
      manifest.blob_count += 1;
      manifest.blobs[extraHash] = {
        mime_type: "application/octet-stream",
        size_bytes: extra.length,
      };
      return { name: entry.name, body: JSON.stringify(manifest) };
    }
    return { name: entry.name, body: entry.body };
  });
  entries.push({ name: `blobs/${extraHash}`, body: Buffer.from(extra) });
  return tar(entries);
}
