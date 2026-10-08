import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { MarfaClient } from "../../client/api.js";
import type {
  AncestorUnavailableResponse,
  ConflictResponse,
  TestContext,
} from "../../client/types.js";
import {
  createTestContext,
  trackItem,
  trackEdge,
  trackKey,
  cleanup,
} from "../../utils/setup.js";
import { collectUntil, withStream } from "../../utils/stream.js";
import type { SseEvent } from "../../utils/sse.js";
import { detectSyncCapabilities, requireRule } from "./capabilities.js";
import type { SyncCapabilities } from "./capabilities.js";

/**
 * A repeated write under one idempotency key is the same write.
 *
 * Every item and edge write door accepts an `Idempotency-Key`. The header is
 * optional in the sense that the caller chooses whether to send one, never in
 * the sense that the server chooses whether to honor one.
 *
 * The acknowledged repeat in `acknowledged.test.ts` is the other mechanism for
 * a resent write, and the two are easy to confuse: one collapses a retry by a
 * header the caller invents, the other by the row id the caller already
 * minted.
 *
 * **A key is minted per mutation, so it names one request and not a slot.**
 * Sending a different request under a key that has already been used is a
 * caller bug rather than a retry, and the server refuses it with `422
 * idempotency_key_reused` rather than serving an answer to a request nobody
 * made. That refusal is its own case below. It also has to be kept out of the
 * *other* cases: a repeat has to be byte-identical to be a repeat, which is
 * what a queue resends anyway, and writing one of these with a changed body
 * asserts the refusal by accident.
 *
 * This is the rule that makes an offline queue safe to drain. A client that
 * sends a create and loses the response has no way to know whether the write
 * landed; its only options are to retry, or to drop the user's work. It
 * retries, and without a key on the server every retry is a new row — which is
 * the single most common way an offline client corrupts a library, because it
 * happens on exactly the flaky connection that made the queue necessary.
 *
 * The keyed answer has to be the *stored result*, not merely a success. A
 * server that answered a repeat by performing the write again would keep one
 * row and still step the version twice, and a client reconciling against its
 * own pending mutation would see a version it cannot account for.
 */

let client: MarfaClient;
let ctx: TestContext;
let apiUrl: string;
let apiKey: string;
let caps: SyncCapabilities;

beforeAll(async () => {
  ({ ctx, client, apiUrl, apiKey } = await createTestContext(
    "sync",
    "idempotency",
  ));
  caps = await detectSyncCapabilities({ client, ctx, apiUrl, apiKey });
});

afterAll(async () => {
  await cleanup(ctx);
});

interface ItemEnvelope {
  item: { id: string; version: number; properties: Record<string, unknown> };
}

