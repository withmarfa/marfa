import { existsSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { v7 as uuidv7 } from "uuid";
import { MarfaClient } from "../../client/api.js";
import {
  blobHash,
  itemsArchive,
  listTarGzEntries,
  tarGz,
} from "../../utils/archive.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import {
  blobFolder,
  clientsFor,
  diskPath,
  runJob,
} from "../../utils/own-blob-server.js";
import { parseSse, type SseEvent } from "../../utils/sse.js";
import {
  baselineEventId,
  collectUntil,
  withStream,
} from "../../utils/stream.js";
import { TEST_OWNER } from "../../utils/target.js";
import { waitFor } from "../../utils/wait.js";

/**
 * What a restore leaves when it does not finish, and what other requests see
 * while it writes, on a server of the fixture's own. The fixtures stop a
 * restore where the target interface's faults say (`conformance/README.md`,
 * "Faults"): `hold:restore:before-commit` makes it wait with every row
 * written and nothing committed, `fail:audit`, `fail:commit` and
 * `fail:commit-full` fail the write that would commit it, and a `SIGKILL`
 * while it waits ends the process.
 *
 * Each case restores an archive of its own, so the rows, types, blobs and
 * events of one never stand for another's.
 */
let server: FreshServer;
let operator: MarfaClient;
let working: MarfaClient;

beforeAll(async () => {
  server = await bootFreshServer("restore-faults");
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
    ownerCookie: server.ownerCookie,
    ownerCredentials: TEST_OWNER,
    ownerSessionFile: `${server.stateDir}/owner-session.json`,
  });
}

const edgeTypeOf = (id: string) => ({
  id,
  cardinality: "many-to-many",
  source_type_constraints: ["*"],
  target_type_constraints: ["*"],
  cascade_on_delete: "orphan",
  property_schema: {},
  written_at: "source",
});

/** What an archive carries: a type, an edge type, a blob, two rows and an edge. */
interface Carried {
  a: string;
  b: string;
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
  const entries = listTarGzEntries(base).map((entry) => ({
    name: entry.name,
    body:
      entry.name === "edges.ndjson"
        ? `${JSON.stringify({
            edge: {
              id: uuidv7(),
              source_id: a,
              target_id: b,
              edge_type: edgeType,
            },
          })}\n`
        : entry.name === "types.ndjson"
          ? `${JSON.stringify({ type: schema })}\n${JSON.stringify({ edge_type: edgeTypeOf(edgeType) })}\n`
          : entry.body,
  }));
  return {
    a,
    b,
    type,
    source,
    edgeType,
    bytes: blob,
    hash,
    archive: tarGz(entries),
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

/** What is in the folder the restore spools into. */
function spooled(): string[] {
  const folder = join(blobFolder(server), "tmp");
  return existsSync(folder) ? readdirSync(folder) : [];
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
    expect(existsSync(diskPath(server, rows.hash))).toBe(true);
  });

  it.each([
    { fault: "fail:audit=restore_archive", status: 500 },
    { fault: "fail:commit=restore_archive", status: 500 },
    { fault: "fail:commit-full=restore_archive", status: 507 },
    { fault: "fail:blob-write", status: 507 },
  ])(
    "leaves no row, type, edge type, blob, event or audit record when a write fails ($fault), and restores whole when it is tried again",
    async ({ fault, status }) => {
      const rows = carrying();
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
      expect(existsSync(diskPath(server, rows.hash))).toBe(false);
      expect(spooled()).toEqual([]);

      // The log from before the restore to a write made after it holds none
      // of the restore's events: the sentinel settles the absence.
      await withStream(
        server.apiUrl,
        server.workingKey,
        { lastEventId: eventId },
        async (stream) => {
          const sentinel = await working.createItem({
            type: "core.note",
            properties: { body: "after the failed restore" },
          });
          expect(sentinel.status).toBe(201);
          const { events } = await collectUntil(
            stream,
            (seen) =>
              seen.some((one) => itemIdOf(one) === sentinel.data.item.id),
            "the sentinel write's event",
          );
          expect(
            events.filter((one) =>
              [rows.a, rows.b].includes(itemIdOf(one) ?? ""),
            ),
          ).toEqual([]);
        },
      );

      const again = await ownerClient().restoreArchive(rows.archive);
      expect(again.status, JSON.stringify(again.error)).toBe(200);
      await expectAllOf(rows);
    },
  );

