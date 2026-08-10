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
 *     one of the selected, target_type is a recognized type), then
 *     `storage.items.update`s the connection's `properties.configuration`
 *     and renders a success page that links to the connection's runtime
 *     view.
 *
 * Auth: a bearer token OR a Better Auth session on both verbs, matching the
 * install surface one step earlier in the same flow. A browser navigation
 * carries no bearer, and these pages exist to be opened by a person.
 * Space scoping flows through the resolved caller's space; cross-space probes
 * 404-cloak via the space-bounded item read.
 *
 * The route is mounted at `/connections` so it sits alongside the JSON
 * install + uninstall routes that already live under that prefix.
 */
import { Hono } from "hono";
import {
  MarfaError,
  ErrorCode,
  declaredConfigurationDefault,
  validateConnectionConfiguration,
} from "@withmarfa/shared";
import type { AppEnv } from "../middleware/auth.js";
import type { MarfaAuth } from "../auth/instance.js";
import {
  buildAllowedOrigins,
  isCrossOriginPost,
  resolveSpaceAdminCaller,
} from "./_space-caller.js";
import type { Storage } from "../storage/interface.js";
import type { ConfigurationFieldSpec, Item } from "@withmarfa/shared";
import { setNoStore } from "./no-store.js";
import { renderAuthLayout } from "./auth-layout.js";

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

/**
 * These four states render through the shared auth layout.
 *
 * They used to carry a hand-written copy of the design system — tokens,
 * body, card, buttons, the lot — whose own comment said it was "kept in
 * sync with auth-css.ts" by hand. The stated reason was that they render
 * outside /auth/* and so have no session; the stylesheet is a public asset
 * that needs no session, so the reason never held. Only the genuinely
 * page-specific rules moved, into the "Connection surfaces" section of
 * auth.css, where one change now reaches every page that uses them.
 */

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

  // Each calendar renders as a selectable card: a `<label>` wraps the
  // include checkbox plus the dot + name, so clicking anywhere on the row
  // toggles `selected_calendar_ids`. The "Save new events to" control is a
  // single `<select name="default_write_calendar_id">` listing every
  // calendar — kept out of the cards so it stays independently operable
  // (a checkbox nested in the same label can't host a second control).
  const calendarCards =
    params.calendars.length === 0
      ? `<p class="empty">No calendars were returned for this account. Reconnect the integration if you expected to see some here.</p>`
      : params.calendars
          .map((cal) => {
            const checked =
              priorSelected.has(cal.id) ||
              (priorSelected.size === 0 && cal.primary === true)
                ? "checked"
                : "";
            const dot = cal.backgroundColor
              ? `<span class="ccard__dot" style="background:${esc(cal.backgroundColor)}"></span>`
              : `<span class="ccard__dot" style="background:var(--border-strong)"></span>`;
            const primaryBadge = cal.primary
              ? `<span class="ccard__badge">primary</span>`
              : "";
            const subline = cal.accessRole
              ? `<span>${esc(cal.accessRole)}</span>`
              : "";
            return `
        <label class="ccard">
          <input class="chk" type="checkbox" name="selected_calendar_ids" value="${esc(cal.id)}" ${checked}>
          ${dot}
          <span class="ccard__tt">
            <span class="ccard__name"><b>${esc(cal.summary)}</b>${primaryBadge}</span>
            ${subline}
          </span>
        </label>`;
          })
          .join("");

  const defaultWriteOptions = params.calendars
    .map(
      (cal) =>
        `<option value="${esc(cal.id)}" ${cal.id === priorDefaultWrite ? "selected" : ""}>${esc(cal.summary)}</option>`,
    )
    .join("");

  const targetTypeOptions = params.targetTypeChoices
    .map(
      (t) =>
        `<option value="${esc(t)}" ${t === priorTargetType ? "selected" : ""}>${esc(t)}</option>`,
    )
    .join("");

  return renderAuthLayout({
    title: "Configure Google Calendar",
    wide: true,
    bodyHtml: `      <h1 class="title">Choose calendars to sync</h1>
      <p class="sub">Pick the calendars you want in Marfa. You can change this later.</p>
      <form method="post" action="">
        <div class="grid">
          ${calendarCards}
        </div>

        <div class="defrow">
          <label class="label" for="default_write_calendar_id">Save new events to</label>
          <select name="default_write_calendar_id" id="default_write_calendar_id">
            ${defaultWriteOptions}
          </select>
        </div>

        <div class="defrow">
          <label class="label" for="target_type">Write events as</label>
          <select name="target_type" id="target_type">
            ${targetTypeOptions}
          </select>
        </div>
        <p class="label__hint">Keep the Google format to preserve everything Google tracks, including repeats and time zones. Choose the standard format if other apps need to read these events too.</p>

        <div class="stack">
          <button class="btn btn--primary" type="submit">Save calendars</button>
        </div>
      </form>
    `,
  });
}

