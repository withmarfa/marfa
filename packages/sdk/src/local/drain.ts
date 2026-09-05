import type { Edge, Item } from "@withmarfa/shared";
import type { MarfaClient } from "../client.js";
import { putEdgeIfNotOlder, putItemIfNotOlder } from "./apply.js";
import { classifyFailure, type Verdict } from "./classify.js";
import type { LocalStore } from "./store/index.js";
import type {
  LocalEngineEvent,
  LocalEngineEventListener,
  OutboxEntry,
} from "./types.js";

/**
 * How many attempts a transient failure gets before the mutation parks with
 * its reason.
 *
 * Only attempts made while the server was reachable count. Being offline is
 * not a failed attempt, so a laptop shut for a week arrives with its queue
 * intact rather than with everything parked.
 */
export const DEFAULT_RETRY_CEILING = 5;

export interface DrainOptions {
  store: LocalStore;
  client: MarfaClient;
  /** Transient attempts a mutation gets before it parks. */
  retryCeiling?: number;
  /**
   * Where the engine tells the app that work has stopped moving. Called
   * after the change is committed, so a listener that throws abandons the
   * pass without losing anything: the queue is restartable and the state it
   * reports is already on disk.
   */
  onEvent?: LocalEngineEventListener;
  now?: () => string;
}

export interface DrainResult {
  /** Mutations the server accepted on this pass. */
  sent: number;
  /** Mutations still queued afterwards, pending and blocked alike. */
  remaining: number;
  /** Whether the whole queue parked on auth. */
  parked: boolean;
  /** Whether the pass stopped because the server could not be reached. */
  offline: boolean;
}

export interface OutboxDrain {
  /**
   * Send what can be sent, in the order it was written.
   *
   * One pass. Nothing here loops or waits: when a mutation is retried is
   * the caller's decision, and a queue that retried on a timer of its own
   * would be a second scheduler beside the app's.
   */
  drain(): Promise<DrainResult>;
}

type SendResult =
  | { ok: true; item: Item }
  | { ok: true; edge: Edge }
  | { ok: true; removed: "item" | "edge" }
  | { ok: false; error: unknown };

/** Every id a mutation waits behind: its own target, plus an edge's two
 *  endpoints. */
function heldIds(entry: OutboxEntry): string[] {
  return [entry.targetId, ...entry.dependsOn];
}

