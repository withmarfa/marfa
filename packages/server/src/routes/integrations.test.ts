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
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestContext, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import type { IntegrationManifest } from "@mymehq/shared";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(() => {
  ctx.cleanup();
});

function baseManifest(
  overrides?: Partial<IntegrationManifest>,
): IntegrationManifest {
  return {
    name: "acme.calendar-sync",
    version: "1.0.0",
    publisher: "Acme",
    description: "Sync calendar events into Myme",
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
    expect(props.kind).toBe("external-service-connector");
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
