import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createTestContext, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { hashApiKey } from "../middleware/auth.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(() => {
  ctx.cleanup();
});

describe("POST /import", () => {
  it("imports items in bulk", async () => {
    const res = await request(ctx.app, "POST", "/import", {
      key: ctx.adminKey,
      body: {
        items: [
          {
            type: "core.note",
            properties: { body: "Import test 1" },
            source: "import-test",
            source_id: "imp-1",
          },
          {
            type: "core.note",
            properties: { body: "Import test 2" },
            source: "import-test",
            source_id: "imp-2",
          },
        ],
      },
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      imported: number;
      duplicates: number;
    };
    expect(data.imported).toBe(2);
    expect(data.duplicates).toBe(0);
  });

  it("detects duplicate source_id on re-import", async () => {
    const items = [
      {
        type: "core.note",
        properties: { body: "Dup test" },
        source: "dup-test",
        source_id: "dup-1",
      },
    ];

    await request(ctx.app, "POST", "/import", {
      key: ctx.adminKey,
      body: { items },
    });

    const res = await request(ctx.app, "POST", "/import", {
      key: ctx.adminKey,
      body: { items },
    });
    const data = (await res.json()) as {
      imported: number;
      duplicates: number;
    };
    expect(data.duplicates).toBe(1);
  });

  it("requires admin role", async () => {
    // Create a non-admin key
    const rawKey = `myme_k1_member_${Math.random().toString(36).slice(2)}`;
    const keyHash = hashApiKey(rawKey, "test-salt");
    await ctx.storage.keys.create(
      {
        label: "import-member",
        role: "member",
        type_permissions: { "*": "write" },
      },
      keyHash,
    );

    const res = await request(ctx.app, "POST", "/import", {
      key: rawKey,
      body: { items: [{ type: "core.note", properties: { body: "x" } }] },
    });
    expect(res.status).toBe(403);
  });
});

describe("GET /export", () => {
  it("exports items as NDJSON", async () => {
    // Create a test item first
    await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: {
        type: "core.note",
        properties: { body: "Export test" },
        source: "export-test",
        source_id: "exp-1",
      },
    });

    const res = await request(ctx.app, "GET", "/export", {
      key: ctx.adminKey,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("ndjson");

    const text = await res.text();
    const lines = text.trim().split("\n");
    expect(lines.length).toBeGreaterThan(0);

    const first = JSON.parse(lines[0]) as { item: { id: string } };
    expect(first.item.id).toBeDefined();
  });

  it("filters export by type", async () => {
    await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: {
        type: "core.bookmark",
        properties: { url: "https://example.com" },
      },
    });

    const res = await request(
      ctx.app,
      "GET",
      "/export?type=core.bookmark",
      { key: ctx.adminKey },
    );
    expect(res.status).toBe(200);

    const text = await res.text();
    const lines = text.trim().split("\n");
    for (const line of lines) {
      const parsed = JSON.parse(line) as { item: { type: string } };
      expect(parsed.item.type).toBe("core.bookmark");
    }
  });

  it("round-trips: export then import produces same items", async () => {
    // Create items with a unique source
    const source = `roundtrip-${Math.random().toString(36).slice(2)}`;
    await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: {
        type: "core.note",
        properties: { body: "Round trip note", title: "RT" },
        source,
        source_id: "rt-1",
        tags: ["roundtrip"],
      },
    });

    // Export
    const exportRes = await request(
      ctx.app,
      "GET",
      `/export?type=core.note`,
      { key: ctx.adminKey },
    );
    const exportText = await exportRes.text();
    const lines = exportText.trim().split("\n");
    const exported = lines.map(
      (l) =>
        JSON.parse(l) as {
          item: Record<string, unknown>;
          metadata: Record<string, unknown>;
        },
    );

    // Find our item
    const ours = exported.find(
      (e) => (e.item as { source?: string }).source === source,
    );
    expect(ours).toBeDefined();

    // Import with new source to avoid dedup
    const importRes = await request(ctx.app, "POST", "/import", {
      key: ctx.adminKey,
      body: {
        items: [
          {
            type: "core.note",
            properties: ours?.item.properties,
            source: `${source}-copy`,
            source_id: "rt-1",
          },
        ],
      },
    });
    expect(importRes.status).toBe(200);
    const importData = (await importRes.json()) as { imported: number };
    expect(importData.imported).toBe(1);
  });
});
