/**
 * T-045 — OAuth scope grammar enforcement.
 *
 * The scope grammar in `@mymehq/shared` parses `<type>:<verb>`,
 * `edge.<type>:<verb>`, `metadata:<verb>`, and `metadata.<sub>:<verb>`
 * shapes; the auth middleware projects them into `type_permissions`,
 * `edge_permissions`, and `metadata_permissions` on a synthetic
 * member-tier `ApiKey` at token-resolve time.
 *
 * These tests are the load-bearing verification that the projection
 * actually gates the data plane — they exercise the four route
 * families end-to-end with narrow scopes and assert the correct
 * accept/reject shape per scope kind.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  request,
  createTestContext,
  TEST_API_KEY_SALT,
} from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { hashApiKey } from "./auth.js";

let ctx: TestContext;

beforeEach(async () => {
  ctx = await createTestContext();
});

afterEach(() => {
  ctx.cleanup();
});

interface MintedToken {
  rawToken: string;
  grantId: string;
}

/**
 * Mints an OAuth token bound to a fresh app `system.connection`
 * stamped with the requested scopes. Returns both the bearer token and
 * the grant's item id (for revocation tests).
 */
async function mintOAuthToken(opts: {
  scopes: string[];
  tenantId?: string;
}): Promise<MintedToken> {
  const client = await ctx.storage.oauth.createClient({
    name: "Scope Enforcement Test App",
    redirect_uris: ["http://localhost/cb"],
  });
  const grant = await ctx.storage.items.create(
    {
      type: "system.connection",
      state: "active",
      tier: "library",
      properties: {
        kind: "app",
        client_id: client.id,
        scopes: opts.scopes,
        status: "active",
        granted_at: new Date().toISOString(),
      },
      source: "test/oauth-scope",
    },
    opts.tenantId,
  );
  const rawToken = `myme_at_${Math.random().toString(36).slice(2)}_${Date.now().toString(36)}`;
  const tokenHash = hashApiKey(rawToken, TEST_API_KEY_SALT);
  await ctx.storage.oauth.createToken(
    grant.id,
    tokenHash,
    "access",
    new Date(Date.now() + 3600_000).toISOString(),
  );
  return { rawToken, grantId: grant.id };
}

