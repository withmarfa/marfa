/**
 * Tests for the Integration registry + install pipeline.
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
 *   - Cross-space isolation handled by the existing space_id flow on
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
    name: "acme/calendar-sync",
    version: "1.0.0",
    publisher: "Acme",
    description: "Sync calendar events into Marfa",
    direction: "read",
    triggers: [
      { type: "schedule", config: { cron: "*/15 * * * *" } },
      { type: "webhook" },
    ],
    target_types: ["core.note", "core.task"],
    bidirectional_handling: {
      echo_ttl_seconds: 60,
      lag_window_seconds: 60,
      tombstone_mapping: "state-trashed",
      partial_write_mode: "all-or-nothing",
    },
    oauth_requirements: {},
    webhook_verification: { method: "hmac-sha256" },
    manifest_schema_version: "2.0.0",
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
  display_name?: string;
  publisher: string;
  direction: "read" | "write" | "both";
  installed_count: number;
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
    const manifest = baseManifest({ name: "acme/test-register" });
    const res = await request(ctx.app, "POST", "/integrations", {
      key: ctx.adminKey,
      body: { manifest },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as RegisterResponse;
    expect(body.manifest_name).toBe("acme/test-register");
    expect(body.manifest_version).toBe("1.0.0");
    expect(body.publisher).toBe("Acme");
    expect(body.direction).toBe("read");
    expect(body.id).toMatch(/^[0-9a-f-]+$/);

    // Underlying item exists with the right type + properties shape.
    const item = await ctx.storage.items.get(body.id);
    expect(item?.type).toBe("system.integration");
    expect((item?.properties as { manifest_name?: string }).manifest_name).toBe(
      "acme/test-register",
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
    const manifest = baseManifest({ name: "acme/dup-version" });
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
        manifest: baseManifest({ name: "acme/sibling", version: "1.0.0" }),
      },
    });
    expect(v1.status).toBe(201);
    const v2 = await request(ctx.app, "POST", "/integrations", {
      key: ctx.adminKey,
      body: {
        manifest: baseManifest({ name: "acme/sibling", version: "1.1.0" }),
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
      body: { manifest: baseManifest({ name: "acme/list-a" }) },
    });
    await request(ctx.app, "POST", "/integrations", {
      key: ctx.adminKey,
      body: { manifest: baseManifest({ name: "acme/list-b" }) },
    });

    const filtered = await request(
      ctx.app,
      "GET",
      "/integrations?manifest_name=acme/list-a",
      { key: ctx.adminKey },
    );
    expect(filtered.status).toBe(200);
    const body = (await filtered.json()) as ListResponse;
    expect(body.data.length).toBeGreaterThanOrEqual(1);
    expect(body.data.every((d) => d.manifest_name === "acme/list-a")).toBe(
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
      body: { manifest: baseManifest({ name: "acme/get-by-id" }) },
    });
    const regBody = (await reg.json()) as RegisterResponse;
    const get = await request(ctx.app, "GET", `/integrations/${regBody.id}`, {
      key: ctx.adminKey,
    });
    expect(get.status).toBe(200);
    const getBody = (await get.json()) as RegisterResponse;
    expect(getBody.manifest.name).toBe("acme/get-by-id");
  });
});