  it("leaves no row, type, edge type, event or audit record when the process stops while it writes, and the next copy cleanup removes the bytes it placed", async () => {
    const rows = carrying();
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
    // before the rows are committed.
    expect(existsSync(diskPath(server, rows.hash))).toBe(true);

    await server.restart({ signal: "SIGKILL" });
    // A restore the process died under is never answered.
    expect(await restoring).toBe(0);
    ({ operator, working } = clientsFor(server));

    await expectNothingOf(rows, since);
    // No row names the bytes, so the cleanup of the next run removes them.
    await runJob(operator, "blob-integrity");
    expect(existsSync(diskPath(server, rows.hash))).toBe(false);
    expect(spooled()).toEqual([]);

    const again = await ownerClient().restoreArchive(rows.archive);
    expect(again.status, JSON.stringify(again.error)).toBe(200);
    await expectAllOf(rows);
  });
});

describe("a restore that is still writing", () => {
  it("shows other requests none of its rows, registrations, blobs or events until it commits", async () => {
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

      // Every row is written, and the bytes are in place, and none of it shows.
      expect(existsSync(diskPath(server, rows.hash))).toBe(true);
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

describe("a restore that does not commit and removes the bytes it placed", () => {
  it("keeps the bytes a committed row names, and removes those no row names", async () => {
    // A blob the instance holds a row for whose bytes are gone from the disk:
    // the restore brings them back, and the row is what names them.
    const kept = new TextEncoder().encode(`named by a row, ${uuidv7()}`);
    const keptHash = blobHash(kept);
    const upload = await working.uploadBlob(kept, "application/octet-stream");
    expect(upload.status, JSON.stringify(upload.error)).toBe(201);
    expect(existsSync(diskPath(server, keptHash))).toBe(true);
    unlinkSync(diskPath(server, keptHash));

    const rows = carrying();
    const both = carryingBoth(rows, kept);
    await server.setFault("fail:commit=restore_archive");
    const refused = await ownerClient().restoreArchive(both);
    expect(refused.status, JSON.stringify(refused.error)).toBe(500);

    // The witness that bytes are taken back: the restore's own were.
    expect(existsSync(diskPath(server, rows.hash))).toBe(false);
    expect(existsSync(diskPath(server, keptHash))).toBe(true);
    await server.clearFault();
    const read = await operator.downloadBlob(keptHash);
    expect(read.status).toBe(200);
    expect(new Uint8Array(read.data)).toEqual(kept);
  });

  it("keeps the bytes of an upload requested while the failed restore ran", async () => {
    const shared = new TextEncoder().encode(`sent twice, ${uuidv7()}`);
    const rows = carryingBoth(carrying(), shared);
    const sharedHash = blobHash(shared);
    await server.setFault("hold:restore:before-commit");
    await server.setFault("fail:commit=restore_archive");
    const restoring = ownerClient().restoreArchive(rows);
    await server.waitForHold("hold:restore:before-commit");
    expect(existsSync(diskPath(server, sharedHash))).toBe(true);

    // The upload meets the bytes the restore placed, and waits for the restore
    // as it does for any request for the same bytes.
    const uploading = working.uploadBlob(shared, "application/octet-stream");
    await waitFor("the upload to be spooled", () =>
      Promise.resolve(spooled().length > 0 ? true : undefined),
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
  const entries = listTarGzEntries(rows.archive).map((entry) => {
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
  return tarGz(entries);
}