export function renderConfigureSuccess(): string {
  return renderAuthLayout({
    title: "Configuration saved",
    centered: true,
    bodyHtml: `      <h1 class="title">Configuration saved</h1>
      <p class="sub">Your choices are saved. New events will start syncing on the next run.</p>
    `,
  });
}

/**
 * Schema-driven configuration form for any integration that declares a
 * configuration contract. Field controls follow the declared type:
 * checkbox for boolean, number input for number, select for a closed
 * value set (including one derived from target_types), text otherwise.
 * A string_array renders as comma-separated text — the generic surface
 * favors working everywhere over per-integration polish, which a
 * bespoke page like the calendar picker can still add on top.
 */
export function renderGenericConfigureForm(
  connectionId: string,
  manifest: IntegrationManifestShape,
  current: Record<string, unknown>,
): string {
  const schema = manifest.configuration_schema ?? {};
  const rows = Object.entries(schema)
    .map(([key, spec]) => {
      const value = current[key];
      const allowed = spec.from_target_types
        ? manifest.target_types
        : spec.values;
      let control: string;
      if (spec.type === "boolean") {
        control = `<input type="checkbox" name="${esc(key)}" value="true"${value === true ? " checked" : ""}>`;
      } else if (allowed) {
        const opts = allowed
          .map(
            (v) =>
              `<option value="${esc(v)}"${value === v ? " selected" : ""}>${esc(v)}</option>`,
          )
          .join("");
        control = `<select name="${esc(key)}">${opts}</select>`;
      } else if (spec.type === "number") {
        control = `<input type="number" name="${esc(key)}" value="${typeof value === "number" ? String(value) : ""}">`;
      } else if (spec.type === "string_array") {
        const joined = Array.isArray(value) ? value.join(", ") : "";
        control = `<input type="text" name="${esc(key)}" value="${esc(joined)}" placeholder="comma-separated">`;
      } else {
        control = `<input type="text" name="${esc(key)}" value="${typeof value === "string" ? esc(value) : ""}"${spec.required ? " required" : ""}>`;
      }
      return `<label class="field"><span class="field-name">${esc(key)}${spec.required ? " *" : ""}</span><span class="field-desc">${esc(spec.description)}</span>${control}</label>`;
    })
    .join("\n");
  return renderAuthLayout({
    title: "Configure connection",
    wide: true,
    bodyHtml: `      <h1 class="title">Configure ${esc(manifest.name)}</h1>
      <form method="post" action="/connections/${esc(connectionId)}/configure">
        ${rows}
        <button type="submit" class="btn btn--primary">Save configuration</button>
      </form>
    `,
  });
}

/**
 * Coerce a submitted form back to the declared configuration types. HTML
 * forms deliver strings; the declared spec says what each key really is.
 * An unchecked checkbox sends nothing, which reads as false.
 */
export function parseGenericConfigurePayload(
  form: Record<string, unknown>,
  schema: Record<string, ConfigurationFieldSpec>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, spec] of Object.entries(schema)) {
    const raw = form[key];
    if (spec.type === "boolean") {
      out[key] = raw === "true" || raw === "on";
      continue;
    }
    if (raw === undefined || raw === "") continue;
    const first: unknown = Array.isArray(raw) ? raw[0] : raw;
    // Form values are strings; anything else (a file part) is not
    // configuration material and reads as absent.
    if (typeof first !== "string") continue;
    const text = first;
    if (spec.type === "number") {
      const n = Number(text);
      out[key] = Number.isFinite(n) ? n : text;
    } else if (spec.type === "string_array") {
      out[key] = text
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    } else {
      out[key] = text;
    }
  }
  return out;
}

/**
 * Shown when a connection reaches its configuration screen before the
 * upstream OAuth dance has run, so there is nothing yet to configure.
 *
 * This once redirected to a POST-only endpoint wanting a bearer credential
 * and a JSON body, which nothing following a redirect sends, so the page then
 * named the endpoint instead of jumping to it. There is a browser front door
 * now, so the page can do what it always wanted to: send the person on.
 */
