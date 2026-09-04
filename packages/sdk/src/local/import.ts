import type { MarfaClient } from "../client.js";
import { paginate } from "../pagination.js";
import { putEdgeIfNotOlder, putItemIfNotOlder } from "./apply.js";
import type { LocalStore } from "./store/index.js";

/** How many rows a read asks for at a time. */
const PAGE_SIZE = 200;

export interface ImportOptions {
  store: LocalStore;
  client: MarfaClient;
  /**
   * Remove what the server no longer has.
   *
   * On for a re-import, which is the only thing that can find a removal
   * the client was away for. Off for a catch-up, which reads a slice and
   * would take the whole corpus for absent if it pruned against it.
   */
  prune: boolean;
  /**
   * Read only what changed at or after this. Omit to read everything.
   *
   * Inclusive, so the row sitting exactly on the mark comes back again;
   * the version comparison makes that a no-op rather than a problem, which
   * is what lets the bound be inclusive at all. A bound that excluded its
   * own instant would drop every row sharing a timestamp with it, and a
   * bulk write gives a great many rows the same one.
   */
  updatedAfter?: string;
  /**
   * Called as rows land, with the running totals.
   *
   * Counts rather than a percentage, and monotonic: they only ever rise,
   * so a progress display built on them cannot go backwards when a page
   * turns out to hold rows the store already had. What they are a
   * fraction of is the caller's business, because only the caller knows
   * whether it asked for the whole corpus or a slice of it.
   */
  onProgress?: (progress: { items: number; edges: number }) => void;
}

export interface ImportResult {
  items: number;
  edges: number;
  prunedItems: number;
  prunedEdges: number;
}

/** A re-import over unsent work would race the drain for the same rows. */
export class PendingWritesError extends Error {
  readonly pending: number;
  constructor(pending: number) {
    super(
      `@withmarfa/sdk/local: ${String(pending)} mutation(s) are still waiting to be sent. ` +
        `Drain the queue before importing: a read that lands while a write is in flight ` +
        `records a server state the write is about to change.`,
    );
    this.name = "PendingWritesError";
    this.pending = pending;
  }
}

/**
 * Read the server's state into the store, and optionally remove what the
 * server no longer has.
 *
 * This is the path a client takes when its cursor has aged out of the
 * event log, and the first read a fresh store makes. It runs against a
 * live subscription rather than instead of one, which is what decides most
 * of the care below: every write goes through the same version comparison
 * the stream uses, so an event delivered mid-walk is not undone by a page
 * that was already in flight when it arrived.
 */
export async function importAll(options: ImportOptions): Promise<ImportResult> {
  const { store, client, prune, updatedAfter, onProgress } = options;

  const queued = await store.outbox.list();

  // The refusal belongs to the prune and to nothing else.
  //
  // What it guards is measuring the corpus against a listing: a row a
  // pending write is about to create is absent from that listing, and
  // sweeping against it would delete the write. A read that does not
  // prune only ever writes forward, through the same version comparison
  // the stream uses, so it cannot touch a queued row at all — and
  // refusing there would take out the catch-up that runs on every
  // reconnect, which is exactly when a queue is least likely to be empty.
  //
  // A blocked row is not pending: it is not going anywhere on its own, and
  // refusing on one would strand the client that most needs to re-import,
  // permanently, since the import is what would let it rebase. The prune's
  // own protection covers those.
  if (prune) {
    const pending = queued.filter((entry) => entry.state === "pending");
    if (pending.length > 0) throw new PendingWritesError(pending.length);
  }

  // Captured before the read, and this is the whole reason the prune is
  // safe to run against a live stream. A row the stream delivers while the
  // walk is in progress is not in this set, so it cannot be mistaken for
  // one the server has dropped — which is exactly what comparing against
  // the store's state *after* the read would do.
  const heldItems = prune ? new Set(await store.server.items.listIds()) : null;
  const heldEdges = prune ? new Set(await store.server.edges.listIds()) : null;

  const seenItems = new Set<string>();
  const seenEdges = new Set<string>();
  let items = 0;
  let edges = 0;

  // Every state, trashed included. A client that read only active rows
  // would never see a row reach the bin, and would then keep showing one
  // the person deleted somewhere else.
  const itemPages = paginate((cursor) =>
    client.items.listWithMetadata({
      state: "any",
      limit: PAGE_SIZE,
      ...(updatedAfter === undefined ? {} : { updated_after: updatedAfter }),
      ...(cursor === undefined ? {} : { cursor }),
    }),
  );

  for await (const row of itemPages) {
    seenItems.add(row.item.id);
    await store.transaction(async (tx) => {
      const outcome = await putItemIfNotOlder(tx, row.item);
      // The metadata sidecar is written whatever the item's version said.
      // It carries no version of its own and has its own writer, so
      // skipping it because the item half was stale would leave the two
      // layers disagreeing about the same row for no stated reason.
      await tx.server.metadata.put(row.metadata);
      if (outcome === "applied") items += 1;
    });
    // Every row rather than every page, because a read that stalls
    // part-way through a page is exactly when a person is watching, and a
    // per-page report would sit still through it.
    onProgress?.({ items, edges });
  }

  const edgePages = paginate((cursor) =>
    client.edges.list({
      limit: PAGE_SIZE,
      ...(updatedAfter === undefined ? {} : { updated_after: updatedAfter }),
      ...(cursor === undefined ? {} : { cursor }),
    }),
  );

  for await (const edge of edgePages) {
    seenEdges.add(edge.id);
    await store.transaction(async (tx) => {
      if ((await putEdgeIfNotOlder(tx, edge)) === "applied") edges += 1;
    });
    onProgress?.({ items, edges });
  }

  if (heldItems === null || heldEdges === null) {
    return { items, edges, prunedItems: 0, prunedEdges: 0 };
  }

  // Anything this client's queue still names, whatever it is parked for. A
  // create is the case the contract names and the one that matters most —
  // the row exists nowhere but here, so the server was never going to
  // return it and pruning would delete the write itself — but an edit or a
  // removal waiting on a row is the same argument one step along.
  const claimed = new Set(queued.flatMap((e) => [e.targetId, ...e.dependsOn]));

  let prunedItems = 0;
  let prunedEdges = 0;
  await store.transaction(async (tx) => {
    for (const id of heldItems) {
      if (seenItems.has(id) || claimed.has(id)) continue;
      await tx.server.items.remove(id);
      prunedItems += 1;
    }
    // Edges as well as items, and this half is easy to leave out because
    // the rows read fine without it. An edge removed while this client was
    // away past the retention window has no event coming and no row in the
    // read, so nothing else will ever take it: the client is left holding
    // a relationship between rows it has correctly pruned.
    for (const id of heldEdges) {
      if (seenEdges.has(id) || claimed.has(id)) continue;
      await tx.server.edges.remove(id);
      prunedEdges += 1;
    }
  });

  return { items, edges, prunedItems, prunedEdges };
}