describe("T-045 — OAuth scope grammar enforcement on the data plane", () => {
  // -----------------------------------------------------------------------
  // Type scopes — `core.note:read`, `core.note:write`, etc.
  // -----------------------------------------------------------------------

  describe("type scopes", () => {
    it("accepts a read of the granted type and rejects writes without :write", async () => {
      const { rawToken } = await mintOAuthToken({
        scopes: ["core.note:read"],
      });

      // First seed an item via the admin key so there's something to read.
      const admin = ctx.adminKey;
      const created = await request(ctx.app, "POST", "/items", {
        key: admin,
        body: {
          type: "core.note",
          properties: { body: "hello" },
        },
      });
      expect(created.status).toBe(201);

      // Read with the scoped token — accepted (covered by core.note:read).
      const list = await request(ctx.app, "GET", "/items?type=core.note", {
        key: rawToken,
      });
      expect(list.status).toBe(200);

      // Write with the same token — rejected (no :write).
      const write = await request(ctx.app, "POST", "/items", {
        key: rawToken,
        body: { type: "core.note", properties: { body: "denied" } },
      });
      expect(write.status).toBe(403);
      const body = (await write.json()) as { error?: { code?: string } };
      expect(body.error?.code).toBe("type_not_permitted");
    });

    it("excludes out-of-scope types from list reads (implicit denial via allowed_types)", async () => {
      // Seed items of two types as admin so both are present in the DB.
      const admin = ctx.adminKey;
      await request(ctx.app, "POST", "/items", {
        key: admin,
        body: { type: "core.note", properties: { body: "in-scope" } },
      });
      await request(ctx.app, "POST", "/items", {
        key: admin,
        body: {
          type: "core.task",
          properties: { title: "out-of-scope" },
        },
      });

      const { rawToken } = await mintOAuthToken({
        scopes: ["core.note:read"],
      });
      // List reads use `getTypeFilter` to project allowed_types into
      // the storage filter — out-of-scope types silently drop from the
      // result. This is implicit-denial enforcement (status 200, empty
      // data), not 403 — strict rejection on filter mismatch would
      // force callers to know exactly what's in scope. The single-item
      // GET path enforces explicitly via `requireTypeAccess` (next
      // test).
      const res = await request(ctx.app, "GET", "/items?type=core.task", {
        key: rawToken,
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: unknown[] };
      expect(body.data).toEqual([]);
    });

    it("rejects single-item GET on an out-of-scope type with 403", async () => {
      const admin = ctx.adminKey;
      const created = (await (
        await request(ctx.app, "POST", "/items", {
          key: admin,
          body: { type: "core.task", properties: { title: "task" } },
        })
      ).json()) as { item: { id: string } };

      const { rawToken } = await mintOAuthToken({
        scopes: ["core.note:read"],
      });
      const res = await request(ctx.app, "GET", `/items/${created.item.id}`, {
        key: rawToken,
      });
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error?: { code?: string } };
      expect(body.error?.code).toBe("type_not_permitted");
    });

    it("write scope covers read", async () => {
      const { rawToken } = await mintOAuthToken({
        scopes: ["core.note:write"],
      });
      // Create an item with the scoped token.
      const created = await request(ctx.app, "POST", "/items", {
        key: rawToken,
        body: { type: "core.note", properties: { body: "scoped write" } },
      });
      expect(created.status).toBe(201);
      const item = (await created.json()) as { item: { id: string } };
      // Read with the same token — accepted because write covers read.
      const got = await request(ctx.app, "GET", `/items/${item.item.id}`, {
        key: rawToken,
      });
      expect(got.status).toBe(200);
    });
  });

  // -----------------------------------------------------------------------
  // Edge scopes — `edge.parent-of:write`, etc.
  // -----------------------------------------------------------------------

  describe("edge scopes", () => {
    it("rejects edge mutations without the matching edge scope", async () => {
      // Token has the type permission but NOT the edge permission.
      const { rawToken } = await mintOAuthToken({
        scopes: ["core.note:write"],
      });
      // Seed two notes via admin so there are referencable items.
      const admin = ctx.adminKey;
      const a = (await (
        await request(ctx.app, "POST", "/items", {
          key: admin,
          body: { type: "core.note", properties: { body: "A" } },
        })
      ).json()) as { item: { id: string } };
      const b = (await (
        await request(ctx.app, "POST", "/items", {
          key: admin,
          body: { type: "core.note", properties: { body: "B" } },
        })
      ).json()) as { item: { id: string } };

      // Try to create a parent-of edge — denied (no edge.parent-of:write).
      const edgeRes = await request(ctx.app, "POST", "/edges", {
        key: rawToken,
        body: {
          source_id: a.item.id,
          target_id: b.item.id,
          edge_type: "parent-of",
        },
      });
      expect(edgeRes.status).toBe(403);
      const body = (await edgeRes.json()) as { error?: { code?: string } };
      expect(body.error?.code).toBe("edge_permission_denied");
    });

    it("accepts edge mutation when the edge scope is granted", async () => {
      const { rawToken } = await mintOAuthToken({
        scopes: ["core.note:write", "edge.parent-of:write"],
      });
      // Seed two notes via admin.
      const admin = ctx.adminKey;
      const a = (await (
        await request(ctx.app, "POST", "/items", {
          key: admin,
          body: { type: "core.note", properties: { body: "A" } },
        })
      ).json()) as { item: { id: string } };
      const b = (await (
        await request(ctx.app, "POST", "/items", {
          key: admin,
          body: { type: "core.note", properties: { body: "B" } },
        })
      ).json()) as { item: { id: string } };
      const edgeRes = await request(ctx.app, "POST", "/edges", {
        key: rawToken,
        body: {
          source_id: a.item.id,
          target_id: b.item.id,
          edge_type: "parent-of",
        },
      });
      expect(edgeRes.status).toBe(201);
    });

    it("wildcard edge scope covers any edge type", async () => {
      const { rawToken } = await mintOAuthToken({
        scopes: ["core.note:write", "edge.*:write"],
      });
      const admin = ctx.adminKey;
      const a = (await (
        await request(ctx.app, "POST", "/items", {
          key: admin,
          body: { type: "core.note", properties: { body: "A" } },
        })
      ).json()) as { item: { id: string } };
      const b = (await (
        await request(ctx.app, "POST", "/items", {
          key: admin,
          body: { type: "core.note", properties: { body: "B" } },
        })
      ).json()) as { item: { id: string } };
      // Use a different edge type from the previous test to exercise the
      // wildcard.
      const edgeRes = await request(ctx.app, "POST", "/edges", {
        key: rawToken,
        body: {
          source_id: a.item.id,
          target_id: b.item.id,
          edge_type: "annotates",
        },
      });
      expect(edgeRes.status).toBe(201);
    });
  });

  // -----------------------------------------------------------------------
  // Metadata scopes — `metadata.types:write` (the existing surface),
  // `metadata:read`, etc.
  // -----------------------------------------------------------------------

  describe("metadata scopes", () => {
    it("rejects type registration without metadata.types:write", async () => {
      const { rawToken } = await mintOAuthToken({
        scopes: ["core.note:read"],
      });
      const res = await request(ctx.app, "POST", "/types", {
        key: rawToken,
        body: {
          id: "demo.test_t045",
          version: 1,
          fields: [{ name: "name", type: "string" }],
        },
      });
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error?: { code?: string } };
      expect(body.error?.code).toBe("forbidden");
    });

    it("accepts type registration with metadata.types:write", async () => {
      const { rawToken } = await mintOAuthToken({
        scopes: ["metadata.types:write"],
      });
      const res = await request(ctx.app, "POST", "/types", {
        key: rawToken,
        body: {
          id: "demo.t045_accepted",
          version: 1,
          fields: [{ name: "name", type: "string" }],
        },
      });
      expect(res.status).toBe(201);
    });
  });

  // -----------------------------------------------------------------------
  // Out-of-grammar scopes — silently ignored at parse time, no effect.
  // -----------------------------------------------------------------------

  describe("malformed scope grants are inert", () => {
    it("a token with only nonsense scopes returns empty data on list and 403 on direct access", async () => {
      const admin = ctx.adminKey;
      const created = (await (
        await request(ctx.app, "POST", "/items", {
          key: admin,
          body: { type: "core.note", properties: { body: "secret" } },
        })
      ).json()) as { item: { id: string } };

      const { rawToken } = await mintOAuthToken({
        scopes: ["nonsense", "::write", "DELETE EVERYTHING"],
      });
      // List read — empty type_permissions → allowed_types is [],
      // storage returns no rows. 200 with empty data.
      const list = await request(ctx.app, "GET", "/items?type=core.note", {
        key: rawToken,
      });
      expect(list.status).toBe(200);
      const body = (await list.json()) as { data: unknown[] };
      expect(body.data).toEqual([]);
      // Direct read — requireTypeAccess fires and rejects.
      const direct = await request(
        ctx.app,
        "GET",
        `/items/${created.item.id}`,
        { key: rawToken },
      );
      expect(direct.status).toBe(403);
    });
  });
});