export function renderConnectionNotAuthorized(connectionId: string): string {
  return renderAuthLayout({
    title: "Not authorized yet",
    centered: true,
    bodyHtml: `      <h1 class="title">Not authorized yet</h1>
      <p class="sub">There is nothing to configure until this connection has access to the other service.</p>
      <a href="/connections/${esc(connectionId)}/oauth/start" class="btn btn--primary">Authorize this connection</a>
    `,
  });
}

export function renderConfigureError(message: string): string {
  return renderAuthLayout({
    title: "Couldn't configure",
    centered: true,
    bodyHtml: `      <h1 class="title">Couldn't configure</h1>
      <p class="sub">${esc(message)}</p>
    `,
  });
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
 * Parse the form-encoded picker submission into a normalized payload.
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
  configuration_schema?: Record<string, ConfigurationFieldSpec>;
}

interface ConnectionPropertiesShape {
  kind?: string;
  integration_ref?: string;
  configuration?: Record<string, unknown>;
  space_id?: string;
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
    manifest?: {
      name?: string;
      target_types?: string[];
      configuration_schema?: Record<string, ConfigurationFieldSpec>;
    };
  };
  const manifest = integrationProps.manifest;
  if (!manifest || typeof manifest.name !== "string") return null;
  if (!Array.isArray(manifest.target_types)) return null;
  return {
    name: manifest.name,
    target_types: manifest.target_types,
    ...(manifest.configuration_schema !== undefined
      ? { configuration_schema: manifest.configuration_schema }
      : {}),
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
  spaceId: string | undefined;
}) => Promise<CalendarListEntry[]>;

export interface ConnectionConfigureOptions {
  fetchCalendars?: CalendarListFetcher;
  /** The identity layer, when the deployment has one. Absent leaves these
   *  surfaces bearer-only, which is what a keys-mode self-host gets. */
  auth?: MarfaAuth;
  /** Operator CORS origins, for the cross-origin guard on the form post. */
  corsOrigins?: readonly string[];
  /** Issuer URL, whose origin is where a post from a page this server
   *  rendered comes from. */
  authBaseUrl?: string;
}

