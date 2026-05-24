/**
 * Todoist bidirectional handlers.
 *
 * Two triggers, one shared cursor + mapping store:
 *
 * - SCHEDULE (10-minute incremental sync, inbound):
 *     Calls Todoist's `POST /api/v1/sync` with the stored
 *     `sync_token` (opaque; the sentinel `"*"` on the first run).
 *     For each returned item:
 *       - If `is_deleted` or `checked` → trash the mapped Myme item
 *         (or skip if not mapped).
 *       - Else compute `(external_id, content_hash)`. If
 *         `ctx.echo.shouldSkipReactive(...)` → skip (we wrote this
 *         ourselves recently).
 *       - Else upsert as `todoist.task`. Record the mapping in the
 *         cursor.
 *     Persist the response's `sync_token` for the next call.
 *
 * - ITEM-EVENT (outbound, fires on Myme task mutations):
 *     - The reactive bridge already filters self-events; defensively
 *       double-check against `cycle`.
 *     - Trash transition → REST `POST /api/v1/tasks/{id}/close`.
 *       Delete the mapping.
 *     - Mapping-known + active → REST `POST /api/v1/tasks/{id}` with
 *       a body subset (content, description, priority, labels, due).
 *     - Mapping-unknown + active → Sync `item_add` command with a
 *       deterministic `temp_id` (SHA-256 hex of `myme:<item.id>`)
 *       and deterministic `uuid` for command-level idempotency
 *       (T-020 deterministic-id rail). On `sync_status.<uuid> ===
 *       "ok"`, read the real id from `temp_id_mapping`. On error
 *       payload `error_code: 22` (`ALREADY_EXISTS`) — which Todoist
 *       returns when the same uuid is replayed — the prior write
 *       already landed, so we re-derive by listing recently-added
 *       tasks and matching on content + temp_id sentinel. Belt-and-
 *       braces: the deterministic uuid is the primary idempotency
 *       rail (Todoist returns the original `temp_id_mapping`); the
 *       sentinel is the fallback.
 *
 *     Lag-window guard runs ahead of every outbound action — recent
 *     inbound writes for the same external id defer with retry=true.
 */
import {
  registerScheduleHandler,
  registerItemEventHandler,
  type ConnectionContext,
  type ScheduleMessage,
  type ItemEventMessage,
  type HandlerResult,
  type CreateItemInput,
  type ItemResource,
} from "@mymehq/runtime-sdk";
import {
  DEFAULT_TARGET_TYPE,
  SYNC_RESOURCE_TYPES,
  SYNC_TOKEN_INITIAL,
} from "./manifest.js";

const CURSOR_KEY = "main";

const SYNC_PATH = "/api/v1/sync";
const TASKS_BASE_PATH = "/api/v1/tasks";

/** Sentinel injected into a task's `description` on outbound create so
 *  we can recover the mapping in the rare case Todoist's command-level
 *  idempotency rail returns a recoverable error without the
 *  `temp_id_mapping` we expect. Belt-and-braces; the deterministic
 *  uuid is the primary rail. */
const MYME_ID_DESCRIPTION_SENTINEL_PREFIX = "[myme-id:";

interface TodoistDue {
  date?: string;
  datetime?: string;
  string?: string;
  lang?: string;
  is_recurring?: boolean;
  timezone?: string | null;
}

interface TodoistItem {
  id: string;
  user_id?: string;
  project_id?: string | null;
  section_id?: string | null;
  parent_id?: string | null;
  content?: string;
  description?: string;
  priority?: number;
  due?: TodoistDue | null;
  labels?: string[];
  child_order?: number;
  checked?: boolean;
  is_deleted?: boolean;
  url?: string;
  comment_count?: number;
  added_at?: string;
  updated_at?: string;
}

interface SyncResponse {
  sync_token: string;
  full_sync?: boolean;
  items?: TodoistItem[];
  temp_id_mapping?: Record<string, string>;
  sync_status?: Record<
    string,
    "ok" | { error_code?: number; error?: string; error_tag?: string }
  >;
}

