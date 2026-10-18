/**
 * `GET /export?format=archive`: the `marfa-archive-v0.tar.gz` that
 * `POST /restore` reads.
 *
 * The export reads the whole selection before it sends a byte, because the
 * manifest comes first and carries the counts and the blob list, and a tar
 * header carries each entry's size. What it reads is kept in the disk
 * store's spool (`export-spool.ts`), not in memory, and the event loop gets a
 * turn between pages, so the memory it holds and the time it holds the
 * server for are one page's, not the instance's. The tar is then written
 * from the spool with backpressure, and the spool is removed on every
 * outcome.
 *
 * A blob no store can read whole is named under the manifest's
 * `missing_blobs` and left out, so one lost file costs the backup that file
 * and not the rest. Bytes that do not hash to their name are found only as
 * they are sent, and end the response with an error.
 */

import { createHash } from "node:crypto";
import { PassThrough, Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import type { Context } from "hono";
import * as tar from "tar-stream";
import type { Item } from "@withmarfa/shared";
import { withPreparedHeaders } from "../prepared-headers.js";
import type { OwnerItemRead } from "./_owner-item-read.js";
import type { Storage, ItemFilters } from "../storage/interface.js";
import {
  recordedStores,
  storeChecks,
  storeUnavailable,
  wholeCopies,
  within,
  type BlobLayer,
} from "../storage/blob-layer.js";
import { withBlobUploadLock } from "../storage/blob-upload-lock.js";
import { copyIntact, strikeCopy } from "../housekeeping/blob-strike.js";
import type { BlobRead, BlobStore } from "../storage/blob-store.js";
import { collectBlobHashes, fileBlobRef } from "../storage/blob-utils.js";
import { yieldBulkWork } from "../bulk-actions/yield.js";
import { errorMessage } from "../error-text.js";
import { loggablePath } from "../inbound/address.js";
import { streamFailure } from "../process-faults.js";
import { withStatementFault } from "../storage/sqlite/injected-failure.js";
import { ExportSpool, type KeySet, type TextSpool } from "./export-spool.js";
import * as clock from "../clock.js";

/** How many edges, blob digests or history snapshots are read at once. */
const PAGE = 200;

/** How many items are read between turns of the event loop. An item brings
 *  its metadata and history with it, so a page of items is the heaviest unit
 *  of work the export does, and a request waits for the loop for at most one
 *  page. */
const ITEMS_PER_PAGE = 25;

export interface ArchiveManifest {
  version: number;
  format: string;
  created_at: string;
  /**
   * The instance that produced the archive.
   *
   * Provenance, and nothing acts on it: `POST /restore` does
   * not read it, because restoring an instance's own archive into itself and
   * restoring another's are both supported and neither is an error to
   * detect. What it answers is the question a directory of `.tar.gz` files
   * cannot — which deployment this one came off — and `created_at` alone
   * cannot answer it for an operator running two.
   */
  instance_id: string;
  item_count: number;
  edge_count: number;
  blob_count: number;
  /** The type and edge-type registrations carried in `types.ndjson`. The
   *  type count is the instance's own registrations only — the export reads
   *  them through `listRegisteredWithProvenance`, which excludes the
   *  platform-seeded rows sharing the table. */
  type_count: number;
  edge_type_count: number;
  blobs: Record<string, { mime_type: string; size_bytes: number }>;
  /** The blobs the archive should carry that no store could read whole,
   *  in the shape of `blobs`, and not counted in `blob_count`. A blob the
   *  instance has no record of, which a file's `blob_ref` names, has a null
   *  type and size: nothing here knows them. */
  missing_blobs: Record<
    string,
    { mime_type: string | null; size_bytes: number | null }
  >;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type HonoContext = Context<any, any, any>;

/**
 * The bytes of the first recorded copy of `hash` that holds them whole, and
 * the store they come from. Nothing of the entry is written yet, so a store
 * that fails here, or holds the blob short, gives way to the next.
 */
async function readWhole(
  storage: Storage,
  blobs: BlobLayer,
  hash: string,
  sizeBytes: number,
): Promise<{ read: BlobRead; store: BlobStore }> {
  let failure: unknown;
  for (const store of await recordedStores(storage, blobs, hash)) {
    let read: BlobRead | null;
    try {
      read = await within(
        (signal) => store.get(hash, undefined, signal),
        storeChecks.timeoutMs,
        { late: (gone) => gone?.stream.destroy() },
      );
    } catch (error) {
      failure = storeUnavailable(store, hash, error);
      continue;
    }
    if (!read) continue;
    if (read.length === sizeBytes) return { read, store };
    read.stream.destroy();
  }
  throw new Error(`No store holds the whole bytes of ${hash}`, {
    cause: failure,
  });
}

/**
 * Passes bytes on while hashing them, and holds the last chunk back until
 * they are known to be the blob's, so an entry with other bytes ends short
 * and its tar is not well formed. Only `size` bytes that hash to another
 * name are evidence against the copy, and `onMismatch` is then asked to
 * judge it; a read that ends short says only that the read went wrong.
 */
class VerifyingTransform extends Transform {
  private readonly hashing = createHash("sha256");
  private held: Buffer | null = null;
  private bytes = 0;

  constructor(
    private readonly hash: string,
    private readonly size: number,
    private readonly onMismatch: () => Promise<void>,
  ) {
    super();
  }

  override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null, data?: Buffer) => void,
  ): void {
    this.hashing.update(chunk);
    this.bytes += chunk.length;
    const previous = this.held;
    this.held = chunk;
    callback(null, previous ?? undefined);
  }

  override _flush(callback: (error?: Error | null, data?: Buffer) => void) {
    if (this.bytes !== this.size) {
      callback(
        new Error(
          `The read of ${this.hash} ended after ${String(this.bytes)} of ${String(this.size)} bytes`,
        ),
      );
      return;
    }
    const actual = `sha256:${this.hashing.digest("hex")}`;
    if (actual === this.hash) {
      callback(null, this.held ?? undefined);
      return;
    }
    const mismatch = new Error(
      `The bytes read for ${this.hash} hash to ${actual}`,
    );
    this.onMismatch().then(
      () => {
        callback(mismatch);
      },
      (error: unknown) => {
        callback(new Error(mismatch.message, { cause: error }));
      },
    );
  }
}

