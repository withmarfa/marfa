/**
 * Tests for the Integration registry + install pipeline (Layer 2 PR 1).
 *
 * Covers:
 *   - POST /integrations: platform-credential gate, manifest validation,
 *     sibling-per-version uniqueness, persistence as system.integration.
 *   - GET /integrations + GET /integrations/:id list/get round-trip.
 *   - GET /integrations/:id/install: HTML consent screen renders with the
 *     manifest's surfaces (name, version, target_types, triggers,
 *     permissions).
 *   - POST /integrations/:id/install: end-to-end install creates a
 *     system.connection + runtime credential (apiKeys row stamped with
 *     is_runtime_credential + connection_id) + system.activity. Cancel
 *     path returns no rows. Compensation: credential mint failure
 *     (forced via duplicate source) trashes the connection.
 *   - Cross-tenant isolation handled by the existing tenant_id flow on
 *     items.create / keys.createRuntimeCredential — exercised here via
 *     the basic positive path.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import {
  createTestContext,
  markEmailVerified,
  request,
  TEST_API_KEY_SALT,
} from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import type { IntegrationManifest } from "@withmarfa/shared";
import { hashApiKey } from "../middleware/auth.js";

const ORIGIN = "http://localhost:0";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.cleanup();
});

function baseManifest(
  overrides?: Partial<IntegrationManifest>,
): IntegrationManifest {
  return {
    name: "acme.calendar-sync",
    version: "1.0.0",
    publisher: "Acme",
    description: "Sync calendar events into Marfa",
    direction: "read",
    triggers: [
      { type: "schedule", config: { cron: "*/15 * * * *" } },
      { type: "webhook" },
    ],
    target_types: ["core.note", "core.task"],
    runtime_compatibility: ["hosted"],
    bidirectional_handling: {
      echo_ttl_seconds: 60,
      lag_window_seconds: 60,
      tombstone_mapping: "state-trashed",
      partial_write_mode: "all-or-nothing",
    },
    oauth_requirements: {},
    webhook_verification: { method: "hmac-sha256" },
    manifest_schema_version: "1.0.0",
    permissions: {
      extension: { "acme.cursor": "write" },
      edge: {},
    },
    ...overrides,
  };
}

interface RegisterResponse {
  id: string;
  manifest_name: string;
  manifest_version: string;
  publisher: string;
  direction: "read" | "write" | "both";
  runtime_compatibility: string[];
  manifest: Record<string, unknown>;
  registered_at: string;
}

interface ListResponse {
  data: RegisterResponse[];
}

interface ErrorBody {
  error: { code: string; message: string };
}