export function connectionConfigureRoutes(
  storage: Storage,
  options: ConnectionConfigureOptions = {},
) {
  const r = new Hono<AppEnv>();
  const allowedOrigins = buildAllowedOrigins(
    options.corsOrigins ?? [],
    options.authBaseUrl,
  );

  const FORBIDDEN = "Space admin authority required to configure a connection";

  // Default fetcher does the proxy call out-of-process. Tests typically
  // override via `options.fetchCalendars` so the GET path renders
  // deterministically without re-entering the server's HTTP stack.
  const fetchCalendars: CalendarListFetcher =
    options.fetchCalendars ??
    // eslint-disable-next-line @typescript-eslint/require-await
    (async () => []);

  r.get("/:id/configure", async (c) => {
    const caller = await resolveSpaceAdminCaller(
      c,
      storage,
      options.auth,
      FORBIDDEN,
    );
    if (caller instanceof Response) return caller;
    const spaceId = caller.spaceId;
    const id = c.req.param("id");

    const connection = await storage.items.get(id, spaceId);
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

    // google.calendar keeps its bespoke picker; every other integration
    // that declares a configuration contract gets the schema-driven form.
    if (manifest.name !== "google.calendar") {
      if (
        manifest.configuration_schema &&
        Object.keys(manifest.configuration_schema).length > 0
      ) {
        const currentProps = connection.properties as ConnectionPropertiesShape;
        setNoStore(c);
        return c.html(
          renderGenericConfigureForm(
            id,
            manifest,
            currentProps.configuration ?? {},
          ),
        );
      }
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
    const tokens = await storage.connectionOauthTokens.get(id, spaceId);
    if (!tokens) {
      setNoStore(c);
      return c.html(renderConnectionNotAuthorized(id), 409);
    }

    let calendars: CalendarListEntry[];
    try {
      calendars = await fetchCalendars({ connectionId: id, spaceId });
    } catch (err) {
      // Keep the raw cause in the server log; show the user calm, curated copy
      // rather than the upstream error string.
      console.error("connection-configure: failed to load calendars", err);
      setNoStore(c);
      return c.html(
        renderConfigureError(
          "We couldn't load your calendars right now. This is usually temporary — try again in a moment. If it keeps happening, reconnect the integration.",
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
    // The manifest is the one statement of what this integration writes by
    // default. Falling back to the first offered type keeps the picker
    // renderable for a manifest that declares none; it is not a preference.
    // The schema requires at least one target type, so the last fallback is
    // for the type checker rather than a state a manifest can reach.
    const declaredTargetType =
      declaredConfigurationDefault(manifest, "target_type") ??
      manifest.target_types[0] ??
      "";

    setNoStore(c);
    return c.html(
      renderGoogleCalendarPicker({
        connectionId: id,
        calendars,
        targetTypeChoices: manifest.target_types,
        // Read from the manifest, not named here. A hardcoded preference
        // agrees with the declared default only by coincidence, and the
        // picker is where an operator learns what the integration intends.
        defaultTargetType: declaredTargetType,
        prior: {
          selectedCalendarIds: priorSelected,
          defaultWriteCalendarId: priorDefaultWrite,
          targetType: priorTargetType,
        },
      }),
    );
  });

  r.post("/:id/configure", async (c) => {
    // This post makes a durable write from a page a browser rendered, so it
    // carries the same origin fence the consent decision does rather than
    // resting on `SameSite=Lax` alone like the other session-gated posts. A
    // missing origin still passes: a same-origin form post may send neither
    // header.
    if (isCrossOriginPost(c.req.raw.headers, allowedOrigins)) {
      return c.text("Cross-origin configuration change rejected", 403);
    }
    const caller = await resolveSpaceAdminCaller(
      c,
      storage,
      options.auth,
      FORBIDDEN,
    );
    if (caller instanceof Response) return caller;
    const spaceId = caller.spaceId;
    const id = c.req.param("id");

    const connection = await storage.items.get(id, spaceId);
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

    // Same dispatch as the GET path: google.calendar keeps its picker,
    // any other integration with a declared contract takes the generic
    // path, and everything else is refused.
    if (manifest.name !== "google.calendar") {
      if (
        manifest.configuration_schema &&
        Object.keys(manifest.configuration_schema).length > 0
      ) {
        const form = await c.req.parseBody({ all: true });
        const payload = parseGenericConfigurePayload(
          form,
          manifest.configuration_schema,
        );
        const issues = validateConnectionConfiguration(manifest, payload);
        if (issues.length > 0) {
          setNoStore(c);
          return c.html(
            renderConfigureError(issues.map((i) => i.message).join(" ")),
            400,
          );
        }
        const genericProps = connection.properties as ConnectionPropertiesShape;
        await storage.items.update(
          id,
          {
            properties: {
              ...genericProps,
              configuration: {
                ...(genericProps.configuration ?? {}),
                ...payload,
              },
            },
          },
          spaceId,
        );
        void storage.audit.log({
          key_id: caller.apiKeyId,
          client_ip: c.get("clientIp") ?? null,
          space_id: spaceId ?? null,
          action: "connection.configure",
          resource_type: "item",
          resource_id: id,
          details: {
            manifest_name: manifest.name,
            keys: Object.keys(payload),
          },
        });
        setNoStore(c);
        return c.html(renderConfigureSuccess());
      }
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
    const parsed = parseConfigurePayload(form, validTargetTypes);
    if (!parsed.ok) {
      setNoStore(c);
      return c.html(renderConfigureError(parsed.error), 400);
    }

    const existingProps = connection.properties as ConnectionPropertiesShape;
    const existingCfg = existingProps.configuration ?? {};
    const mergedConfiguration = {
      ...existingCfg,
      selected_calendar_ids: parsed.payload.selected_calendar_ids,
      default_write_calendar_id: parsed.payload.default_write_calendar_id,
      target_type: parsed.payload.target_type,
    };
    // The picker validates its own UI semantics; the declared contract is
    // still the authority on what may be written, through the same gate
    // every other configuration write passes.
    const contractIssues = validateConnectionConfiguration(
      manifest,
      mergedConfiguration,
    );
    if (contractIssues.length > 0) {
      setNoStore(c);
      return c.html(
        renderConfigureError(contractIssues.map((i) => i.message).join(" ")),
        400,
      );
    }
    const newProps = {
      ...existingProps,
      configuration: mergedConfiguration,
    };
    await storage.items.update(id, { properties: newProps }, spaceId);

    void storage.audit.log({
      key_id: caller.apiKeyId,
      client_ip: c.get("clientIp") ?? null,
      space_id: spaceId ?? null,
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
    return c.html(renderConfigureSuccess());
  });

  return r;
}
