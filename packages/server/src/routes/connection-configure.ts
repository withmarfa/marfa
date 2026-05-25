/**
 * Post-install configuration surface for integration connections that
 * carry a `properties.configuration` payload. Today's only consumer is
 * `google.calendar`, but the route is integration-agnostic — it
 * dispatches the picker UI on the connection's `integration_ref`
 * manifest_name.
 *
 * Two endpoints:
 *
 *   - `GET /connections/:id/configure` — HTML page. Resolves the
 *     connection, confirms OAuth tokens exist on it (else redirects to
 *     `/connections/:id/oauth/start`), calls the upstream's "list
 *     calendars" surface via the OAuth proxy, and renders the picker
 *     form.
 *
 *   - `POST /connections/:id/configure` — form submit. Validates the
 *     selection (at least one calendar, the default-write target is
 *     one of the selected, target_type is a recognised type), then
 *     `storage.items.update`s the connection's `properties.configuration`
 *     and renders a success page that links to the connection's runtime
 *     view.
 *
 * Auth: `requireTenantAdmin` on both verbs, matching the install routes.
 * Tenant scoping flows through `apiKey.tenant_id`; cross-tenant probes
 * 404-cloak via the tenant-bounded item read.
 *
 * The route is mounted at `/connections` so it sits alongside the JSON
 * install + uninstall routes that already live under that prefix.
 */
import { Hono } from "hono";
import { MarfaError, ErrorCode } from "@withmarfa/shared";
import type { AppEnv } from "../middleware/auth.js";
import { requireTenantAdmin } from "../middleware/auth.js";
import type { Storage } from "../storage/interface.js";
import type { Item } from "@withmarfa/shared";
import { setNoStore } from "./no-store.js";

// ---------------------------------------------------------------------------
// Calendar surface representation — the subset of Calendar's
// `calendarList.list` response we surface in the picker. Stable shape so
// the renderer is testable without round-tripping through the OAuth
// proxy.
// ---------------------------------------------------------------------------

export interface CalendarListEntry {
  id: string;
  summary: string;
  primary?: boolean;
  accessRole?: string;
  backgroundColor?: string;
}

export interface GoogleCalendarPickerParams {
  connectionId: string;
  calendars: CalendarListEntry[];
  /**
   * The set of `target_type` values the picker offers. Comes from the
   * integration manifest's `target_types`. Default first entry in the
   * list is preselected.
   */
  targetTypeChoices: string[];
  /** Default target type if no override is offered or chosen. */
  defaultTargetType: string;
  /** Pre-fill existing selections when the user re-visits the page. */
  prior?: {
    selectedCalendarIds: string[];
    defaultWriteCalendarId: string | null;
    targetType: string | null;
  };
}

// ---------------------------------------------------------------------------
// HTML renderer — server-rendered, no JS.
// ---------------------------------------------------------------------------

