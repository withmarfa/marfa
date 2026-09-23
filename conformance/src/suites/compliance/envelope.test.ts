import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import {
  cleanup,
  createTestContext,
  trackEdge,
  trackItem,
  trackWebhook,
} from "../../utils/setup.js";
import { createNote } from "../../generators/items.js";
import {
  expectMatchesSchema,
  pageDoors,
  servedDocument,
} from "../../utils/openapi.js";

/**
 * Every list and every search answers one envelope: the rows under `data`
 * and the cursor that continues them under `next_cursor`, `null` on the
 * last page. Two doors carry a sibling about the answer rather than the
 * page. Nothing else stands beside the two keys.
 */

let client: MarfaClient;
let ctx: TestContext;
let apiUrl: string;
let apiKey: string;
const operatorKey = process.env.MARFA_OPERATOR_KEY ?? "";

let itemId: string;
let targetId: string;
let webhookId: string;
let connectorId: string;
let blobHash: string;
let title: string;

beforeAll(async () => {
  ({ ctx, client, apiUrl, apiKey } = await createTestContext(
    "compliance",
    "envelope",
  ));
  title = `envelope-${ctx.runId}`;
  const a = await client.createItem(
    createNote({ source: ctx.source, properties: { title, body: title } }),
  );
  const b = await client.createItem(createNote({ source: ctx.source }));
  expect(a.ok && b.ok).toBe(true);
  itemId = a.data.item.id;
  trackItem(ctx, itemId);
  trackItem(ctx, b.data.item.id);
  targetId = b.data.item.id;
  const edge = await client.createEdge({
    source_id: itemId,
    target_id: b.data.item.id,
    edge_type: "about",
  });
  expect(edge.ok).toBe(true);
  trackEdge(ctx, edge.data.edge.id);
  const webhook = await client.createWebhook({
    url: "https://example.com/hook",
    events: ["item.created"],
  });
  expect(webhook.ok).toBe(true);
  webhookId = webhook.data.id;
  trackWebhook(ctx, webhookId);
  const connector = await client.registerConnector({ name: title });
  expect(connector.ok).toBe(true);
  connectorId = connector.data.id;
  const blob = await client.uploadBlob(
    new TextEncoder().encode(title),
    "text/plain",
  );
  expect(blob.ok).toBe(true);
  blobHash = blob.data.hash;
});

afterAll(async () => {
  await cleanup(ctx);
});

async function read(path: string, key = apiKey): Promise<unknown> {
  const response = await fetch(`${apiUrl}${path}`, {
    headers: { Authorization: `Bearer ${key}` },
  });
  expect(response.status, path).toBe(200);
  return response.json();
}

