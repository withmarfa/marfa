import { describe, it, expect, beforeAll, afterAll } from "vitest";
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
 * "A modification time moves when the item changes", on the read a
 * reconnecting client makes: the catch-up covers the graph as well as the
 * rows, and a bound the request names is either applied or refused — never
 * dropped.
 *
 * Query parameters are parsed with a schema that strips keys it does not
 * declare, so a request naming a filter the server does not have parses
 * successfully with the filter gone. The caller gets 200 and a well-formed
 * page with no bound applied at all: a full listing that is indistinguishable
 * from the narrow one they asked for. On a read that is a wrong answer. On
 * `POST /items/bulk-actions` the filter *is* the match set, so a dropped
 * bound turns "purge the items before this date" into "purge everything", and
 * under the match cap it does not error — it succeeds, against every row the
 * credential can see.
 *
 * That door is why this file exists rather than the bounds being taken on
 * trust from the document.
 */

let client: MarfaClient;
let ctx: TestContext;
let apiUrl: string;
let apiKey: string;
let caps: SyncCapabilities;

const IMPOSSIBLE_FUTURE = "2099-01-01T00:00:00.000Z";

beforeAll(async () => {
  ({ ctx, client, apiUrl, apiKey } = await createTestContext(
    "sync",
    "time-filters",
  ));
  caps = await detectSyncCapabilities({ client, ctx, apiUrl, apiKey });
});

afterAll(async () => {
  await cleanup(ctx);
});

/**
 * Every edge the catch-up read returns, following the cursor to the end.
 *
 * One page is not enough and the shortfall is silent. `/edges` takes no
 * `source` filter, so this read returns every edge on the server rather than
 * this run's, and a busy target pushes the edge under test off the first page
 * — at which point the case reports that an edge written after the boundary
 * was missing from the catch-up, which is the message for a real defect.
 */
async function edgesModifiedSince(boundary: string): Promise<Set<string>> {
  const ids = new Set<string>();
  let cursor: string | undefined;
  for (;;) {
    const page = await client.rawRequest<{
      data?: Array<{ id: string }>;
      cursor?: string | null;
      has_more?: boolean;
    }>(
      `/edges?limit=500&updated_after=${encodeURIComponent(boundary)}` +
        (cursor === undefined ? "" : `&cursor=${encodeURIComponent(cursor)}`),
    );
    expect(
      page.ok,
      `the edge catch-up read was refused (${page.status}), so a reconnecting client has to re-read every edge in the dataset`,
    ).toBe(true);
    for (const edge of page.data.data ?? []) ids.add(edge.id);
    if (!page.data.has_more || !page.data.cursor) return ids;
    cursor = page.data.cursor;
  }
}

/**
 * The `details` object an error body carries, or an empty one.
 *
 * Optional on the error envelope, so a refusal without one is a shape to
 * assert against rather than a crash inside the assertion.
 */
function errorDetail(error: unknown): Record<string, unknown> {
  if (typeof error !== "object" || error === null) return {};
  const inner = (error as { error?: unknown }).error;
  if (typeof inner !== "object" || inner === null) return {};
  const details = (inner as { details?: unknown }).details;
  if (typeof details !== "object" || details === null) return {};
  return details as Record<string, unknown>;
}