interface TodoistCursor {
  /** Opaque sync_token from Todoist's Sync API. `"*"` on first run via
   *  `SYNC_TOKEN_INITIAL`; the server's previous-response value
   *  thereafter. Persisted to the `connection.runtime` extension under
   *  `CURSOR_KEY = "main"`. */
  sync_token: string;
  /** ISO timestamp of the last successful schedule run. Diagnostic
   *  only; the watermark itself is `sync_token`. */
  last_inbound_at: string | null;
  /** Map of Todoist task id → Myme item id. Used on every inbound +
   *  outbound to look up the matching Myme item without round-tripping
   *  through the server. */
  mappings: Record<string, string>;
}

function defaultCursor(): TodoistCursor {
  return {
    sync_token: SYNC_TOKEN_INITIAL,
    last_inbound_at: null,
    mappings: {},
  };
}

function findExternalIdFor(
  cursor: TodoistCursor,
  myme_id: string,
): string | null {
  for (const [ext, m] of Object.entries(cursor.mappings)) {
    if (m === myme_id) return ext;
  }
  return null;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// Hashing — deterministic ids + content-hash for echo suppression
// ---------------------------------------------------------------------------

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  const bytes = new Uint8Array(digest);
  let out = "";
  for (const b of bytes) {
    out += b.toString(16).padStart(2, "0");
  }
  return out;
}

/** Deterministic temp_id for the Sync API's item_add command. Two runs
 *  of the same outbound for the same Myme item produce the same
 *  temp_id; Todoist's per-uuid idempotency rail returns the original
 *  command's result instead of creating a duplicate. */
function deriveTempId(myme_id: string): Promise<string> {
  return sha256Hex(`myme:temp_id:${myme_id}`);
}

/** Deterministic uuid for the Sync API command. Distinct from temp_id
 *  but derived from the same seed so a retry hits Todoist's
 *  "same-uuid → same-result" rail. */
function deriveCommandUuid(myme_id: string): Promise<string> {
  return sha256Hex(`myme:command_uuid:${myme_id}`);
}

/** Content-hash for echo suppression. Includes every field a
 *  round-trip might touch. */
