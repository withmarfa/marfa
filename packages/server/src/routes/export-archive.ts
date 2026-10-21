/**
 * `GET /export?format=archive`: the `marfa-archive-v0.tar.gz` that
 * `POST /restore` reads.
 *
 * The export reads the whole selection before it sends a byte, because the
 * manifest comes first and carries the counts and the blob list, and a tar
 * header carries each entry's size. What it reads is kept in the disk
 * store's spool (`export-spool.ts`). Each page reads its rows and registrations
 * in one read snapshot, released before the page is spooled. The event
 * loop gets a turn between pages. The spooled selection then passes the
 * restore's own checks (`archive-validation.ts`). A selection that fails
 * them is read once more: writes between pages can combine into rows that
 * no single state held. If the second read holds the same rows and fails
 * the same way, the instance's own data is at fault and the refusal names
 * the row; otherwise writes were landing, and the caller is told to retry.
 * The tar is then written from the spool with backpressure, and the spool
 * is removed on every outcome. Each batch of spooled lines and each blob is
 * sent only after the credential has been asked again (`export-authority.ts`),
 * and a credential that ended or no longer reads what the archive has still to
 * send ends the response with an error. The manifest, which lists every blob,
 * and the type registrations are held only by the credential still standing,
 * not by what it reads.
 *
 * A blob no store can read whole is named under the manifest's
 * `missing_blobs` and left out, so one lost file costs the backup that file
 * and not the rest. Bytes that do not hash to their name are found only as
 * they are sent, and end the response with an error.
 */

