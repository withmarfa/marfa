/**
 * Tests for the post-install configuration surface
 * (`GET/POST /connections/:id/configure`).
 *
 * Covers:
 *   - The pure parser (`parseConfigurePayload`).
 *   - The pure renderer (`renderGoogleCalendarPicker`).
 *   - POST end-to-end against the test app:
 *       * auth gate (401 unauthenticated / 403 member),
 *       * connection-not-found (404),
 *       * non-google.calendar manifest (400),
 *       * validation rejections (no selection / no default /
 *         default-not-in-selected / unknown target_type),
 *       * happy path (200 + persisted configuration + audit row).
 *   - GET end-to-end via a dedicated mini-app with an injected
 *     `fetchCalendars` stub (avoids re-entering the OAuth proxy).
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { Hono } from "hono";
import {
  createTestContext,
  markEmailVerified,
  request,
  waitForAudit,
} from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import {
  parseConfigurePayload,
  renderGoogleCalendarPicker,
  connectionConfigureRoutes,
  type CalendarListEntry,
} from "./connection-configure.js";
import type { AppEnv } from "../middleware/auth.js";
import { encryptSecret, SECRET_INFO } from "../crypto/secret-encryption.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.cleanup();
});

// ---------------------------------------------------------------------------
// Pure-function tests
// ---------------------------------------------------------------------------

const VALID_TARGET_TYPES = new Set(["core.event", "google.calendar.event"]);

describe("parseConfigurePayload", () => {
  it("accepts a well-formed submission", () => {
    const result = parseConfigurePayload(
      {
        selected_calendar_ids: ["primary", "team@example.com"],
        default_write_calendar_id: "primary",
        target_type: "google.calendar.event",
      },
      VALID_TARGET_TYPES,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.selected_calendar_ids).toEqual([
        "primary",
        "team@example.com",
      ]);
      expect(result.payload.default_write_calendar_id).toBe("primary");
      expect(result.payload.target_type).toBe("google.calendar.event");
    }
  });

  it("coerces a single string into a one-element selection array", () => {
    const result = parseConfigurePayload(
      {
        selected_calendar_ids: "primary",
        default_write_calendar_id: "primary",
        target_type: "core.event",
      },
      VALID_TARGET_TYPES,
    );
    expect(result.ok).toBe(true);
  });

  it("rejects when no calendars are selected", () => {
    const result = parseConfigurePayload(
      {
        selected_calendar_ids: [],
        default_write_calendar_id: "primary",
        target_type: "core.event",
      },
      VALID_TARGET_TYPES,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/at least one calendar/i);
  });

  it("rejects when no default write calendar is supplied", () => {
    const result = parseConfigurePayload(
      {
        selected_calendar_ids: ["primary"],
        target_type: "core.event",
      },
      VALID_TARGET_TYPES,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/default write target/i);
  });

  it("rejects when default write calendar isn't in the selected set", () => {
    const result = parseConfigurePayload(
      {
        selected_calendar_ids: ["primary"],
        default_write_calendar_id: "team@example.com",
        target_type: "core.event",
      },
      VALID_TARGET_TYPES,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/must also be ticked/i);
  });

  it("rejects an unknown target_type", () => {
    const result = parseConfigurePayload(
      {
        selected_calendar_ids: ["primary"],
        default_write_calendar_id: "primary",
        target_type: "evil.event",
      },
      VALID_TARGET_TYPES,
    );
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.error).toMatch(/not one of the integration's/);
  });
});

describe("renderGoogleCalendarPicker", () => {
  const sampleCalendars: CalendarListEntry[] = [
    {
      id: "primary",
      summary: "oblix.cyzr@gmail.com",
      primary: true,
      accessRole: "owner",
      backgroundColor: "#4285f4",
    },
    {
      id: "team@example.com",
      summary: "Team",
      accessRole: "writer",
    },
  ];

  it("renders both calendars with primary preselected", () => {
    const html = renderGoogleCalendarPicker({
      connectionId: "conn_abc",
      calendars: sampleCalendars,
      targetTypeChoices: ["core.event", "google.calendar.event"],
      defaultTargetType: "google.calendar.event",
    });
    expect(html).toContain("oblix.cyzr@gmail.com");
    expect(html).toContain("team@example.com");
    expect(html).toContain('value="primary" checked');
    expect(html).toContain('value="google.calendar.event"');
  });

  it("escapes special characters in calendar names", () => {
    const html = renderGoogleCalendarPicker({
      connectionId: "conn_abc",
      calendars: [
        { id: "x", summary: "<script>alert('x')</script>", primary: true },
      ],
      targetTypeChoices: ["core.event"],
      defaultTargetType: "core.event",
    });
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;");
  });

  it("preselects prior selections when re-rendering", () => {
    const html = renderGoogleCalendarPicker({
      connectionId: "conn_abc",
      calendars: sampleCalendars,
      targetTypeChoices: ["core.event", "google.calendar.event"],
      defaultTargetType: "google.calendar.event",
      prior: {
        selectedCalendarIds: ["team@example.com"],
        defaultWriteCalendarId: "team@example.com",
        targetType: "core.event",
      },
    });
    // 'team@example.com' should be checked; 'primary' should NOT be the
    // pre-tick fallback now that prior selections are present.
    expect(html).toContain('value="team@example.com" checked');
    expect(html).toContain('value="core.event" selected');
  });
});

// ---------------------------------------------------------------------------
// End-to-end POST tests against the live app
// ---------------------------------------------------------------------------

async function mintMemberKey(): Promise<string> {
  const res = await request(ctx.app, "POST", "/keys", {
    key: ctx.adminKey,
    body: {
      label: "configure-member",
      source: "configure-member",
      role: "member",
      type_permissions: {},
    },
  });
  const body = (await res.json()) as { key: string };
  return body.key;
}

interface SeededConnection {
  connectionId: string;
  integrationId: string;
}

async function seedGoogleCalendarConnection(
  opts: {
    withOauthTokens?: boolean;
    manifestName?: string;
  } = {},
): Promise<SeededConnection> {
  const integration = await ctx.storage.items.create(
    {
      type: "system.integration",
      properties: {
        manifest_name: opts.manifestName ?? "google.calendar",
        manifest_version: "0.1.0",
        publisher: "google",
        direction: "both",
        runtime_compatibility: ["hosted", "local"],
        manifest: {
          name: opts.manifestName ?? "google.calendar",
          version: "0.1.0",
          publisher: "google",
          description: "test",
          direction: "both",
          target_types: ["core.event", "google.calendar.event"],
          triggers: [{ type: "manual" }],
          runtime_compatibility: ["hosted", "local"],
          bidirectional_handling: {
            echo_ttl_seconds: 60,
            lag_window_seconds: 60,
            tombstone_mapping: "state-trashed",
            partial_write_mode: "accept-partial",
          },
          oauth_requirements: { calendar: "proxy" },
          webhook_verification: { method: "hmac-sha256" },
          manifest_schema_version: "1.2.0",
          configuration_schema: {
            target_type: {
              type: "string",
              description: "Item type synced events land as.",
              from_target_types: true,
            },
            selected_calendar_ids: {
              type: "string_array",
              description: "Calendars included in the sync.",
            },
            default_write_calendar_id: {
              type: "string",
              description: "Calendar that receives events created in Marfa.",
            },
            mode: {
              type: "string",
              description: "Whether one calendar or several are synced.",
              values: ["single", "multi"],
            },
            inbound_webhook_url: {
              type: "string",
              description: "Push receipt URL for the watch channel.",
            },
          },
        },
        registered_at: new Date().toISOString(),
      },
    },
    undefined,
  );
  const connection = await ctx.storage.items.create(
    {
      type: "system.connection",
      properties: {
        kind: "integration",
        status: "active",
        granted_at: new Date().toISOString(),
        integration_ref: integration.id,
        configuration: {},
        direction: "both",
        triggers: [{ type: "manual" }],
        runtime_status: "healthy",
        feed_activity: false,
      },
    },
    undefined,
  );
  if (opts.withOauthTokens) {
    await ctx.storage.connectionOauthTokens.upsert({
      connection_id: connection.id,
      space_id: undefined,
      access_token_encrypted: encryptSecret(
        "test-access",
        SECRET_INFO.connectionOauthToken,
      ),
      refresh_token_encrypted: encryptSecret(
        "test-refresh",
        SECRET_INFO.connectionOauthToken,
      ),
      expires_at: new Date(Date.now() + 3600_000).toISOString(),
      scopes: ["https://www.googleapis.com/auth/calendar.events"],
      previous_refresh_hash: null,
    });
  }
  return { connectionId: connection.id, integrationId: integration.id };
}

describe("POST /connections/:id/configure — auth gate", () => {
  it("sends a caller with no credential to sign in, with a way back", async () => {
    // These pages exist to be opened by a person, and a person who has
    // simply not signed in yet gets a dead end from a 401. The API-client
    // shape is unchanged and covered by the next case.
    const { connectionId } = await seedGoogleCalendarConnection();
    const res = await request(
      ctx.app,
      "POST",
      `/connections/${connectionId}/configure`,
      {
        form: {
          selected_calendar_ids: "primary",
          default_write_calendar_id: "primary",
          target_type: "google.calendar.event",
        },
      },
    );
    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(location).toContain("/auth/sign-in?return_to=");
    expect(decodeURIComponent(location)).toContain(
      `/connections/${connectionId}/configure`,
    );
  });

  it("still answers 401 to a bearer that does not resolve", async () => {
    const { connectionId } = await seedGoogleCalendarConnection();
    const res = await request(
      ctx.app,
      "POST",
      `/connections/${connectionId}/configure`,
      {
        key: "marfa_k1_not_a_real_key",
        form: {
          selected_calendar_ids: "primary",
          default_write_calendar_id: "primary",
          target_type: "google.calendar.event",
        },
      },
    );
    expect(res.status).toBe(401);
  });

  it("rejects a form post from an origin the deployment does not allow", async () => {
    const { connectionId } = await seedGoogleCalendarConnection();
    const res = await request(
      ctx.app,
      "POST",
      `/connections/${connectionId}/configure`,
      {
        key: ctx.adminKey,
        headers: { origin: "https://not-this-deployment.example" },
        form: {
          selected_calendar_ids: "primary",
          default_write_calendar_id: "primary",
          target_type: "google.calendar.event",
        },
      },
    );
    expect(res.status).toBe(403);
  });

  it("rejects member keys with 403", async () => {
    const { connectionId } = await seedGoogleCalendarConnection();
    const memberKey = await mintMemberKey();
    const res = await request(
      ctx.app,
      "POST",
      `/connections/${connectionId}/configure`,
      {
        key: memberKey,
        form: {
          selected_calendar_ids: "primary",
          default_write_calendar_id: "primary",
          target_type: "google.calendar.event",
        },
      },
    );
    expect(res.status).toBe(403);
  });
});

describe("POST /connections/:id/configure — happy path + persistence", () => {
  it("writes selection + default_write + target_type onto properties.configuration", async () => {
    const { connectionId } = await seedGoogleCalendarConnection();
    const res = await request(
      ctx.app,
      "POST",
      `/connections/${connectionId}/configure`,
      {
        key: ctx.adminKey,
        form: {
          selected_calendar_ids: ["primary", "team@example.com"],
          default_write_calendar_id: "primary",
          target_type: "google.calendar.event",
        },
      },
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Configuration saved");

    const conn = await ctx.storage.items.get(connectionId);
    const cfg = (
      conn?.properties as { configuration?: Record<string, unknown> }
    ).configuration;
    expect(cfg).toMatchObject({
      selected_calendar_ids: ["primary", "team@example.com"],
      default_write_calendar_id: "primary",
      target_type: "google.calendar.event",
    });
  });

  it("writes a connection.configure audit row", async () => {
    const { connectionId } = await seedGoogleCalendarConnection();
    await request(ctx.app, "POST", `/connections/${connectionId}/configure`, {
      key: ctx.adminKey,
      form: {
        selected_calendar_ids: "primary",
        default_write_calendar_id: "primary",
        target_type: "core.event",
      },
    });
    const audits = await waitForAudit(
      () =>
        ctx.storage.audit.list({
          action: "connection.configure",
        }),
      (r) => r.data.some((row) => row.resource_id === connectionId),
    );
    const row = audits.data.find((r) => r.resource_id === connectionId);
    expect(row).toBeTruthy();
    expect(row?.details).toMatchObject({
      manifest_name: "google.calendar",
      selected_count: 1,
      default_write_calendar_id: "primary",
      target_type: "core.event",
    });
  });
});

describe("POST /connections/:id/configure — error paths", () => {
  it("404s when the connection doesn't exist", async () => {
    const res = await request(
      ctx.app,
      "POST",
      `/connections/itm_does_not_exist/configure`,
      {
        key: ctx.adminKey,
        form: {
          selected_calendar_ids: "primary",
          default_write_calendar_id: "primary",
          target_type: "google.calendar.event",
        },
      },
    );
    expect(res.status).toBe(404);
  });

  it("serves the schema-driven path for a non-calendar integration that declares a contract", async () => {
    // The surface works for any integration that declares a schema; the
    // bespoke picker is a google.calendar refinement, not the gate.
    const { connectionId } = await seedGoogleCalendarConnection({
      manifestName: "acme.other",
    });
    const res = await request(
      ctx.app,
      "POST",
      `/connections/${connectionId}/configure`,
      {
        key: ctx.adminKey,
        form: {
          target_type: "google.calendar.event",
          mode: "single",
        },
      },
    );
    expect(res.status).toBe(200);
    const conn = await ctx.storage.items.get(connectionId, undefined);
    const cfg = (
      conn?.properties as { configuration?: Record<string, unknown> }
    ).configuration;
    expect(cfg).toMatchObject({
      target_type: "google.calendar.event",
      mode: "single",
    });
  });

  it("400s a declared-contract violation on the schema-driven path", async () => {
    const { connectionId } = await seedGoogleCalendarConnection({
      manifestName: "acme.other-invalid",
    });
    const res = await request(
      ctx.app,
      "POST",
      `/connections/${connectionId}/configure`,
      {
        key: ctx.adminKey,
        form: { mode: "sideways" },
      },
    );
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain("must be one of");
  });

  it("400s when no calendars are selected", async () => {
    const { connectionId } = await seedGoogleCalendarConnection();
    const res = await request(
      ctx.app,
      "POST",
      `/connections/${connectionId}/configure`,
      {
        key: ctx.adminKey,
        form: {
          default_write_calendar_id: "primary",
          target_type: "google.calendar.event",
        },
      },
    );
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain("Pick at least one calendar");
  });

  it("400s when target_type is not in the manifest's target_types", async () => {
    const { connectionId } = await seedGoogleCalendarConnection();
    const res = await request(
      ctx.app,
      "POST",
      `/connections/${connectionId}/configure`,
      {
        key: ctx.adminKey,
        form: {
          selected_calendar_ids: "primary",
          default_write_calendar_id: "primary",
          target_type: "evil.event",
        },
      },
    );
    expect(res.status).toBe(400);
    const html = await res.text();
    // Apostrophes are HTML-escaped to `&#39;` in the rendered page, so
    // assert against a substring that survives escaping.
    expect(html).toContain("not one of the integration");
    expect(html).toContain("declared target types");
  });
});

// ---------------------------------------------------------------------------
// GET end-to-end via a dedicated mini-app with an injected stub fetcher
// ---------------------------------------------------------------------------

describe("GET /connections/:id/configure", () => {
  it("says the connection is not authorized yet, rather than redirecting somewhere unreachable", async () => {
    // It used to 302 here, to a route registered POST-only that also wants a
    // bearer credential and a JSON body. Nothing following a redirect sends
    // any of those, so the old assertion passed while the flow it described
    // could not run: it read the Location header and never followed it.
    const { connectionId } = await seedGoogleCalendarConnection();
    const res = await request(
      ctx.app,
      "GET",
      `/connections/${connectionId}/configure`,
      { key: ctx.adminKey },
    );
    expect(res.status).toBe(409);
    expect(res.headers.get("location")).toBeNull();
    const html = await res.text();
    expect(html).toContain("Not authorized yet");
    expect(html).toContain(`/connections/${connectionId}/oauth/start`);
  });

  it("renders the picker when OAuth tokens exist and the fetcher returns calendars", async () => {
    const { connectionId } = await seedGoogleCalendarConnection({
      withOauthTokens: true,
    });

    // Build a tiny dedicated app that mounts the configure routes with
    // an injected fetcher. Mirrors how the route is wired in production
    // (`packages/server/src/app.ts:578`) but lets the test return a
    // deterministic calendar list without re-entering the OAuth proxy.
    const miniApp = new Hono<AppEnv>();
    // The test request helper sets `apiKey` on `c.var` via the
    // bearer-token middleware on the main app. Here we propagate it by
    // reading the same context env shim and stamping a fixed apiKey for
    // the route's `requireSpaceAdmin` to consume.
    miniApp.use("*", async (c, next) => {
      c.set("apiKey", {
        id: "test-admin",
        label: "test-admin",
        source: "test-admin",
        role: "admin",
        is_platform: true,
        default_tier: "library",
        type_permissions: { "*": "write" },
        extension_permissions: {},
        edge_permissions: {},
        metadata_permissions: {},
        created_at: new Date().toISOString(),
        last_used_at: null,
      });
      await next();
    });
    miniApp.route(
      "/connections",
      connectionConfigureRoutes(ctx.storage, {
        // eslint-disable-next-line @typescript-eslint/require-await
        fetchCalendars: async () => [
          {
            id: "primary",
            summary: "oblix.cyzr@gmail.com",
            primary: true,
            accessRole: "owner",
          },
          { id: "team@example.com", summary: "Team", accessRole: "writer" },
        ],
      }),
    );
    const res = await miniApp.request(
      `/connections/${connectionId}/configure`,
      { method: "GET" },
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("oblix.cyzr@gmail.com");
    expect(html).toContain("Team");
    expect(html).toContain("Configure Google Calendar");
  });
});

// ---------------------------------------------------------------------------
// A browser can open these pages
//
// The surface a person meets right after connecting an integration, and the
// one place the platform asks them to make a choice about their own data. It
// had been built, styled, previewed and snapshotted, and a browser could not
// open it: every test drove it with a bearer, which is why they all passed.
// ---------------------------------------------------------------------------

describe("the configuration surface answers a browser session", () => {
  let sessionCtx: TestContext;
  const ORIGIN = "http://localhost:0";
  let counter = 0;

  beforeAll(async () => {
    sessionCtx = await createTestContext({ authAllowSignup: true });
  });

  afterAll(async () => {
    await sessionCtx.cleanup();
  });

  async function signIn(email: string): Promise<string> {
    const password = "correct horse battery";
    const up = await request(sessionCtx.app, "POST", "/auth/sign-up/email", {
      body: { email, password, name: "Test User" },
      headers: { origin: ORIGIN },
    });
    if (up.status !== 200) {
      throw new Error(`sign-up failed ${String(up.status)}`);
    }
    await markEmailVerified(sessionCtx.storage, email);
    const inRes = await request(sessionCtx.app, "POST", "/auth/sign-in/email", {
      body: { email, password },
      headers: { origin: ORIGIN },
    });
    if (inRes.status !== 200) {
      throw new Error(`sign-in failed ${String(inRes.status)}`);
    }
    for (const part of (inRes.headers.get("set-cookie") ?? "").split(
      /,\s*(?=[a-zA-Z0-9_-]+=)/,
    )) {
      const head = part.split(";")[0];
      if (head?.includes("session_token")) return head;
    }
    throw new Error("session_token cookie not found");
  }

  /** An integration declaring a configuration contract, so the generic form
   *  renders without needing an upstream OAuth dance first. */
  function configurableManifest(name: string): Record<string, unknown> {
    return {
      name,
      version: "1.0.0",
      publisher: "Acme",
      description: "configurable test integration",
      direction: "read",
      triggers: [{ type: "manual" }],
      target_types: ["core.note"],
      runtime_compatibility: ["hosted"],
      configuration_schema: {
        folder: { type: "string", description: "Folder to read from." },
      },
      bidirectional_handling: {
        echo_ttl_seconds: 60,
        lag_window_seconds: 60,
        tombstone_mapping: "ignore",
        partial_write_mode: "accept-partial",
      },
      oauth_requirements: {},
      webhook_verification: { method: "hmac-sha256" },
      manifest_schema_version: "1.2.0",
    };
  }

  /** Install through the browser flow, so the connection lands in the
   *  session user's own space rather than an admin key's. */
  async function installAsBrowser(
    cookie: string,
    name: string,
  ): Promise<string> {
    const registered = await request(sessionCtx.app, "POST", "/integrations", {
      key: sessionCtx.adminKey,
      body: { manifest: configurableManifest(name) },
    });
    expect(registered.status).toBe(201);
    const { id } = (await registered.json()) as { id: string };

    const installed = await sessionCtx.app.request(
      `/integrations/${id}/install`,
      {
        method: "POST",
        headers: {
          cookie,
          origin: ORIGIN,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          decision: "approve",
          label: "Browser-Installed",
        }).toString(),
      },
    );
    expect(installed.status).toBe(200);

    const connections = await sessionCtx.storage.items.list({
      type: "system.connection",
    });
    const connection = connections.data.find(
      (item) =>
        (item.properties as { integration_ref?: string }).integration_ref ===
        id,
    );
    if (!connection) throw new Error("installed connection not found");
    return connection.id;
  }

  it("renders the configuration form to a signed-in browser with no bearer", async () => {
    counter += 1;
    const cookie = await signIn(`configure-get-${String(counter)}@example.com`);
    const connectionId = await installAsBrowser(
      cookie,
      `acme.configurable-get-${String(counter)}`,
    );

    const res = await sessionCtx.app.request(
      `/connections/${connectionId}/configure`,
      { headers: { cookie } },
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain(`action="/connections/${connectionId}/configure"`);
  });

  it("accepts the form that page renders, from the same session", async () => {
    counter += 1;
    const cookie = await signIn(
      `configure-post-${String(counter)}@example.com`,
    );
    const connectionId = await installAsBrowser(
      cookie,
      `acme.configurable-post-${String(counter)}`,
    );

    const res = await sessionCtx.app.request(
      `/connections/${connectionId}/configure`,
      {
        method: "POST",
        headers: {
          cookie,
          origin: ORIGIN,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ folder: "Inbox" }).toString(),
      },
    );

    expect(res.status).toBe(200);
    const connection = await sessionCtx.storage.items.get(connectionId);
    expect(
      (connection?.properties as { configuration?: Record<string, unknown> })
        .configuration,
    ).toMatchObject({ folder: "Inbox" });
  });
});