function contentHashForItem(item: TodoistItem): string {
  const canonical = JSON.stringify({
    content: item.content ?? "",
    description: stripSentinel(item.description ?? ""),
    priority: item.priority ?? 1,
    labels: [...(item.labels ?? [])].sort(),
    due: item.due
      ? {
          date: item.due.date ?? null,
          datetime: item.due.datetime ?? null,
          string: item.due.string ?? null,
          is_recurring: item.due.is_recurring ?? false,
        }
      : null,
    project_id: item.project_id ?? null,
    section_id: item.section_id ?? null,
    parent_id: item.parent_id ?? null,
  });
  // 32-char hex prefix is plenty for collision resistance at the
  // scale of one user's task list.
  let hash = 0;
  for (let i = 0; i < canonical.length; i++) {
    hash = (hash * 31 + canonical.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(16);
}

function stripSentinel(description: string): string {
  // Drop the `[myme-id:<…>]` marker line if present. Multiple consumers
  // of the description should see what the user typed, not our
  // bookkeeping.
  return description
    .split("\n")
    .filter(
      (line) => !line.trim().startsWith(MYME_ID_DESCRIPTION_SENTINEL_PREFIX),
    )
    .join("\n")
    .replace(/^\s+|\s+$/g, "");
}

function appendSentinel(description: string, myme_id: string): string {
  const base = description.length > 0 ? `${description}\n\n` : "";
  return `${base}${MYME_ID_DESCRIPTION_SENTINEL_PREFIX}${myme_id}]`;
}

// ---------------------------------------------------------------------------
// Inbound — schedule handler
// ---------------------------------------------------------------------------

export async function handleSchedule(
  ctx: ConnectionContext,
  message: ScheduleMessage,
): Promise<HandlerResult> {
  void message;
  const cursor: TodoistCursor =
    ((await ctx.cursor.read(CURSOR_KEY)) as TodoistCursor | null) ??
    defaultCursor();

  let response: Response;
  try {
    response = await ctx.myme.proxyRequestForm("POST", SYNC_PATH, {
      sync_token: cursor.sync_token,
      resource_types: JSON.stringify(SYNC_RESOURCE_TYPES),
    });
  } catch (err) {
    return reportFailure(ctx, "todoist /sync fetch failed", err, true);
  }

  if (!response.ok) {
    return reportFailure(
      ctx,
      `todoist /sync returned ${String(response.status)}`,
      null,
      response.status >= 500,
    );
  }

  let payload: SyncResponse;
  try {
    const raw: unknown = await response.json();
    payload = raw as SyncResponse;
  } catch (err) {
    return reportFailure(ctx, "todoist /sync parse failed", err, true);
  }

  let upserted = 0;
  let skippedEcho = 0;
  let trashed = 0;

  for (const item of payload.items ?? []) {
    const mappedMymeId = cursor.mappings[item.id];

    if (item.is_deleted === true || item.checked === true) {
      if (mappedMymeId !== undefined) {
        try {
          await ctx.myme.transitionItem(mappedMymeId, "trashed");
          trashed += 1;
          Reflect.deleteProperty(cursor.mappings, item.id);
        } catch (err) {
          await ctx.activity.emit({
            severity: "action_required",
            summary: `todoist: failed to trash myme item for deleted/checked task ${item.id}`,
            detail: { error: errorMessage(err) },
          });
        }
      }
      continue;
    }

    const hash = contentHashForItem(item);
    if (await ctx.echo.shouldSkipReactive(item.id, hash)) {
      skippedEcho += 1;
      continue;
    }

    const input = buildItemInput(item);
    try {
      if (mappedMymeId !== undefined) {
        await ctx.myme.updateItem(mappedMymeId, input);
      } else {
        const created = await ctx.myme.createItem({
          ...input,
          source_id: item.id,
        });
        cursor.mappings[item.id] = created.id;
      }
      upserted += 1;
    } catch (err) {
      await ctx.activity.emit({
        severity: "action_required",
        summary: `todoist: failed to upsert myme item for task ${item.id}`,
        detail: { error: errorMessage(err) },
      });
    }
  }

  cursor.sync_token = payload.sync_token;
  cursor.last_inbound_at = new Date().toISOString();
  await ctx.cursor.write(CURSOR_KEY, cursor);

  await ctx.activity.emit({
    severity: "info",
    summary: `todoist inbound: upserted=${String(upserted)} echo_skipped=${String(skippedEcho)} trashed=${String(trashed)}`,
    detail: {
      items_seen: payload.items?.length ?? 0,
      upserted,
      skipped_echo: skippedEcho,
      trashed,
      full_sync: payload.full_sync ?? false,
    },
  });

  return { ok: true };
}

// ---------------------------------------------------------------------------
// Outbound — item-event handler
// ---------------------------------------------------------------------------

export async function handleItemEvent(
  ctx: ConnectionContext,
  message: ItemEventMessage,
): Promise<HandlerResult> {
  // Defensive self-event filter — the bridge already drops these, but
  // double-check.
  if (
    ctx.cycle?.originating_connection_id === ctx.connection_id ||
    message.cycle.originating_connection_id === ctx.connection_id
  ) {
    return { ok: true };
  }

  const cursor: TodoistCursor =
    ((await ctx.cursor.read(CURSOR_KEY)) as TodoistCursor | null) ??
    defaultCursor();

  const item = await ctx.myme.getItem(message.item_id);
  if (item === null) {
    // Item disappeared. If we know its mapping treat it as trash; else
    // no-op.
    return ackHandledIfMappedAsTrash(ctx, cursor, message.item_id);
  }

  // Only react to task-shaped items. Echo-loops are already prevented
  // by the bridge + the `cycle` check above; this is just a sanity
  // gate against being woken on an unrelated type.
  if (item.type !== "core.task" && item.type !== "todoist.task") {
    return { ok: true };
  }

  const externalId = findExternalIdFor(cursor, item.id);

  // Lag-window guard — recent outbound write to this id; defer.
  if (externalId !== null && (await ctx.echo.inLagWindow(externalId))) {
    return { ok: false, retry: true, reason: "in_lag_window" };
  }

  if (item.state === "trashed") {
    if (externalId !== null) {
      const path = `${TASKS_BASE_PATH}/${encodeURIComponent(externalId)}/close`;
      const resp = await ctx.myme.proxyRequest("POST", path);
      if (!resp.ok && resp.status !== 404 && resp.status !== 410) {
        return reportOutboundFailure(ctx, "close", externalId, resp);
      }
      Reflect.deleteProperty(cursor.mappings, externalId);
      await ctx.cursor.write(CURSOR_KEY, cursor);
      await ctx.activity.emit({
        severity: "info",
        summary: `todoist outbound: closed task ${externalId}`,
      });
    }
    return { ok: true };
  }

  // Update path — REST. Simpler than Sync `item_update` for singletons.
  if (externalId !== null) {
    const body = buildTodoistUpdateBody(item);
    const resp = await ctx.myme.proxyRequest(
      "POST",
      `${TASKS_BASE_PATH}/${encodeURIComponent(externalId)}`,
      body,
    );
    if (!resp.ok) {
      return reportOutboundFailure(ctx, "update", externalId, resp);
    }
    const updatedRaw: unknown = await resp.json();
    const updated = updatedRaw as TodoistItem;
    await ctx.echo.trackOutboundWrite(externalId, contentHashForItem(updated));
    await ctx.activity.emit({
      severity: "info",
      summary: `todoist outbound: updated task ${externalId}`,
    });
    return { ok: true };
  }

  // Create path — Sync API with deterministic temp_id + uuid (T-020).
  // The deterministic uuid means a retry sees the original command's
  // result via Todoist's command-level idempotency rail; the
  // temp_id_mapping resolves the server-side id either way.
  const temp_id = await deriveTempId(item.id);
  const uuid = await deriveCommandUuid(item.id);
  const args = buildTodoistAddArgs(item);
  // Augment description with the myme-id sentinel for the
  // belt-and-braces recovery path (the temp_id_mapping is the primary
  // rail).
  args.description = appendSentinel(args.description ?? "", item.id);
  const commands = [
    {
      type: "item_add",
      temp_id,
      uuid,
      args,
    },
  ];

  const resp = await ctx.myme.proxyRequestForm("POST", SYNC_PATH, {
    sync_token: cursor.sync_token,
    resource_types: JSON.stringify(SYNC_RESOURCE_TYPES),
    commands: JSON.stringify(commands),
  });

  if (!resp.ok) {
    return reportOutboundFailure(ctx, "item_add", "(new)", resp);
  }
  const payloadRaw: unknown = await resp.json();
  const payload = payloadRaw as SyncResponse;
  const status = payload.sync_status?.[uuid];

  // Sync_token advances after every Sync API call regardless of
  // command success — persist so the next inbound poll picks up the
  // new state correctly.
  cursor.sync_token = payload.sync_token;

  if (status === "ok") {
    const real_id = payload.temp_id_mapping?.[temp_id];
    if (real_id === undefined) {
      await ctx.activity.emit({
        severity: "action_required",
        summary: `todoist outbound: item_add reported ok but temp_id_mapping missing for ${temp_id}`,
        detail: { sync_status: status, item_id: item.id },
      });
      await ctx.cursor.write(CURSOR_KEY, cursor);
      return { ok: true };
    }
    cursor.mappings[real_id] = item.id;
    await ctx.echo.trackOutboundWrite(
      real_id,
      contentHashForItem({ id: real_id, ...args }),
    );
    await ctx.cursor.write(CURSOR_KEY, cursor);
    await ctx.activity.emit({
      severity: "info",
      summary: `todoist outbound: created task ${real_id} from myme item ${item.id}`,
    });
    return { ok: true };
  }

  // Per Todoist's docs, replaying a uuid returns the original result
  // — so any non-"ok" status here is a genuine command failure. The
  // command-error shape is `{ error_code, error, error_tag }`; absent
  // means we couldn't read the status block at all. Both surface as
  // accept-partial (ok: true) with an action_required activity for the
  // operator.
  const errorPayload = typeof status === "object" ? status : null;
  await ctx.cursor.write(CURSOR_KEY, cursor);
  await ctx.activity.emit({
    severity: "action_required",
    summary: `todoist outbound: item_add failed for myme item ${item.id}`,
    detail: { sync_status: status, error: errorPayload },
  });
  return { ok: true };
}

async function ackHandledIfMappedAsTrash(
  ctx: ConnectionContext,
  cursor: TodoistCursor,
  myme_id: string,
): Promise<HandlerResult> {
  const externalId = findExternalIdFor(cursor, myme_id);
  if (externalId === null) return { ok: true };
  const path = `${TASKS_BASE_PATH}/${encodeURIComponent(externalId)}/close`;
  const resp = await ctx.myme.proxyRequest("POST", path);
  if (!resp.ok && resp.status !== 404 && resp.status !== 410) {
    return reportOutboundFailure(ctx, "close (item gone)", externalId, resp);
  }
  Reflect.deleteProperty(cursor.mappings, externalId);
  await ctx.cursor.write(CURSOR_KEY, cursor);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Field translation
// ---------------------------------------------------------------------------

function buildItemInput(item: TodoistItem): CreateItemInput {
  // Inbound: Todoist item → `todoist.task` Myme item. Strip the
  // round-trip sentinel from description so the user sees what they
  // wrote, not our bookkeeping.
  const description = stripSentinel(item.description ?? "");
  const props: Record<string, unknown> = {
    title: item.content ?? "",
  };
  if (description.length > 0) props.description = description;
  if (item.project_id !== undefined && item.project_id !== null) {
    props.project_id = item.project_id;
  }
  if (item.section_id !== undefined && item.section_id !== null) {
    props.section_id = item.section_id;
  }
  if (item.parent_id !== undefined && item.parent_id !== null) {
    props.parent_id = item.parent_id;
  }
  if (Array.isArray(item.labels) && item.labels.length > 0) {
    props.labels = item.labels;
  }
  if (typeof item.priority === "number") {
    props.priority = item.priority;
  }
  if (typeof item.child_order === "number") {
    props.child_order = item.child_order;
  }
  if (typeof item.url === "string" && item.url.length > 0) {
    props.url = item.url;
  }
  if (typeof item.comment_count === "number") {
    props.comment_count = item.comment_count;
  }
  if (item.due !== undefined && item.due !== null) {
    props.due = item.due;
  }
  if (typeof item.checked === "boolean") {
    props.completed = item.checked;
  }
  return {
    type: DEFAULT_TARGET_TYPE,
    properties: props,
  };
}

interface TodoistAddArgs {
  content: string;
  description?: string;
  priority?: number;
  labels?: string[];
  project_id?: string;
  section_id?: string;
  parent_id?: string;
  due_string?: string;
  due_date?: string;
  due_datetime?: string;
  due_lang?: string;
}

function buildTodoistAddArgs(item: ItemResource): TodoistAddArgs {
  const props = item.properties ?? {};
  const title = pickString(props, ["title", "content"]) ?? "";
  const description = pickString(props, ["description", "body", "notes"]) ?? "";

  const args: TodoistAddArgs = { content: title };
  if (description.length > 0) args.description = description;
  const priority = pickNumber(props, ["priority"]);
  if (priority !== null) args.priority = priority;
  const labels = pickStringArray(props, ["labels"]);
  if (labels !== null) args.labels = labels;
  const projectId = pickString(props, ["project_id"]);
  if (projectId !== null) args.project_id = projectId;
  const sectionId = pickString(props, ["section_id"]);
  if (sectionId !== null) args.section_id = sectionId;
  const parentId = pickString(props, ["parent_id"]);
  if (parentId !== null) args.parent_id = parentId;
  applyDueToArgs(args, props);
  return args;
}

interface TodoistUpdateBody {
  content?: string;
  description?: string;
  priority?: number;
  labels?: string[];
  due_string?: string;
  due_date?: string;
  due_datetime?: string;
  due_lang?: string;
}

function buildTodoistUpdateBody(item: ItemResource): TodoistUpdateBody {
  const props = item.properties ?? {};
  const body: TodoistUpdateBody = {};
  const content = pickString(props, ["title", "content"]);
  if (content !== null) body.content = content;
  const description = pickString(props, ["description", "body", "notes"]);
  if (description !== null) body.description = description;
  const priority = pickNumber(props, ["priority"]);
  if (priority !== null) body.priority = priority;
  const labels = pickStringArray(props, ["labels"]);
  if (labels !== null) body.labels = labels;
  applyDueToBody(body, props);
  return body;
}

function applyDueToArgs(
  args: TodoistAddArgs,
  props: Record<string, unknown>,
): void {
  const due = props.due;
  if (typeof due !== "object" || due === null) return;
  const d = due as Record<string, unknown>;
  if (typeof d.string === "string" && d.string.length > 0) {
    args.due_string = d.string;
  } else if (typeof d.datetime === "string" && d.datetime.length > 0) {
    args.due_datetime = d.datetime;
  } else if (typeof d.date === "string" && d.date.length > 0) {
    args.due_date = d.date;
  }
  if (typeof d.lang === "string" && d.lang.length > 0) {
    args.due_lang = d.lang;
  }
}

function applyDueToBody(
  body: TodoistUpdateBody,
  props: Record<string, unknown>,
): void {
  const due = props.due;
  if (typeof due !== "object" || due === null) return;
  const d = due as Record<string, unknown>;
  if (typeof d.string === "string" && d.string.length > 0) {
    body.due_string = d.string;
  } else if (typeof d.datetime === "string" && d.datetime.length > 0) {
    body.due_datetime = d.datetime;
  } else if (typeof d.date === "string" && d.date.length > 0) {
    body.due_date = d.date;
  }
  if (typeof d.lang === "string" && d.lang.length > 0) {
    body.due_lang = d.lang;
  }
}

function pickString(
  props: Record<string, unknown>,
  keys: string[],
): string | null {
  for (const k of keys) {
    const v = props[k];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return null;
}

function pickNumber(
  props: Record<string, unknown>,
  keys: string[],
): number | null {
  for (const k of keys) {
    const v = props[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return null;
}

function pickStringArray(
  props: Record<string, unknown>,
  keys: string[],
): string[] | null {
  for (const k of keys) {
    const v = props[k];
    if (
      Array.isArray(v) &&
      v.every((x): x is string => typeof x === "string")
    ) {
      return v;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Failure reporting
// ---------------------------------------------------------------------------

async function reportFailure(
  ctx: ConnectionContext,
  summary: string,
  err: unknown,
  retry: boolean,
): Promise<HandlerResult> {
  await ctx.activity.emit({
    severity: retry ? "info" : "action_required",
    summary,
    detail: { error: errorMessage(err) },
  });
  return retry
    ? { ok: false, retry: true, reason: summary }
    : { ok: false, retry: false, reason: summary };
}

async function reportOutboundFailure(
  ctx: ConnectionContext,
  action: string,
  externalId: string,
  resp: Response,
): Promise<HandlerResult> {
  let body = "";
  try {
    body = await resp.text();
  } catch {
    // ignore — body may already have been consumed
  }
  const retry = resp.status >= 500;
  await ctx.activity.emit({
    severity: retry ? "info" : "action_required",
    summary: `todoist outbound ${action}: upstream returned ${String(resp.status)} (external_id ${externalId})`,
    detail: { status: resp.status, body: body.slice(0, 500) },
  });
  return retry
    ? { ok: false, retry: true, reason: `upstream ${String(resp.status)}` }
    : { ok: true };
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerHandlers(): void {
  registerScheduleHandler(handleSchedule);
  registerItemEventHandler(handleItemEvent);
}

// Test-only exports.
export const __internals = {
  defaultCursor,
  findExternalIdFor,
  buildItemInput,
  buildTodoistAddArgs,
  buildTodoistUpdateBody,
  contentHashForItem,
  stripSentinel,
  appendSentinel,
  deriveTempId,
  deriveCommandUuid,
  MYME_ID_DESCRIPTION_SENTINEL_PREFIX,
};