describe("GET /integrations?latest=true (the catalog view)", () => {
  /** Registers one manifest and hands back the row the registry stored. */
  async function register(
    overrides: Partial<IntegrationManifest>,
  ): Promise<RegisterResponse> {
    const res = await request(ctx.app, "POST", "/integrations", {
      key: ctx.adminKey,
      body: { manifest: baseManifest(overrides) },
    });
    expect(res.status).toBe(201);
    return (await res.json()) as RegisterResponse;
  }

  async function catalog(): Promise<RegisterResponse[]> {
    const res = await request(ctx.app, "GET", "/integrations?latest=true", {
      key: ctx.adminKey,
    });
    expect(res.status).toBe(200);
    return ((await res.json()) as ListResponse).data;
  }

  it("returns one row per integration, the newest version", async () => {
    const name = "acme/catalog-versions";
    await register({ name, version: "1.0.0" });
    await register({ name, version: "1.2.0" });

    const rows = (await catalog()).filter((r) => r.manifest_name === name);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.manifest_version).toBe("1.2.0");
  });

  it("honours a limit as a number of integrations, not of rows scanned", async () => {
    // The reduction has to happen before the limit or the two mean
    // different things: a caller asking for two integrations would
    // otherwise get however many of two *version rows* survived, which on
    // a registry holding several versions of one integration is one.
    await register({ name: "acme/catalog-limit-a", version: "1.0.0" });
    await register({ name: "acme/catalog-limit-a", version: "2.0.0" });
    await register({ name: "acme/catalog-limit-b", version: "1.0.0" });

    const res = await request(
      ctx.app,
      "GET",
      "/integrations?latest=true&limit=1",
      { key: ctx.adminKey },
    );
    const rows = ((await res.json()) as ListResponse).data;
    expect(rows).toHaveLength(1);
  });

  it("orders versions numerically, so a tenth release beats a ninth", async () => {
    // The failure a string sort produces, and it is the ordinary case
    // rather than an edge one: lexically "10.0.0" sorts below "9.0.0", so
    // an integration's tenth release would stop being the one a catalog
    // offers and nothing about the response would say why.
    const name = "acme/catalog-ten";
    await register({ name, version: "9.0.0" });
    await register({ name, version: "10.0.0" });

    const rows = (await catalog()).filter((r) => r.manifest_name === name);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.manifest_version).toBe("10.0.0");
  });

  it("does not let a malformed stored version decide the catalog", async () => {
    // Reachable without a bad actor: the version is read out of a stored
    // row and nothing re-validates a stored manifest against the schema at
    // read time, so a row written before a schema tightening is exactly
    // this shape. It sorts last rather than throwing, so one malformed
    // manifest cannot take the whole catalog down or win the row.
    //
    // Both orders, because the reduction compares each candidate against
    // the one it is holding and the malformed row can be on either side.
    // One order alone leaves the other branch of the comparison untested,
    // and it is the branch a plausible edit inverts.
    async function malformed(name: string): Promise<void> {
      await ctx.storage.items.create(
        {
          type: "system.integration",
          properties: {
            manifest_name: name,
            manifest_version: "not-a-version",
            publisher: "Acme",
            direction: "read",
            manifest: { name, version: "not-a-version" },
            registered_at: new Date().toISOString(),
          },
        },
        undefined,
      );
    }

    const first = "acme/catalog-malformed-first";
    await malformed(first);
    const goodAfter = await register({ name: first, version: "1.0.0" });

    const last = "acme/catalog-malformed-last";
    const goodBefore = await register({ name: last, version: "1.0.0" });
    await malformed(last);

    const rows = await catalog();
    const firstRows = rows.filter((r) => r.manifest_name === first);
    expect(firstRows).toHaveLength(1);
    expect(firstRows[0]?.id).toBe(goodAfter.id);

    const lastRows = rows.filter((r) => r.manifest_name === last);
    expect(lastRows).toHaveLength(1);
    expect(lastRows[0]?.id).toBe(goodBefore.id);
  });

  it("still returns every version when latest is not asked for", async () => {
    // The default is unchanged, which is what makes this additive: the
    // existing caller enumerating one integration's history keeps working.
    const name = "acme/catalog-default";
    await register({ name, version: "1.0.0" });
    await register({ name, version: "1.1.0" });

    const res = await request(
      ctx.app,
      "GET",
      `/integrations?manifest_name=${name}`,
      { key: ctx.adminKey },
    );
    const rows = ((await res.json()) as ListResponse).data;
    expect(rows).toHaveLength(2);
  });

  it("surfaces the readable name, and omits it when the manifest has none", async () => {
    const named = await register({
      name: "acme/catalog-named",
      display_name: "Catalog Named",
    });
    expect(named.display_name).toBe("Catalog Named");

    const bare = await register({ name: "acme/catalog-unnamed" });
    expect(bare.display_name).toBeUndefined();
  });

  it("counts nothing before an install and one after", async () => {
    const name = "acme/catalog-installed";
    const registered = await register({ name });

    const before = (await catalog()).find((r) => r.manifest_name === name);
    expect(before?.installed_count).toBe(0);

    await ctx.app.request(`/integrations/${registered.id}/install`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ctx.adminKey}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ decision: "approve" }).toString(),
    });

    const after = (await catalog()).find((r) => r.manifest_name === name);
    expect(after?.installed_count).toBe(1);
  });

  it("counts by integration rather than by version", async () => {
    // A space holding version 1 while version 2 is the newest is a space
    // that has this integration. Counted per manifest row, the catalog's
    // own row would say zero — which is the question a catalog is least
    // interested in, answered in place of the one it asked.
    const name = "acme/catalog-across-versions";
    const v1 = await register({ name, version: "1.0.0" });
    await ctx.app.request(`/integrations/${v1.id}/install`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ctx.adminKey}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ decision: "approve" }).toString(),
    });
    await register({ name, version: "2.0.0" });

    const row = (await catalog()).find((r) => r.manifest_name === name);
    expect(row?.manifest_version).toBe("2.0.0");
    expect(row?.installed_count).toBe(1);
  });

  it("does not count a revoked connection", async () => {
    // A grant that has been given up is not a connection the space is
    // running, and offering "install" for it is the more useful answer.
    const name = "acme/catalog-revoked";
    const registered = await register({ name });
    await ctx.app.request(`/integrations/${registered.id}/install`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ctx.adminKey}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ decision: "approve" }).toString(),
    });

    const connections = await ctx.storage.items.list({
      type: "system.connection",
      sort: "created_at",
      direction: "desc",
      limit: 20,
    });
    const installed = connections.data.find(
      (i) =>
        (i.properties as { integration_ref?: string }).integration_ref ===
        registered.id,
    );
    if (installed === undefined) throw new Error("connection was not created");
    await ctx.storage.items.update(
      installed.id,
      {
        properties: { ...installed.properties, status: "revoked" },
      },
      undefined,
    );

    const row = (await catalog()).find((r) => r.manifest_name === name);
    expect(row?.installed_count).toBe(0);
  });
});