describe("one envelope for every list and search", () => {
  const doors: {
    template: string;
    path: () => string;
    siblings?: string[];
    operator?: boolean;
  }[] = [
    { template: "/items", path: () => `/items?source=${ctx.source}` },
    { template: "/edges", path: () => "/edges" },
    { template: "/items/{id}/edges", path: () => `/items/${itemId}/edges` },
    {
      template: "/items/{id}/backrefs",
      path: () => `/items/${itemId}/backrefs`,
    },
    { template: "/audit", path: () => "/audit" },
    { template: "/search", path: () => `/search?q=${title}` },
    { template: "/types", path: () => "/types" },
    { template: "/edge-types", path: () => "/edge-types" },
    { template: "/keys", path: () => "/keys" },
    { template: "/webhooks", path: () => "/webhooks" },
    {
      template: "/webhooks/{id}/deliveries",
      path: () => `/webhooks/${webhookId}/deliveries`,
    },
    { template: "/metadata/tags", path: () => "/metadata/tags" },
    {
      template: "/items/{id}/versions",
      path: () => `/items/${itemId}/versions`,
    },
    { template: "/connectors", path: () => "/connectors" },
    {
      template: "/connectors/{id}/runs",
      path: () => `/connectors/${connectorId}/runs`,
    },
    { template: "/housekeeping", path: () => "/housekeeping", operator: true },
    {
      template: "/blobs/orphans",
      path: () => "/blobs/orphans",
      operator: true,
    },
    {
      template: "/blobs/stores",
      path: () => "/blobs/stores",
      siblings: ["min_copies"],
      operator: true,
    },
    {
      template: "/blobs/{hash}/locations",
      path: () => `/blobs/${blobHash}/locations`,
    },
    {
      template: "/admin/platform-types/drift",
      path: () => "/admin/platform-types/drift",
      operator: true,
    },
    {
      template: "/occurrences",
      path: () =>
        "/occurrences?from=2026-01-01T00:00:00Z&to=2026-02-01T00:00:00Z",
      siblings: ["window", "scan"],
    },
  ];

  it("names every door the document publishes as a page", async () => {
    // Derived from the served document rather than counted, so a door that
    // starts answering a page without a row here turns this red.
    expect(doors.map((door) => door.template).sort()).toEqual(
      pageDoors(await servedDocument()).sort(),
    );
  });

  for (const door of doors) {
    it(`GET ${door.template} answers data and next_cursor`, async () => {
      const body = (await read(
        door.path(),
        door.operator ? operatorKey : apiKey,
      )) as Record<string, unknown>;
      await expectMatchesSchema("GET", door.template, 200, body);
      // The occurrence door adds its diagnostics only when there are any,
      // so on that door alone they are set aside from the key set.
      const diagnostics =
        door.template === "/occurrences"
          ? ["series_errors", "series_errors_truncated", "expansion_incomplete"]
          : [];
      expect(
        Object.keys(body)
          .filter((key) => !diagnostics.includes(key))
          .sort(),
      ).toEqual(["data", "next_cursor", ...(door.siblings ?? [])].sort());
      expect(Array.isArray(body.data)).toBe(true);
      expect(
        body.next_cursor === null || typeof body.next_cursor === "string",
      ).toBe(true);
    });
  }

  it("carries each hydrated edge block as a page", async () => {
    type Blocks = Record<string, Record<string, unknown>>;
    const isPage = (block: Record<string, unknown> | undefined) => {
      expect(Object.keys(block ?? {}).sort()).toEqual(["data", "next_cursor"]);
      expect(block?.next_cursor).toBeNull();
    };
    const detail = (await read(`/items/${itemId}?include=backrefs`)) as {
      item: { edges: Blocks };
    };
    isPage(detail.item.edges.about);
    const target = (await read(`/items/${targetId}?include=backrefs`)) as {
      backrefs: Blocks;
    };
    isPage(target.backrefs.about);
    const listed = (await read(
      `/items?source=${ctx.source}&include=edges`,
    )) as { data: { id: string; edges?: Blocks }[] };
    isPage(listed.data.find((row) => row.id === itemId)?.edges?.about);
  });

  it("carries an item's hydrated history as a page", async () => {
    const detail = (await read(`/items/${itemId}?include=versions`)) as {
      versions?: Record<string, unknown>;
    };
    await expectMatchesSchema("GET", "/items/{id}", 200, detail);
    expect(Object.keys(detail.versions ?? {}).sort()).toEqual([
      "data",
      "next_cursor",
    ]);
    expect(Array.isArray(detail.versions?.data)).toBe(true);
    expect(detail.versions?.next_cursor).toBeNull();
  });
});

describe("search pages by cursor", () => {
  it("walks to a null cursor, delivering every hit once", async () => {
    const tag = `envelope-search-${ctx.runId}`;
    for (let i = 0; i < 5; i++) {
      const r = await client.createItem(
        createNote({
          source: ctx.source,
          properties: { title: `${tag} ${String(i)}`, body: tag },
        }),
      );
      expect(r.ok).toBe(true);
      trackItem(ctx, r.data.item.id);
    }
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const answer = await client.search(tag, {
        limit: 2,
        ...(cursor === undefined ? {} : { cursor }),
      });
      expect(answer.ok).toBe(true);
      seen.push(...answer.data.data.map((hit) => hit.item.id));
      if (answer.data.next_cursor === null) break;
      cursor = answer.data.next_cursor;
    }
    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
  });

  it("refuses a cursor minted for another search", async () => {
    const token = `envelope-bound-${ctx.runId}`;
    for (let i = 0; i < 2; i++) {
      const r = await client.createItem(
        createNote({ source: ctx.source, properties: { body: token } }),
      );
      expect(r.ok).toBe(true);
      trackItem(ctx, r.data.item.id);
    }
    const first = await client.search(token, { limit: 1 });
    expect(first.data.next_cursor).not.toBeNull();
    // The witness: the same cursor on the same search continues it.
    const same = await client.search(token, {
      limit: 1,
      cursor: first.data.next_cursor!,
    });
    expect(same.status).toBe(200);
    const refused = await client.search(`${token} other`, {
      limit: 1,
      cursor: first.data.next_cursor!,
    });
    expect(refused.status).toBe(400);
    expect(refused.error?.error.code).toBe("validation_error");
  });

  it("refuses an offset query key", async () => {
    // A search pages by cursor alone. The refusal names the key, so a 400
    // for some other reason, such as a missing `q`, cannot pass for it.
    const response = await fetch(`${apiUrl}/search?q=${title}&offset=1`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as {
      error: { code: string; details?: { unknown_parameters?: string[] } };
    };
    expect(body.error.code).toBe("validation_error");
    expect(body.error.details?.unknown_parameters).toEqual(["offset"]);
  });

  it("refuses a cursor another listing issued, and one it cannot read", async () => {
    const listing = await client.listItems({ source: ctx.source, limit: 1 });
    expect(listing.data.next_cursor).not.toBeNull();
    for (const cursor of [listing.data.next_cursor!, "not-a-cursor"]) {
      const refused = await client.search(title, { cursor });
      expect(refused.status).toBe(400);
      expect(refused.error?.error.code).toBe("validation_error");
    }
  });
});