import { createHash } from "node:crypto";
import { createInterface } from "node:readline";
import { PassThrough, Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import type { Context } from "hono";
import * as tar from "tar-stream";
import {
  ErrorCode,
  MarfaError,
  type Edge,
  type EdgeTypeSchema,
  type Item,
} from "@withmarfa/shared";
import { withPreparedHeaders } from "../prepared-headers.js";
import type { OwnerItemRead } from "./_owner-item-read.js";
import {
  ExportCredentialEnded,
  type CarriedRow,
  type ExportAuthority,
} from "./export-authority.js";
import type { Storage, ItemFilters, LoadedType } from "../storage/interface.js";
import {
  answeringFirst,
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
import { faultsArmed, holdArmed, holdAt } from "../control/faults.js";
import { readableExportEdges } from "./export-read.js";
import { log } from "../middleware/logger.js";
import {
  SelectionRefusal,
  refusalAt,
  runArchiveValidation,
  type RefusedRow,
} from "./archive-validation.js";
import type { DiskReserve } from "../storage/disk-space.js";
import {
  parseManifest,
  assertArchiveTextSize,
} from "./restore-archive-read.js";
import { withStatementFault } from "../storage/sqlite/injected-failure.js";
import { ExportSpool, type TextSpool } from "./export-spool.js";
import { beginArchiveExport } from "./export-lifecycle.js";
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
 * the store they come from, asking the stores in `unanswered` last and
 * adding to it a store that fails. Nothing of the entry is written yet, so
 * a store that fails here, or holds the blob short, gives way to the next.
 */
async function readWhole(
  storage: Storage,
  blobs: BlobLayer,
  hash: string,
  sizeBytes: number,
  unanswered: Set<string>,
  signal: AbortSignal,
): Promise<{ read: BlobRead; store: BlobStore }> {
  let failure: unknown;
  const stores = answeringFirst(
    await recordedStores(storage, blobs, hash),
    unanswered,
  );
  for (const store of stores) {
    let read: BlobRead | null;
    try {
      read = await within(
        (cancel) => store.get(hash, undefined, cancel),
        storeChecks.timeoutMs,
        { signal, late: (gone) => gone?.stream.destroy() },
      );
    } catch (error) {
      signal.throwIfAborted();
      unanswered.add(store.id);
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
  blobRecords: TextSpool;
  itemCount: number;
  edgeCount: number;
  typeCount: number;
  edgeTypeCount: number;
}

interface BlobSelection {
  /** The manifest's `blobs` entries, comma separated, without braces. */
  blobEntries: TextSpool;
  /** The manifest's `missing_blobs` entries, in the same form. */
  missingEntries: TextSpool;
  blobCount: number;
  listedBlobs: TextSpool;
}

export async function handleArchiveExport(
  c: HonoContext,
  storage: Storage,
  blobs: BlobLayer,
  /** The instance writing the archive, for the manifest. */
  instanceId: string,
  filter: ExportFilter,
  reader: OwnerItemRead,
  authority: ExportAuthority,
  reserve: DiskReserve,
  /** The largest properties this instance's write doors, and so its
   *  restore, take. */
  maxRowBytes: number,
  /** Whether the archive carries the bytes of the files it names. */
  withFiles: boolean,
): Promise<Response> {
  const active = beginArchiveExport(storage, c.req.raw.signal);
  try {
    const { response, finished } = await prepareArchiveExport(
      c,
      storage,
      blobs,
      instanceId,
      filter,
      reader,
      authority,
      reserve,
      maxRowBytes,
      withFiles,
      active.signal,
    );
    void finished.then(
      () => {
        active.finish();
      },
      (error: unknown) => {
        active.finish(error);
      },
    );
    return response;
  } catch (error) {
    active.finish();
    throw error;
  }
}

async function prepareArchiveExport(
  c: HonoContext,
  storage: Storage,
  blobs: BlobLayer,
  instanceId: string,
  filter: ExportFilter,
  reader: OwnerItemRead,
  authority: ExportAuthority,
  reserve: DiskReserve,
  maxRowBytes: number,
  withFiles: boolean,
  clientGone: AbortSignal,
): Promise<{ response: Response; finished: Promise<unknown> }> {
  clientGone.throwIfAborted();
  let spool = new ExportSpool(() => blobs.disk.spoolPath(), reserve);
  // A store that hung once is waited for once across both attempts and streaming.
  const unanswered = new Set<string>();
  const created = clock.now().toISOString();
  let selection!: Selection & BlobSelection;
  let head!: string;
  let first: { witness: string; row: RefusedRow } | undefined;
  for (let attempt = 1; ; attempt++) {
    let selected: Selection | undefined;
    try {
      selected = await collectSelection({
        storage,
        reader,
        authority,
        filter,
        spool,
        signal: clientGone,
      });
      selection = {
        ...selected,
        ...(await collectBlobs(
          storage,
          blobs,
          spool,
          selected.blobRecords,
          clientGone,
          unanswered,
          withFiles,
        )),
      };
      head = JSON.stringify({
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
      try {
        // `collectBlobs` checked the blob entries a page at a time.
        assertArchiveTextSize(
          Buffer.byteLength(`${head.slice(0, -1)},"blobs":{`) +
            selection.blobEntries.bytes +
            Buffer.byteLength('},"missing_blobs":{') +
            selection.missingEntries.bytes +
            2,
          "manifest.json",
        );
        parseManifest(`${head.slice(0, -1)},"blobs":{},"missing_blobs":{}}`);
      } catch (error) {
        if (error instanceof MarfaError)
          throw refusalAt({ kind: "manifest", id: null, type: null }, error);
        throw error;
      }
      await runArchiveValidation(
        {
          lineFiles: {
            "items.ndjson": selection.items.path,
            "edges.ndjson": selection.edges.path,
            "types.ndjson": selection.types.path,
          },
          maxRowBytes,
          database: await spool.database(),
        },
        reserve,
        clientGone,
      );
      clientGone.throwIfAborted();
      // The selection took a while to read and check, so ask once more
      // before the response starts: a credential that ended is refused as
      // its next request would be, with no byte sent.
      await authority.current();
      break;
    } catch (error) {
      // The refused row is read back from the spool before it is removed.
      const witness =
        error instanceof SelectionRefusal && selected
          ? await refusalWitness(selected, error.row).catch(() => undefined)
          : undefined;
      await spool.dispose();
      if (clientGone.aborted)
        return {
          response: new Response(null, { status: 499 }),
          finished: Promise.resolve(),
        };
      if (error instanceof MarfaError) throw error;
      if (!(error instanceof SelectionRefusal) || witness === undefined)
        throw new Error(
          `Archive export failed while reading or checking selection ${String(attempt)} of 2`,
          { cause: error },
        );
      log("warn", "Archive export selection would not restore", {
        request_id: c.get("requestId"),
        selection: attempt,
        row: error.row,
      });
      if (!first) {
        first = { witness, row: error.row };
        spool = new ExportSpool(() => blobs.disk.spoolPath(), reserve);
        continue;
      }
      // The same row refused the same way twice, with its own spooled line
      // and its type's registration unchanged between the reads, is the
      // instance's own data, which another try reads the same again.
      // Writes to other rows do not matter to that.
      if (
        first.witness === witness &&
        JSON.stringify(first.row) === JSON.stringify(error.row)
      )
        throw new MarfaError(
          ErrorCode.EXPORT_ROWS_UNRESTORABLE,
          `No archive was sent, because a restore would refuse or skip a row this instance holds. ${error.row.message} Correct the row or its type, then export again.`,
          { row: error.row },
        );
      throw new MarfaError(
        ErrorCode.EXPORT_UNRESTORABLE,
        "No archive was sent: writes changed the row the export refused, or the type it was checked against, between two reads. Retry the export.",
      );
    }
  }

  // The manifest is the head's object with the blob entries inside its
  // `blobs` member, streamed from the same spools validation read.
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
  const signal = AbortSignal.any([clientGone, stopped.signal]);
  const streamed = pipeline(pack, gzip, body, { signal }).catch(
    () => undefined,
  );

  const entry = (name: string, size: number, source: Readable) =>
    pipeline(source, pack.entry({ name, size }), { signal });
  const blobEntry = (
    hash: string,
    size: number,
    source: Readable,
    store: BlobStore,
  ) =>
    pipeline(
      source,
      new BlobReach(() => authority.blob(hash)),
      // The read was made outside the blob's upload lock, so the copy may
      // have been put right since: it is read again under the lock, as
      // `blob-integrity` reads it, and struck only if it is still wrong.
      new VerifyingTransform(hash, size, async () => {
        await withBlobUploadLock(hash, async () => {
          if (!(await copyIntact(store, hash, size, signal))) {
            await strikeCopy(storage, store, hash);
          }
        });
      }),
      pack.entry({ name: `blobs/${hash}`, size }),
      { signal },
    );

  const write = async (): Promise<void> => {
    await entry(
      "manifest.json",
      manifestSize,
      Readable.from(
        (async function* () {
          await authority.standing();
          yield manifestHead;
          for await (const chunk of heldBy(selection.blobEntries, () =>
            authority.standing(),
          )) {
            yield chunk;
          }
          yield manifestMiddle;
          for await (const chunk of heldBy(selection.missingEntries, () =>
            authority.standing(),
          )) {
            yield chunk;
          }
          yield manifestTail;
        })(),
      ),
    );
    // The line files are emitted even when empty, so that a member missing
    // from the tar is a damaged archive rather than an empty one. The restore
    // has no other way to tell those apart.
    await entry(
      "items.ndjson",
      selection.items.bytes,
      Readable.from(
        heldLines(selection.items, (lines) =>
          authority.rows(lines.map((line) => JSON.parse(line) as CarriedRow)),
        ),
        { objectMode: false },
      ),
    );
    await entry(
      "edges.ndjson",
      selection.edges.bytes,
      Readable.from(
        heldLines(selection.edges, (lines) =>
          authority.edges(
            lines.map((line) => (JSON.parse(line) as { edge: Edge }).edge),
          ),
        ),
        { objectMode: false },
      ),
    );
    await entry(
      "types.ndjson",
      selection.types.bytes,
      Readable.from(
        heldBy(selection.types, () => authority.standing()),
        { objectMode: false },
      ),
    );

    for await (const line of spooledLines(selection.listedBlobs)) {
      const { hash, size_bytes: size } = JSON.parse(line) as {
        hash: string;
        size_bytes: number;
      };
      await authority.blob(hash);
      // Content-addressed bytes cannot change with a database write. A
      // lost copy after the manifest was sent still cuts the archive short.
      const { read, store } = await readWhole(
        storage,
        blobs,
        hash,
        size,
        unanswered,
        signal,
      );
      await blobEntry(hash, size, read.stream, store);
    }
    pack.finalize();
  };

  const written = write()
    .catch((error: unknown) => {
      // A client that leaves aborts the writer on purpose, which is not a
      // fault. A failure also closes the body and so also sets the signal,
      // but it rejects with the failure rather than with the abort.
      if (
        signal.aborted &&
        error instanceof Error &&
        error.name === "AbortError"
      ) {
        pack.destroy();
        return;
      }
      if (error instanceof ExportCredentialEnded) {
        const { reason } = error;
        log("info", "Export ended with its credential", {
          request_id: c.get("requestId"),
          reason,
        });
        body.destroy(new ExportCredentialEnded(reason));
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
    .catch(() => undefined);
  const finished = Promise.all([written, streamed]).finally(() =>
    spool.dispose(),
  );

  const date = created.split("T")[0] ?? "today";
  return {
    finished,
    response: withPreparedHeaders(
      c,
      new Response(Readable.toWeb(body) as ReadableStream, {
        status: 200,
        headers: {
          "Content-Type": "application/gzip",
          "Content-Disposition": `attachment; filename="marfa-export-${date}.tar.gz"`,
        },
      }),
    ),
  };
}

async function collectSelection(input: {
  storage: Storage;
  reader: OwnerItemRead;
  authority: ExportAuthority;
  filter: ExportFilter;
  spool: ExportSpool;
  signal: AbortSignal;
}): Promise<Selection> {
  const { storage, reader, authority, filter, spool, signal } = input;
  const readsHistory = reader.reads;
  const items = await spool.text();
  const edges = await spool.text();
  const types = await spool.text();
  const blobRecords = await spool.text();
  const { itemIds, blobHashes } = await spool.sets();

  const registrations = new Map<string, LoadedType>();
  const edgeRegistrations = new Map<string, EdgeTypeSchema>();
  const captureRegistrations = async () => {
    // Keep removed registrations for carried rows, and replace retained
    // definitions whenever a later page sees them. The complete selection is
    // checked against the final registrations because schema.write also
    // permits replacements that invalidate older rows.
    for (const row of await storage.types.listRegisteredWithProvenance()) {
      registrations.set(row.schema.id, row);
    }
    for (const schema of await storage.edgeTypes.list()) {
      edgeRegistrations.set(schema.id, schema);
    }
  };
  const captureBlobs = async (
    hashes: Set<string>,
    refs = new Set<string>(),
  ) => {
    const records: BlobRecord[] = [];
    for (const hash of hashes) {
      if (!(await reader.blob(storage, hash))) continue;
      const record = await storage.blobs.get(hash);
      if (record)
        records.push({
          hash,
          mime_type: record.mime_type,
          size_bytes: record.size_bytes,
        });
      else if (refs.has(hash))
        records.push({ hash, mime_type: null, size_bytes: null });
    }
    return records;
  };
  const spoolBlobs = async (records: BlobRecord[]) => {
    const held = await blobHashes.held(records.map((record) => record.hash));
    const fresh = records.filter((record) => !held.has(record.hash));
    await blobRecords.append(
      fresh.map((record) => `${JSON.stringify(record)}\n`).join(""),
    );
    await blobHashes.add(fresh.map((record) => record.hash));
  };
  // Each page is read under the credential as it stands in the page's own
  // snapshot, so a key that ended stops the reading at the next page.
  const readPage = <T>(read: () => Promise<T>) =>
    storage.runInReadSnapshot(
      async () => {
        await authority.current();
        return read();
      },
      { deadlineAt: null, signal },
    );
  const turn = async () => {
    signal.throwIfAborted();
    await yieldBulkWork();
    signal.throwIfAborted();
  };

  let itemCount = 0;
  let cursor: string | undefined;
  do {
    await turn();
    const { rows, ids, records, next } = await readPage(async () => {
      const result = await withStatementFault("export-read", () =>
        storage.items.list({
          ...filter,
          limit: ITEMS_PER_PAGE,
          cursor,
        }),
      );
      if (faultsArmed()) await holdAt("read-hydration");
      const rows = [];
      const ids: string[] = [];
      const hashes = new Set<string>();
      const refs = new Set<string>();
      // Writer identity has the same reach as history, so a caller that may
      // not read the history learns no writer from it.
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
        const versions = await historyBelow(
          storage,
          item,
          readsHistory,
          hashes,
        );
        for (const row of [item, ...versions]) {
          const ref = fileBlobRef(row);
          if (ref) refs.add(ref);
        }
        rows.push({
          item,
          metadata,
          versions,
          writer: writers.get(item.id) ?? null,
          restored_at: restoredAt.get(item.id) ?? null,
          lending_blobs: lendingBlobs,
          lending_extensions: lendingExtensions,
        });
        ids.push(item.id);
        collectBlobHashes(item.properties, hashes);
        collectBlobHashes(metadata.extensions, hashes);
      }
      await captureRegistrations();
      return {
        rows,
        ids,
        records: await captureBlobs(hashes, refs),
        next: result.next_cursor,
      };
    });
    await items.append(rows.map((row) => `${JSON.stringify(row)}\n`).join(""));
    await itemIds.add(ids);
    await spoolBlobs(records);
    itemCount += rows.length;
    cursor = next ?? undefined;
    if (faultsArmed() && holdArmed("export-page")) await holdAt("export-page");
  } while (cursor);

  // Same both-endpoints rule as the NDJSON path: the archive carries the
  // relationships among the items it contains, nothing beyond.
  let edgeCount = 0;
  let edgeCursor: string | undefined;
  do {
    await turn();
    const { page, readable, lending, records } = await readPage(async () => {
      const page = await storage.edges.list({
        limit: PAGE,
        cursor: edgeCursor,
        source_filter: filter.source_filter,
      });
      const readable = await readableExportEdges(storage, reader, page.data);
      const lending = await storage.blobs.lendingHashesOfEdges(
        readable.map((edge) => edge.id),
      );
      await captureRegistrations();
      const hashes = new Set<string>();
      for (const edge of readable) collectBlobHashes(edge.properties, hashes);
      return { page, readable, lending, records: await captureBlobs(hashes) };
    });
    const exported = await itemIds.held(
      readable.flatMap((edge) => [edge.source_id, edge.target_id]),
    );
    const written = readable.filter(
      (edge) => exported.has(edge.source_id) && exported.has(edge.target_id),
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
    await spoolBlobs(records.filter((record) => hashes.has(record.hash)));
    edgeCount += lines.length;
    edgeCursor = page.next_cursor ?? undefined;
    if (faultsArmed() && holdArmed("export-page")) await holdAt("export-page");
  } while (edgeCursor);

  // Provenance belongs beside the schema: restore compares normalized schemas
  // and uses origin separately to preserve the registration's authority.
  await turn();
  let typeCount = 0;
  let edgeTypeCount = 0;
  const typeLines: string[] = [];
  for (const row of registrations.values()) {
    typeLines.push(
      `${JSON.stringify({ type: row.schema, provenance: { origin: row.origin } })}\n`,
    );
    typeCount += 1;
  }
  for (const schema of edgeRegistrations.values()) {
    typeLines.push(`${JSON.stringify({ edge_type: schema })}\n`);
    edgeTypeCount += 1;
  }
  await types.append(typeLines.join(""));

  await Promise.all([
    items.seal(),
    edges.seal(),
    types.seal(),
    blobRecords.seal(),
  ]);
  signal.throwIfAborted();
  return {
    items,
    edges,
    types,
    blobRecords,
    itemCount,
    edgeCount,
    typeCount,
    edgeTypeCount,
  };
}

interface BlobRecord {
  hash: string;
  mime_type: string | null;
  size_bytes: number | null;
}

/** Probe physical copies after releasing the page snapshots. The spool
 *  fixes which digests and sizes the manifest promises; copies can disappear
 *  independently of SQLite and are verified again when their bytes stream. */
async function collectBlobs(
  storage: Storage,
  blobs: BlobLayer,
  spool: ExportSpool,
  records: TextSpool,
  signal: AbortSignal,
  unanswered: Set<string>,
  withFiles: boolean,
): Promise<BlobSelection> {
  const blobEntries = await spool.text();
  const missingEntries = await spool.text();
  const listedBlobs = await spool.text();
  let blobCount = 0;
  let missingCount = 0;
  const page: BlobRecord[] = [];
  const flush = async () => {
    signal.throwIfAborted();
    const sizes = new Map<string, number>();
    for (const record of page) {
      if (record.size_bytes !== null) sizes.set(record.hash, record.size_bytes);
    }
    // Without files no copy is asked for, so every blob is named as one the
    // archive lacks.
    const copies = withFiles
      ? await wholeCopies(storage, blobs, sizes, { signal, unanswered })
      : new Map<string, BlobStore | null>();
    const present: string[] = [];
    const missing: string[] = [];
    const listed: string[] = [];
    const manifest = {
      version: 0,
      blobs: {} as Record<string, unknown>,
      missing_blobs: {} as Record<string, unknown>,
    };
    for (const { hash, mime_type, size_bytes } of page) {
      const entry = `${JSON.stringify(hash)}:${JSON.stringify({ mime_type, size_bytes })}`;
      if (copies.get(hash)) {
        present.push(entry);
        listed.push(`${JSON.stringify({ hash, size_bytes })}\n`);
        manifest.blobs[hash] = { mime_type, size_bytes };
      } else {
        missing.push(entry);
        manifest.missing_blobs[hash] = { mime_type, size_bytes };
      }
    }
    // The restore's own reading of a manifest, asked of a page of its
    // entries, so no part of the export holds or parses the whole of it.
    try {
      parseManifest(JSON.stringify(manifest));
    } catch (error) {
      if (error instanceof MarfaError)
        throw refusalAt({ kind: "blob", id: null, type: null }, error);
      throw error;
    }
    await blobEntries.append(
      present.map((one, i) => (blobCount + i === 0 ? one : `,${one}`)).join(""),
    );
    await missingEntries.append(
      missing
        .map((one, i) => (missingCount + i === 0 ? one : `,${one}`))
        .join(""),
    );
    await listedBlobs.append(listed.join(""));
    blobCount += present.length;
    missingCount += missing.length;
    page.length = 0;
  };
  for await (const line of spooledLines(records)) {
    page.push(JSON.parse(line) as BlobRecord);
    if (page.length === PAGE) await flush();
  }
  await flush();
  await Promise.all([
    blobEntries.seal(),
    missingEntries.seal(),
    listedBlobs.seal(),
  ]);
  return { blobEntries, missingEntries, listedBlobs, blobCount };
}

/**
 * What a refusal of `row` rests on, as the spooled selection holds it: the
 * row's own line and the registration of its type. Two reads that refuse
 * the same row with the same witness refuse it for what the instance holds
 * and not for a write in flight. A refusal about a row's relation to
 * others (a second id, an endpoint the selection lacks, a cycle) is judged
 * by the row's line too, because the second read repeated it. A refusal
 * that names no row line (the manifest, a blob) rests on the whole
 * selection.
 */
async function refusalWitness(
  selection: Selection,
  row: RefusedRow,
): Promise<string> {
  const hashing = createHash("sha256");
  const lineOf = async (
    spool: TextSpool,
    match: (parsed: Record<string, unknown>) => boolean,
  ): Promise<string> => {
    for await (const line of spooledLines(spool)) {
      try {
        const parsed: unknown = JSON.parse(line);
        if (
          typeof parsed === "object" &&
          parsed !== null &&
          match(parsed as Record<string, unknown>)
        )
          return line;
      } catch {
        // A line that does not parse is not the row.
      }
    }
    return "";
  };
  const field = (value: unknown, key: string) =>
    typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)[key]
      : undefined;
  if ((row.kind === "item" || row.kind === "edge") && row.id !== null) {
    const spool = row.kind === "item" ? selection.items : selection.edges;
    const own = await lineOf(
      spool,
      (parsed) => field(parsed[row.kind], "id") === row.id,
    );
    if (own !== "" && row.type !== null) {
      const registration = await lineOf(
        selection.types,
        (parsed) =>
          field(parsed[row.kind === "item" ? "type" : "edge_type"], "id") ===
          row.type,
      );
      hashing.update(own).update("\n").update(registration);
      return hashing.digest("hex");
    }
  }
  for (const file of [
    selection.items,
    selection.edges,
    selection.types,
    selection.blobRecords,
  ])
    hashing.update(file.digest());
  return hashing.digest("hex");
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
      if (snapshot.version >= item.version) continue;
      versions.push(snapshot);
      collectBlobHashes(snapshot.properties, hashes);
    }
    historyCursor = history.next_cursor ?? undefined;
  } while (historyCursor);
  return versions;
}

async function* spooledLines(spool: TextSpool): AsyncGenerator<string> {
  const stream = spool.read();
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) yield line;
  } finally {
    lines.close();
    stream.destroy();
  }
}

/** The spool's bytes, each chunk held until `standing` accepts it. */
async function* heldBy(
  spool: TextSpool,
  standing: () => Promise<void>,
): AsyncGenerator<Buffer> {
  for await (const chunk of spool.read()) {
    await standing();
    yield chunk as Buffer;
  }
}

/**
 * The spool's bytes, unchanged, in runs of whole lines. Each run is held
 * until `holds` accepts the lines it carries, which is the last thing awaited
 * before the run is handed on.
 */
async function* heldLines(
  spool: TextSpool,
  holds: (lines: string[]) => Promise<void>,
): AsyncGenerator<Buffer> {
  // The bytes of a line that has not ended yet, joined only when it does.
  let partial: Buffer[] = [];
  for await (const chunk of spool.read()) {
    const bytes = chunk as Buffer;
    const end = bytes.lastIndexOf(0x0a) + 1;
    if (end === 0) {
      partial.push(bytes);
      continue;
    }
    const whole = Buffer.concat([...partial, bytes.subarray(0, end)]);
    partial = end < bytes.length ? [bytes.subarray(end)] : [];
    await holds(whole.toString("utf8").split("\n").slice(0, -1));
    yield whole;
  }
  if (partial.length > 0) throw new Error("A spooled line file ended mid-line");
}

/** How many blob bytes pass between asking whether the credential still reads the blob. */
const BLOB_REACH_BYTES = 1024 * 1024;

/** Passes a blob's bytes on, asking `reaches` again for every megabyte. */
class BlobReach extends Transform {
  private since = 0;

  constructor(private readonly reaches: () => Promise<void>) {
    super();
  }

  override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null, data?: Buffer) => void,
  ): void {
    this.since += chunk.length;
    if (this.since < BLOB_REACH_BYTES) {
      callback(null, chunk);
      return;
    }
    this.since = 0;
    this.reaches().then(
      () => {
        callback(null, chunk);
      },
      (error: unknown) => {
        callback(
          error instanceof Error ? error : new Error(errorMessage(error)),
        );
      },
    );
  }
}