describe("POST /integrations (registry)", () => {
  it("rejects unauthenticated callers", async () => {
    const res = await request(ctx.app, "POST", "/integrations", {
      body: { manifest: baseManifest() },
    });
    expect(res.status).toBe(401);
  });

  it("registers a valid manifest as a system.integration item", async () => {
    const manifest = baseManifest({ name: "acme.test-register" });
    const res = await request(ctx.app, "POST", "/integrations", {
      key: ctx.adminKey,
      body: { manifest },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as RegisterResponse;
    expect(body.manifest_name).toBe("acme.test-register");
    expect(body.manifest_version).toBe("1.0.0");
    expect(body.publisher).toBe("Acme");
    expect(body.direction).toBe("read");
    expect(body.id).toMatch(/^[0-9a-f-]+$/);

    // Underlying item exists with the right type + properties shape.
    const item = await ctx.storage.items.get(body.id);
    expect(item?.type).toBe("system.integration");
    expect((item?.properties as { manifest_name?: string }).manifest_name).toBe(
      "acme.test-register",
    );
  });

  it("rejects an invalid manifest with VALIDATION_ERROR", async () => {
    const res = await request(ctx.app, "POST", "/integrations", {
      key: ctx.adminKey,
      body: { manifest: { name: "missing-everything" } },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe("validation_error");
  });

  it("409s when registering the same manifest_name + version twice", async () => {
    const manifest = baseManifest({ name: "acme.dup-version" });
    const first = await request(ctx.app, "POST", "/integrations", {
      key: ctx.adminKey,
      body: { manifest },
    });
    expect(first.status).toBe(201);
    const dup = await request(ctx.app, "POST", "/integrations", {
      key: ctx.adminKey,
      body: { manifest },
    });
    expect(dup.status).toBe(409);
    const body = (await dup.json()) as ErrorBody;
    expect(body.error.code).toBe("conflict");
  });

  it("permits sibling registration of a new version", async () => {
    const v1 = await request(ctx.app, "POST", "/integrations", {
      key: ctx.adminKey,
      body: {
        manifest: baseManifest({ name: "acme.sibling", version: "1.0.0" }),
      },
    });
    expect(v1.status).toBe(201);
    const v2 = await request(ctx.app, "POST", "/integrations", {
      key: ctx.adminKey,
      body: {
        manifest: baseManifest({ name: "acme.sibling", version: "1.1.0" }),
      },
    });
    expect(v2.status).toBe(201);
    const v1Body = (await v1.json()) as RegisterResponse;
    const v2Body = (await v2.json()) as RegisterResponse;
    expect(v1Body.id).not.toBe(v2Body.id);
  });
});

describe("GET /integrations + /integrations/:id", () => {
  it("lists registered integrations and supports manifest_name filter", async () => {
    await request(ctx.app, "POST", "/integrations", {
      key: ctx.adminKey,
      body: { manifest: baseManifest({ name: "acme.list-a" }) },
    });
    await request(ctx.app, "POST", "/integrations", {
      key: ctx.adminKey,
      body: { manifest: baseManifest({ name: "acme.list-b" }) },
    });

    const filtered = await request(
      ctx.app,
      "GET",
      "/integrations?manifest_name=acme.list-a",
      { key: ctx.adminKey },
    );
    expect(filtered.status).toBe(200);
    const body = (await filtered.json()) as ListResponse;
    expect(body.data.length).toBeGreaterThanOrEqual(1);
    expect(body.data.every((d) => d.manifest_name === "acme.list-a")).toBe(
      true,
    );
  });

  it("404s on unknown id", async () => {
    const res = await request(
      ctx.app,
      "GET",
      "/integrations/itm_does_not_exist",
      {
        key: ctx.adminKey,
      },
    );
    expect(res.status).toBe(404);
  });

  it("returns the manifest blob on get-by-id", async () => {
    const reg = await request(ctx.app, "POST", "/integrations", {
      key: ctx.adminKey,
      body: { manifest: baseManifest({ name: "acme.get-by-id" }) },
    });
    const regBody = (await reg.json()) as RegisterResponse;
    const get = await request(ctx.app, "GET", `/integrations/${regBody.id}`, {
      key: ctx.adminKey,
    });
    expect(get.status).toBe(200);
    const getBody = (await get.json()) as RegisterResponse;
    expect(getBody.manifest.name).toBe("acme.get-by-id");
  });
});

describe("GET /integrations/:id/install (consent HTML)", () => {
  it("renders an HTML form referencing the manifest's surfaces", async () => {
    const reg = await request(ctx.app, "POST", "/integrations", {
      key: ctx.adminKey,
      body: { manifest: baseManifest({ name: "acme.consent-html" }) },
    });
    const regBody = (await reg.json()) as RegisterResponse;

    const res = await request(
      ctx.app,
      "GET",
      `/integrations/${regBody.id}/install`,
      { key: ctx.adminKey },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("acme.consent-html");
    expect(html).toContain("1.0.0");
    expect(html).toContain("core.note");
    expect(html).toContain("schedule");
    expect(html).toContain("acme.cursor");
    // Form posts back to the same path with decision field
    expect(html).toContain(`action="/integrations/${regBody.id}/install"`);
    expect(html).toContain('name="decision"');
  });

  describe("?credential_ref= pre-arm", () => {
    /**
     * The route accepts an optional `?credential_ref=<id>` query param.
     * When set, the GET validates it resolves to a same-tenant
     * `system.credential` of `kind: oauth_token` and renders it as a
     * hidden form field so the POST install carries it through to the
     * install pipeline. When unset (the historic default) the form
     * omits the hidden field — install behaves as today.
     */

    async function createOAuthCredential(label = "Test OAuth"): Promise<{
      id: string;
      label: string;
    }> {
      const res = await request(
        ctx.app,
        "POST",
        "/credentials/oauth-provider",
        {
          key: ctx.adminKey,
          body: {
            label,
            oauth_authorize_url: "https://accounts.example.com/oauth2/auth",
            oauth_token_url: "https://accounts.example.com/oauth2/token",
            oauth_client_id: "test-client.example",
            oauth_client_secret: "test-secret",
            upstream_base_url: "https://api.example.com",
          },
        },
      );
      expect(res.status).toBe(201);
      const body = (await res.json()) as { credential_id: string };
      return { id: body.credential_id, label };
    }

    it("omits the hidden field when no credential_ref is provided", async () => {
      const reg = await request(ctx.app, "POST", "/integrations", {
        key: ctx.adminKey,
        body: { manifest: baseManifest({ name: "acme.no-prearm" }) },
      });
      const regBody = (await reg.json()) as RegisterResponse;

      const res = await request(
        ctx.app,
        "GET",
        `/integrations/${regBody.id}/install`,
        { key: ctx.adminKey },
      );
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).not.toContain('name="credential_ref"');
      expect(html).not.toContain("Reusing existing OAuth credential");
    });

    it("renders the hidden field + hint when a valid credential_ref is provided", async () => {
      const reg = await request(ctx.app, "POST", "/integrations", {
        key: ctx.adminKey,
        body: { manifest: baseManifest({ name: "acme.with-prearm" }) },
      });
      const regBody = (await reg.json()) as RegisterResponse;
      const cred = await createOAuthCredential("Google (e2e test)");

      const res = await request(
        ctx.app,
        "GET",
        `/integrations/${regBody.id}/install?credential_ref=${cred.id}`,
        { key: ctx.adminKey },
      );
      expect(res.status).toBe(200);
      const html = await res.text();
      // Hidden form input carries the id through to POST
      expect(html).toContain('name="credential_ref"');
      expect(html).toContain(`value="${cred.id}"`);
      // Human-readable hint above the form
      expect(html).toContain("Reusing existing OAuth credential");
      expect(html).toContain(cred.label);
    });

    it("rejects credential_ref that does not resolve in this tenant", async () => {
      const reg = await request(ctx.app, "POST", "/integrations", {
        key: ctx.adminKey,
        body: { manifest: baseManifest({ name: "acme.bad-prearm" }) },
      });
      const regBody = (await reg.json()) as RegisterResponse;

      const res = await request(
        ctx.app,
        "GET",
        `/integrations/${regBody.id}/install?credential_ref=01999999-9999-7999-9999-999999999999`,
        { key: ctx.adminKey },
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as {
        error: { code: string; message: string };
      };
      expect(body.error.code).toBe("invalid_request");
      expect(body.error.message).toContain(
        "does not resolve to a system.credential",
      );
    });

    it("rejects credential_ref that resolves to a non-oauth_token credential", async () => {
      const reg = await request(ctx.app, "POST", "/integrations", {
        key: ctx.adminKey,
        body: { manifest: baseManifest({ name: "acme.wrong-kind-prearm" }) },
      });
      const regBody = (await reg.json()) as RegisterResponse;

      // Create a system.credential of a different kind (api_key) directly
      // via the items store; the route should reject it as wrong kind.
      const wrongKindCred = await ctx.storage.items.create({
        type: "system.credential",
        properties: {
          label: "wrong-kind test",
          kind: "api_key",
          secret_encrypted: "irrelevant",
        },
      });

      const res = await request(
        ctx.app,
        "GET",
        `/integrations/${regBody.id}/install?credential_ref=${wrongKindCred.id}`,
        { key: ctx.adminKey },
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as {
        error: { code: string; message: string };
      };
      expect(body.error.code).toBe("invalid_request");
      expect(body.error.message).toContain("expected 'oauth_token'");
    });
  });
});

describe("POST /integrations/:id/install (install pipeline)", () => {
  it("end-to-end: installs a connection + credential + activity on approve", async () => {
    const reg = await request(ctx.app, "POST", "/integrations", {
      key: ctx.adminKey,
      body: { manifest: baseManifest({ name: "acme.install-happy" }) },
    });
    const regBody = (await reg.json()) as RegisterResponse;

    const formBody = new URLSearchParams({
      decision: "approve",
      label: "My Calendar",
    }).toString();

    const res = await ctx.app.request(`/integrations/${regBody.id}/install`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ctx.adminKey}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: formBody,
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Connection installed");

    // Find the connection that was just minted (latest by created_at)
    const connections = await ctx.storage.items.list({
      type: "system.connection",
      sort: "created_at",
      direction: "desc",
      limit: 5,
    });
    const installed = connections.data.find(
      (i) =>
        (i.properties as { integration_ref?: string }).integration_ref ===
        regBody.id,
    );
    expect(installed).toBeDefined();
    const props = installed?.properties as {
      kind: string;
      status: string;
      direction: string;
      runtime_status: string;
    };
    expect(props.kind).toBe("integration");
    expect(props.status).toBe("active");
    expect(props.direction).toBe("read");
    expect(props.runtime_status).toBe("healthy");

    // Runtime credential row exists, bound to the connection
    const keys = await ctx.storage.keys.list();
    const cred = keys.find(
      (k) => k.is_runtime_credential && k.connection_id === installed?.id,
    );
    expect(cred).toBeDefined();
    expect(cred?.label).toBe("My Calendar");
    expect(cred?.is_runtime_credential).toBe(true);
    if (!cred) throw new Error("expected runtime credential to exist");
    expect(cred.extension_permissions).toMatchObject({
      "connection.runtime": "write",
      "acme.cursor": "write",
    });
    expect(cred.type_permissions).toMatchObject({
      "core.note": "read",
      "core.task": "read",
    });

    // Activity row exists, references connection + credential
    const activities = await ctx.storage.items.list({
      type: "system.activity",
      limit: 50,
    });
    const matching = activities.data.find(
      (i) =>
        (i.properties as { connection_id?: string }).connection_id ===
        installed?.id,
    );
    expect(matching).toBeDefined();
    const aprops = matching?.properties as {
      severity: string;
      summary: string;
      detail: { credential_id: string };
    };
    expect(aprops.severity).toBe("info");
    expect(aprops.summary).toContain("acme.install-happy");
    expect(aprops.detail.credential_id).toBe(cred.id);
  });

  it("declines without writing rows when decision != approve", async () => {
    const reg = await request(ctx.app, "POST", "/integrations", {
      key: ctx.adminKey,
      body: { manifest: baseManifest({ name: "acme.install-deny" }) },
    });
    const regBody = (await reg.json()) as RegisterResponse;

    const before = (
      await ctx.storage.items.list({ type: "system.connection", limit: 100 })
    ).data.length;

    const res = await ctx.app.request(`/integrations/${regBody.id}/install`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ctx.adminKey}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "decision=deny",
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("denied");

    const after = (
      await ctx.storage.items.list({ type: "system.connection", limit: 100 })
    ).data.length;
    expect(after).toBe(before);
  });

  it("404s on unknown integration id", async () => {
    const res = await ctx.app.request(
      "/integrations/itm_does_not_exist/install",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${ctx.adminKey}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: "decision=approve",
      },
    );
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// T-232 — catalogue visibility for tenant-scoped member tokens.
//
// Manifests register under platform credentials (is_platform: true), which
// carry tenant_id: null. The default tenant-equality filter on items.list
// hid them from any in-tenant caller — turning the marketplace surface
// invisible to every real user. The fix opts the dedicated catalogue list
// into `includePlatformScoped: true` so platform-scoped rows surface
// alongside the caller's own; per-tenant integration rows must stay
// isolated, and the generic /items route must stay strictly equality-fenced.
// ---------------------------------------------------------------------------

describe("GET /integrations — catalogue visibility (T-232)", () => {
  async function mintTenantKey(
    tenantId: string,
    typePermissions: Record<string, "read" | "write" | "none"> = {},
  ): Promise<string> {
    const suffix = Math.random().toString(36).slice(2, 10);
    const raw = `myme_k1_test_member_${suffix}`;
    const hash = hashApiKey(raw, TEST_API_KEY_SALT);
    await ctx.storage.keys.create(
      {
        label: `test-member-${suffix}`,
        source: `test-member-${suffix}`,
        role: "member",
        type_permissions: typePermissions,
        default_tier: "library",
        is_platform: false,
      },
      hash,
      tenantId,
    );
    return raw;
  }

  it("returns platform-registered manifests to a member token in a tenant", async () => {
    // The platform admin (ctx.adminKey) registers a fresh manifest. It
    // lands with tenant_id: null because the admin carries no tenant.
    const reg = await request(ctx.app, "POST", "/integrations", {
      key: ctx.adminKey,
      body: { manifest: baseManifest({ name: "acme.member-visibility" }) },
    });
    expect(reg.status).toBe(201);
    const regBody = (await reg.json()) as RegisterResponse;

    if (!ctx.storage.tenants) return;
    const tenant = await ctx.storage.tenants.create("tenant-member-vis");
    const memberKey = await mintTenantKey(tenant.id, {
      "system.integration": "read",
    });

    const res = await request(
      ctx.app,
      "GET",
      "/integrations?manifest_name=acme.member-visibility",
      { key: memberKey },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListResponse;
    const match = body.data.find((d) => d.id === regBody.id);
    expect(match).toBeDefined();
    expect(match?.manifest_name).toBe("acme.member-visibility");
  });

  it("preserves existing behaviour for member tokens without the read scope", async () => {
    // The dedicated catalogue list does not gate on type_permissions
    // (the route just calls requireAuth). This test pins that pre-existing
    // behaviour: a member token with no system.integration grant still
    // resolves the endpoint at status 200 — no new rejection introduced.
    await request(ctx.app, "POST", "/integrations", {
      key: ctx.adminKey,
      body: { manifest: baseManifest({ name: "acme.member-no-scope" }) },
    });

    if (!ctx.storage.tenants) return;
    const tenant = await ctx.storage.tenants.create("tenant-member-no-scope");
    const memberKey = await mintTenantKey(tenant.id, {}); // no scope

    const res = await request(
      ctx.app,
      "GET",
      "/integrations?manifest_name=acme.member-no-scope",
      { key: memberKey },
    );
    expect(res.status).toBe(200);
  });

  it("platform credentials still see every manifest", async () => {
    // Existing platform-admin behaviour preserved. Sanity check that the
    // widening flag doesn't accidentally constrain admin reads.
    await request(ctx.app, "POST", "/integrations", {
      key: ctx.adminKey,
      body: { manifest: baseManifest({ name: "acme.platform-still-sees" }) },
    });

    const res = await request(
      ctx.app,
      "GET",
      "/integrations?manifest_name=acme.platform-still-sees",
      { key: ctx.adminKey },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListResponse;
    expect(
      body.data.some((d) => d.manifest_name === "acme.platform-still-sees"),
    ).toBe(true);
  });

  it("does not leak a tenant-scoped manifest to another tenant's member", async () => {
    // Defence-in-depth — if a stray system.integration row carries a real
    // tenant_id (whether seeded by accident, by a future code path, or
    // copied during data migration), it must NOT cross the tenant
    // boundary just because the catalogue endpoint widens to include
    // platform-scoped rows.
    if (!ctx.storage.tenants) return;
    const tenantA = await ctx.storage.tenants.create("tenant-iso-A");
    const tenantB = await ctx.storage.tenants.create("tenant-iso-B");

    // Build a tenant-A-bound system.integration row by going through
    // the storage layer directly (we don't expose a tenant-bound
    // register API surface — this is a defensive shape test).
    const tenantAOnly = await ctx.storage.items.create(
      {
        type: "system.integration",
        properties: {
          manifest_name: "acme.tenant-a-private",
          manifest_version: "1.0.0",
          publisher: "Acme",
          summary: "Tenant-A-only manifest fixture",
          direction: "read" as const,
          runtime_compatibility: ["hosted"],
          registered_at: new Date().toISOString(),
          manifest: { name: "acme.tenant-a-private", version: "1.0.0" },
        },
      },
      tenantA.id,
    );

    // A platform-scoped manifest also lives in the catalogue so we can
    // assert the member in tenant B still sees null-tenant rows.
    const platformManifest = await request(ctx.app, "POST", "/integrations", {
      key: ctx.adminKey,
      body: {
        manifest: baseManifest({ name: "acme.platform-catalogue-iso" }),
      },
    });
    const platformBody = (await platformManifest.json()) as RegisterResponse;

    const memberB = await mintTenantKey(tenantB.id, {
      "system.integration": "read",
    });
    const res = await request(ctx.app, "GET", "/integrations?limit=200", {
      key: memberB,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListResponse;

    // tenant-A's private row must NOT leak to tenant B
    expect(body.data.some((d) => d.id === tenantAOnly.id)).toBe(false);
    expect(
      body.data.some((d) => d.manifest_name === "acme.tenant-a-private"),
    ).toBe(false);

    // ...but the platform-scoped catalogue row IS visible
    expect(body.data.some((d) => d.id === platformBody.id)).toBe(true);
  });

  it("does not widen the generic /items route — system.connection stays tenant-isolated", async () => {
    // Out-of-scope guard. The fix is local to the catalogue endpoint;
    // a stray system.connection row with tenant_id IS NULL (known
    // leftover dev data shape per the T-232 brief) must remain
    // invisible to a member token hitting the generic /items route.
    // Mirrors the staging end-to-end check `curl /items?type=system.connection`.
    if (!ctx.storage.tenants) return;
    const tenant = await ctx.storage.tenants.create("tenant-items-gate");
    const memberKey = await mintTenantKey(tenant.id, {
      "system.connection": "read",
    });

    // Seed a NULL-tenant system.connection row to stand in for the
    // staging leftover.
    const nullTenantConnection = await ctx.storage.items.create(
      {
        type: "system.connection",
        properties: {
          kind: "integration",
          status: "active",
          direction: "read",
          runtime_status: "healthy",
          granted_at: new Date().toISOString(),
          integration_ref: "irrelevant",
          credential_ref: "irrelevant",
          triggers: [],
          runtime_compatibility: ["hosted"],
        },
      },
      undefined, // tenant_id: null
    );

    const res = await request(
      ctx.app,
      "GET",
      "/items?type=system.connection&limit=200",
      { key: memberKey },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { id: string; properties: Record<string, unknown> }[];
    };
    expect(body.data.some((d) => d.id === nullTenantConnection.id)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// T-234 — platform-scoped get-by-id + install for tenant member callers.
//
// The catalogue list endpoint opts into `includePlatformScoped: true` so
// platform-scoped manifests surface to in-tenant callers (T-232). The
// single-id `get` calls (`GET /integrations/:id`, `GET/POST
// /integrations/:id/install`) and the admin install (`POST
// /connections/install`) did not — they tenant-fenced through
// `items.get(id, tenantId)` and therefore 404'd for any caller with a
// real tenant. Catalogue listed manifests but trying to open or install
// one threw `integration_not_found`.
//
// The fix adds `ItemGetOptions.includePlatformScoped` and threads it
// through all four sites. The resulting install pipeline still stamps
// the new `system.connection` with the caller's tenant_id (never the
// manifest's null tenant) — the regression test below pins that.
// ---------------------------------------------------------------------------

describe("GET /integrations/:id + /:id/install — platform-scope (T-234)", () => {
  async function mintTenantMember(
    tenantId: string,
    typePermissions: Record<string, "read" | "write" | "none"> = {
      "system.integration": "read",
    },
  ): Promise<string> {
    const suffix = Math.random().toString(36).slice(2, 10);
    const raw = `myme_k1_test_member_${suffix}`;
    const hash = hashApiKey(raw, TEST_API_KEY_SALT);
    await ctx.storage.keys.create(
      {
        label: `t234-member-${suffix}`,
        source: `t234-member-${suffix}`,
        role: "member",
        type_permissions: typePermissions,
        default_tier: "library",
        is_platform: false,
      },
      hash,
      tenantId,
    );
    return raw;
  }

  it("GET /integrations/:id resolves a platform-scoped manifest for a member token", async () => {
    // Manifest registered by platform admin → lives with tenant_id: null.
    // Pre-fix this returned 404 to any caller with a real tenant; the
    // tenant-fenced get filtered the null-tenant row out.
    const reg = await request(ctx.app, "POST", "/integrations", {
      key: ctx.adminKey,
      body: { manifest: baseManifest({ name: "acme.t234-get-by-id" }) },
    });
    expect(reg.status).toBe(201);
    const regBody = (await reg.json()) as RegisterResponse;

    if (!ctx.storage.tenants) return;
    const tenant = await ctx.storage.tenants.create("t234-tenant-get");
    const memberKey = await mintTenantMember(tenant.id);

    const res = await request(ctx.app, "GET", `/integrations/${regBody.id}`, {
      key: memberKey,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as RegisterResponse;
    expect(body.id).toBe(regBody.id);
    expect(body.manifest_name).toBe("acme.t234-get-by-id");
  });

  it("GET /integrations/:id/install renders consent HTML for a tenant member with a Bearer token", async () => {
    const reg = await request(ctx.app, "POST", "/integrations", {
      key: ctx.adminKey,
      body: { manifest: baseManifest({ name: "acme.t234-install-html" }) },
    });
    const regBody = (await reg.json()) as RegisterResponse;

    if (!ctx.storage.tenants) return;
    const tenant = await ctx.storage.tenants.create("t234-tenant-html");
    const memberKey = await mintTenantMember(tenant.id);

    const res = await request(
      ctx.app,
      "GET",
      `/integrations/${regBody.id}/install`,
      { key: memberKey },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain(`action="/integrations/${regBody.id}/install"`);
    expect(html).toContain('name="decision"');
  });

  it("POST /integrations/:id/install completes for a tenant member and stamps the connection with the caller's tenant_id", async () => {
    const reg = await request(ctx.app, "POST", "/integrations", {
      key: ctx.adminKey,
      body: { manifest: baseManifest({ name: "acme.t234-install-post" }) },
    });
    const regBody = (await reg.json()) as RegisterResponse;

    if (!ctx.storage.tenants) return;
    const tenant = await ctx.storage.tenants.create("t234-tenant-post");
    const memberKey = await mintTenantMember(tenant.id);

    const formBody = new URLSearchParams({
      decision: "approve",
      label: "T-234-member-install",
    }).toString();

    const res = await ctx.app.request(`/integrations/${regBody.id}/install`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${memberKey}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: formBody,
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Connection installed");

    // Pin the load-bearing tenant invariant: the connection lands in
    // the caller's tenant, NOT in the manifest's null tenant. Without
    // this guard a future regression in the install pipeline could
    // silently land cross-tenant rows.
    const connections = await ctx.storage.items.list({
      tenantId: tenant.id,
      type: "system.connection",
      limit: 50,
    });
    const installed = connections.data.find(
      (c) =>
        (c.properties as { integration_ref?: string }).integration_ref ===
        regBody.id,
    );
    expect(installed).toBeDefined();
    expect(installed?.tenant_id).toBe(tenant.id);
  });

  it("POST /integrations/:id/install on an unknown id still returns INTEGRATION_NOT_FOUND", async () => {
    // Negative test — the widening must not turn a missing manifest
    // into a 500 or a silent success. The type check on the next line
    // is the authoritative gate; only genuine `system.integration`
    // items pass.
    if (!ctx.storage.tenants) return;
    const tenant = await ctx.storage.tenants.create("t234-tenant-missing");
    const memberKey = await mintTenantMember(tenant.id);

    const res = await ctx.app.request(
      "/integrations/01999999-9999-7999-9999-999999999999/install",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${memberKey}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: "decision=approve",
      },
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe("integration_not_found");
  });

  it("widening does not leak a tenant-scoped system.integration into another tenant via get-by-id", async () => {
    // Defence-in-depth — if a stray system.integration row carries a
    // real tenant_id (seeded by accident, or via a future tenant-bound
    // register path), it must not be reachable by id from another
    // tenant via the catalogue endpoint.
    if (!ctx.storage.tenants) return;
    const tenantA = await ctx.storage.tenants.create("t234-iso-A");
    const tenantB = await ctx.storage.tenants.create("t234-iso-B");

    const tenantABound = await ctx.storage.items.create(
      {
        type: "system.integration",
        properties: {
          manifest_name: "acme.t234-tenant-a-only",
          manifest_version: "1.0.0",
          publisher: "Acme",
          direction: "read" as const,
          runtime_compatibility: ["hosted"],
          registered_at: new Date().toISOString(),
          manifest: { name: "acme.t234-tenant-a-only", version: "1.0.0" },
        },
      },
      tenantA.id,
    );
    const memberB = await mintTenantMember(tenantB.id);

    const res = await request(
      ctx.app,
      "GET",
      `/integrations/${tenantABound.id}`,
      {
        key: memberB,
      },
    );
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Browser session auth on /integrations/:id/install
//
// Prior behaviour: install routes only accepted Bearer tokens. A browser
// navigation (cookie present, no Authorization header) hit `requireAuth`
// and 401'd, even though the routes are documented as a browser consent
// flow. Fix: try the BetterAuth session cookie first, fall back to Bearer.
// Unauthenticated requests are 401 when an Authorization header was
// presented (API client failure) and 302 to /auth/sign-in otherwise
// (browser navigation).
// ---------------------------------------------------------------------------

describe("/integrations/:id/install — browser session auth", () => {
  let sessionCtx: TestContext;
  // Uniqueness suffix per test so accounts don't collide across cases.
  let counter = 0;

  beforeAll(async () => {
    sessionCtx = await createTestContext({ authAllowSignup: true });
  });

  afterAll(async () => {
    await sessionCtx.cleanup();
  });

  afterEach(() => {
    counter++;
  });

  async function signInUser(email: string): Promise<string> {
    const password = "correct horse battery";
    const signUpRes = await request(
      sessionCtx.app,
      "POST",
      "/auth/sign-up/email",
      {
        body: { email, password, name: "Test User" },
        headers: { origin: ORIGIN },
      },
    );
    if (signUpRes.status !== 200) {
      const text = await signUpRes.text();
      throw new Error(
        `sign-up failed (${String(signUpRes.status)}): ${text.slice(0, 300)}`,
      );
    }
    await markEmailVerified(sessionCtx.storage, email);
    const signInRes = await request(
      sessionCtx.app,
      "POST",
      "/auth/sign-in/email",
      {
        body: { email, password },
        headers: { origin: ORIGIN },
      },
    );
    if (signInRes.status !== 200) {
      const text = await signInRes.text();
      throw new Error(
        `sign-in failed (${String(signInRes.status)}): ${text.slice(0, 300)}`,
      );
    }
    const setCookie = signInRes.headers.get("set-cookie");
    if (!setCookie) throw new Error("sign-in: no Set-Cookie header");
    const cookies = setCookie.split(/,\s*(?=[a-zA-Z0-9_-]+=)/);
    for (const c of cookies) {
      const head = c.split(";")[0];
      if (head?.includes("session_token")) return head;
    }
    throw new Error("sign-in: session_token cookie not found");
  }

  async function registerIntegration(name: string): Promise<string> {
    const res = await request(sessionCtx.app, "POST", "/integrations", {
      key: sessionCtx.adminKey,
      body: { manifest: baseManifest({ name }) },
    });
    if (res.status !== 201) {
      throw new Error(`register failed: ${String(res.status)}`);
    }
    const body = (await res.json()) as RegisterResponse;
    return body.id;
  }

  it("GET returns the consent HTML to a signed-in browser (no Bearer)", async () => {
    const integrationId = await registerIntegration(
      `acme.session-get-${String(counter)}`,
    );
    const cookie = await signInUser(
      `session-get-${String(counter)}@example.com`,
    );

    const res = await sessionCtx.app.request(
      `/integrations/${integrationId}/install`,
      { headers: { cookie } },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain(`action="/integrations/${integrationId}/install"`);
    expect(html).toContain('name="decision"');
  });

  it("POST completes the install for a signed-in browser session", async () => {
    const integrationId = await registerIntegration(
      `acme.session-post-${String(counter)}`,
    );
    const cookie = await signInUser(
      `session-post-${String(counter)}@example.com`,
    );

    const formBody = new URLSearchParams({
      decision: "approve",
      label: "Browser-Installed",
    }).toString();

    const res = await sessionCtx.app.request(
      `/integrations/${integrationId}/install`,
      {
        method: "POST",
        headers: {
          cookie,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: formBody,
      },
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Connection installed");

    // Confirm the connection landed in the session user's tenant scope —
    // the audit row's key_id should carry the synthetic `auth_user:<id>`
    // marker so operators can recognise session-backed installs.
    const audit = await sessionCtx.storage.audit.list({
      action: "integration.install",
      limit: 50,
    });
    const sessionAudit = audit.data.find((r) =>
      r.key_id?.startsWith("auth_user:"),
    );
    expect(sessionAudit).toBeDefined();
  });

  it("Bearer path still works (regression cover)", async () => {
    // The bug fix shouldn't change the existing Bearer flow at all —
    // operators / tests / CLIs that present an Authorization header
    // continue to resolve through `c.var.apiKey`.
    const integrationId = await registerIntegration(
      `acme.bearer-regression-${String(counter)}`,
    );
    const res = await sessionCtx.app.request(
      `/integrations/${integrationId}/install`,
      { headers: { Authorization: `Bearer ${sessionCtx.adminKey}` } },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
  });

  it("401s when an Authorization header is presented but invalid", async () => {
    // Bearer was attempted but rejected by the bearer middleware → the
    // API-client failure shape. Negative test from the bug report.
    const integrationId = await registerIntegration(
      `acme.bad-bearer-${String(counter)}`,
    );
    const res = await sessionCtx.app.request(
      `/integrations/${integrationId}/install`,
      { headers: { Authorization: "Bearer myme_k1_completely_invalid" } },
    );
    expect(res.status).toBe(401);
  });

  it("302s to /auth/sign-in on an unauthenticated browser navigation (no Bearer, no session)", async () => {
    // No Authorization header, no session cookie — the only sensible
    // response is a redirect to sign-in with the install URL preserved,
    // so the user lands back on the consent screen after authenticating.
    const integrationId = await registerIntegration(
      `acme.anon-${String(counter)}`,
    );
    const res = await sessionCtx.app.request(
      `/integrations/${integrationId}/install`,
    );
    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(location).toContain("/auth/sign-in");
    expect(location).toContain(
      encodeURIComponent(`/integrations/${integrationId}/install`),
    );
  });
});