describe("GET /integrations/:id/install (consent HTML)", () => {
  it("renders an HTML form referencing the manifest's surfaces", async () => {
    const reg = await request(ctx.app, "POST", "/integrations", {
      key: ctx.adminKey,
      body: { manifest: baseManifest({ name: "acme/consent-html" }) },
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
    expect(html).toContain("acme/consent-html");
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
     * When set, the GET validates it resolves to a same-space
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
        body: { manifest: baseManifest({ name: "acme/no-prearm" }) },
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
        body: { manifest: baseManifest({ name: "acme/with-prearm" }) },
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

    it("rejects credential_ref that does not resolve in this space", async () => {
      const reg = await request(ctx.app, "POST", "/integrations", {
        key: ctx.adminKey,
        body: { manifest: baseManifest({ name: "acme/bad-prearm" }) },
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
        body: { manifest: baseManifest({ name: "acme/wrong-kind-prearm" }) },
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
  it("end-to-end: installs a connection + activity on approve", async () => {
    const reg = await request(ctx.app, "POST", "/integrations", {
      key: ctx.adminKey,
      body: { manifest: baseManifest({ name: "acme/install-happy" }) },
    });
    const regBody = (await reg.json()) as RegisterResponse;

    const formBody = new URLSearchParams({
      decision: "approve",
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

    // No credential. The install used to mint one and discard its
    // plaintext, so nothing could present it; the supervisor mints per
    // dispatch instead, and what that mint grants is asserted against the
    // mint itself in `integrations/local-runtime/credentials.test.ts`.
    const bound = await ctx.storage.keys.listByConnectionId(
      installed?.id ?? "",
      undefined,
    );
    expect(bound).toEqual([]);

    // Activity row exists and references the connection.
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
    };
    expect(aprops.severity).toBe("info");
    expect(aprops.summary).toContain("acme/install-happy");
  });

  it("declines without writing rows when decision != approve", async () => {
    const reg = await request(ctx.app, "POST", "/integrations", {
      key: ctx.adminKey,
      body: { manifest: baseManifest({ name: "acme/install-deny" }) },
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
    // The decline terminal, identified by its title rather than by a word in
    // the body — the copy here is user-facing and will keep moving, and a
    // test that pins a single word turns a copy edit into a red build.
    expect(html).toContain("<title>Install declined</title>");
    // And it is a designed page. This terminal used to emit bare HTML with
    // four rules of inline CSS, so a person who declined met unstyled Times
    // New Roman straight after a fully designed consent screen.
    expect(html).toContain('href="/auth/static/auth.css"');

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
// Catalog visibility for space-scoped member tokens.
//
// Manifests register under platform credentials (is_platform: true), which
// carry space_id: null. The default space-equality filter on items.list
// hides them from any in-space caller — turning the marketplace surface
// invisible to every real user. The catalog list opts into
// `includePlatformScoped: true` so platform-scoped rows surface alongside
// the caller's own; per-space integration rows must stay isolated, and the
// generic /items route must stay strictly equality-fenced.
// ---------------------------------------------------------------------------

describe("GET /integrations — catalog visibility", () => {
  async function mintSpaceKey(
    spaceId: string,
    typePermissions: Record<string, "read" | "write" | "none"> = {},
  ): Promise<string> {
    const suffix = Math.random().toString(36).slice(2, 10);
    const raw = `marfa_k1_test_member_${suffix}`;
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
      spaceId,
    );
    return raw;
  }

  it("returns platform-registered manifests to a member token in a space", async () => {
    // The platform admin (ctx.adminKey) registers a fresh manifest. It
    // lands with space_id: null because the admin carries no space.
    const reg = await request(ctx.app, "POST", "/integrations", {
      key: ctx.adminKey,
      body: { manifest: baseManifest({ name: "acme/member-visibility" }) },
    });
    expect(reg.status).toBe(201);
    const regBody = (await reg.json()) as RegisterResponse;

    if (!ctx.storage.spaces) return;
    const space = await ctx.storage.spaces.create("space-member-vis");
    const memberKey = await mintSpaceKey(space.id, {
      "system.integration": "read",
    });

    const res = await request(
      ctx.app,
      "GET",
      "/integrations?manifest_name=acme/member-visibility",
      { key: memberKey },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListResponse;
    const match = body.data.find((d) => d.id === regBody.id);
    expect(match).toBeDefined();
    expect(match?.manifest_name).toBe("acme/member-visibility");
  });

  it("preserves existing behavior for member tokens without the read scope", async () => {
    // The dedicated catalog list does not gate on type_permissions
    // (the route just calls requireAuth). This test pins that pre-existing
    // behavior: a member token with no system.integration grant still
    // resolves the endpoint at status 200 — no new rejection introduced.
    await request(ctx.app, "POST", "/integrations", {
      key: ctx.adminKey,
      body: { manifest: baseManifest({ name: "acme/member-no-scope" }) },
    });

    if (!ctx.storage.spaces) return;
    const space = await ctx.storage.spaces.create("space-member-no-scope");
    const memberKey = await mintSpaceKey(space.id, {}); // no scope

    const res = await request(
      ctx.app,
      "GET",
      "/integrations?manifest_name=acme/member-no-scope",
      { key: memberKey },
    );
    expect(res.status).toBe(200);
  });

  it("platform credentials still see every manifest", async () => {
    // Existing platform-admin behavior preserved. Sanity check that the
    // widening flag doesn't accidentally constrain admin reads.
    await request(ctx.app, "POST", "/integrations", {
      key: ctx.adminKey,
      body: { manifest: baseManifest({ name: "acme/platform-still-sees" }) },
    });

    const res = await request(
      ctx.app,
      "GET",
      "/integrations?manifest_name=acme/platform-still-sees",
      { key: ctx.adminKey },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListResponse;
    expect(
      body.data.some((d) => d.manifest_name === "acme/platform-still-sees"),
    ).toBe(true);
  });

  it("does not leak a space-scoped manifest to another space's member", async () => {
    // Defense-in-depth — if a stray system.integration row carries a real
    // space_id (whether seeded by accident, by a future code path, or
    // copied during data migration), it must NOT cross the space
    // boundary just because the catalog endpoint widens to include
    // platform-scoped rows.
    if (!ctx.storage.spaces) return;
    const spaceA = await ctx.storage.spaces.create("space-iso-A");
    const spaceB = await ctx.storage.spaces.create("space-iso-B");

    // Build a space-A-bound system.integration row by going through
    // the storage layer directly (we don't expose a space-bound
    // register API surface — this is a defensive shape test).
    const spaceAOnly = await ctx.storage.items.create(
      {
        type: "system.integration",
        properties: {
          manifest_name: "acme/space-a-private",
          manifest_version: "1.0.0",
          publisher: "Acme",
          summary: "Space-A-only manifest fixture",
          direction: "read" as const,
          registered_at: new Date().toISOString(),
          manifest: { name: "acme/space-a-private", version: "1.0.0" },
        },
      },
      spaceA.id,
    );

    // A platform-scoped manifest also lives in the catalog so we can
    // assert the member in space B still sees null-space rows.
    const platformManifest = await request(ctx.app, "POST", "/integrations", {
      key: ctx.adminKey,
      body: {
        manifest: baseManifest({ name: "acme/platform-catalog-iso" }),
      },
    });
    const platformBody = (await platformManifest.json()) as RegisterResponse;

    const memberB = await mintSpaceKey(spaceB.id, {
      "system.integration": "read",
    });
    const res = await request(ctx.app, "GET", "/integrations?limit=200", {
      key: memberB,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListResponse;

    // space-A's private row must NOT leak to space B
    expect(body.data.some((d) => d.id === spaceAOnly.id)).toBe(false);
    expect(
      body.data.some((d) => d.manifest_name === "acme/space-a-private"),
    ).toBe(false);

    // ...but the platform-scoped catalog row IS visible
    expect(body.data.some((d) => d.id === platformBody.id)).toBe(true);
  });

  it("does not widen the generic /items route — system.connection stays space-isolated", async () => {
    // Out-of-scope guard. The fix is local to the catalog endpoint;
    // a stray system.connection row with space_id IS NULL must remain
    // invisible to a member token hitting the generic /items route.
    if (!ctx.storage.spaces) return;
    const space = await ctx.storage.spaces.create("space-items-gate");
    const memberKey = await mintSpaceKey(space.id, {
      "system.connection": "read",
    });

    // Seed a NULL-space system.connection row to stand in for the
    // staging leftover.
    const nullSpaceConnection = await ctx.storage.items.create(
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
        },
      },
      undefined, // space_id: null
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
    expect(body.data.some((d) => d.id === nullSpaceConnection.id)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Platform-scoped get-by-id + install for space member callers.
//
// The catalog list endpoint opts into `includePlatformScoped: true` so
// platform-scoped manifests surface to in-space callers. The single-id
// `get` calls (`GET /integrations/:id`, `GET/POST /integrations/:id/install`)
// and the admin install (`POST /connections/install`) thread the same
// option through `items.get`. The install pipeline still stamps the new
// `system.connection` with the caller's space_id (never the manifest's
// null space) — the regression test below pins that.
// ---------------------------------------------------------------------------

describe("GET /integrations/:id + /:id/install — platform-scope", () => {
  // Two ranks, because the routes here sit at two tiers. Reading the
  // catalog is member work: a platform-scoped manifest must resolve for
  // any space-bound credential. Installing is not — it mints a runtime
  // credential from the manifest, so it takes space-admin authority
  // (`routes/integrations-install-authority.test/ts` holds that line).
  // The install tests below therefore mint an admin: their subject is
  // space stamping and error shape, never who may install.
  async function mintKeyAtRank(
    spaceId: string,
    role: "member" | "space_admin",
    typePermissions: Record<string, "read" | "write" | "none"> = {
      "system.integration": "read",
    },
  ): Promise<string> {
    const suffix = Math.random().toString(36).slice(2, 10);
    const raw = `marfa_k1_test_member_${suffix}`;
    const hash = hashApiKey(raw, TEST_API_KEY_SALT);
    await ctx.storage.keys.create(
      {
        label: `t234-${role}-${suffix}`,
        source: `t234-${role}-${suffix}`,
        role,
        type_permissions: typePermissions,
        default_tier: "library",
        is_platform: false,
      },
      hash,
      spaceId,
    );
    return raw;
  }

  it("GET /integrations/:id resolves a platform-scoped manifest for a member token", async () => {
    // Manifest registered by platform admin → lives with space_id: null.
    // Pre-fix this returned 404 to any caller with a real space; the
    // space-fenced get filtered the null-space row out.
    const reg = await request(ctx.app, "POST", "/integrations", {
      key: ctx.adminKey,
      body: { manifest: baseManifest({ name: "acme/t234-get-by-id" }) },
    });
    expect(reg.status).toBe(201);
    const regBody = (await reg.json()) as RegisterResponse;

    if (!ctx.storage.spaces) return;
    const space = await ctx.storage.spaces.create("t234-space-get");
    const memberKey = await mintKeyAtRank(space.id, "member");

    const res = await request(ctx.app, "GET", `/integrations/${regBody.id}`, {
      key: memberKey,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as RegisterResponse;
    expect(body.id).toBe(regBody.id);
    expect(body.manifest_name).toBe("acme/t234-get-by-id");
  });

  it("GET /integrations/:id/install renders consent HTML for a space-bound Bearer token", async () => {
    const reg = await request(ctx.app, "POST", "/integrations", {
      key: ctx.adminKey,
      body: { manifest: baseManifest({ name: "acme/t234-install-html" }) },
    });
    const regBody = (await reg.json()) as RegisterResponse;

    if (!ctx.storage.spaces) return;
    const space = await ctx.storage.spaces.create("t234-space-html");
    const installerKey = await mintKeyAtRank(space.id, "space_admin");

    const res = await request(
      ctx.app,
      "GET",
      `/integrations/${regBody.id}/install`,
      { key: installerKey },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain(`action="/integrations/${regBody.id}/install"`);
    expect(html).toContain('name="decision"');
  });

  it("counts an install of a platform-scoped manifest from inside the space", async () => {
    // The ordinary hosted shape, and the one that reads as "nothing is
    // installed" if the count is taken without widening: manifests ship
    // with the platform and carry no space id, while the connection
    // referring to one carries the installer's. A space-fenced lookup of
    // the reference then finds nothing, and every row in the catalog says
    // zero however many connections the space is running.
    const reg = await request(ctx.app, "POST", "/integrations", {
      key: ctx.adminKey,
      body: { manifest: baseManifest({ name: "acme/t234-installed-count" }) },
    });
    const regBody = (await reg.json()) as RegisterResponse;

    if (!ctx.storage.spaces) return;
    const space = await ctx.storage.spaces.create("t234-space-count");
    const installerKey = await mintKeyAtRank(space.id, "space_admin", {
      "system.integration": "read",
      "system.connection": "read",
    });

    await ctx.app.request(`/integrations/${regBody.id}/install`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${installerKey}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ decision: "approve" }).toString(),
    });

    const res = await request(ctx.app, "GET", "/integrations?latest=true", {
      key: installerKey,
    });
    expect(res.status).toBe(200);
    const rows = ((await res.json()) as ListResponse).data;
    const row = rows.find(
      (r) => r.manifest_name === "acme/t234-installed-count",
    );
    expect(row?.installed_count).toBe(1);
  });

  it("POST /integrations/:id/install stamps the connection with the caller's space_id", async () => {
    const reg = await request(ctx.app, "POST", "/integrations", {
      key: ctx.adminKey,
      body: { manifest: baseManifest({ name: "acme/t234-install-post" }) },
    });
    const regBody = (await reg.json()) as RegisterResponse;

    if (!ctx.storage.spaces) return;
    const space = await ctx.storage.spaces.create("t234-space-post");
    const installerKey = await mintKeyAtRank(space.id, "space_admin");

    const formBody = new URLSearchParams({
      decision: "approve",
    }).toString();

    const res = await ctx.app.request(`/integrations/${regBody.id}/install`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${installerKey}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: formBody,
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Connection installed");

    // Pin the load-bearing space invariant: the connection lands in
    // the caller's space, NOT in the manifest's null space. Without
    // this guard a future regression in the install pipeline could
    // silently land cross-space rows.
    const connections = await ctx.storage.items.list({
      spaceId: space.id,
      type: "system.connection",
      limit: 50,
    });
    const installed = connections.data.find(
      (c) =>
        (c.properties as { integration_ref?: string }).integration_ref ===
        regBody.id,
    );
    expect(installed).toBeDefined();
    expect(installed?.space_id).toBe(space.id);
  });

  it("POST /integrations/:id/install on an unknown id still returns INTEGRATION_NOT_FOUND", async () => {
    // Negative test — the widening must not turn a missing manifest
    // into a 500 or a silent success. The type check on the next line
    // is the authoritative gate; only genuine `system.integration`
    // items pass.
    if (!ctx.storage.spaces) return;
    const space = await ctx.storage.spaces.create("t234-space-missing");
    const installerKey = await mintKeyAtRank(space.id, "space_admin");

    const res = await ctx.app.request(
      "/integrations/01999999-9999-7999-9999-999999999999/install",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${installerKey}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: "decision=approve",
      },
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe("integration_not_found");
  });

  it("widening does not leak a space-scoped system.integration into another space via get-by-id", async () => {
    // Defense-in-depth — if a stray system.integration row carries a
    // real space_id (seeded by accident, or via a future space-bound
    // register path), it must not be reachable by id from another
    // space via the catalog endpoint.
    if (!ctx.storage.spaces) return;
    const spaceA = await ctx.storage.spaces.create("t234-iso-A");
    const spaceB = await ctx.storage.spaces.create("t234-iso-B");

    const spaceABound = await ctx.storage.items.create(
      {
        type: "system.integration",
        properties: {
          manifest_name: "acme/t234-space-a-only",
          manifest_version: "1.0.0",
          publisher: "Acme",
          direction: "read" as const,
          registered_at: new Date().toISOString(),
          manifest: { name: "acme/t234-space-a-only", version: "1.0.0" },
        },
      },
      spaceA.id,
    );
    const memberB = await mintKeyAtRank(spaceB.id, "member");

    const res = await request(
      ctx.app,
      "GET",
      `/integrations/${spaceABound.id}`,
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
// Prior behavior: install routes only accepted Bearer tokens. A browser
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
      `acme/session-get-${String(counter)}`,
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
      `acme/session-post-${String(counter)}`,
    );
    const cookie = await signInUser(
      `session-post-${String(counter)}@example.com`,
    );

    const formBody = new URLSearchParams({
      decision: "approve",
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

    // Confirm the connection landed in the session user's space scope —
    // the audit row's key_id should carry the synthetic `auth_user:<id>`
    // marker so operators can recognize session-backed installs.
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
      `acme/bearer-regression-${String(counter)}`,
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
      `acme/bad-bearer-${String(counter)}`,
    );
    const res = await sessionCtx.app.request(
      `/integrations/${integrationId}/install`,
      { headers: { Authorization: "Bearer marfa_k1_completely_invalid" } },
    );
    expect(res.status).toBe(401);
  });

  it("302s to /auth/sign-in on an unauthenticated browser navigation (no Bearer, no session)", async () => {
    // No Authorization header, no session cookie — the only sensible
    // response is a redirect to sign-in with the install URL preserved,
    // so the user lands back on the consent screen after authenticating.
    const integrationId = await registerIntegration(
      `acme/anon-${String(counter)}`,
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
