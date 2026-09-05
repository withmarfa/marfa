import type { Edge, Item } from "@withmarfa/shared";
import type { MarfaClient } from "../client.js";
import { putEdgeIfNotOlder, putItemIfNotOlder } from "./apply.js";
import { classifyFailure, type Verdict } from "./classify.js";
import type { LocalStore } from "./store/index.js";
import type { BlobRefusal, LocalBlobs } from "./blobs.js";
import type { LocalTypeGraph } from "./type-graph.js";
import { localRefusalFor } from "./validate.js";
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
  /**
   * The local type graph, for the one refresh a schema refusal buys.
   *
   * Optional, and its absence is a real configuration rather than an
   * oversight: an engine wired without it treats a schema refusal as
   * final on the first answer, which is the older behavior and the right
   * one when there is no graph to be stale.
   */
  types?: LocalTypeGraph;
  /**
   * The blob queue, for the uploads that go in front of the writes that
   * name them.
   *
   * Optional in the same way `types` is. Without it nothing uploads, and
   * a write naming a blob this store staged is held rather than sent —
   * which is the honest answer, because sending it would put a reference
   * on the server to bytes the server does not have.
   */
  blobs?: LocalBlobs;
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
              // The key the mutation was written with, which every other
              // door has carried since the queue started minting them.
              // Without it a replayed update is a second write: the
              // server derives a `keep_both_copies` sibling's id from
              // this, so a lost answer spawned a second copy of the
              // losing text with nothing linking it to the first.
              ...keyed,
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

  /**
   * The type and the whole property bag this mutation would present to the
   * server, for revalidating against a refreshed graph.
   *
   * Undefined for anything that has no item type to validate against: an
   * edge write, a delete, or an update whose row this store no longer
   * holds. The caller sends again rather than guessing, which is the
   * conservative direction — the server is the authority and a second
   * refusal costs one request.
   */
  const validatable = async (
    entry: OutboxEntry,
  ): Promise<
    { type: string; properties: Record<string, unknown> } | undefined
  > => {
    if (entry.kind === "item.create") {
      const payload = entry.payload as {
        type?: string;
        properties?: Record<string, unknown>;
      };
      if (payload.type === undefined) return undefined;
      return { type: payload.type, properties: payload.properties ?? {} };
    }
    if (entry.kind !== "item.update") return undefined;
    // The visible row, which is server state with this very update already
    // replayed over it — so it is the merged bag the server will validate,
    // not the patch.
    const held = await store.visible.getItem(entry.targetId);
    if (held === undefined) return undefined;
    return { type: held.type, properties: held.properties };
  };

  /**
   * Dead-letter every queued mutation that names one of these blobs.
   *
   * A create the server refused cascades through `deadLetter`, which walks
   * the queue for dependants. A refused *upload* is the same shape from
   * the other end: nothing that references those bytes can ever succeed,
   * because the reference would resolve to nothing on the server. The
   * bytes stay on disk either way — that is the half of rule 14 the person
   * cares about.
   */
  const cascadeRefusedBlobs = async (
    refusals: BlobRefusal[],
  ): Promise<{ events: LocalEngineEvent[]; removed: number[] }> => {
    const events: LocalEngineEvent[] = [];
    const removed: number[] = [];
    if (refusals.length === 0) return { events, removed };
    const at = now();
    const byHash = new Map(refusals.map((refusal) => [refusal.hash, refusal]));

    await store.transaction(async (tx) => {
      const queued = await tx.outbox.list();

      // The writes that name the refused bytes directly, and then
      // everything that waits on those — an edit to the item the
      // attachment was on, an edge pointing at it. The closure is the same
      // one a refused create takes, and for the same reason: the row those
      // dependants name is never going to exist on the server, so sending
      // them produces a 404 apiece and a dead letter that says the wrong
      // thing about why.
      const cause = new Map<string, BlobRefusal>();
      for (const candidate of queued) {
        const refusal = candidate.dependsOn
          .map((id) => byHash.get(id))
          .find((found) => found !== undefined);
        if (refusal !== undefined) cause.set(candidate.targetId, refusal);
      }
      let grew = true;
      while (grew) {
        grew = false;
        for (const candidate of queued) {
          if (cause.has(candidate.targetId)) continue;
          const inherited = heldIds(candidate)
            .map((id) => cause.get(id))
            .find((found) => found !== undefined);
          if (inherited === undefined) continue;
          cause.set(candidate.targetId, inherited);
          grew = true;
        }
      }

      for (const candidate of queued) {
        const refusal = heldIds(candidate)
          .map((id) => cause.get(id))
          .find((found) => found !== undefined);
        if (refusal === undefined) continue;
        const message = `Waiting on the upload of ${refusal.hash}, which the server refused: ${refusal.message}. The bytes are kept.`;
        await tx.deadLetters.record({
          id: candidate.id,
          seq: candidate.seq,
          kind: candidate.kind,
          targetKind: candidate.targetKind,
          targetId: candidate.targetId,
          payload: candidate.payload,
          reason: "cascaded",
          code: refusal.code,
          message,
          httpStatus: refusal.httpStatus,
          failedAt: at,
        });
        await tx.outbox.remove(candidate.seq);
        removed.push(candidate.seq);
        events.push({
          type: "mutation.dead_lettered",
          seq: candidate.seq,
          id: candidate.id,
          reason: "cascaded",
          code: refusal.code,
          message,
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
      /** Ids with unsent work in front of them on this pass. */
      const waiting = new Set<string>();
      // A cascade takes rows out of the queue that this pass is still
      // walking. Sending one of those repeats a write the engine has
      // already given up on, against a row the server refused to create.
      const gone = new Set<number>();
      let sent = 0;

      // Uploads first, and the whole of rule 14's ordering is in that one
      // word. A write that names a blob is sent only after the bytes are
      // on the server, so a reference on the server never points at
      // nothing — and this is the only place that ordering is enforced,
      // because the queue's own ordering is by when a mutation was made
      // rather than by what it depends on.
      if (options.blobs !== undefined) {
        const flushed = await options.blobs.flush();
        const cascade = await cascadeRefusedBlobs(flushed.refused);
        for (const seq of cascade.removed) gone.add(seq);
        for (const event of cascade.events) emit(event);
        if (flushed.auth !== undefined) {
          const parked = await store.outbox.blockAll("auth", now());
          emit({
            type: "queue.parked",
            reason: "auth",
            parked,
            message: flushed.auth,
          });
          return finish(0, true, false);
        }
        if (flushed.offline) return finish(0, false, true);
      }

      const queued = await store.outbox.list();

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

        // Blobs this store staged and has not landed. `pending` holds the
        // write; `failed` ends it, because the reference would resolve to
        // nothing on the server and no amount of waiting changes that.
        // Holding it instead would leave a write skipped on every pass with
        // no reason attached, which is the shape of a queue entry nobody
        // can act on.
        let blobRefusal: BlobRefusal | undefined;
        let awaitingUpload = false;
        for (const dependency of entry.dependsOn) {
          const blob = await store.blobs.get(dependency);
          if (blob === undefined) continue;
          if (blob.state === "failed") {
            blobRefusal = {
              hash: blob.hash,
              code: blob.code,
              httpStatus: null,
              message: blob.lastError ?? "the upload was refused",
            };
            break;
          }
          awaitingUpload = true;
        }
        if (blobRefusal !== undefined) {
          const cascade = await cascadeRefusedBlobs([blobRefusal]);
          for (const seq of cascade.removed) gone.add(seq);
          for (const event of cascade.events) emit(event);
          waiting.add(entry.targetId);
          continue;
        }
        if (awaitingUpload) {
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

          case "schema": {
            const asPermanent = {
              class: "permanent" as const,
              code: verdict.code,
              httpStatus: verdict.httpStatus,
              message: verdict.message,
            };

            // The refresh has already been spent on this mutation, or
            // there is no graph to refresh. Either way the server's answer
            // is the last word.
            if (
              entry.schemaRefreshedAt !== null ||
              options.types === undefined
            ) {
              const cascade = await deadLetter(entry, asPermanent);
              for (const seq of cascade.removed) gone.add(seq);
              for (const event of cascade.events) emit(event);
              break;
            }

            try {
              await options.types.refresh();
            } catch (refreshError) {
              // The graph could not be read, so nothing has been learned
              // and nothing is recorded against the mutation. An
              // unreachable server ends the pass exactly as an unreachable
              // write does; anything else leaves the write pending to be
              // tried again, because a refusal this engine has not
              // finished thinking about must not become a dead letter.
              const why = classifyFailure(refreshError, entry.kind);
              if (why.class === "offline") return finish(sent, false, true);
              waiting.add(entry.targetId);
              break;
            }
            await store.outbox.markSchemaRefreshed(entry.seq, now());

            // Revalidation, the second half of the allowance. A write the
            // refreshed graph still refuses is refused for good, and
            // sending it again would spend a request to be told what this
            // client now knows.
            const subject = await validatable(entry);
            const stillRefused =
              subject === undefined
                ? undefined
                : localRefusalFor(
                    subject.type,
                    subject.properties,
                    store.identity.spaceId,
                  );
            if (stillRefused !== undefined) {
              const cascade = await deadLetter(entry, {
                ...asPermanent,
                message: `${verdict.message} — and the refreshed type graph refuses it too: ${stillRefused.message}`,
              });
              for (const seq of cascade.removed) gone.add(seq);
              for (const event of cascade.events) emit(event);
              break;
            }

            // The graph moved and the write now looks valid, so it is
            // owed another send — on the next pass rather than this one.
            // This drain is one pass by design, and a mutation that
            // re-sent itself here would be a retry loop the caller never
            // asked for.
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
