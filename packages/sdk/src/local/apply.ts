import type { Edge, Item } from "@withmarfa/shared";
import type { MarfaEvent } from "../events.js";
import type { LocalStore, LocalStoreScope } from "./store/index.js";

/**
 * What an inbound event did to the store.
 *
 * `stale` is a success, not a failure: the stream is at-least-once and the
 * catch-up read deliberately overlaps, so a payload older than the row held
 * is the ordinary shape of a replay rather than something going wrong.
 */
export type ApplyOutcome = "applied" | "stale";

/**
 * Write a row into server state unless what is held is already newer.
 *
 * The comparison the contract puts on inbound events, shared with the read
 * that hydrates and catches up — because those run against a live stream,
 * and a read that overwrote unconditionally would undo an event delivered
 * while it was walking. One rule with two callers rather than two rules
 * that agree until they do not.
 *
 * Not older, rather than strictly newer: an equal version is the same row
 * arriving twice, which has to settle rather than be refused.
 */
export async function putItemIfNotOlder(
  tx: LocalStoreScope,
  item: Item,
): Promise<ApplyOutcome> {
  const held = await tx.server.items.get(item.id);
  if (held !== undefined && item.version < held.version) return "stale";
  await tx.server.items.put(item);
  return "applied";
}

export async function putEdgeIfNotOlder(
  tx: LocalStoreScope,
  edge: Edge,
): Promise<ApplyOutcome> {
  const held = await tx.server.edges.get(edge.id);
  if (held !== undefined && edge.version < held.version) return "stale";
  await tx.server.edges.put(edge);
  return "applied";
}

/**
 * Apply one event to server state.
 *
 * Server state only. The visible projection is recomputed from it and the
 * outbox on every read, which is what stops another device's change hiding
 * an edit this client has typed and not yet sent.
 */
async function applyInto(
  tx: LocalStoreScope,
  event: MarfaEvent,
): Promise<ApplyOutcome> {
  if ("edge" in event) {
    if (event.type === "edge.deleted") {
      // An edge has no trash: deleted is gone. Unconditional, because a
      // removal carries no version worth comparing — the row it names is
      // not coming back under a higher one.
      await tx.server.edges.remove(event.edge.id);
      return "applied";
    }
    return putEdgeIfNotOlder(tx, event.edge);
  }

  if (event.type === "metadata.changed") {
    // The only event that writes the metadata layer, and it writes nothing
    // else. It carries the item as well, and taking that would give the
    // item layer a second writer whose payload is a side effect of a tag
    // change rather than a report about the item.
    if (event.metadata !== undefined) {
      await tx.server.metadata.put(event.metadata);
    }
    return "applied";
  }

  if (event.type === "item.purged") {
    // Gone for good, so the copy goes with it — along with its metadata,
    // which has nothing left to hang from. Nothing will ever correct a
    // copy kept past this, which is what separates it from a trashing.
    await tx.server.items.purge(event.item.id);
    return "applied";
  }

  // Everything else is the row as it now stands, `item.deleted` included:
  // that one says the row was trashed, and a trashed row is real state a
  // restore can bring back. This store reads every state on hydration, so
  // dropping it here would make the two paths disagree about what the
  // server holds.
  //
  // The metadata field is deliberately not read. An item event carries no
  // tags and no extensions even when the field is populated, so a write
  // from here would erase them on every ordinary edit — the reason the
  // layers are separate tables in the first place.
  return putItemIfNotOlder(tx, event.item);
}

/**
 * Apply an event and record where the stream has reached, as one write.
 *
 * The cursor moves after the event is applied and never before, so a
 * process that dies between them comes back to the event rather than past
 * it. One transaction is what makes that true: two statements would leave
 * a window where the cursor names an event the store never took.
 *
 * A throw from here leaves both untouched. The subscription awaits this
 * before advancing its own cursor, so a store that refuses an event stops
 * the stream at that event rather than skipping it.
 */
export async function applyEvent(
  store: LocalStore,
  event: MarfaEvent,
  eventId: string | undefined,
): Promise<ApplyOutcome> {
  return store.transaction(async (tx) => {
    const outcome = await applyInto(tx, event);
    if (eventId !== undefined) {
      await tx.syncState.setCursor(store.identity, eventId);
    }
    return outcome;
  });
}
