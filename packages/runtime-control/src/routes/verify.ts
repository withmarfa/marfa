import { Hono } from "hono";
import type { ControlPlaneEnv } from "../env.js";
import { MymeServerClient } from "../myme-client.js";

/**
 * Synchronous verify-route (T-082).
 *
 *   POST /connections/:connection_id/verify
 *     body: {
 *       event: {
 *         item_id: string,
 *         event_type: string (e.g. "item.created"),
 *         payload?: unknown,
 *         cycle?: { originating_connection_id?: string | null, hop_count?: number },
 *       }
 *     }
 *
 *   Response shape (matches the T-082 ticket's "What" section):
 *     {
 *       ok: boolean,
 *       handler_result: HandlerResult,
 *       activity_emitted: SystemActivityRow[],
 *       items_created: string[],
 *       envelope_used: QueueMessageBody,
 *     }
 *
 * Auth gate: the operator's bearer must be a platform credential
 * (`is_platform: true`). The gate is enforced by forwarding the bearer
 * to the server's `GET /system/connections/:id/verify-context` endpoint
 * — that endpoint already gates on `is_platform: true` (matching the
 * pattern at `packages/server/src/routes/runtime-credentials.ts:30`).
 *
 * Dispatch path:
 *   1. Look up the connection's integration_name + tenant_id via the
 *      verify-context endpoint (also validates kind + active).
 *   2. Synthesise the queue-message envelope. The shape mirrors
 *      `packages/server/src/connections/envelope.ts:buildQueueMessageBody`
 *      — kept inline here because runtime-control doesn't depend on the
 *      server package, and the wire shape is what every per-Integration
 *      Worker consumes (high stability, low drift risk).
 *   3. Resolve the integration's service binding and POST `/verify`
 *      with the envelope — the SDK's `verifyHandler` runs the
 *      registered handler synchronously and returns its result.
 *   4. Poll `system.activity` for rows tagged with the connection,
 *      since the dispatch timestamp.
 *   5. Surface the combined response.
 *
 * Persistence is real — verify executes a real handler invocation. No
 * dry-run mode (preview-event covers static envelope rendering).
 */

interface VerifyEnvelope {
  kind: "item-event";
  integration_name: string;
  connection_id: string;
  tenant_id?: string;
  event_type: string;
  item_id: string;
  cycle: {
    originating_connection_id: string | null;
    hop_count: number;
  };
  payload: unknown;
}

interface VerifyEventInput {
  item_id?: string;
  event_type?: string;
  payload?: unknown;
  cycle?: {
    originating_connection_id?: string | null;
    hop_count?: number;
  };
}

interface IntegrationVerifyResponse {
  ok: boolean;
  handler_result: { ok: true } | { ok: false; retry: boolean; reason: string };
  envelope_used: VerifyEnvelope;
}

interface ActivityRow {
  id: string;
  properties?: Record<string, unknown>;
  created_at?: string;
}

/** Mirrors `packages/server/src/connections/envelope.ts:buildQueueMessageBody`.
 *  Lives inline because runtime-control doesn't (and shouldn't) depend
 *  on the server package — the envelope is a stable wire shape every
 *  per-Integration Worker consumes, so a parallel implementation here
 *  is the lower-coupling option than wiring up a workspace dep just for
 *  this one helper. Shape drift is caught by `verifyHandler`'s
 *  `integration_name` filter and the dispatcher's kind-switch. */
function buildVerifyEnvelope(args: {
  integrationName: string;
  connectionId: string;
  tenantId: string | null;
  eventType: string;
  itemId: string;
  payload: unknown;
  cycle: { originating_connection_id: string | null; hop_count: number };
}): VerifyEnvelope {
  return {
    kind: "item-event",
    integration_name: args.integrationName,
    connection_id: args.connectionId,
    ...(args.tenantId !== null && { tenant_id: args.tenantId }),
    event_type: args.eventType,
    item_id: args.itemId,
    cycle: args.cycle,
    payload: args.payload,
  };
}

/** Map a manifest-name to its service binding. Mirrors the same switch
 *  in `arm-schedule.ts`; the bounded-set assumption is documented on
 *  `env.ts`. */
function resolveServiceBinding(
  env: ControlPlaneEnv,
  integrationName: string,
): { fetch(request: Request): Promise<Response> } | undefined {
  switch (integrationName) {
    case "mymehq.rss-watcher":
      return env.INTEGRATION_RSS_WATCHER;
    case "mymehq.github-webhooks":
      return env.INTEGRATION_GITHUB_WEBHOOKS;
    case "mymehq.task-auto-archive":
      return env.INTEGRATION_TASK_AUTO_ARCHIVE;
    case "google.calendar":
      return env.INTEGRATION_GOOGLE_CALENDAR;
    case "google.tasks":
      return env.INTEGRATION_GOOGLE_TASKS;
    case "google.drive":
      return env.INTEGRATION_GOOGLE_DRIVE;
    default:
      return undefined;
  }
}

