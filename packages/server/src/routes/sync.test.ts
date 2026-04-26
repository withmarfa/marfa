import { describe, expect, it, beforeEach } from "vitest";
import { Hono } from "hono";
import {
  syncRoutes,
  buildShapeFilter,
  expandReadableTypes,
  expandReadableEdgeTypes,
} from "./sync.js";
import type { ApiKey } from "@mymehq/shared";
import { createTestContext } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";

const SALT = "test-salt";
const ELECTRIC_URL = "http://electric.test:8603";

interface CapturedRequest {
  url: string;
  method: string;
  headers: Headers;
}

/**
 * Fake fetch that captures the request and returns a canned response.
 * The route never reaches a real Electric service; we assert on the
 * URL (table, where, params) and on what the proxy passes through.
 */
function makeFakeFetch(
  responseInit: {
    status?: number;
    body?: string;
    headers?: Record<string, string>;
  } = {},
): { fetch: typeof fetch; calls: CapturedRequest[] } {
  const calls: CapturedRequest[] = [];
  const fakeFetch: typeof fetch = (input, init) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({
      url,
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers ?? {}),
    });
    return Promise.resolve(
      new Response(responseInit.body ?? "[]", {
        status: responseInit.status ?? 200,
        headers: new Headers({
          "content-type": "application/json",
          "electric-handle": "h-test",
          "electric-offset": "42_0",
          ...responseInit.headers,
        }),
      }),
    );
  };
  return { fetch: fakeFetch, calls };
}

// ---------------------------------------------------------------------------
// buildShapeFilter — pure unit
// ---------------------------------------------------------------------------

const baseAdminKey: ApiKey = {
  id: "k_admin",
  label: "admin",
  source: "test",
  role: "admin",
  default_origin: "user",
  default_library: false,
  type_permissions: {},
  extension_permissions: {},
  edge_permissions: {},
  created_at: "2026-01-01T00:00:00Z",
  last_used_at: null,
};

const baseMemberKey: ApiKey = {
  ...baseAdminKey,
  id: "k_member",
  label: "member",
  role: "member",
};

describe("buildShapeFilter — items", () => {
  it("admin gets only the trashed-exclusion predicate", () => {
    const f = buildShapeFilter(baseAdminKey, "items");
    expect(f.where).toBe("state != 'trashed'");
    expect(f.params).toEqual([]);
  });

  it("admin with tenant scope gets tenant + trashed predicate", () => {
    const f = buildShapeFilter(
      { ...baseAdminKey, tenant_id: "t_abc" },
      "items",
    );
    expect(f.where).toBe("tenant_id = $1 AND state != 'trashed'");
    expect(f.params).toEqual(["t_abc"]);
  });

  it("member with explicit type permission gets a single-type filter", () => {
    const f = buildShapeFilter(
      { ...baseMemberKey, type_permissions: { "core.note": "read" } },
      "items",
    );
    expect(f.where).toBe("type IN ($1) AND state != 'trashed'");
    expect(f.params).toEqual(["core.note"]);
  });

  it("member with prefix wildcard expands against the type registry", () => {
    const f = buildShapeFilter(
      { ...baseMemberKey, type_permissions: { "core.media.*": "read" } },
      "items",
    );
    expect(f.where).toMatch(/^type IN \(.+\) AND state != 'trashed'$/);
    // All known core.media.* types should be included; at minimum the
    // type registry has core.media as a parent and several children.
    // We don't pin the exact list (the registry evolves), only that it
    // includes the expected anchor and that `params` equals the IN list.
    expect(f.params.some((t) => t.startsWith("core.media"))).toBe(true);
    expect(f.params.length).toBeGreaterThanOrEqual(1);
  });

  it("member with no readable types yields the empty-shape sentinel", () => {
    const f = buildShapeFilter(
      { ...baseMemberKey, type_permissions: {} },
      "items",
    );
    // EMPTY_FILTER carries the sentinel `__empty__` so the route can
    // distinguish "no readable rows" from "no filter".
    expect(f.where).toBe("__empty__");
  });

  it("global wildcard write permission expands to every known type", () => {
    const f = buildShapeFilter(
      { ...baseMemberKey, type_permissions: { "*": "write" } },
      "items",
    );
    expect(f.params.length).toBeGreaterThan(10);
    expect(f.params).toContain("core.note");
  });
});

describe("buildShapeFilter — edges", () => {
  it("admin gets no edge filter", () => {
    const f = buildShapeFilter(baseAdminKey, "edges");
    expect(f.where).toBeNull();
    expect(f.params).toEqual([]);
  });

  it("member with edge wildcard gets no edge_type filter", () => {
    const f = buildShapeFilter(
      { ...baseMemberKey, edge_permissions: { "*": "read" } },
      "edges",
    );
    expect(f.where).toBeNull();
  });

  it("member with specific edge types gets an edge_type IN filter", () => {
    const f = buildShapeFilter(
      {
        ...baseMemberKey,
        edge_permissions: { "parent-of": "read", "in-thread": "write" },
      },
      "edges",
    );
    expect(f.where).toMatch(/^edge_type IN \(\$1, \$2\)$/);
    expect(f.params).toEqual(
      expect.arrayContaining(["parent-of", "in-thread"]),
    );
  });

  it("member with no edge permissions yields the empty-shape sentinel", () => {
    const f = buildShapeFilter(baseMemberKey, "edges");
    expect(f.where).toBe("__empty__");
  });
});