/** The export's filter, resolved once by the route handler. */
export type ExportFilter = Pick<
  ItemFilters,
  | "type"
  | "state"
  | "all_states"
  | "exclude_states"
  | "source"
  | "occurred_after"
  | "occurred_before"
  | "allowed_types"
  | "excluded_types"
  | "source_filter"
>;

/** What the pass over the selection leaves in the spool. */
interface Selection {
  items: TextSpool;
  edges: TextSpool;
  types: TextSpool;
  /** The manifest's `blobs` entries, comma separated, without braces. */
  blobEntries: TextSpool;
  /** The manifest's `missing_blobs` entries, in the same form. */
  missingEntries: TextSpool;
  itemCount: number;
  edgeCount: number;
  typeCount: number;
  edgeTypeCount: number;
  blobCount: number;
  listedBlobs: KeySet;
}

export async function handleArchiveExport(
  c: HonoContext,
  storage: Storage,
  blobs: BlobLayer,
  /** The instance writing the archive, for the manifest. */
  instanceId: string,
  filter: ExportFilter,
  reader: OwnerItemRead,
): Promise<Response> {
  const clientGone = c.req.raw.signal;
  const spool = new ExportSpool(() => blobs.disk.spoolPath());

  let selection: Selection;
  try {
    selection = await collectSelection({
      storage,
      blobs,
      reader,
      filter,
      spool,
      signal: clientGone,
    });
  } catch (error) {
    await spool.dispose();
    // The client has left, so there is nobody to answer.
    if (clientGone.aborted) return new Response(null, { status: 499 });
    throw error;
  }

  const created = clock.now().toISOString();
  const head = JSON.stringify({
    version: 0,
    format: "marfa-archive-v0",
    created_at: created,
    instance_id: instanceId,
    item_count: selection.itemCount,
    edge_count: selection.edgeCount,
    blob_count: selection.blobCount,
    type_count: selection.typeCount,
    edge_type_count: selection.edgeTypeCount,
  } satisfies Omit<ArchiveManifest, "blobs" | "missing_blobs">);
  // The manifest is the head's object with the blob entries inside its
  // `blobs` member, cut open here so the entries are never held whole.
  const manifestHead = Buffer.from(`${head.slice(0, -1)},"blobs":{`);
  const manifestMiddle = Buffer.from('},"missing_blobs":{');
  const manifestTail = Buffer.from("}}");
  const manifestSize =
    manifestHead.length +
    selection.blobEntries.bytes +
    manifestMiddle.length +
    selection.missingEntries.bytes +
    manifestTail.length;

  const pack = tar.pack();
  const gzip = createGzip();
  const body = new PassThrough();
  const stopped = new AbortController();
  // A client that leaves ends the body from the other side: the web stream's
  // cancel destroys it, and this is what tells the writer below.
  body.once("close", () => {
    stopped.abort();
  });
  pipeline(pack, gzip, body).catch(() => undefined);

  const entry = (name: string, size: number, source: Readable) =>
    pipeline(source, pack.entry({ name, size }), { signal: stopped.signal });
  const blobEntry = (
    hash: string,
    size: number,
    source: Readable,
    store: BlobStore,
  ) =>
    pipeline(
      source,
      // The read was made outside the blob's upload lock, so the copy may
      // have been put right since: it is read again under the lock, as
      // `blob-integrity` reads it, and struck only if it is still wrong.
      new VerifyingTransform(hash, size, async () => {
        await withBlobUploadLock(hash, async () => {
          if (!(await copyIntact(store, hash, size))) {
            await strikeCopy(storage, store, hash);
          }
        });
      }),
      pack.entry({ name: `blobs/${hash}`, size }),
      { signal: stopped.signal },
    );

  const write = async (): Promise<void> => {
    await entry(
      "manifest.json",
      manifestSize,
      Readable.from(
        (async function* () {
          yield manifestHead;
          for await (const chunk of selection.blobEntries.read()) {
            yield chunk as Buffer;
          }
          yield manifestMiddle;
          for await (const chunk of selection.missingEntries.read()) {
            yield chunk as Buffer;
          }
          yield manifestTail;
        })(),
      ),
    );
    // The line files are emitted even when empty, so that a member missing
    // from the tar is a damaged archive rather than an empty one. The restore
    // has no other way to tell those apart.
    for (const [name, text] of [
      ["items.ndjson", selection.items],
      ["edges.ndjson", selection.edges],
      ["types.ndjson", selection.types],
    ] as const) {
      await entry(name, text.bytes, text.read());
    }

    let after: string | undefined;
    for (;;) {
      const hashes = await selection.listedBlobs.page(after, PAGE);
      for (const hash of hashes) {
        // The manifest listing the blob has been sent, so a blob whose
        // record or last copy went since the selection cuts the archive
        // short rather than leaving the entry out. A blob's record is never
        // rewritten, so its size is the one the selection judged by.
        const size = (await storage.blobs.get(hash))?.size_bytes;
        if (size === undefined) throw new Error(`${hash} is not registered`);
        const { read, store } = await readWhole(storage, blobs, hash, size);
        await blobEntry(hash, size, read.stream, store);
      }
      after = hashes.at(-1);
      if (hashes.length < PAGE) break;
    }
    pack.finalize();
  };

  void write()
    .catch((error: unknown) => {
      // A client that leaves aborts the writer on purpose, which is not a
      // fault. A failure also closes the body and so also sets the signal,
      // but it rejects with the failure rather than with the abort.
      if (
        stopped.signal.aborted &&
        error instanceof Error &&
        error.name === "AbortError"
      ) {
        pack.destroy();
        return;
      }
      // Ending the body with the failure is what makes the client see a
      // connection cut short and a gzip stream with no end, an archive that
      // cannot be mistaken for a complete one.
      const failure = streamFailure("Archive export failed", error, {
        request_id: c.get("requestId"),
        path: loggablePath(c.req.path),
      });
      body.destroy(
        failure instanceof Error ? failure : new Error(errorMessage(failure)),
      );
      pack.destroy();
    })
    .finally(() => spool.dispose())
    .catch(() => undefined);

  const date = created.split("T")[0] ?? "today";
  return withPreparedHeaders(
    c,
    new Response(Readable.toWeb(body) as ReadableStream, {
      status: 200,
      headers: {
        "Content-Type": "application/gzip",
        "Content-Disposition": `attachment; filename="marfa-export-${date}.tar.gz"`,
      },
    }),
  );
}