describe("idempotency keys", () => {
  it("answers a repeated create with the first result rather than a second row", async () => {
    requireRule(caps, "idempotencyKeys");
    const key = `sync-create-${randomUUID()}`;

    const first = await client.rawRequest<ItemEnvelope>("/items", {
      method: "POST",
      headers: { "Idempotency-Key": key },
      body: {
        type: "core.note",
        source: ctx.source,
        properties: { body: "idempotent-first" },
      },
    });
    expect(first.ok).toBe(true);
    trackItem(ctx, first.data.item.id);

    // Byte-identical, which is what a queue resends: it kept the request, not
    // a description of one. A changed body under this key is a different
    // assertion entirely and is the case below.
    const repeat = await client.rawRequest<ItemEnvelope>("/items", {
      method: "POST",
      headers: { "Idempotency-Key": key },
      body: {
        type: "core.note",
        source: ctx.source,
        properties: { body: "idempotent-first" },
      },
    });
    expect(
      repeat.ok,
      `a resent create was refused: ${JSON.stringify(repeat.error)}`,
    ).toBe(true);
    trackItem(ctx, repeat.data.item.id);

    expect(
      repeat.data.item.id,
      "a retry under the same key created a second row, which is a duplicate the user never asked for",
    ).toBe(first.data.item.id);

    // The id above already rules out a second row, because a create carrying
    // no id of its own mints a fresh one every time it executes. This rules
    // out the other re-run: the write applied a second time onto the row it
    // had just made, which keeps one row and steps the version twice, and
    // leaves a client reconciling its own pending write facing a version it
    // cannot account for.
    expect(
      repeat.data.item.version,
      "the repeat performed the write again instead of replaying the stored result",
    ).toBe(first.data.item.version);

    // What the client is actually told. Everything above is inferred from
    // the row — the same id, the same version — which a client can only
    // check by holding the first response and comparing. `Idempotency-
    // Replayed` is the server saying it directly, and it is what lets a
    // client that lost the first response know which of the two it has.
    //
    // Both arms, deliberately. A header sent on every response would
    // satisfy an assertion that only reads the repeat, and would carry no
    // information at all — so the absent arm is what gives the present one
    // its meaning.
    expect(
      first.headers.get("Idempotency-Replayed"),
      "a first write announced itself as a replay, so the header cannot tell a stored result from a fresh one",
    ).toBeNull();
    expect(
      repeat.headers.get("Idempotency-Replayed"),
      "a replayed write did not announce itself, so a client that lost the first response cannot tell the write landed",
    ).toBe("true");

    // The control. A different key against the same content has to produce a
    // different row, or the collapse above was content dedupe rather than the
    // key being honored, and this test would pass on a server with no keys.
    const other = await client.rawRequest<ItemEnvelope>("/items", {
      method: "POST",
      headers: { "Idempotency-Key": `sync-create-${randomUUID()}` },
      body: {
        type: "core.note",
        source: ctx.source,
        properties: { body: "idempotent-first" },
      },
    });
    expect(other.ok).toBe(true);
    trackItem(ctx, other.data.item.id);
    expect(
      other.data.item.id,
      "two creates under different keys collapsed into one row, so the earlier collapse says nothing about idempotency keys",
    ).not.toBe(first.data.item.id);
    // A write carrying a key it has never seen is still a write, so the
    // absence above is a property of the outcome rather than of the first
    // request in the file.
    expect(
      other.headers.get("Idempotency-Replayed"),
      "a write under an unused key announced itself as a replay",
    ).toBeNull();
  });

  it("announces nothing for a repeated request under a key, on the create, update, edge create and delete doors", async (context) => {
    requireRule(caps, "idempotencyKeys");
    const frames = (events: SseEvent[], id: string): string[] =>
      events
        .filter((e) => {
          const data = e.data as {
            item?: { id?: string };
            edge?: { id?: string };
          };
          return data.item?.id === id || data.edge?.id === id;
        })
        .map((e) => e.event);
    const keyed = (path: string, method: string, key: string, body?: object) =>
      client.rawRequest<{
        item: { id: string; version: number };
        edge: { id: string };
      }>(path, { method, headers: { "Idempotency-Key": key }, body });

    const peer = await client.createItem({
      type: "core.note",
      source: ctx.source,
      properties: { body: "keyed-repeat-peer" },
    });
    expect(peer.ok).toBe(true);
    trackItem(ctx, peer.data.item.id);

    const run = await withStream(apiUrl, apiKey, {}, async (stream) => {
      await new Promise((r) => setTimeout(r, 250));

      const create = {
        type: "core.note",
        source: ctx.source,
        properties: { body: "keyed-repeat" },
      };
      const createKey = `sync-announce-create-${randomUUID()}`;
      const created = await keyed("/items", "POST", createKey, create);
      expect(created.ok, JSON.stringify(created.error)).toBe(true);
      const itemId = created.data.item.id;
      trackItem(ctx, itemId);
      const createRepeat = await keyed("/items", "POST", createKey, create);
      expect(createRepeat.headers.get("Idempotency-Replayed")).toBe("true");

      const update = {
        properties: { body: "keyed-repeat-updated" },
        version: created.data.item.version,
      };
      const updateKey = `sync-announce-update-${randomUUID()}`;
      const updated = await keyed(
        `/items/${itemId}`,
        "PATCH",
        updateKey,
        update,
      );
      expect(updated.ok, JSON.stringify(updated.error)).toBe(true);
      const updateRepeat = await keyed(
        `/items/${itemId}`,
        "PATCH",
        updateKey,
        update,
      );
      expect(updateRepeat.headers.get("Idempotency-Replayed")).toBe("true");

      const edge = {
        source_id: itemId,
        target_id: peer.data.item.id,
        edge_type: "about",
      };
      const edgeKey = `sync-announce-edge-${randomUUID()}`;
      const madeEdge = await keyed("/edges", "POST", edgeKey, edge);
      expect(madeEdge.ok, JSON.stringify(madeEdge.error)).toBe(true);
      const edgeId = madeEdge.data.edge.id;
      trackEdge(ctx, edgeId);
      const edgeRepeat = await keyed("/edges", "POST", edgeKey, edge);
      expect(edgeRepeat.headers.get("Idempotency-Replayed")).toBe("true");

      const deleteKey = `sync-announce-delete-${randomUUID()}`;
      const deleted = await keyed(`/items/${itemId}`, "DELETE", deleteKey);
      expect(deleted.ok, JSON.stringify(deleted.error)).toBe(true);
      const deleteRepeat = await keyed(`/items/${itemId}`, "DELETE", deleteKey);
      expect(deleteRepeat.headers.get("Idempotency-Replayed")).toBe("true");

      // Written after every repeat. The stream delivers in id order, so the
      // sentinel arriving means any frame a repeat published has arrived.
      const sentinel = await client.createItem({
        type: "core.note",
        source: ctx.source,
        properties: { body: "keyed-repeat-sentinel" },
      });
      expect(sentinel.ok).toBe(true);
      trackItem(ctx, sentinel.data.item.id);
      const { events } = await collectUntil(
        stream,
        (seen) => frames(seen, sentinel.data.item.id).length > 0,
        `the sentinel written after every repeat (${sentinel.data.item.id})`,
        context.signal,
      );
      return { events, itemId, edgeId };
    });

    // One frame for each write that happened, which is the witness that the
    // stream was live for all of them; a second for any of them would be a
    // repeat announced.
    expect(
      frames(run.events, run.itemId).filter((name) => name.startsWith("item.")),
    ).toEqual(["item.created", "item.updated", "item.deleted"]);
    expect(frames(run.events, run.edgeId)).toEqual(["edge.created"]);
  });

  it("refuses a key that names a different request rather than serving it", async () => {
    requireRule(caps, "idempotencyKeys");
    const key = `sync-reuse-${randomUUID()}`;

    const first = await client.rawRequest<ItemEnvelope>("/items", {
      method: "POST",
      headers: { "Idempotency-Key": key },
      body: {
        type: "core.note",
        source: ctx.source,
        properties: { body: "reuse-original" },
      },
    });
    expect(first.ok).toBe(true);
    trackItem(ctx, first.data.item.id);

    // The same key, a different write. Serving this would hand the caller a
    // 201 naming a row that holds someone else's content, and the write it
    // believes it made would never have happened — the exact silent loss the
    // key exists to prevent, arriving from the other side.
    const reused = await client.rawRequest<ItemEnvelope>("/items", {
      method: "POST",
      headers: { "Idempotency-Key": key },
      body: {
        type: "core.note",
        source: ctx.source,
        properties: { body: "reuse-different" },
      },
    });
    expect(
      reused.ok,
      "a key reused for a different request was accepted, so one of the two writes was silently discarded",
    ).toBe(false);
    expect(reused.status).toBe(422);
    expect(reused.error?.error.code).toBe("idempotency_key_reused");

    // The control, and it is the half that matters: a refusal is only the
    // right refusal if the *first* write survived it. A server that rolled
    // the original back, or never stored it, would fail here while passing
    // every assertion above.
    const original = await client.getItem(first.data.item.id);
    expect(original.ok).toBe(true);
    expect(
      original.data.item.properties.body,
      "the refusal reached the stored row and changed it, so the key protected nothing",
    ).toBe("reuse-original");
  });

  it("makes a repeated update one version step, not two", async () => {
    requireRule(caps, "idempotencyKeys");

    const seed = await client.createItem({
      type: "core.note",
      source: ctx.source,
      properties: { body: "idempotent-update-seed" },
    });
    expect(seed.ok).toBe(true);
    const id = seed.data.item.id;
    trackItem(ctx, id);
    const startingVersion = seed.data.item.version;

    const key = `sync-update-${randomUUID()}`;
    const body = {
      properties: { body: "idempotent-update-applied" },
      version: startingVersion,
    };

    const first = await client.rawRequest<ItemEnvelope>(`/items/${id}`, {
      method: "PATCH",
      headers: { "Idempotency-Key": key },
      body,
    });
    expect(first.ok).toBe(true);

    // The same request again, exactly as a queue would resend it: the same
    // key and the same base version. Without the key this is the shape that
    // conflicts with itself, because the version it names is now stale.
    const repeat = await client.rawRequest<ItemEnvelope>(`/items/${id}`, {
      method: "PATCH",
      headers: { "Idempotency-Key": key },
      body,
    });
    expect(
      repeat.ok,
      `a retried update conflicted with itself: ${JSON.stringify(repeat.error)}`,
    ).toBe(true);

    // The same announcement on a second door, because the header is set by
    // middleware mounted per door rather than by a route: a door added to
    // the table without the mount would replay correctly and say nothing.
    expect(
      first.headers.get("Idempotency-Replayed"),
      "a first update announced itself as a replay",
    ).toBeNull();
    expect(
      repeat.headers.get("Idempotency-Replayed"),
      "a replayed update did not announce itself",
    ).toBe("true");

    const after = await client.getItem(id);
    expect(after.ok).toBe(true);
    expect(
      after.data.item.version,
      "a retried update moved the version twice, so a client reconciling its own pending write sees a version it cannot account for",
    ).toBe(first.data.item.version);
    expect(after.data.item.version).toBe(startingVersion + 1);

    // The content, not only the count. A version is a cheap thing to get
    // right by accident — a server that swallowed the retry without applying
    // anything, or applied it twice onto a merged value, lands on this same
    // number — so a version assertion on its own passes on a row whose
    // content the retry corrupted.
    expect(
      after.data.item.properties.body,
      "a retried update reached the right version carrying the wrong content",
    ).toBe("idempotent-update-applied");
  });

  /**
   * Two more of the ten doors, chosen because they are the ones a shared
   * assertion would miss.
   *
   * The marker rides middleware registered per door from a table, not one
   * hook over the whole app, so each door is a separate mount and a separate
   * chance to be wrong. Covering only `POST /items` and `PATCH /items/{id}`
   * would leave the claim about the other eight resting on reading that
   * table. These two make it measured on a different resource and on a verb
   * that returns no row: an edge create, and a delete whose replay is the one
   * that would otherwise 404.
   */
  it("announces a replayed edge create", async () => {
    requireRule(caps, "idempotencyKeys");

    const [source, target] = await Promise.all([
      client.createItem({
        type: "core.note",
        source: ctx.source,
        properties: { body: "edge-replay-source" },
      }),
      client.createItem({
        type: "core.note",
        source: ctx.source,
        properties: { body: "edge-replay-target" },
      }),
    ]);
    expect(source.ok).toBe(true);
    expect(target.ok).toBe(true);
    trackItem(ctx, source.data.item.id);
    trackItem(ctx, target.data.item.id);

    const key = `sync-edge-${randomUUID()}`;
    const body = {
      source_id: source.data.item.id,
      target_id: target.data.item.id,
      edge_type: "about",
    };

    const first = await client.rawRequest<{ edge: { id: string } }>("/edges", {
      method: "POST",
      headers: { "Idempotency-Key": key },
      body,
    });
    expect(
      first.ok,
      `an edge create was refused: ${JSON.stringify(first.error)}`,
    ).toBe(true);
    trackEdge(ctx, first.data.edge.id);

    const repeat = await client.rawRequest<{ edge: { id: string } }>("/edges", {
      method: "POST",
      headers: { "Idempotency-Key": key },
      body,
    });
    expect(
      repeat.ok,
      `a resent edge create was refused: ${JSON.stringify(repeat.error)}`,
    ).toBe(true);

    // The row first, so a server that announced a replay without performing
    // one still fails here.
    expect(
      repeat.data.edge.id,
      "a retried edge create made a second edge",
    ).toBe(first.data.edge.id);

    expect(
      first.headers.get("Idempotency-Replayed"),
      "a first edge create announced itself as a replay",
    ).toBeNull();
    expect(
      repeat.headers.get("Idempotency-Replayed"),
      "a replayed edge create did not announce itself",
    ).toBe("true");
  });

  it("announces a replayed delete, which would otherwise be a 404", async () => {
    requireRule(caps, "idempotencyKeys");

    const seed = await client.createItem({
      type: "core.note",
      source: ctx.source,
      properties: { body: "idempotent-delete-seed" },
    });
    expect(seed.ok).toBe(true);
    const id = seed.data.item.id;
    trackItem(ctx, id);

    const key = `sync-delete-${randomUUID()}`;
    const first = await client.rawRequest<unknown>(`/items/${id}`, {
      method: "DELETE",
      headers: { "Idempotency-Key": key },
    });
    expect(
      first.ok,
      `a delete was refused: ${JSON.stringify(first.error)}`,
    ).toBe(true);

    // Without the key this is the shape that answers 404: the row is
    // already gone, so the second attempt has nothing to delete. The
    // replayed success is the whole point, and the marker is what tells a
    // client which of the two it received.
    const repeat = await client.rawRequest<unknown>(`/items/${id}`, {
      method: "DELETE",
      headers: { "Idempotency-Key": key },
    });
    expect(
      repeat.ok,
      `a retried delete was refused rather than replayed: ${JSON.stringify(repeat.error)}`,
    ).toBe(true);
    expect(repeat.status).toBe(first.status);

    expect(
      first.headers.get("Idempotency-Replayed"),
      "a first delete announced itself as a replay",
    ).toBeNull();
    expect(
      repeat.headers.get("Idempotency-Replayed"),
      "a replayed delete did not announce itself",
    ).toBe("true");
  });

  it("reauthorizes a retained answer after its credential is narrowed", async () => {
    requireRule(caps, "idempotencyKeys");
    const label = `sync-current-grant-${randomUUID().slice(0, 8)}`;
    const minted = await client.createKey({
      label,
      source: `${ctx.source}-${label}`,
      type_permissions: { "core.note": "write" },
    });
    expect(minted.ok).toBe(true);
    trackKey(ctx, minted.data.id);
    const actor = new MarfaClient({ baseUrl: apiUrl, apiKey: minted.data.key });
    const created = await client.rawRequest<ItemEnvelope>("/items", {
      method: "POST",
      body: {
        type: "core.note",
        source: ctx.source,
        properties: { title: "Before", body: "Retained data" },
      },
    });
    expect(created.ok).toBe(true);
    const item = created.data.item;
    trackItem(ctx, item.id);
    const body = { version: item.version, properties: { title: "After" } };
    const headers = { "Idempotency-Key": `sync-current-grant-${randomUUID()}` };
    const ask = () =>
      actor.rawRequest<ItemEnvelope>(`/items/${item.id}`, {
        method: "PATCH",
        body,
        headers,
      });
    const first = await ask();
    expect(first.ok).toBe(true);
    expect(first.data.item.properties.body).toBe("Retained data");
    expect((await ask()).headers.get("Idempotency-Replayed")).toBe("true");
    expect(
      (
        await client.updateKey(minted.data.id, {
          type_permissions: { "core.task": "read" },
        })
      ).ok,
    ).toBe(true);
    expect((await actor.rawRequest(`/items/${item.id}`)).status).toBe(404);
    expect(
      (await actor.rawRequest(`/items/${item.id}`, { method: "PATCH", body }))
        .status,
    ).toBe(404);
    const refused = await ask();
    expect(refused.status).toBe(404);
    expect(refused.headers.get("Idempotency-Replayed")).toBeNull();
    expect(
      (
        await client.updateKey(minted.data.id, {
          type_permissions: { "core.note": "write" },
        })
      ).ok,
    ).toBe(true);
    const restored = await ask();
    expect(restored.headers.get("Idempotency-Replayed")).toBe("true");
    expect(restored.data).toEqual(first.data);
    const current = await client.rawRequest<ItemEnvelope>(`/items/${item.id}`);
    expect(current.data.item.version).toBe(first.data.item.version);
  });

  it("holds a key to the credential that sent it", async () => {
    requireRule(caps, "idempotencyKeys");
    const label = `sync-idem-second-${randomUUID().slice(0, 8)}`;
    const minted = await client.createKey({
      label,
      source: `${ctx.source}-${label}`,
      type_permissions: { "core.note": "write" },
    });
    expect(minted.ok).toBe(true);
    trackKey(ctx, minted.data.id);
    const second = new MarfaClient({
      baseUrl: apiUrl,
      apiKey: minted.data.key,
    });

    const create = (
      as: MarfaClient,
      key: string,
      body: string,
      source?: string,
    ) =>
      as.rawRequest<ItemEnvelope>("/items", {
        method: "POST",
        headers: { "Idempotency-Key": key },
        body: { type: "core.note", source, properties: { body } },
      });

    // A different request from each under one key: neither is refused for
    // a key only the other used.
    const shared = `sync-shared-${randomUUID()}`;
    const mine = await create(client, shared, "first credential", ctx.source);
    expect(mine.ok).toBe(true);
    trackItem(ctx, mine.data.item.id);
    const theirs = await create(
      second,
      shared,
      "second credential",
      `${ctx.source}-${label}`,
    );
    expect(
      theirs.ok,
      `a second credential was refused for a key only the first used: ${JSON.stringify(theirs.error)}`,
    ).toBe(true);
    trackItem(ctx, theirs.data.item.id);
    expect(theirs.headers.get("Idempotency-Replayed")).toBeNull();
    expect(theirs.data.item.properties.body).toBe("second credential");

    // The same request from each, each stamped with its own source: the
    // second is its own write, never the first's stored answer.
    const same = `sync-same-${randomUUID()}`;
    const a = await create(client, same, "one body");
    expect(a.ok).toBe(true);
    trackItem(ctx, a.data.item.id);
    const b = await create(second, same, "one body");
    expect(b.ok).toBe(true);
    trackItem(ctx, b.data.item.id);
    expect(b.headers.get("Idempotency-Replayed")).toBeNull();
    expect(b.data.item.id).not.toBe(a.data.item.id);

    // The witness: within one credential the key still replays.
    const again = await create(
      second,
      shared,
      "second credential",
      `${ctx.source}-${label}`,
    );
    expect(again.headers.get("Idempotency-Replayed")).toBe("true");
  });
});