describe("a bound is applied or refused, never dropped", () => {
  it("honors the item listing's own-time bound and refuses a name it does not declare", async () => {
    const seed = await client.createItem({
      type: "core.note",
      source: ctx.source,
      properties: { body: "time-filter-seed" },
    });
    expect(seed.ok).toBe(true);
    trackItem(ctx, seed.data.item.id);

    const scope = `source=${encodeURIComponent(ctx.source)}&limit=50`;

    // The bound is honored rather than merely accepted: an impossible lower
    // bound has to empty the page. Without this the refusal below would pass
    // against a server that refused every name and applied none of them.
    const bounded = await client.rawRequest<{ data?: unknown[] }>(
      `/items?${scope}&occurred_after=${IMPOSSIBLE_FUTURE}`,
    );
    expect(
      bounded.ok,
      `the own-time bound was refused: ${JSON.stringify(bounded.error)}`,
    ).toBe(true);
    expect(
      bounded.data.data ?? [],
      "the bound returned rows dated before an impossible lower bound, so it is being dropped",
    ).toHaveLength(0);

    // And a name the door does not declare is refused rather than stripped.
    // The refusal names it, so a caller learns which key was wrong rather
    // than receiving an unfiltered page at 200.
    const undeclared = await client.rawRequest<unknown>(
      `/items?${scope}&occurred_at_after=${IMPOSSIBLE_FUTURE}`,
    );
    expect(
      undeclared.status,
      "a bound name the door does not declare answered 200, so a caller who misspells one gets an unbounded listing that looks exactly like the bounded one they asked for",
    ).toBe(400);
    expect(errorDetail(undeclared.error).unknown_parameters).toEqual([
      "occurred_at_after",
    ]);
  });

  it("refuses an undeclared bound inside a bulk-action filter, where a dropped bound is every row", async () => {
    const seed = await client.createItem({
      type: "core.note",
      source: ctx.source,
      properties: { body: "time-filter-bulk-seed" },
    });
    expect(seed.ok).toBe(true);
    trackItem(ctx, seed.data.item.id);

    // Every request in this test is a dry run, and the action is the mildest
    // one the door takes. The refusal is what is under test; matching against
    // a live purge to observe it would be a test that has to work perfectly to
    // avoid destroying the rows it matched.
    const dryRun = (filter: Record<string, unknown>) =>
      client.rawRequest<{ matched?: number; dry_run?: boolean }>(
        "/items/bulk-actions",
        {
          method: "POST",
          body: {
            action: "update_tags",
            add: ["sync-contract-dry-run"],
            dry_run: true,
            filter: { source: ctx.source, ...filter },
          },
        },
      );

    // The control. The door has to match this run's own row under a filter
    // with no time bound, or "matched nothing" below would be the door
    // matching nothing at all.
    const unbounded = await dryRun({});
    expect(
      unbounded.ok,
      `the bulk-action door refused a dry run with no time bound: ${JSON.stringify(unbounded.error)}`,
    ).toBe(true);
    expect(
      unbounded.data.matched ?? 0,
      "the dry run matched nothing under an unbounded filter, so this door is not reading this run's rows",
    ).toBeGreaterThan(0);
    expect(
      unbounded.data.dry_run,
      "the door did not report the run as a dry run, so it may have written",
    ).toBe(true);

    const undeclared = await dryRun({ since: IMPOSSIBLE_FUTURE });
    expect(
      undeclared.status,
      "the bulk-action door accepted a filter field it does not declare; if it dropped it, the match set is every item the credential can see and the action is applied to all of them",
    ).toBe(400);

    // And the declared bound narrows rather than being dropped in its turn.
    // An impossible lower bound has to match nothing, against a filter that
    // matched this run's row a moment ago.
    const bounded = await dryRun({ occurred_after: IMPOSSIBLE_FUTURE });
    expect(
      bounded.ok,
      `the own-time bound was refused on the bulk-action door: ${JSON.stringify(bounded.error)}`,
    ).toBe(true);
    expect(
      bounded.data.matched ?? -1,
      "the bound matched rows dated before an impossible lower bound, so the bulk-action door is dropping it",
    ).toBe(0);
  });
});