export function createOutboxDrain(options: DrainOptions): OutboxDrain {
  const { store, client } = options;
  const ceiling = options.retryCeiling ?? DEFAULT_RETRY_CEILING;
  const now = options.now ?? (() => new Date().toISOString());
  const emit = (event: LocalEngineEvent): void => {
    options.onEvent?.(event);
  };

  const send = async (entry: OutboxEntry): Promise<SendResult> => {
    /**
     * The key the mutation was written with, sent on every door that takes
     * one.
     *
     * From the row rather than minted here, which is the whole mechanism: a
     * fresh key per attempt makes every attempt a separate write, and the
     * server then has nothing to recognize a repeat by. A create survives a
     * lost response either way, on the id the client minted, but a delete
     * has no such handle — the second attempt finds the row already gone
     * and is refused, so the engine would dead-letter a write the server
     * carried out.
     */
    const keyed = { idempotencyKey: entry.idempotencyKey };

    try {
      switch (entry.kind) {
        case "item.create": {
          const payload = entry.payload as {
            id: string;
            type: string;
            properties: Record<string, unknown>;
            tier?: Item["tier"];
            timestamp?: string;
            source_id?: string;
          };
          return { ok: true, item: await client.items.create(payload, keyed) };
        }
        case "item.update": {
          const payload = entry.payload as {
            properties: Record<string, unknown>;
            type?: string;
          };
          // The version the row was read at. A null on the entry means the
          // row's own create was still queued when the edit was made, so
          // the version to name is the one that create's response carried —
          // which is in server state precisely because this pass sent the
          // create first.
          const known = await store.server.items.get(entry.targetId);
          const expectedVersion = entry.baseVersion ?? known?.version;
          const item = await client.items.update(
            entry.targetId,
            payload.properties,
            {
              ...(expectedVersion === undefined ? {} : { expectedVersion }),
              ...(payload.type === undefined
                ? known === undefined
                  ? {}
                  : { type: known.type }
                : { type: payload.type }),
              // Stated rather than inherited. The client's default has
              // been `auto` throughout; what changed is what `auto` does,
              // not what the default is — so this line documents rather
              // than alters, and is worth keeping for that. The kit
              // once merged a conflict in this process and spawned the
              // sibling resolution can call for as a plain second create —
              // an engine keeping a resolution rule of its own, which a
              // second device on a different kit would settle differently.
              // The server now merges inside the write's transaction, once,
              // by the type's policy, for every client. So "auto" is the
              // engine declining to guess rather than asking to be told:
              // what comes back is the row the server settled on, and the
              // only 409 left is one it could not merge at all.
              conflict: "auto",
              // The merged row arrives through the ordinary settle and
              // looks like any other write, so without this a person's
              // text leaves the row they typed it into with nothing said.
              // `conflictedCopyId` is also the only place the sibling is
              // named — no route reports what a write created — so an app
              // that does not read it here cannot find the copy until the
              // stream happens to deliver it.
              onAutoMerge: (merged) => {
                emit({
                  type: "mutation.merged",
                  seq: entry.seq,
                  id: entry.id,
                  fields: merged.fields,
                  strategy: merged.strategy,
                  ...(merged.conflictedCopyId === undefined
                    ? {}
                    : { conflictedCopyId: merged.conflictedCopyId }),
                });
              },
            },
          );
          return { ok: true, item };
        }
        case "item.delete": {
          await client.items.delete(entry.targetId, keyed);
          return { ok: true, removed: "item" };
        }
        case "edge.create": {
          const payload = entry.payload as {
            id: string;
            edge_type: string;
            source_id: string;
            target_id: string;
            properties: Record<string, unknown>;
          };
          return { ok: true, edge: await client.edges.create(payload, keyed) };
        }
        case "edge.update": {
          const payload = entry.payload as {
            properties: Record<string, unknown>;
          };
          const known = await store.server.edges.get(entry.targetId);
          const version = entry.baseVersion ?? known?.version;
          const edge = await client.edges.update(
            entry.targetId,
            payload.properties,
            version === undefined ? undefined : { version },
          );
          return { ok: true, edge };
        }
        case "edge.delete": {
          await client.edges.delete(entry.targetId, keyed);
          return { ok: true, removed: "edge" };
        }
      }
    } catch (error) {
      return { ok: false, error };
    }
  };

  /**
   * Write what the server answered into server state and take the mutation
   * off the queue, as one transaction.
   *
   * Two statements that must not come apart: settle in two steps and a
   * crash between them either loses the write or sends it twice.
   */
  const settle = async (
    entry: OutboxEntry,
    result: Extract<SendResult, { ok: true }>,
  ): Promise<void> => {
    await store.transaction(async (tx) => {
      // Through the same comparison the stream uses. What the server
      // returns describes the row at the version this write produced,
      // which is not necessarily the newest one held: an event carrying a
      // later version can arrive and be applied while this write is still
      // in flight, and writing the answer over it unconditionally would
      // undo an event no later delivery will repeat.
      if ("item" in result) await putItemIfNotOlder(tx, result.item);
      else if ("edge" in result) await putEdgeIfNotOlder(tx, result.edge);
      else if (result.removed === "item") {
        // The server has trashed the row. It is gone from what this client
        // holds until the stream's own event or a re-import brings it back
        // as trashed — leaving it in server state instead would put it back
        // on screen the moment the mutation left the queue.
        //
        // The tags stay. A trashing keeps the row on the server, so taking
        // the sidecar here would leave a restore bringing the item back
        // stripped, with nothing to correct it until a metadata event or a
        // full re-read happens along.
        await tx.server.items.remove(entry.targetId);
      } else {
        await tx.server.edges.remove(entry.targetId);
      }
      await tx.outbox.remove(entry.seq);
    });
  };

  /**
   * Move a refused mutation to the dead-letter log, and take its dependants
   * with it when the refusal was a create.
   *
   * A create the server refused leaves nothing for a later edit or an edge
   * to name, so retrying those would only produce the same refusal with a
   * less useful reason. An update or a delete refused against a row that
   * does exist takes nothing with it.
   */
  const deadLetter = async (
    entry: OutboxEntry,
    verdict: Extract<Verdict, { class: "permanent" }>,
  ): Promise<{ events: LocalEngineEvent[]; removed: number[] }> => {
    const at = now();
    const events: LocalEngineEvent[] = [];
    const removed: number[] = [entry.seq];

    await store.transaction(async (tx) => {
      await tx.deadLetters.record({
        id: entry.id,
        seq: entry.seq,
        kind: entry.kind,
        targetKind: entry.targetKind,
        targetId: entry.targetId,
        payload: entry.payload,
        reason: "refused",
        code: verdict.code,
        message: verdict.message,
        httpStatus: verdict.httpStatus,
        failedAt: at,
      });
      await tx.outbox.remove(entry.seq);
      events.push({
        type: "mutation.dead_lettered",
        seq: entry.seq,
        id: entry.id,
        reason: "refused",
        code: verdict.code,
        message: verdict.message,
      });

      if (!entry.kind.endsWith(".create")) return;

      // Close over the dependants: an edge that cascades takes the edits to
      // that edge with it.
      const doomed = new Set([entry.targetId]);
      const queued = await tx.outbox.list();
      let grew = true;
      while (grew) {
        grew = false;
        for (const candidate of queued) {
          if (doomed.has(candidate.targetId)) continue;
          if (heldIds(candidate).some((id) => doomed.has(id))) {
            doomed.add(candidate.targetId);
            grew = true;
          }
        }
      }

      for (const candidate of queued) {
        if (!heldIds(candidate).some((id) => doomed.has(id))) continue;
        await tx.deadLetters.record({
          id: candidate.id,
          seq: candidate.seq,
          kind: candidate.kind,
          targetKind: candidate.targetKind,
          targetId: candidate.targetId,
          payload: candidate.payload,
          reason: "cascaded",
          code: verdict.code,
          message: `Waiting on ${entry.kind} ${entry.targetId}, which the server refused: ${verdict.message}`,
          httpStatus: verdict.httpStatus,
          failedAt: at,
        });
        await tx.outbox.remove(candidate.seq);
        removed.push(candidate.seq);
        events.push({
          type: "mutation.dead_lettered",
          seq: candidate.seq,
          id: candidate.id,
          reason: "cascaded",
          code: verdict.code,
          message: `Waiting on ${entry.kind} ${entry.targetId}, which the server refused`,
        });
      }
    });

    return { events, removed };
  };

  const finish = async (
    sent: number,
    parked: boolean,
    offline: boolean,
  ): Promise<DrainResult> => {
    const remaining = await store.outbox.count();
    if (remaining === 0 && sent > 0) {
      await store.syncState.setLastDrainedAt(store.identity, now());
    }
    emit({ type: "drain.finished", sent, remaining });
    return { sent, remaining, parked, offline };
  };

  return {
    drain: async () => {
      const queued = await store.outbox.list();
      /** Ids with unsent work in front of them on this pass. */
      const waiting = new Set<string>();
      // A cascade takes rows out of the queue that this pass is still
      // walking. Sending one of those repeats a write the engine has
      // already given up on, against a row the server refused to create.
      const gone = new Set<number>();
      let sent = 0;

      for (const entry of queued) {
        if (gone.has(entry.seq)) continue;
        // What this mutation waits on, and what it makes others wait on,
        // are deliberately not the same set. An edge waits behind either
        // endpoint's unsent create, so both are tested. But only the row
        // this mutation is *about* is held back by it — adding the
        // endpoints would make an item wait behind an edge, and an item
        // parked behind a blocked edge is never sent, never blocked and
        // never dead-lettered: it is skipped on every pass, counted as
        // pending with no reason attached, and clears only when somebody
        // acts on an edge that has nothing to do with it.
        //
        // Transitivity still holds, because each later mutation is tested
        // with its own `heldIds` against everything already waiting.
        const held = heldIds(entry).some((id) => waiting.has(id));
        if (entry.state === "blocked" || held) {
          waiting.add(entry.targetId);
          continue;
        }

        const result = await send(entry);
        if (result.ok) {
          await settle(entry, result);
          sent += 1;
          continue;
        }

        const verdict = classifyFailure(result.error, entry.kind);
        switch (verdict.class) {
          case "offline":
            // Nothing was refused and nothing else in the queue will reach
            // the server either, so the pass ends here with no attempt
            // recorded against anything.
            return finish(sent, false, true);

          case "auth": {
            const parked = await store.outbox.blockAll("auth", now());
            emit({
              type: "queue.parked",
              reason: "auth",
              parked,
              message: verdict.message,
            });
            return finish(sent, true, false);
          }

          case "blocked": {
            await store.outbox.block(entry.seq, verdict.reason, now());
            emit({
              type: "mutation.blocked",
              seq: entry.seq,
              id: entry.id,
              reason: verdict.reason,
              message: verdict.message,
            });
            waiting.add(entry.targetId);
            break;
          }

          case "conflict": {
            // Parked with the edit intact, and with no attempt to settle
            // it here. Retrying would send the same stale base version and
            // meet the same refusal, and merging would be this engine
            // deciding an outcome that is the server's to decide, so the
            // one honest move is to hand it to the app: the row is still
            // queued, still on screen, and waiting to be re-applied over
            // what the server now holds or dropped.
            await store.outbox.block(entry.seq, "needs_review", now());
            emit({
              type: "mutation.blocked",
              seq: entry.seq,
              id: entry.id,
              reason: "needs_review",
              message: verdict.message,
            });
            waiting.add(entry.targetId);
            break;
          }

          case "permanent": {
            const cascade = await deadLetter(entry, verdict);
            for (const seq of cascade.removed) gone.add(seq);
            for (const event of cascade.events) emit(event);
            break;
          }

          case "transient": {
            await store.outbox.recordAttempt(entry.seq, verdict.message, now());
            if (entry.attempts + 1 >= ceiling) {
              await store.outbox.block(entry.seq, "retry_ceiling", now());
              emit({
                type: "mutation.blocked",
                seq: entry.seq,
                id: entry.id,
                reason: "retry_ceiling",
                message: verdict.message,
              });
            }
            waiting.add(entry.targetId);
            break;
          }
        }
      }

      return finish(sent, false, false);
    },
  };
}