export function registerVerifyRoute(
  app: Hono<{ Bindings: ControlPlaneEnv }>,
): void {
  app.post("/connections/:connection_id/verify", async (c) => {
    const connectionId = c.req.param("connection_id");

    if (!c.env.MYME_API_URL) {
      return c.json(
        {
          error: "control_plane_misconfigured",
          message: "MYME_API_URL must be set.",
        },
        503,
      );
    }

    const auth = c.req.header("authorization");
    if (!auth?.startsWith("Bearer ")) {
      return c.json({ error: "unauthorized" }, 401);
    }
    const operatorBearer = auth.slice("Bearer ".length).trim();
    if (operatorBearer.length === 0) {
      return c.json({ error: "unauthorized" }, 401);
    }

    let body: { event?: VerifyEventInput };
    try {
      body = await c.req.json<{ event?: VerifyEventInput }>();
    } catch {
      return c.json({ error: "invalid_json" }, 400);
    }
    const event = body.event;
    if (!event || typeof event !== "object") {
      return c.json(
        {
          error: "missing_event",
          message: "Request body must include `event`.",
        },
        400,
      );
    }
    if (typeof event.item_id !== "string" || event.item_id.length === 0) {
      return c.json({ error: "missing_event_field", field: "item_id" }, 400);
    }
    if (typeof event.event_type !== "string" || event.event_type.length === 0) {
      return c.json({ error: "missing_event_field", field: "event_type" }, 400);
    }

    const myme = new MymeServerClient(
      c.env.MYME_API_URL,
      // Broker key is unused on the verify path — the verify-context +
      // activity polling calls go through the operator's bearer so the
      // server's is_platform gate enforces against the operator, not the
      // broker. Pass an empty string; the helper only uses it on calls
      // that explicitly use `this.brokerKey` (mintRuntimeCredential et al).
      "",
    );

    // 1. Validate connection exists, kind=integration, status=active +
    //    enforce is_platform: true (the verify-context endpoint gates).
    const ctxResult = await myme.getVerifyContext(connectionId, operatorBearer);
    if (!ctxResult.ok) {
      // Forward the upstream status (401/403/404/400) verbatim. Anything
      // else is treated as a 502 — runtime-control couldn't talk to its
      // upstream.
      const status = ctxResult.status;
      const code =
        status === 401
          ? "unauthorized"
          : status === 403
            ? "forbidden"
            : status === 404
              ? "connection_not_found"
              : status === 400
                ? "connection_invalid"
                : "upstream_error";
      const httpStatus =
        status === 401 || status === 403 || status === 404 || status === 400
          ? status
          : 502;
      return c.json({ error: code, message: ctxResult.message }, httpStatus);
    }

    // 2. Build the synthetic envelope.
    const cycleInput = event.cycle ?? {};
    const envelope = buildVerifyEnvelope({
      integrationName: ctxResult.integration_name,
      connectionId: ctxResult.connection_id,
      tenantId: ctxResult.tenant_id,
      eventType: event.event_type,
      itemId: event.item_id,
      payload: event.payload ?? null,
      cycle: {
        originating_connection_id: cycleInput.originating_connection_id ?? null,
        hop_count: cycleInput.hop_count ?? 0,
      },
    });

    // 3. Dispatch via service binding.
    const binding = resolveServiceBinding(c.env, ctxResult.integration_name);
    if (!binding) {
      return c.json(
        {
          error: "no_service_binding",
          message: `No service binding declared for integration ${ctxResult.integration_name}. The bounded-set assumption (see env.ts) means new integrations need an entry in wrangler.control.toml AND in resolveServiceBinding.`,
          integration_name: ctxResult.integration_name,
        },
        503,
      );
    }

    // Dispatch timestamp — used to scope the activity poll to rows
    // emitted by THIS verify run. Tightened by 1 second to absorb
    // clock skew between the control plane and the server.
    const dispatchTimestampMs = Date.now() - 1000;
    const dispatchTimestampIso = new Date(dispatchTimestampMs).toISOString();

    let dispatchRes: Response;
    try {
      dispatchRes = await binding.fetch(
        new Request("https://integration.invalid/verify", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ envelope }),
        }),
      );
    } catch (err) {
      return c.json(
        {
          error: "binding_fetch_failed",
          message: err instanceof Error ? err.message : String(err),
        },
        502,
      );
    }
    if (!dispatchRes.ok) {
      const text = await dispatchRes.text();
      return c.json(
        {
          error: "dispatch_failed",
          status: dispatchRes.status,
          body: text.slice(0, 1024),
        },
        502,
      );
    }

    let dispatchBody: IntegrationVerifyResponse;
    try {
      dispatchBody = await dispatchRes.json();
    } catch (err) {
      return c.json(
        {
          error: "dispatch_response_invalid",
          message: err instanceof Error ? err.message : String(err),
        },
        502,
      );
    }

    // 4. Poll system.activity for rows tagged with the connection,
    //    since dispatch. Single fetch — the handler ran synchronously,
    //    so anything it emitted via `ctx.activity.emit(...)` should be
    //    written by now. A second poll with a small delay would be
    //    belt-and-braces but adds latency and complexity for a debug
    //    surface; keep it lean and let the operator re-run if the
    //    activity sink lagged.
    let activity: ActivityRow[];
    try {
      const rows = await myme.listActivitySince(
        connectionId,
        dispatchTimestampIso,
        operatorBearer,
      );
      activity = rows as ActivityRow[];
    } catch (err) {
      // Don't fail the whole verify because the poll fell over — the
      // handler result is still useful. Surface the poll error in the
      // response so the operator can see what happened.
      return c.json({
        ok: dispatchBody.ok,
        handler_result: dispatchBody.handler_result,
        activity_emitted: [] as ActivityRow[],
        activity_poll_error: err instanceof Error ? err.message : String(err),
        items_created: [],
        envelope_used: envelope,
      });
    }

    // 5. Items created — derive from activity rows where the row's
    //    `properties.detail.created_item_ids` (or similar) carries them.
    //    Today no in-tree connector emits this shape on its
    //    `system.activity` writes, so the field is reserved as a future
    //    extension point. Surface as an empty array now; populate when
    //    the connector contract grows the field.
    const itemsCreated: string[] = [];

    return c.json({
      ok: dispatchBody.ok,
      handler_result: dispatchBody.handler_result,
      activity_emitted: activity,
      items_created: itemsCreated,
      envelope_used: envelope,
    });
  });
}
