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
import { createTestContext, request, waitForAudit } from "../test-utils.js";
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
          manifest_schema_version: "1.0.0",
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
  it("rejects unauthenticated requests with 401", async () => {
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
    expect(res.status).toBe(401);
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

  it("400s when the manifest is not google.calendar", async () => {
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
          selected_calendar_ids: "primary",
          default_write_calendar_id: "primary",
          target_type: "google.calendar.event",
        },
      },
    );
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain("does not declare a configuration surface");
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
  it("redirects to /oauth/start when OAuth tokens are missing", async () => {
    const { connectionId } = await seedGoogleCalendarConnection();
    const res = await request(
      ctx.app,
      "GET",
      `/connections/${connectionId}/configure`,
      { key: ctx.adminKey },
    );
    expect(res.status).toBe(302);
    const location = res.headers.get("location");
    expect(location).toBe(
      `/connections/${encodeURIComponent(connectionId)}/oauth/start`,
    );
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