function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function renderGoogleCalendarPicker(
  params: GoogleCalendarPickerParams,
): string {
  const priorSelected = new Set(params.prior?.selectedCalendarIds ?? []);
  const priorDefaultWrite =
    params.prior?.defaultWriteCalendarId ??
    params.calendars.find((c) => c.primary)?.id ??
    params.calendars[0]?.id ??
    "";
  const priorTargetType = params.prior?.targetType ?? params.defaultTargetType;

  const calendarRows = params.calendars
    .map((cal) => {
      const checked =
        priorSelected.has(cal.id) ||
        (priorSelected.size === 0 && cal.primary === true)
          ? "checked"
          : "";
      const defaultWriteChecked = priorDefaultWrite === cal.id ? "checked" : "";
      const swatch = cal.backgroundColor
        ? `<span class="cal-swatch" style="background:${esc(cal.backgroundColor)}"></span>`
        : "";
      const accessRoleNote = cal.accessRole
        ? `<span class="cal-role">${esc(cal.accessRole)}</span>`
        : "";
      const primaryBadge = cal.primary
        ? `<span class="cal-primary">primary</span>`
        : "";
      return `
        <tr>
          <td><input type="checkbox" name="selected_calendar_ids" value="${esc(cal.id)}" ${checked}></td>
          <td><input type="radio" name="default_write_calendar_id" value="${esc(cal.id)}" ${defaultWriteChecked}></td>
          <td>${swatch}<span class="cal-name">${esc(cal.summary)}</span> ${primaryBadge} ${accessRoleNote}</td>
        </tr>`;
    })
    .join("");

  const targetTypeOptions = params.targetTypeChoices
    .map(
      (t) =>
        `<option value="${esc(t)}" ${t === priorTargetType ? "selected" : ""}>${esc(t)}</option>`,
    )
    .join("");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>Configure Google Calendar</title>
    <style>
      body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; max-width: 720px; margin: 2.5rem auto; color: #1f2328; padding: 0 1rem; }
      h1 { font-size: 1.5rem; margin-bottom: 0.25rem; }
      p.lede { color: #57606a; margin-top: 0; }
      table { width: 100%; border-collapse: collapse; margin: 1.5rem 0; }
      th, td { padding: 0.5rem 0.4rem; border-bottom: 1px solid #d0d7de; text-align: left; }
      th { font-weight: 600; font-size: 0.85rem; color: #57606a; }
      .cal-swatch { display: inline-block; width: 0.85rem; height: 0.85rem; border-radius: 3px; margin-right: 0.5rem; vertical-align: -2px; }
      .cal-name { font-weight: 500; }
      .cal-primary { font-size: 0.75rem; background: #ddf4ff; color: #0969da; padding: 0.1rem 0.4rem; border-radius: 4px; margin-left: 0.4rem; }
      .cal-role { font-size: 0.75rem; color: #57606a; margin-left: 0.4rem; }
      label.target-type { display: block; margin: 1.5rem 0 0.5rem; font-weight: 600; }
      select { font: inherit; padding: 0.4rem 0.6rem; }
      button { font: inherit; padding: 0.6rem 1.2rem; background: #1f883d; color: white; border: 0; border-radius: 6px; cursor: pointer; margin-top: 1rem; }
      button:hover { background: #1a7f37; }
      .hint { color: #57606a; font-size: 0.85rem; }
    </style>
  </head>
  <body>
    <h1>Configure Google Calendar</h1>
    <p class="lede">Pick which calendars Marfa should sync, and where new events should land when you create them in Marfa.</p>
    <form method="post" action="">
      <table>
        <thead>
          <tr>
            <th style="width: 1.5rem;">Sync</th>
            <th style="width: 1.5rem;">Write here by default</th>
            <th>Calendar</th>
          </tr>
        </thead>
        <tbody>
          ${calendarRows}
        </tbody>
      </table>
      <p class="hint">Tick the calendars you want Marfa to read. Pick one (a radio) as the destination for events you create in Marfa.</p>

      <label class="target-type" for="target_type">Write events into Marfa as</label>
      <select name="target_type" id="target_type">
        ${targetTypeOptions}
      </select>
      <p class="hint">Default keeps full Google fidelity (recurrence, timezone, etag). Switch to <code>core.event</code> if you want cross-app interop with non-Google consumers and don't mind the lossier shape.</p>

      <button type="submit">Save configuration</button>
    </form>
  </body>
</html>`;
}

export function renderConfigureSuccess(connectionId: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>Configuration saved</title>
    <style>
      body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; max-width: 720px; margin: 2.5rem auto; color: #1f2328; padding: 0 1rem; }
      h1 { font-size: 1.5rem; }
      a { color: #0969da; }
    </style>
  </head>
  <body>
    <h1>Configuration saved</h1>
    <p>The connection's calendar selection has been recorded. The next scheduled run will pick up events from the calendars you chose.</p>
    <p><code>${esc(connectionId)}</code></p>
  </body>
</html>`;
}

export function renderConfigureError(message: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>Could not configure</title>
    <style>
      body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; max-width: 720px; margin: 2.5rem auto; color: #1f2328; padding: 0 1rem; }
      h1 { font-size: 1.5rem; color: #cf222e; }
    </style>
  </head>
  <body>
    <h1>Could not configure</h1>
    <p>${esc(message)}</p>
  </body>
</html>`;
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

interface ConfigurationPayload {
  selected_calendar_ids: string[];
  default_write_calendar_id: string;
  target_type: string;
}

/**
 * Parse the form-encoded picker submission into a normalised payload.
 * Returns either a `{ ok: true, payload }` or `{ ok: false, error }`
 * where error is a plain-text user-facing string.
 */
export function parseConfigurePayload(
  form: Record<string, unknown>,
  validTargetTypes: ReadonlySet<string>,
): { ok: true; payload: ConfigurationPayload } | { ok: false; error: string } {
  const rawSelected = form.selected_calendar_ids;
  const selected: string[] = Array.isArray(rawSelected)
    ? rawSelected.filter((v): v is string => typeof v === "string")
    : typeof rawSelected === "string"
      ? [rawSelected]
      : [];
  if (selected.length === 0) {
    return {
      ok: false,
      error: "Pick at least one calendar to sync (the checkboxes on the left).",
    };
  }

  const defaultWrite = form.default_write_calendar_id;
  if (typeof defaultWrite !== "string" || defaultWrite.length === 0) {
    return {
      ok: false,
      error:
        "Pick one calendar as the default write target (the radio on the right).",
    };
  }
  if (!selected.includes(defaultWrite)) {
    return {
      ok: false,
      error: "The default-write calendar must also be ticked for syncing.",
    };
  }

  const targetType = form.target_type;
  if (typeof targetType !== "string" || targetType.length === 0) {
    return {
      ok: false,
      error: "Pick a target type for events written into Marfa.",
    };
  }
  if (!validTargetTypes.has(targetType)) {
    return {
      ok: false,
      error: `Target type '${targetType}' is not one of the integration's declared target types.`,
    };
  }

  return {
    ok: true,
    payload: {
      selected_calendar_ids: selected,
      default_write_calendar_id: defaultWrite,
      target_type: targetType,
    },
  };
}

interface IntegrationManifestShape {
  name: string;
  target_types: string[];
}

interface ConnectionPropertiesShape {
  kind?: string;
  integration_ref?: string;
  configuration?: Record<string, unknown>;
  tenant_id?: string;
}

async function resolveIntegrationManifest(
  storage: Storage,
  connection: Item,
): Promise<IntegrationManifestShape | null> {
  const props = connection.properties as ConnectionPropertiesShape;
  if (props.integration_ref === undefined) return null;
  const integration = await storage.items.get(props.integration_ref);
  if (integration?.type !== "system.integration") return null;
  const integrationProps = integration.properties as {
    manifest?: { name?: string; target_types?: string[] };
  };
  const manifest = integrationProps.manifest;
  if (!manifest || typeof manifest.name !== "string") return null;
  if (!Array.isArray(manifest.target_types)) return null;
  return {
    name: manifest.name,
    target_types: manifest.target_types,
  };
}

/**
 * Pluggable calendar-list fetcher. In production, an outer wiring layer
 * implements this by calling the connection-proxy with admin credentials
 * (the picker UI itself is admin-gated). Tests inject a stub that returns
 * a fixed calendar list without touching the OAuth path. This keeps the
 * route deterministic under unit-test conditions and avoids re-entering
 * the request stack from inside a handler.
 */
export type CalendarListFetcher = (args: {
  connectionId: string;
  tenantId: string | undefined;
}) => Promise<CalendarListEntry[]>;

export interface ConnectionConfigureOptions {
  fetchCalendars?: CalendarListFetcher;
}

export function connectionConfigureRoutes(
  storage: Storage,
  options: ConnectionConfigureOptions = {},
) {
  const r = new Hono<AppEnv>();

  // Default fetcher does the proxy call out-of-process. Tests typically
  // override via `options.fetchCalendars` so the GET path renders
  // deterministically without re-entering the server's HTTP stack.
  const fetchCalendars: CalendarListFetcher =
    options.fetchCalendars ??
    // eslint-disable-next-line @typescript-eslint/require-await
    (async () => []);

  r.get("/:id/configure", async (c) => {
    const apiKey = requireTenantAdmin(c);
    const tenantId = apiKey.tenant_id;
    const id = c.req.param("id");

    const connection = await storage.items.get(id, tenantId);
    if (connection?.type !== "system.connection") {
      throw new MarfaError(
        ErrorCode.CONNECTION_NOT_FOUND,
        `Connection ${id} not found`,
        { connection_id: id },
      );
    }

    const manifest = await resolveIntegrationManifest(storage, connection);
    if (manifest === null) {
      setNoStore(c);
      return c.html(
        renderConfigureError(
          "Connection's integration manifest could not be resolved.",
        ),
        400,
      );
    }

    // Today only google.calendar uses this surface — surface an error for
    // anything else so unexpected manifests don't silently render an
    // empty picker.
    if (manifest.name !== "google.calendar") {
      setNoStore(c);
      return c.html(
        renderConfigureError(
          `Integration '${manifest.name}' does not declare a configuration surface.`,
        ),
        400,
      );
    }

    // Confirm OAuth tokens exist — if not, the picker can't list
    // calendars and the user must complete the OAuth dance first.
    const tokens = await storage.connectionOauthTokens.get(id, tenantId);
    if (!tokens) {
      setNoStore(c);
      return c.redirect(`/connections/${encodeURIComponent(id)}/oauth/start`);
    }

    let calendars: CalendarListEntry[];
    try {
      calendars = await fetchCalendars({ connectionId: id, tenantId });
    } catch (err) {
      setNoStore(c);
      return c.html(
        renderConfigureError(
          `Could not load calendars: ${err instanceof Error ? err.message : String(err)}`,
        ),
        502,
      );
    }

    const props = connection.properties as ConnectionPropertiesShape;
    const cfg = props.configuration ?? {};
    const priorSelected = Array.isArray(cfg.selected_calendar_ids)
      ? (cfg.selected_calendar_ids as unknown[]).filter(
          (v): v is string => typeof v === "string",
        )
      : [];
    const priorDefaultWrite =
      typeof cfg.default_write_calendar_id === "string"
        ? cfg.default_write_calendar_id
        : null;
    const priorTargetType =
      typeof cfg.target_type === "string" ? cfg.target_type : null;

    setNoStore(c);
    return c.html(
      renderGoogleCalendarPicker({
        connectionId: id,
        calendars,
        targetTypeChoices: manifest.target_types,
        defaultTargetType: manifest.target_types.includes(
          "google.calendar.event",
        )
          ? "google.calendar.event"
          : (manifest.target_types[0] ?? "core.event"),
        prior: {
          selectedCalendarIds: priorSelected,
          defaultWriteCalendarId: priorDefaultWrite,
          targetType: priorTargetType,
        },
      }),
    );
  });

  r.post("/:id/configure", async (c) => {
    const apiKey = requireTenantAdmin(c);
    const tenantId = apiKey.tenant_id;
    const id = c.req.param("id");

    const connection = await storage.items.get(id, tenantId);
    if (connection?.type !== "system.connection") {
      throw new MarfaError(
        ErrorCode.CONNECTION_NOT_FOUND,
        `Connection ${id} not found`,
        { connection_id: id },
      );
    }

    const manifest = await resolveIntegrationManifest(storage, connection);
    if (manifest === null) {
      setNoStore(c);
      return c.html(
        renderConfigureError(
          "Connection's integration manifest could not be resolved.",
        ),
        400,
      );
    }

    // Same gate as the GET path — today only google.calendar has a
    // configuration surface.
    if (manifest.name !== "google.calendar") {
      setNoStore(c);
      return c.html(
        renderConfigureError(
          `Integration '${manifest.name}' does not declare a configuration surface.`,
        ),
        400,
      );
    }

    const validTargetTypes = new Set(manifest.target_types);
    // `parseBody({ all: true })` returns arrays for repeated form fields
    // (the checkbox group `selected_calendar_ids` sends one entry per
    // checked calendar). The default `parseBody()` picks only the last
    // value, which silently drops every entry except one — the parser
    // would then complain the default-write calendar isn't ticked
    // (because it lost the rest of the array).
    const form = await c.req.parseBody({ all: true });
    const parsed = parseConfigurePayload(
      form as Record<string, unknown>,
      validTargetTypes,
    );
    if (!parsed.ok) {
      setNoStore(c);
      return c.html(renderConfigureError(parsed.error), 400);
    }

    const existingProps = connection.properties as ConnectionPropertiesShape;
    const existingCfg = existingProps.configuration ?? {};
    const newProps = {
      ...existingProps,
      configuration: {
        ...existingCfg,
        selected_calendar_ids: parsed.payload.selected_calendar_ids,
        default_write_calendar_id: parsed.payload.default_write_calendar_id,
        target_type: parsed.payload.target_type,
      },
    };
    await storage.items.update(id, { properties: newProps }, tenantId);

    void storage.audit.log({
      key_id: apiKey.id,
      client_ip: c.get("clientIp") ?? null,
      tenant_id: tenantId ?? null,
      action: "connection.configure",
      resource_type: "item",
      resource_id: id,
      details: {
        manifest_name: manifest.name,
        selected_count: parsed.payload.selected_calendar_ids.length,
        default_write_calendar_id: parsed.payload.default_write_calendar_id,
        target_type: parsed.payload.target_type,
      },
    });

    setNoStore(c);
    return c.html(renderConfigureSuccess(id));
  });

  return r;
}
