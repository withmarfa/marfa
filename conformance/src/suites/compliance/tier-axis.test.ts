import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import {
  createTestContext,
  trackItem,
  trackKey,
  cleanup,
} from "../../utils/setup.js";

let client: MarfaClient;
let ctx: TestContext;
let apiUrl: string;

beforeAll(async () => {
  ({ ctx, client, apiUrl } = await createTestContext(
    "compliance",
    "tier-axis",
  ));
});

afterAll(async () => {
  await cleanup(ctx);
});

async function makeClient(
  label: string,
  defaultTier: "library" | "feed",
): Promise<MarfaClient> {
  const resp = await client.createKey({
    label,
    source: `${ctx.source}-${label}`,
    type_permissions: { "*": "write" },
    default_tier: defaultTier,
  });
  expect(resp.ok).toBe(true);
  trackKey(ctx, resp.data.id);
  return new MarfaClient({ baseUrl: apiUrl, apiKey: resp.data.key });
}

describe("tier axis", () => {
  it("POST with tier=library at top level stamps tier=library", async () => {
    const r = await client.createItem({
      type: "core.note",
      properties: { body: "lib-top" },
      tier: "library",
    });
    expect(r.ok).toBe(true);
    trackItem(ctx, r.data.item.id);
    expect(r.data.item.tier).toBe("library");
  });

  it("POST with tier=feed at top level stamps tier=feed", async () => {
    const r = await client.createItem({
      type: "core.note",
      properties: { body: "feed" },
      tier: "feed",
    });
    expect(r.ok).toBe(true);
    trackItem(ctx, r.data.item.id);
    expect(r.data.item.tier).toBe("feed");
  });

  it("default-when-omitted is library", async () => {
    // The file credential's default_tier is "library"; omitting tier should
    // produce library, not feed.
    const r = await client.createItem({
      type: "core.note",
      properties: { body: "no-tier" },
    });
    expect(r.ok).toBe(true);
    trackItem(ctx, r.data.item.id);
    expect(r.data.item.tier).toBe("library");
  });

  it("default query omitting tier returns both library and feed items", async () => {
    const tag = `tier-default-${ctx.runId}`;
    const lib = await client.createItem({
      type: "core.note",
      properties: { body: "lib" },
      tags: [tag],
      tier: "library",
    });
    expect(lib.ok).toBe(true);
    trackItem(ctx, lib.data.item.id);
    const feed = await client.createItem({
      type: "core.note",
      properties: { body: "feed" },
      tags: [tag],
      tier: "feed",
    });
    expect(feed.ok).toBe(true);
    trackItem(ctx, feed.data.item.id);

    const list = await client.listItems({ tags: [tag] });
    expect(list.ok).toBe(true);
    const ids = list.data.data.map((i) => i.id);
    expect(ids).toContain(lib.data.item.id);
    expect(ids).toContain(feed.data.item.id);
  });

  it("tier=library returns library items only", async () => {
    const tag = `tier-lib-${ctx.runId}`;
    const lib = await client.createItem({
      type: "core.note",
      properties: { body: "lib" },
      tags: [tag],
      tier: "library",
    });
    expect(lib.ok).toBe(true);
    trackItem(ctx, lib.data.item.id);
    const feed = await client.createItem({
      type: "core.note",
      properties: { body: "feed" },
      tags: [tag],
      tier: "feed",
    });
    expect(feed.ok).toBe(true);
    trackItem(ctx, feed.data.item.id);

    const list = await client.listItems({ tags: [tag], tier: "library" });
    expect(list.ok).toBe(true);
    const ids = list.data.data.map((i) => i.id);
    expect(ids).toContain(lib.data.item.id);
    expect(ids).not.toContain(feed.data.item.id);
  });

  it("tier=feed returns feed items only", async () => {
    const tag = `tier-feed-${ctx.runId}`;
    const lib = await client.createItem({
      type: "core.note",
      properties: { body: "lib" },
      tags: [tag],
      tier: "library",
    });
    expect(lib.ok).toBe(true);
    trackItem(ctx, lib.data.item.id);
    const feed = await client.createItem({
      type: "core.note",
      properties: { body: "feed" },
      tags: [tag],
      tier: "feed",
    });
    expect(feed.ok).toBe(true);
    trackItem(ctx, feed.data.item.id);

    const list = await client.listItems({ tags: [tag], tier: "feed" });
    expect(list.ok).toBe(true);
    const ids = list.data.data.map((i) => i.id);
    expect(ids).not.toContain(lib.data.item.id);
    expect(ids).toContain(feed.data.item.id);
  });

  it("tier=all returns both library and feed items", async () => {
    const tag = `tier-all-${ctx.runId}`;
    const lib = await client.createItem({
      type: "core.note",
      properties: { body: "lib" },
      tags: [tag],
      tier: "library",
    });
    expect(lib.ok).toBe(true);
    trackItem(ctx, lib.data.item.id);
    const feed = await client.createItem({
      type: "core.note",
      properties: { body: "feed" },
      tags: [tag],
      tier: "feed",
    });
    expect(feed.ok).toBe(true);
    trackItem(ctx, feed.data.item.id);

    const list = await client.listItems({ tags: [tag], tier: "all" });
    expect(list.ok).toBe(true);
    const ids = list.data.data.map((i) => i.id);
    expect(ids).toContain(lib.data.item.id);
    expect(ids).toContain(feed.data.item.id);
  });

  it("credential default_tier stamps tier when client omits", async () => {
    const feedKey = await makeClient("feed-key", "feed");
    const r = await feedKey.createItem({
      type: "core.note",
      properties: { body: "stamped-feed" },
    });
    expect(r.ok).toBe(true);
    trackItem(ctx, r.data.item.id);
    expect(r.data.item.tier).toBe("feed");

    const libKey = await makeClient("lib-key", "library");
    const r2 = await libKey.createItem({
      type: "core.note",
      properties: { body: "stamped-lib" },
    });
    expect(r2.ok).toBe(true);
    trackItem(ctx, r2.data.item.id);
    expect(r2.data.item.tier).toBe("library");
  });

  it("client per-item tier overrides credential default_tier", async () => {
    const feedKey = await makeClient("override-key", "feed");
    const libItem = await feedKey.createItem({
      type: "core.note",
      properties: { body: "override-to-lib" },
      tier: "library",
    });
    expect(libItem.ok).toBe(true);
    trackItem(ctx, libItem.data.item.id);
    expect(libItem.data.item.tier).toBe("library");

    const libKey = await makeClient("override-key-2", "library");
    const feedItem = await libKey.createItem({
      type: "core.note",
      properties: { body: "override-to-feed" },
      tier: "feed",
    });
    expect(feedItem.ok).toBe(true);
    trackItem(ctx, feedItem.data.item.id);
    expect(feedItem.data.item.tier).toBe("feed");
  });

  it.each([
    { mode: "upsert", defaultTier: "feed" },
    { mode: "create_only", defaultTier: "feed" },
    { mode: "upsert", defaultTier: "library" },
    { mode: "create_only", defaultTier: "library" },
  ] as const)(
    "uses the credential default and explicit tier on new bulk rows ($mode, $defaultTier)",
    async ({ mode, defaultTier }) => {
      const scoped = await makeClient(`${mode}-${defaultTier}`, defaultTier);
      const override = defaultTier === "feed" ? "library" : "feed";
      const response = await scoped.bulkItems({
        mode,
        items: [
          {
            type: "core.note",
            source_id: `${ctx.runId}-${mode}-${defaultTier}-default`,
            properties: { body: "credential default" },
          },
          {
            type: "core.note",
            source_id: `${ctx.runId}-${mode}-${defaultTier}-override`,
            properties: { body: "explicit override" },
            tier: override,
          },
        ],
      });
      expect(response.status, JSON.stringify(response.error)).toBe(200);
      expect(response.data.counts).toMatchObject({ created: 2, errored: 0 });
      expect(response.data.results).toHaveLength(2);
      for (const result of response.data.results) {
        expect(result.outcome).toBe("created");
        expect(result.id).toBeDefined();
        trackItem(ctx, result.id!);
      }
      const explicit = await scoped.getItem(response.data.results[1]!.id!);
      expect(explicit.status).toBe(200);
      expect(explicit.data.item.tier).toBe(override);
      const omitted = await scoped.getItem(response.data.results[0]!.id!);
      expect(omitted.status).toBe(200);
      expect(omitted.data.item.tier).toBe(defaultTier);
    },
  );

  it("keeps a row's tier through a natural-key re-sync on both doors", async () => {
    // A person moves a synced row to the feed; the connector's next sync
    // names no tier and must leave it there, whichever door it uses.
    for (const door of ["single", "bulk"] as const) {
      const sourceId = `tier-resync-${door}-${String(Date.now())}`;
      const first = await client.createItem({
        type: "core.note",
        source: ctx.source,
        source_id: sourceId,
        properties: { body: "synced" },
      });
      expect(first.status, JSON.stringify(first.error)).toBe(201);
      trackItem(ctx, first.data.item.id);
      expect(first.data.item.tier).toBe("library");

      const moved = await client.updateItem(first.data.item.id, {
        tier: "feed",
        version: first.data.item.version,
      });
      expect(moved.status, JSON.stringify(moved.error)).toBe(200);

      const body = {
        type: "core.note",
        source: ctx.source,
        source_id: sourceId,
        properties: { body: "synced again" },
      };
      if (door === "single") {
        const again = await client.createItem(body);
        expect(again.status, JSON.stringify(again.error)).toBe(200);
        expect(again.data.item.tier).toBe("feed");
      } else {
        const again = await client.bulkItems({ atomic: true, items: [body] });
        expect(again.status, JSON.stringify(again.error)).toBe(200);
        expect(again.data.results[0]?.outcome).toBe("updated");
      }
      const read = await client.getItem(first.data.item.id);
      expect(read.data.item.properties.body).toBe("synced again");
      expect(read.data.item.tier).toBe("feed");
    }
  });
});