describe("buildShapeFilter — metadata (subquery on items.type)", () => {
  it("admin gets no subquery (full read)", () => {
    const f = buildShapeFilter(baseAdminKey, "metadata");
    expect(f.where).toBeNull();
  });

  it("member scopes via item_id IN (SELECT id FROM items WHERE type IN ...)", () => {
    const f = buildShapeFilter(
      { ...baseMemberKey, type_permissions: { "core.note": "read" } },
      "metadata",
    );
    expect(f.where).toMatch(
      /^item_id IN \(SELECT id FROM items WHERE type IN \(\$1\) AND state != 'trashed'\)$/,
    );
    expect(f.params).toEqual(["core.note"]);
  });
});

describe("expandReadableTypes / expandReadableEdgeTypes", () => {
  it("expandReadableTypes drops 'none' permissions", () => {
    const out = expandReadableTypes({
      ...baseMemberKey,
      type_permissions: {
        "core.note": "read",
        "core.media.book": "none",
      },
    });
    expect(out).toContain("core.note");
    expect(out).not.toContain("core.media.book");
  });

  it("expandReadableEdgeTypes returns null for wildcard", () => {
    const out = expandReadableEdgeTypes({
      ...baseMemberKey,
      edge_permissions: { "*": "read" },
    });
    expect(out).toBeNull();
  });

  it("expandReadableEdgeTypes filters out unknown edge types", () => {
    const out = expandReadableEdgeTypes({
      ...baseMemberKey,
      edge_permissions: {
        "parent-of": "read",
        "definitely-not-a-real-edge-type": "read",
      },
    });
    expect(out).toEqual(["parent-of"]);
  });
});

// ---------------------------------------------------------------------------
// Route — integration with auth + Hono
// ---------------------------------------------------------------------------

let ctx: TestContext;

beforeEach(async () => {
  ctx = await createTestContext();
});

describe("GET /sync/shapes/:family — auth & routing", () => {
  it("rejects unauthenticated requests", async () => {
    const fake = makeFakeFetch();
    const app = mountSyncOnly(fake.fetch);
    const res = await app.request("/sync/shapes/items");
    expect(res.status).toBe(401);
    expect(fake.calls.length).toBe(0);
  });

  it("returns 400 for unknown shape family", async () => {
    const fake = makeFakeFetch();
    const app = mountSyncOnly(fake.fetch);
    const res = await app.request("/sync/shapes/wat", {
      headers: { Authorization: `Bearer ${makeAdminKey()}` },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("shape_unknown");
    expect(fake.calls.length).toBe(0);
  });

  it("admin gets a forwarded shape request with no type filter", async () => {
    const fake = makeFakeFetch();
    const app = mountSyncOnly(fake.fetch);
    const res = await app.request("/sync/shapes/edges?offset=-1&live=true", {
      headers: { Authorization: `Bearer ${makeAdminKey()}` },
    });
    expect(res.status).toBe(200);
    expect(fake.calls.length).toBe(1);
    const url = new URL(fake.calls[0]!.url);
    expect(url.pathname).toBe("/v1/shape");
    expect(url.searchParams.get("table")).toBe("edges");
    expect(url.searchParams.get("offset")).toBe("-1");
    expect(url.searchParams.get("live")).toBe("true");
    expect(url.searchParams.get("where")).toBeNull();
  });

  it("forwards Vary: Authorization on the response", async () => {
    const fake = makeFakeFetch();
    const app = mountSyncOnly(fake.fetch);
    const res = await app.request("/sync/shapes/items?offset=-1", {
      headers: { Authorization: `Bearer ${makeAdminKey()}` },
    });
    expect(res.headers.get("Vary")).toBe("Authorization");
  });

  it("forwards electric-* headers from the upstream", async () => {
    const fake = makeFakeFetch();
    const app = mountSyncOnly(fake.fetch);
    const res = await app.request("/sync/shapes/items?offset=-1", {
      headers: { Authorization: `Bearer ${makeAdminKey()}` },
    });
    expect(res.headers.get("electric-handle")).toBe("h-test");
    expect(res.headers.get("electric-offset")).toBe("42_0");
  });

  it("returns 502 when the upstream is unreachable", async () => {
    const failingFetch: typeof fetch = () =>
      Promise.reject(new Error("connect ECONNREFUSED"));
    const app = mountSyncOnly(failingFetch);
    const res = await app.request("/sync/shapes/items?offset=-1", {
      headers: { Authorization: `Bearer ${makeAdminKey()}` },
    });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("shape_upstream_unavailable");
  });

  it("does not forward the caller's Authorization header to the upstream", async () => {
    const fake = makeFakeFetch();
    const app = mountSyncOnly(fake.fetch);
    await app.request("/sync/shapes/items?offset=-1", {
      headers: { Authorization: `Bearer ${makeAdminKey()}` },
    });
    expect(fake.calls[0]!.headers.get("authorization")).toBeNull();
    expect(fake.calls[0]!.headers.get("Authorization")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Helpers — the test mounts a minimal Hono app with just auth + sync,
// ducking the rest of the stack so we exercise the route in isolation.
// ---------------------------------------------------------------------------

function makeAdminKey(): string {
  // Mint a real admin key into the shared TestContext. This re-uses the
  // existing storage so authMiddleware accepts it.
  return ctx.adminKey;
}

function mountSyncOnly(fetchImpl: typeof fetch): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  // Mirror the production stack: error handler first so MymeError
  // (e.g. 401 from requireAuth) maps to its proper HTTP response, then
  // auth middleware, then the route under test.
  app.onError(createErrorHandler({ errorWebhookUrl: "" }));
  app.use("*", authMiddleware(ctx.storage, SALT));
  app.route("/sync", syncRoutes({ electricUrl: ELECTRIC_URL, fetch: fetchImpl }));
  return app;
}

import type { AppEnv } from "../middleware/auth.js";
import { authMiddleware } from "../middleware/auth.js";
import { createErrorHandler } from "../middleware/error-handler.js";
