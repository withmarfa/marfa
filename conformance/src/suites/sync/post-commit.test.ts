import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import {
  createTestContext,
  trackItem,
  trackEdge,
  cleanup,
} from "../../utils/setup.js";
import { collectUntil, withStream } from "../../utils/stream.js";

/**
 * "An event is published after its write commits", and the half of the
 * log-order rule that depends on it: an event is published after its write
 * commits, never inside the transaction.
 *
 * The regression this catches is invisible from the event log. A publish
 * moved back inside the write transaction is rolled back with everything
 * else, so the stored log still reads correctly and only a live subscriber
 * sees the phantom — an `item.updated` announcing a version
 * the item never reached. A client applying it holds state the server has
 * never had, and no later event corrects it, because from the server's side
 * nothing happened.
 *
 * **The failure has to be one the transaction is already inside.** That is the
 * whole difficulty of writing this case, and the obvious choice is wrong: a
 * patch naming an edge target that does not exist is refused while the request
 * is still being validated, before any transaction opens, so nothing is
 * written and there is no phantom for a publish to announce from either side
 * of a commit boundary. A test built on it passes against a server that
 * publishes from inside the transaction, which is the one server it exists to
 * fail against.
 *
 * A cycle is the failure that lands in the right place. Its targets exist, so
 * the up-front pass admits them; the check that refuses it runs against the
 * post-delete graph inside the caller's transaction, after the item row has
 * been written. `edge_cycle` is asserted rather than the status alone because
 * it is the discriminator: no refusal raised before the transaction opens
 * carries that code, so reading it back is how this test knows it reached the
 * window it is about.
 */

/**
 * Distinctive enough to search the whole stream for.
 *
 * The assertion looks for this string anywhere in any frame rather than for a
 * particular event shape, because a publish inside the transaction could
 * announce the doomed write under more than one event name and matching only
 * `item.updated` would miss the others.
 */
const PHANTOM_BODY = "post-commit-phantom-must-not-be-announced";

let client: MarfaClient;
let ctx: TestContext;
let apiUrl: string;
let apiKey: string;

beforeAll(async () => {
  ({ ctx, client, apiUrl, apiKey } = await createTestContext(
    "sync",
    "post-commit",
  ));
});

afterAll(async () => {
  await cleanup(ctx);
});

describe("post-commit emission", () => {
  it("a write that rolls back announces nothing, while one that commits does", async (context) => {
    const [parent, child] = await Promise.all([
      client.createItem({
        type: "core.note",
        source: ctx.source,
        properties: { body: "post-commit-parent" },
      }),
      client.createItem({
        type: "core.note",
        source: ctx.source,
        properties: { body: "post-commit-child" },
      }),
    ]);
    expect(parent.ok && child.ok).toBe(true);
    const parentId = parent.data.item.id;
    const id = child.data.item.id;
    trackItem(ctx, parentId);
    trackItem(ctx, id);

    // The hierarchy the rolled-back write below tries to close into a loop.
    const hierarchy = await client.createEdge({
      source_id: parentId,
      target_id: id,
      edge_type: "parent-of",
    });
    expect(
      hierarchy.ok,
      `could not build the hierarchy the cycle needs: ${JSON.stringify(hierarchy.error)}`,
    ).toBe(true);
    trackEdge(ctx, hierarchy.data.edge.id);

    const outcome = await withStream(apiUrl, apiKey, {}, async (stream) => {
      // Let the subscription settle, or the control write below is published
      // to nobody and the test cannot tell a rolled-back write from a stream
      // that was not listening yet.
      await new Promise((r) => setTimeout(r, 250));

      // The control leg. A write that commits must reach the subscriber,
      // otherwise "the rolled-back write announced nothing" is a statement
      // about a dead stream rather than about the server's ordering.
      const committed = await client.updateItem(id, {
        properties: { body: "post-commit-committed" },
      });
      expect(committed.ok).toBe(true);
      const committedVersion = committed.data.item.version;

      const seen = await collectUntil(
        stream,
        (events) =>
          events.some(
            (e) =>
              e.event === "item.updated" &&
              (e.data as { item?: { id?: string } })?.item?.id === id,
          ),
        `item.updated for the committed write on ${id}`,
        context.signal,
      );

      // The ordering control, and the reason the phantom leg is worth
      // anything. The same request with a version the row has already moved
      // past is refused by the item write itself — which sits at the top of
      // the transaction, ahead of the edge check — so a 409 here is how this
      // test knows the row is written before the cycle refuses it. Were the
      // order the other way round, the answer would be the cycle's 400 and
      // the rolled-back leg below would be rolling back nothing.
      const ordering = await client.updateItem(id, {
        properties: { body: PHANTOM_BODY },
        version: committedVersion - 1,
        edges: { "parent-of": [parentId] },
      });
      expect(
        ordering.status,
        "a stale version lost to the edge check, so the item row is not written before the refusal and this test is not measuring a rollback",
      ).toBe(409);

      // The rolled-back leg. The targets exist, so the up-front pass admits
      // them and the write proceeds: the item row lands, the item's existing
      // `parent-of` edges are deleted, and only then does the cycle check
      // refuse the set — inside the transaction, which unwinds all of it.
      const rolledBack = await client.updateItem(id, {
        properties: { body: PHANTOM_BODY },
        edges: { "parent-of": [parentId] },
      });

      // Written after the refusal, and what makes the phantom's absence a
      // finding rather than a quiet moment. Item events reach a subscriber in
      // publish order, so once this one has arrived a phantom published from
      // inside the transaction has arrived too. Waiting out a fixed window
      // instead would let a busy target hide the very frame under test.
      const sentinel = await client.createItem({
        type: "core.note",
        source: ctx.source,
        properties: { body: `post-commit-sentinel-${ctx.runId}` },
      });
      expect(sentinel.ok).toBe(true);
      trackItem(ctx, sentinel.data.item.id);

      const rest = await collectUntil(
        stream,
        (events) =>
          events.some(
            (e) =>
              (e.data as { item?: { id?: string } })?.item?.id ===
              sentinel.data.item.id,
          ),
        `item.created for the sentinel written after the refusal (${sentinel.data.item.id})`,
        context.signal,
      );
      return {
        committedVersion,
        rolledBackStatus: rolledBack.status,
        rolledBackCode: rolledBack.error?.error.code,
        events: [...seen.events, ...rest.events],
      };
    });

    // The write really did fail, and really did fail inside the transaction
    // rather than at the request validator. Nothing refused before the
    // transaction opens answers `edge_cycle`.
    expect(outcome.rolledBackStatus).toBe(400);
    expect(
      outcome.rolledBackCode,
      "the patch was refused somewhere other than the in-transaction edge check, so no item row was written and there was never a phantom to announce",
    ).toBe("edge_cycle");

    // Nothing the subscriber received carries the rolled-back body. This is
    // the discriminator: it is the only assertion here that fails when the
    // publish moves back inside the transaction.
    const phantomEvents = outcome.events.filter((e) =>
      JSON.stringify(e.data).includes(PHANTOM_BODY),
    );
    expect(
      phantomEvents.map((e) => e.event),
      "a rolled-back write was announced to a live subscriber",
    ).toEqual([]);

    // And the row itself never moved, so there was a rollback to announce.
    const after = await client.getItem(id);
    expect(after.ok).toBe(true);
    expect(after.data.item.properties.body).toBe("post-commit-committed");
    expect(after.data.item.version).toBe(outcome.committedVersion);
  });
});