async function collectSelection(input: {
  storage: Storage;
  blobs: BlobLayer;
  reader: OwnerItemRead;
  filter: ExportFilter;
  spool: ExportSpool;
  signal: AbortSignal;
}): Promise<Selection> {
  const { storage, blobs, reader, filter, spool, signal } = input;
  const readsHistory = reader.reads;
  const items = await spool.text();
  const edges = await spool.text();
  const types = await spool.text();
  const blobEntries = await spool.text();
  const missingEntries = await spool.text();
  const { itemIds, blobHashes, fileRefs, listedBlobs } = await spool.sets();

  // Between pages, and nowhere else, the event loop gets its turn: a page is
  // read as a unit, so an item's row, metadata, lending digests and history
  // come from the same moment.
  const turn = async () => {
    signal.throwIfAborted();
    await yieldBulkWork();
    signal.throwIfAborted();
  };

  let itemCount = 0;
  let cursor: string | undefined;
  do {
    await turn();
    const result = await withStatementFault("export-read", () =>
      storage.items.list({
        ...filter,
        limit: ITEMS_PER_PAGE,
        cursor,
      }),
    );
    const lines: string[] = [];
    const ids: string[] = [];
    const hashes = new Set<string>();
    const refs = new Set<string>();
    // Of the version each row was read at, which a write since may have
    // moved the row past. A writer is held to the reach that holds the
    // snapshots, so a caller that may not read the history learns none.
    const writers = await storage.items.writersAt(
      result.data
        .filter((item) => readsHistory(item.type))
        .map((item) => ({ id: item.id, version: item.version })),
    );
    const restoredAt = await storage.items.restoredAtOf(
      result.data.map((item) => item.id),
    );
    for (const item of await reader.cascade(storage, result.data)) {
      const metadata = reader.metadata(await storage.metadata.get(item.id));
      // Which of the row's digests lend its reach, so a restore credits
      // those and no others. An extension namespace's are carried only for
      // the namespaces the line carries.
      const lendingBlobs = await storage.blobs.lendingHashesOf(item.id);
      const lendingExtensions = Object.fromEntries(
        Object.entries(
          await storage.blobs.lendingHashesOfExtensions(item.id),
        ).filter(([namespace]) => namespace in metadata.extensions),
      );
      const versions = await historyBelow(storage, item, readsHistory, hashes);
      for (const row of [item, ...versions]) {
        const ref = fileBlobRef(row);
        if (ref) refs.add(ref);
      }
      lines.push(
        JSON.stringify({
          item,
          metadata,
          versions,
          writer: writers.get(item.id) ?? null,
          restored_at: restoredAt.get(item.id) ?? null,
          lending_blobs: lendingBlobs,
          lending_extensions: lendingExtensions,
        }),
      );
      ids.push(item.id);
      collectBlobHashes(item.properties, hashes);
      collectBlobHashes(metadata.extensions, hashes);
    }
    await items.append(lines.map((line) => `${line}\n`).join(""));
    await itemIds.add(ids);
    await blobHashes.add(hashes);
    await fileRefs.add(refs);
    itemCount += lines.length;
    cursor = result.next_cursor ?? undefined;
  } while (cursor);

  // Same both-endpoints rule as the NDJSON path: the archive carries the
  // relationships among the items it contains, nothing beyond.
  let edgeCount = 0;
  let edgeCursor: string | undefined;
  do {
    await turn();
    const page = await storage.edges.list({ limit: PAGE, cursor: edgeCursor });
    // The NDJSON path's twin, and the same two halves: the endpoint rule
    // settles the source, and the edge map has to be asked for the kind of
    // relationship.
    const readable = page.data.filter((edge) => reader.edge(edge));
    const exported = await itemIds.held(
      readable.flatMap((edge) => [edge.source_id, edge.target_id]),
    );
    const written = readable.filter(
      (edge) => exported.has(edge.source_id) && exported.has(edge.target_id),
    );
    const lending = await storage.blobs.lendingHashesOfEdges(
      written.map((edge) => edge.id),
    );
    const lines: string[] = [];
    const hashes = new Set<string>();
    for (const edge of written) {
      lines.push(
        `${JSON.stringify({ edge, lending_blobs: lending.get(edge.id) ?? [] })}\n`,
      );
      collectBlobHashes(edge.properties, hashes);
    }
    await edges.append(lines.join(""));
    await blobHashes.add(hashes);
    edgeCount += lines.length;
    edgeCursor = page.next_cursor ?? undefined;
  } while (edgeCursor);

  // The instance's own registrations, not the filtered item set's: a
  // restore has to be able to write every item the archive carries,
  // and an unfiltered archive is the case that matters. Carrying a
  // type the archive happens not to use costs one line.
  // Provenance rides beside the schema rather than inside it. The
  // restore validates and normalizes `type` and compares the
  // result against the stored row to decide skip-or-conflict, so a
  // field added into the schema would read as a different registration
  // and turn every re-restore into a conflict.
  //
  // It is carried at all because `origin` is not descriptive: it decides
  // whether the consent screen offers a root read-only or
  // read-and-write. An archive without it restores as `unknown`,
  // read-only, so a `user` registration would come back without the
  // wildcard it earned.
  await turn();
  let typeCount = 0;
  let edgeTypeCount = 0;
  const typeLines: string[] = [];
  for (const row of await storage.types.listRegisteredWithProvenance()) {
    typeLines.push(
      `${JSON.stringify({ type: row.schema, provenance: { origin: row.origin } })}\n`,
    );
    typeCount += 1;
  }
  for (const schema of await storage.edgeTypes.list()) {
    typeLines.push(`${JSON.stringify({ edge_type: schema })}\n`);
    edgeTypeCount += 1;
  }
  await types.append(typeLines.join(""));

  // An archive carries only bytes the blob doors would serve this
  // caller: naming a digest in a row it may read lends nothing the
  // door would not, wherever in the row the digest sits.
  let blobCount = 0;
  let missingCount = 0;
  let after: string | undefined;
  for (;;) {
    await turn();
    const page = await blobHashes.page(after, PAGE);
    const listed: string[] = [];
    const entries: string[] = [];
    const missing: string[] = [];
    const records = new Map<
      string,
      { mime_type: string | null; size_bytes: number | null }
    >();
    const sizes = new Map<string, number>();
    // A digest with no record is a blob only where a file's `blob_ref`
    // names it; anywhere else it may be any run of hex.
    const refs = await fileRefs.held(page);
    for (const hash of page) {
      if (!(await reader.blob(storage, hash))) continue;
      const record = await storage.blobs.get(hash);
      if (record) {
        records.set(hash, record);
        sizes.set(hash, record.size_bytes);
      } else if (refs.has(hash)) {
        records.set(hash, { mime_type: null, size_bytes: null });
      }
    }
    const copies = await wholeCopies(storage, blobs, sizes, signal);
    for (const [hash, record] of records) {
      const entry = `${JSON.stringify(hash)}:${JSON.stringify({
        mime_type: record.mime_type,
        size_bytes: record.size_bytes,
      })}`;
      if (copies.get(hash)) {
        listed.push(hash);
        entries.push(entry);
      } else {
        missing.push(entry);
      }
    }
    await blobEntries.append(
      entries.map((one, i) => (blobCount + i === 0 ? one : `,${one}`)).join(""),
    );
    await missingEntries.append(
      missing
        .map((one, i) => (missingCount + i === 0 ? one : `,${one}`))
        .join(""),
    );
    await listedBlobs.add(listed);
    blobCount += listed.length;
    missingCount += missing.length;
    after = page.at(-1);
    if (page.length < PAGE) break;
  }

  await Promise.all([
    items.seal(),
    edges.seal(),
    types.seal(),
    blobEntries.seal(),
    missingEntries.seal(),
  ]);
  return {
    items,
    edges,
    types,
    blobEntries,
    missingEntries,
    itemCount,
    edgeCount,
    typeCount,
    edgeTypeCount,
    blobCount,
    listedBlobs,
  };
}

/** Every stored snapshot of `item` the caller may read, strictly below the
 *  version the export selected, with the blobs they name added to `hashes`. */
async function historyBelow(
  storage: Storage,
  item: Item,
  reads: OwnerItemRead["reads"],
  hashes: Set<string>,
) {
  const versions = [];
  let historyCursor: string | undefined;
  do {
    const history = await storage.versions.list(item.id, {
      reads,
      limit: PAGE,
      cursor: historyCursor,
    });
    for (const snapshot of history.data) {
      // A concurrent write may have snapshotted the row selected above.
      // That snapshot belongs to the next current version, not this one.
      if (snapshot.version >= item.version) continue;
      versions.push(snapshot);
      collectBlobHashes(snapshot.properties, hashes);
    }
    historyCursor = history.next_cursor ?? undefined;
  } while (historyCursor);
  return versions;
}
