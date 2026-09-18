import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import {
  createTestContext,
  trackItem,
  trackEdge,
  cleanup,
} from "../../utils/setup.js";
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
});
