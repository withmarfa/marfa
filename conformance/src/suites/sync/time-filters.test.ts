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
 * rows, and a filter it names is either applied or refused — never dropped.
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
 * That door is why this file exists rather than the naming being tidied in
 * passing.
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

describe("a renamed time filter is refused, never dropped", () => {
  it("refuses the old name on the read door and honors the new one", async () => {
    requireRule(caps, "renamedTimeFilters");

    const seed = await client.createItem({
      type: "core.note",
      source: ctx.source,
      properties: { body: "renamed-filter-seed" },
    });
    expect(seed.ok).toBe(true);
    trackItem(ctx, seed.data.item.id);

    const scope = `source=${encodeURIComponent(ctx.source)}&limit=50`;

    // The control, and what it establishes depends on how the door answers
    // it. An undeclared key that is ignored makes a 400 on the old name
    // readable on its own; an undeclared key that is refused means the door
    // refuses unknown input generally, and the refusal has to be read.
    const ignored = await client.rawRequest<{ data?: unknown[] }>(
      `/items?${scope}&zzz_not_a_parameter=${IMPOSSIBLE_FUTURE}`,
    );
    expect(
      [200, 400],
      `an undeclared query key answered ${ignored.status}, which is neither ignored nor refused`,
    ).toContain(ignored.status);

    const old = await client.rawRequest<unknown>(
      `/items?${scope}&since=${IMPOSSIBLE_FUTURE}`,
    );
    expect(
      old.status,
      "the old filter name answered 200, so a caller still using it gets an unbounded listing that looks exactly like the bounded one they asked for",
    ).toBe(400);

    if (ignored.status === 400) {
      // The door refuses every key it does not declare, so a 400 here is the
      // answer it gives any unknown name and says nothing about the rename.
      // The message cannot settle it either: the general refusal lists every
      // parameter the door accepts, `timestamp_after` among them, so a
      // substring check passes against a server that has never renamed
      // anything. The refusal has to name what replaced the old filter.
      const detail = errorDetail(old.error);
      expect(
        detail.renamed_from,
        `"since" was refused as an unrecognized parameter rather than as a renamed one, so the caller is told their request is wrong and not what replaced it: ${JSON.stringify(old.error)}`,
      ).toBe("since");
      expect(
        detail.use,
        "the refusal names the old filter but not the one that replaces it",
      ).toBe("timestamp_after");
    } else {
      expect(
        JSON.stringify(old.error),
        "the refusal does not name the filter that replaces it, so a caller learns their request is wrong and not how to fix it",
      ).toContain("timestamp_after");
    }

    // The new name is honored rather than merely accepted: an impossible
    // lower bound has to empty the page. Without this the test would pass
    // against a server that refused the old name and dropped the new one.
    const renamed = await client.rawRequest<{ data?: unknown[] }>(
      `/items?${scope}&timestamp_after=${IMPOSSIBLE_FUTURE}`,
    );
    expect(
      renamed.ok,
      `the replacement filter was refused: ${JSON.stringify(renamed.error)}`,
    ).toBe(true);
    expect(
      renamed.data.data ?? [],
      "the replacement filter returned rows dated before an impossible lower bound, so it is being dropped exactly as the old name was",
    ).toHaveLength(0);
  });

  it("refuses the old name inside a bulk-action filter, where a dropped bound is every row", async () => {
    requireRule(caps, "renamedTimeFilters");

    const seed = await client.createItem({
      type: "core.note",
      source: ctx.source,
      properties: { body: "renamed-filter-bulk-seed" },
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

    const old = await dryRun({ since: IMPOSSIBLE_FUTURE });
    expect(
      old.status,
      "the bulk-action door accepted the old filter name; if it dropped it, the match set is every item the credential can see and the action is applied to all of them",
    ).toBe(400);

    // And the replacement narrows rather than being dropped in its turn. An
    // impossible lower bound has to match nothing, against a filter that
    // matched this run's row a moment ago.
    const renamed = await dryRun({ timestamp_after: IMPOSSIBLE_FUTURE });
    expect(
      renamed.ok,
      `the replacement filter was refused on the bulk-action door: ${JSON.stringify(renamed.error)}`,
    ).toBe(true);
    expect(
      renamed.data.matched ?? -1,
      "the replacement filter matched rows dated before an impossible lower bound, so the bulk-action door is dropping it",
    ).toBe(0);
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