/**
 * The natural key is the other way a write lands on a row that already
 * exists, and unlike an idempotency key it is not a retry marker: a create
 * naming a `(source, source_id)` the server already holds is an upsert, and
 * the caller may or may not have read the row it is about to overwrite.
 *
 * A `version` is how it says which. Sent, the upsert is conditional and
 * answers exactly what the update door answers; omitted, it stays
 * unconditional, because a caller creating a row it has never seen has no
 * version to name. Without that, a client draining a queue of creates against
 * a library another device has been editing overwrites every row it touches,
 * and the door that enforces the version on `PATCH` is walked straight around
 * by a `POST`.
 */
describe("a create that resolves an existing row", () => {
  it("a bulk entry naming a stale version is refused, and rolls the page back or not as atomic says", async () => {
    // The same walk-around as the create door, through the door a draining
    // queue is most likely to use. What the batch must not do is fail
    // whole: ninety-nine good rows should not be lost to one stale entry,
    // so the refusal is that entry's own outcome.
    const staleId = `bulk-version-${randomUUID()}`;
    const freshId = `bulk-version-fresh-${randomUUID()}`;

    const seed = await client.createItem({
      type: "core.note",
      source: ctx.source,
      source_id: staleId,
      properties: { title: "original", body: "original body" },
    });
    expect(
      seed.ok,
      `could not seed the row to upsert onto: ${JSON.stringify(seed.error)}`,
    ).toBe(true);
    trackItem(ctx, seed.data.item.id);
    const staleVersion = seed.data.item.version;

    const advanced = await client.updateItem(seed.data.item.id, {
      properties: { title: "moved on" },
      version: staleVersion,
    });
    expect(advanced.ok).toBe(true);

    // The good entry first and the stale one second, which is what makes the
    // rollback observable. Processing stops at the first errored entry, so
    // with the stale one leading, the good one is never attempted and its
    // absence afterwards would prove nothing about the transaction.
    const entries = [
      {
        type: "core.note",
        source: ctx.source,
        source_id: freshId,
        // A whole note rather than a title alone: this entry is a create,
        // so it has no stored row to merge a required field in from.
        properties: { title: "the entry beside it", body: "its body" },
      },
      {
        type: "core.note",
        source: ctx.source,
        source_id: staleId,
        properties: { title: "from a stale writer" },
        version: staleVersion,
      },
    ];

    // Atomic by default, so a stale entry rolls the page back exactly as
    // every other per-entry refusal on this door does, with the inner code
    // in `details.code`. The batch is refused, not the entry.
    const atomic = await client.bulkItems(entries);
    expect(atomic.status).toBe(409);
    expect(atomic.error?.error.code).toBe("bulk_atomic_rollback");
    expect(atomic.error?.error.details?.code).toBe("version_conflict");
    expect(atomic.error?.error.details?.index).toBe(1);

    // And nothing landed, including the entry that was fine.
    const afterAtomic = await client.listItems({ source: ctx.source });
    expect(afterAtomic.ok).toBe(true);
    // Asserting an absence, so the page has to be the whole of it: a
    // truncated one makes `.some(...)` false for free and stops looking.
    expect(afterAtomic.data.next_cursor).toBeNull();
    expect(
      afterAtomic.data.data.some((i) => i.source_id === freshId),
      "the good entry was written and not rolled back",
    ).toBe(false);

    // With the page non-atomic the refusal is that entry's own outcome and
    // the rest of the batch lands, which is what a draining queue needs:
    // ninety-nine good rows are not lost to one stale one.
    const perEntry = await client.bulkItems({ items: entries, atomic: false });
    expect(
      perEntry.ok,
      `a non-atomic page was refused whole: ${JSON.stringify(perEntry.error)}`,
    ).toBe(true);

    const stale = perEntry.data.results.find((r) => r.index === 1);
    expect(stale?.outcome).toBe("errored");
    expect(stale?.error?.code).toBe("version_conflict");

    const fresh = perEntry.data.results.find((r) => r.index === 0);
    expect(
      fresh?.outcome,
      `the entry beside the stale one did not land: ${JSON.stringify(fresh)}`,
    ).toBe("created");
    if (fresh?.id) trackItem(ctx, fresh.id);

    // And the stale entry wrote nothing either way.
    const read = await client.getItem(seed.data.item.id);
    expect(read.ok).toBe(true);
    expect(read.data.item.properties.title).toBe("moved on");
  });

  it("a create naming a stale version on an existing row is refused", async () => {
    const sourceId = `upsert-version-${randomUUID()}`;

    const seed = await client.createItem({
      type: "core.note",
      source: ctx.source,
      source_id: sourceId,
      properties: { title: "original", body: "original body" },
    });
    expect(
      seed.ok,
      `could not seed the row to upsert onto: ${JSON.stringify(seed.error)}`,
    ).toBe(true);
    const id = seed.data.item.id;
    trackItem(ctx, id);
    const staleVersion = seed.data.item.version;

    // The other device's write, which is what makes the version below stale.
    const advanced = await client.updateItem(id, {
      properties: { title: "moved on" },
      version: staleVersion,
    });
    expect(
      advanced.ok,
      `the first writer's update failed, so there is no stale version to name: ${JSON.stringify(advanced.error)}`,
    ).toBe(true);
    expect(advanced.data.item.version).toBeGreaterThan(staleVersion);

    // The same natural key, so this resolves the row above rather than making
    // a second one, and the version the queued client last read. It collides
    // on `title` deliberately: a stale write whose fields do not collide is
    // merged rather than refused, so changing anything else would assert the
    // merge path and say nothing about the condition.
    const refused = await client.createItem({
      type: "core.note",
      source: ctx.source,
      source_id: sourceId,
      properties: { title: "from a stale writer" },
      version: staleVersion,
    });
    expect(
      refused.status,
      `a create naming a stale version on an existing row was not refused 409: ${JSON.stringify(refused.error ?? refused.data)}`,
    ).toBe(409);
    expect(refused.error?.error.code).toBe("version_conflict");

    // The same envelope the update door gives, because the caller is doing
    // the same thing and has to resolve it the same way. A bare 409 would
    // leave a queued client with nothing to rebase onto and no route to call
    // that the refusal did not already have the answer for.
    const body = refused.error as unknown as ConflictResponse;
    expect(body.error.status).toBe(409);
    // The request named a key and not an id, so the envelope is the only
    // place a queued client learns which row refused it.
    expect(
      body.current.id,
      "the refusal did not name the row the natural key resolved in current.id",
    ).toBe(id);
    expect(body.current.version).toBe(advanced.data.item.version);
    expect(body.current.properties.title).toBe("moved on");
    expect(body.ancestor.version).toBe(staleVersion);
    expect(body.ancestor.properties.title).toBe("original");
    expect(body.conflicting_fields).toEqual(["title"]);

    // The half that proves the upsert was conditional rather than merely
    // reported as one. Every assertion above passes on a server that answers
    // 409 and writes anyway, and on this door that write is the one that
    // silently discards the other device's edit.
    const after = await client.getItem(id);
    expect(after.ok).toBe(true);
    expect(
      after.data.item.properties.title,
      "the refused upsert reached the stored row, so the condition was reported without being enforced",
    ).toBe("moved on");
    expect(
      after.data.item.properties.body,
      "the refused upsert replaced the row's properties wholesale",
    ).toBe("original body");
    expect(after.data.item.version, "a refused upsert moved the version").toBe(
      advanced.data.item.version,
    );

    // And it stayed one row: a server that sidestepped the condition by
    // writing a second row under the same natural key would pass everything
    // above while leaving the library with a duplicate.
    //
    // `next_cursor` is checked first because the count below is only a count of
    // the whole set when the listing was not a page of it — a truncated page
    // would make this assertion quietly stop looking at everything.
    const listed = await client.listItems({ source: ctx.source, limit: 100 });
    expect(listed.ok).toBe(true);
    expect(
      listed.data.next_cursor,
      "the listing was truncated, so a duplicate row could be sitting on a page this assertion never read",
    ).toBeNull();
    expect(
      listed.data.data.filter((item) => item.source_id === sourceId).length,
      "the refused upsert wrote a second row under the same natural key",
    ).toBe(1);
  });

  it("a create naming a stale version on an existing row merges where nothing collides", async () => {
    const sourceId = `upsert-merge-${randomUUID()}`;
    const seed = await client.createItem({
      type: "core.note",
      source: ctx.source,
      source_id: sourceId,
      properties: { title: "original", body: "original body" },
    });
    expect(seed.ok, JSON.stringify(seed.error)).toBe(true);
    const id = seed.data.item.id;
    trackItem(ctx, id);
    const advanced = await client.updateItem(id, {
      properties: { title: "moved on" },
      version: seed.data.item.version,
    });
    expect(advanced.ok).toBe(true);

    const merged = await client.createItem({
      type: "core.note",
      source: ctx.source,
      source_id: sourceId,
      properties: { notes: "from a stale writer" },
      version: seed.data.item.version,
    });
    expect(merged.status, JSON.stringify(merged.error)).toBe(200);
    expect(merged.data.acknowledged).toBeUndefined();
    expect(merged.data.item.id).toBe(id);
    expect(merged.data.item.version).toBe(3);
    expect(merged.data.item.properties).toEqual({
      title: "moved on",
      body: "original body",
      notes: "from a stale writer",
    });
    expect(
      (await client.getVersions(id)).data.data.map((v) => v.version),
    ).toEqual([1, 2]);

    const listed = await client.listItems({ source: ctx.source, limit: 100 });
    expect(listed.data.next_cursor).toBeNull();
    expect(
      listed.data.data.filter((item) => item.source_id === sourceId),
    ).toHaveLength(1);
  });

  it("takes a create's version of zero as the claim that there is no row", async () => {
    // Zero is the version a device sends when its copy holds nothing under
    // the natural key, and the server never mints it, so no row can ever
    // carry it. That makes it usable as a precondition and as nothing else:
    // on an empty key it creates, and on a key that already names a row it
    // is a stale version like any other.
    const emptyKey = `version-zero-${randomUUID()}`;
    const created = await client.createItem({
      type: "core.note",
      source: ctx.source,
      source_id: emptyKey,
      properties: { title: "nothing was here", body: "first" },
      version: 0,
    });
    expect(
      created.ok,
      `a create carrying version 0 onto an empty natural key was refused: ${JSON.stringify(created.error)}`,
    ).toBe(true);
    trackItem(ctx, created.data.item.id);
    // The server mints 1 rather than the 0 it was handed, which is the half
    // that makes zero safe to mean "I read nothing".
    expect(created.data.item.version).toBe(1);

    const refused = await client.createItem({
      type: "core.note",
      source: ctx.source,
      source_id: emptyKey,
      properties: { title: "still nothing here?", body: "second" },
      version: 0,
    });
    expect(refused.status).toBe(409);
    expect(refused.error?.error.code).toBe("ancestor_unavailable");
    // Named by the row, because the create named only the key: a device
    // that read nothing has to learn which row is there before it can hold
    // it rather than a second copy of it (`queue-and-verdicts/landed-refused`).
    const envelope = refused.error as unknown as AncestorUnavailableResponse;
    expect(
      envelope.current.id,
      "the refusal did not name the row the natural key resolved in current.id",
    ).toBe(created.data.item.id);
    expect(envelope.current.version).toBe(1);

    const after = await client.getItem(created.data.item.id);
    expect(after.ok).toBe(true);
    expect(after.data.item.properties.title).toBe("nothing was here");
    expect(after.data.item.version).toBe(1);
  });

  it("takes a bulk entry's version of zero as the claim that there is no row, in both modes", async () => {
    const entry = (sourceId: string, title: string, version = 0) => ({
      type: "core.note",
      source: ctx.source,
      source_id: sourceId,
      properties: { title, body: "bulk body" },
      version,
    });

    for (const mode of ["upsert", "create_only"] as const) {
      const sourceId = `bulk-zero-${mode}-${randomUUID()}`;
      const created = await client.bulkItems({
        mode,
        items: [entry(sourceId, "nothing was here")],
      });
      expect(created.status, mode + JSON.stringify(created.error)).toBe(200);
      expect(created.data.results[0]?.outcome, mode).toBe("created");
      const id = created.data.results[0]?.id ?? "";
      trackItem(ctx, id);
      const read = await client.getItem(id);
      expect(read.data.item.version, mode).toBe(1);
    }

    // Zero is no more than one of the versions a create may name where no
    // row resolves: the row it makes is at 1 whatever it was handed.
    const handed = `bulk-handed-${randomUUID()}`;
    const five = await client.bulkItems([entry(handed, "handed five", 5)]);
    expect(five.status).toBe(200);
    expect(five.data.results[0]?.outcome).toBe("created");
    trackItem(ctx, five.data.results[0]?.id ?? "");
    const fiveRead = await client.getItem(five.data.results[0]?.id ?? "");
    expect(fiveRead.data.item.version).toBe(1);

    // A key that names a live row is a version no snapshot covers.
    const held = `bulk-zero-held-${randomUUID()}`;
    const seed = await client.createItem({
      type: "core.note",
      source: ctx.source,
      source_id: held,
      properties: { title: "held", body: "held body" },
    });
    expect(seed.status).toBe(201);
    const id = seed.data.item.id;
    trackItem(ctx, id);
    const fresh = `bulk-zero-beside-${randomUUID()}`;
    const entries = [
      {
        type: "core.note",
        source: ctx.source,
        source_id: fresh,
        properties: { title: "beside it", body: "beside body" },
      },
      entry(held, "from a writer that read nothing"),
    ];

    const atomic = await client.bulkItems(entries);
    expect(atomic.status).toBe(409);
    expect(atomic.error?.error.code).toBe("bulk_atomic_rollback");
    expect(atomic.error?.error.details).toMatchObject({
      code: "ancestor_unavailable",
      index: 1,
    });

    const perEntry = await client.bulkItems({ items: entries, atomic: false });
    expect(perEntry.status).toBe(200);
    expect(perEntry.data.results[1]).toMatchObject({
      outcome: "errored",
      error: { code: "ancestor_unavailable" },
    });
    // The entry beside it landed only on the page that was not atomic.
    expect(perEntry.data.results[0]?.outcome).toBe("created");
    trackItem(ctx, perEntry.data.results[0]?.id ?? "");

    const skipped = await client.bulkItems({
      mode: "create_only",
      items: [entry(held, "from a writer that read nothing")],
    });
    expect(skipped.status).toBe(200);
    expect(skipped.data.results[0]?.outcome).toBe("skipped");

    const after = await client.getItem(id);
    expect(after.data.item.properties.title).toBe("held");
    expect(after.data.item.version).toBe(1);
  });
});
