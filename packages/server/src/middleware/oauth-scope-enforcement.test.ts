/**
 * OAuth scope grammar enforcement.
 *
 * The scope grammar in `@withmarfa/shared` parses `<type>:<verb>`,
 * `edge.<type>:<verb>`, `metadata:<verb>`, and `metadata.<sub>:<verb>`
 * shapes; the auth middleware projects them into `type_permissions`,
 * `edge_permissions`, and `metadata_permissions` on a synthetic
 * member-tier `ApiKey` at token-resolve time.
 *
 * These tests verify that the projection actually gates the data
 * plane — they exercise the four route families end-to-end with narrow
 * scopes and assert the correct accept/reject shape per scope kind.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { request, createTestContext, seedOauthBearer } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";

let ctx: TestContext;

beforeEach(async () => {
  ctx = await createTestContext();
});

afterEach(async () => {
  await ctx.cleanup();
});

interface MintedToken {
  rawToken: string;
  grantId: string;
}

/**
 * Setup uses `seedOauthBearer` which writes into the
 * @better-auth/oauth-provider plugin's `auth_oauth_*` tables. Bearer
 * middleware resolves the resulting tokens identically; the scope
 * projection under test is unchanged.
 */
async function mintOAuthToken(opts: {
  scopes: string[];
  tenantId?: string;
}): Promise<MintedToken> {
  const { token, grantId } = await seedOauthBearer(ctx.storage, opts.scopes, {
    clientName: "Scope Enforcement Test App",
    tenantId: opts.tenantId,
  });
  return { rawToken: token, grantId };
}

describe("OAuth scope grammar enforcement on the data plane", () => {
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

    it("treats underscores in subtree scopes as literal identifier bytes", async () => {
      const schemas = [
        "demo.web_gallery",
        "demo.web_gallery.card",
        "demo.webxgallery.card",
      ];
      for (const typeId of schemas) {
        const registered = await request(ctx.app, "POST", "/types", {
          key: ctx.adminKey,
          body: {
            id: typeId,
            version: 1,
            fields: { title: { type: "string" } },
          },
        });
        expect(registered.status).toBe(201);
        const created = await request(ctx.app, "POST", "/items", {
          key: ctx.adminKey,
          body: { type: typeId, properties: { title: typeId } },
        });
        expect(created.status).toBe(201);
      }

      const { rawToken } = await mintOAuthToken({
        scopes: ["demo.web_gallery.*:read"],
      });
      const response = await request(ctx.app, "GET", "/items", {
        key: rawToken,
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        data: { type: string }[];
      };
      expect(body.data.map((item) => item.type).sort()).toEqual([
        "demo.web_gallery",
        "demo.web_gallery.card",
      ]);
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
          edge_type: "references",
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
          fields: { name: { type: "string" } },
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
          fields: { name: { type: "string" } },
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

// ---------------------------------------------------------------------------
// The four-bundle keystone: an OAuth token reaches a tenant's RUNTIME `user.*`
// types — which never appear in the static scope allowlist — through the
// wildcard the generous default bundle grants. No role bypass involved (the
// token is a member-tier synthetic key).
// ---------------------------------------------------------------------------

describe("wildcard scope reaches runtime user.* types (keystone)", () => {
  // The in-memory custom-type registry is a module singleton, so each test
  // registers a distinct `user.*` id to avoid a cross-test 409.
  async function registerUserType(typeId: string): Promise<void> {
    const reg = await request(ctx.app, "POST", "/types", {
      key: ctx.adminKey,
      body: {
        id: typeId,
        version: 1,
        fields: { title: { type: "string" } },
      },
    });
    expect(reg.status).toBe(201);
  }

  it("global *:write lets an OAuth token write a runtime user.* item", async () => {
    await registerUserType("user.ks_write");
    const { rawToken } = await mintOAuthToken({ scopes: ["*:write"] });
    const created = await request(ctx.app, "POST", "/items", {
      key: rawToken,
      body: { type: "user.ks_write", properties: { title: "via wildcard" } },
    });
    expect(created.status).toBe(201);
  });

  it("namespace wildcard user.*:read reads user.* items; writing still needs :write", async () => {
    await registerUserType("user.ks_read");
    await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: { type: "user.ks_read", properties: { title: "seed" } },
    });

    const { rawToken } = await mintOAuthToken({ scopes: ["user.*:read"] });
    const list = await request(ctx.app, "GET", "/items?type=user.ks_read", {
      key: rawToken,
    });
    expect(list.status).toBe(200);
    expect(((await list.json()) as { data: unknown[] }).data.length).toBe(1);

    const write = await request(ctx.app, "POST", "/items", {
      key: rawToken,
      body: { type: "user.ks_read", properties: { title: "denied" } },
    });
    expect(write.status).toBe(403);
  });
});

describe("edge-type registration is scope-gated (metadata.edge_types:write)", () => {
  const edgeBody = { id: "user.blocks", cardinality: "many-to-many" as const };

  it("rejects POST /edge-types without metadata.edge_types:write", async () => {
    // A broad data grant is not enough — edge-type setup is its own scope.
    const { rawToken } = await mintOAuthToken({ scopes: ["*:write"] });
    const res = await request(ctx.app, "POST", "/edge-types", {
      key: rawToken,
      body: edgeBody,
    });
    expect(res.status).toBe(403);
  });

  it("accepts POST /edge-types with metadata.edge_types:write", async () => {
    const { rawToken } = await mintOAuthToken({
      scopes: ["metadata.edge_types:write"],
    });
    const res = await request(ctx.app, "POST", "/edge-types", {
      key: rawToken,
      body: edgeBody,
    });
    expect(res.status).toBe(201);
  });
});