describe("the catch-up window, at both ends", () => {
  /**
   * Three rows and three assertions per bound, because two of them cannot
   * tell the failures apart.
   *
   * The row **on** the bound's instant is what separates exclusive from
   * inclusive. The row **inside** the range is the control that separates a
   * working bound from one the validator stripped: a dropped predicate and a
   * predicate that matched nothing both leave the boundary row absent, and
   * only a row that must come back can tell them apart. The row **outside**
   * on the far side proves the bound narrows in the direction it claims.
   */
  it("bounds an item listing by updated_before, exclusively", async () => {
    const seeded: { id: string; at: number }[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await client.createItem({
        type: "core.note",
        source: ctx.source,
        properties: { body: `updated-before-seed-${String(i)}` },
      });
      expect(r.ok).toBe(true);
      trackItem(ctx, r.data.item.id);
      const at = Date.parse(r.data.item.updated_at ?? "");
      expect(Number.isNaN(at)).toBe(false);
      seeded.push({ id: r.data.item.id, at });
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const [earlier, onBound, later] = seeded;
    expect(
      new Set(seeded.map((row) => row.at)).size,
      "two rows share a modification instant, so a bound on one cannot separate them",
    ).toBe(3);

    const scope = `source=${encodeURIComponent(ctx.source)}&limit=200`;
    const ids = async (bound: string): Promise<string[]> => {
      const page = await client.rawRequest<{
        data?: { id: string }[];
        has_more?: boolean;
      }>(`/items?${scope}&${bound}`);
      expect(
        page.ok,
        `the bound was refused: ${JSON.stringify(page.error)}`,
      ).toBe(true);
      expect(
        page.data.has_more,
        "the page was truncated, so a row missing from it proves nothing about the bound",
      ).toBe(false);
      return (page.data.data ?? []).map((row) => row.id);
    };

    const bounded = await ids(
      `updated_before=${encodeURIComponent(new Date(onBound.at).toISOString())}`,
    );
    expect(
      bounded,
      "a row whose modification time is exactly the upper bound came back, so the bound is inclusive where the rule says exclusive",
    ).not.toContain(onBound.id);
    expect(
      bounded,
      "a row modified before the upper bound was missing, so the bound is being dropped or is narrowing the wrong way",
    ).toContain(earlier.id);
    expect(
      bounded,
      "a row modified after the upper bound came back, so the bound narrows in the wrong direction",
    ).not.toContain(later.id);
  });

  it("keeps updated_after inclusive, which the catch-up depends on", async () => {
    // The carve-out, asserted rather than assumed. `updated_at` ties across
    // a bulk write, so a strict lower bound would drop every row sharing a
    // resuming client's cursor — silently, and with no way to ask again.
    const seeded: { id: string; at: number }[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await client.createItem({
        type: "core.note",
        source: ctx.source,
        properties: { body: `updated-after-seed-${String(i)}` },
      });
      expect(r.ok).toBe(true);
      trackItem(ctx, r.data.item.id);
      const at = Date.parse(r.data.item.updated_at ?? "");
      expect(Number.isNaN(at)).toBe(false);
      seeded.push({ id: r.data.item.id, at });
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const [earlier, onBound, later] = seeded;
    expect(new Set(seeded.map((row) => row.at)).size).toBe(3);

    const page = await client.rawRequest<{
      data?: { id: string }[];
      has_more?: boolean;
    }>(
      `/items?source=${encodeURIComponent(ctx.source)}&limit=200&updated_after=${encodeURIComponent(
        new Date(onBound.at).toISOString(),
      )}`,
    );
    expect(
      page.ok,
      `the catch-up bound was refused: ${JSON.stringify(page.error)}`,
    ).toBe(true);
    expect(
      page.data.has_more,
      "the page was truncated, so a row missing from it proves nothing about the bound",
    ).toBe(false);
    const ids = (page.data.data ?? []).map((row) => row.id);

    expect(
      ids,
      "a row whose modification time is exactly the cursor was dropped: this is the catch-up losing every row that shares a bulk write's instant",
    ).toContain(onBound.id);
    expect(
      ids,
      "a row modified after the cursor was missing, so the catch-up is not returning what changed",
    ).toContain(later.id);
    expect(
      ids,
      "a row modified before the cursor came back, so the bound is being dropped",
    ).not.toContain(earlier.id);
  });

  it("bounds an edge listing by updated_before, exclusively", async () => {
    const [a, b, c, d] = await Promise.all(
      ["a", "b", "c", "d"].map((label) =>
        client.createItem({
          type: "core.note",
          source: ctx.source,
          properties: { body: `edge-updated-before-${label}` },
        }),
      ),
    );
    for (const r of [a, b, c, d]) {
      expect(r.ok).toBe(true);
      trackItem(ctx, r.data.item.id);
    }

    const seeded: { id: string; at: number }[] = [];
    for (const [source, target] of [
      [a, b],
      [a, c],
      [a, d],
    ] as const) {
      const edge = await client.createEdge({
        source_id: source.data.item.id,
        target_id: target.data.item.id,
        edge_type: "about",
      });
      expect(edge.ok).toBe(true);
      trackEdge(ctx, edge.data.edge.id);
      const at = Date.parse(edge.data.edge.updated_at ?? "");
      expect(Number.isNaN(at)).toBe(false);
      seeded.push({ id: edge.data.edge.id, at });
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const [earlier, onBound, later] = seeded;
    expect(
      new Set(seeded.map((row) => row.at)).size,
      "two edges share a modification instant, so a bound on one cannot separate them",
    ).toBe(3);

    // `/edges` takes no source filter, so the listing is scoped by its own
    // lower bound: a window opening a millisecond before the first of these
    // three can only answer with edges written since, which on this target
    // is these three and whatever a sibling file wrote in the same instant.
    const from = new Date(earlier.at - 1).toISOString();
    const ids = async (bound: string): Promise<string[]> => {
      const page = await client.rawRequest<{
        data?: { id: string }[];
        has_more?: boolean;
      }>(`/edges?limit=500&updated_after=${encodeURIComponent(from)}&${bound}`);
      expect(
        page.ok,
        `the bound was refused: ${JSON.stringify(page.error)}`,
      ).toBe(true);
      expect(
        page.data.has_more,
        "the page was truncated, so a row missing from it proves nothing about the bound",
      ).toBe(false);
      return (page.data.data ?? []).map((row) => row.id);
    };

    const bounded = await ids(
      `updated_before=${encodeURIComponent(new Date(onBound.at).toISOString())}`,
    );
    expect(
      bounded,
      "an edge whose modification time is exactly the upper bound came back, so the bound is inclusive where the rule says exclusive",
    ).not.toContain(onBound.id);
    expect(
      bounded,
      "an edge modified before the upper bound was missing, so the bound is being dropped or is narrowing the wrong way",
    ).toContain(earlier.id);
    expect(
      bounded,
      "an edge modified after the upper bound came back, so the bound narrows in the wrong direction",
    ).not.toContain(later.id);
  });
});

describe("the catch-up read covers the graph", () => {
  it("narrows an edge listing by modification time", async () => {
    requireRule(caps, "edgeUpdatedAfter");

    const [a, b, c] = await Promise.all([
      client.createItem({
        type: "core.note",
        source: ctx.source,
        properties: { body: "edge-catchup-a" },
      }),
      client.createItem({
        type: "core.note",
        source: ctx.source,
        properties: { body: "edge-catchup-b" },
      }),
      client.createItem({
        type: "core.note",
        source: ctx.source,
        properties: { body: "edge-catchup-c" },
      }),
    ]);
    expect(a.ok && b.ok && c.ok).toBe(true);
    for (const r of [a, b, c]) trackItem(ctx, r.data.item.id);

    // The edge a client already holds. It must be absent from the catch-up,
    // or the read is returning the whole listing and the assertion that
    // matters is satisfied by a filter that does nothing.
    const held = await client.createEdge({
      source_id: a.data.item.id,
      target_id: b.data.item.id,
      edge_type: "about",
    });
    expect(held.ok).toBe(true);
    trackEdge(ctx, held.data.edge.id);

    // A second of slack around the boundary absorbs clock skew between the
    // runner and the server. Nothing below depends on the exact instant, only
    // on one edge landing after it and one before.
    await new Promise((r) => setTimeout(r, 1100));
    const boundary = new Date().toISOString();
    await new Promise((r) => setTimeout(r, 1100));

    const missed = await client.createEdge({
      source_id: a.data.item.id,
      target_id: c.data.item.id,
      edge_type: "about",
    });
    expect(missed.ok).toBe(true);
    trackEdge(ctx, missed.data.edge.id);

    const ids = await edgesModifiedSince(boundary);

    expect(
      ids.has(held.data.edge.id),
      "an edge that did not change after the boundary came back, so the bound is not being applied",
    ).toBe(false);
    expect(
      ids.has(missed.data.edge.id),
      "an edge written after the boundary was missing from the catch-up, so a client that reconnects holds a graph it believes is current",
    ).toBe(true);
  });
});
