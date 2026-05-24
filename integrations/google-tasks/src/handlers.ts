/**
 * Google Tasks bidirectional handlers.
 *
 * Two triggers, one shared echo-suppression + mapping store. The Tasks
 * API differs from Calendar in three operationally significant ways:
 *
 *   - **No `syncToken`.** Tasks' `tasks.list` uses `updatedMin` (ISO
 *     timestamp) as the incremental watermark. Each task list carries
 *     its own watermark in the cursor — wider Drive-style `startPageToken`
 *     doesn't apply.
 *   - **No `channels.watch`.** Tasks API publishes no push-notification
 *     surface. The schedule trigger (every 10 minutes) is the only
 *     inbound rail. No webhook handler is registered.
 *   - **No client-supplied IDs on insert.** Calendar's T-020 SHA-256-
 *     deterministic-id idempotency does not work on Tasks (Google
 *     rejects client `id` on `tasks.insert`). The idempotency rail
 *     here is a sentinel string in `notes` ("[myme-id:<itemId>]"); the
 *     handler scans the target list for an existing task carrying the
 *     sentinel before issuing a fresh insert, so a retry mid-handler
 *     recovers the mapping rather than creating a duplicate.
 *
 * SCHEDULE (inbound):
 *   - List every task list under the connected account
 *     (`GET /users/@me/lists`).
 *   - For each task list, call `tasks.list?updatedMin=<watermark>&showDeleted=true&showHidden=true`.
 *   - For each returned task:
 *       - `deleted: true` → trash the matching Myme item (tombstone-map).
 *       - Otherwise compute `(external_id, content_hash)`. If
 *         echo.shouldSkipReactive(...) → skip (we wrote this ourselves
 *         recently).
 *       - Else upsert as the configured target type.
 *   - Advance the per-list watermark to `max(seen_updated) - guard_window`
 *     so the next poll catches the boundary edits without re-reading
 *     everything.
 *
 * ITEM-EVENT (outbound, fires on Myme target-type mutations):
 *   - Defensive self-event filter against `cycle`.
 *   - If we're inside the lag window for this external_id, defer.
 *   - For created items: search the target list for the
 *     `[myme-id:<itemId>]` sentinel. If found, record the mapping
 *     idempotently (handler retry recovery). Else POST to `tasks.insert`.
 *   - For updated items: PATCH the Tasks resource referenced by the
 *     mapping.
 *   - For trashed-state transitions: DELETE the Tasks resource.
 *   - On Tasks 4xx (non-recoverable): surface as `system.activity`
 *     action_required (per partial_write_mode: accept-partial).
 *   - On Tasks 5xx: return retry=true.
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
import { TASKS_API_BASE, DEFAULT_TARGET_TYPE } from "./manifest.js";

const CURSOR_KEY = "main";

/** The Tasks API's clock-skew guard: poll boundary uses
 *  `updatedMin = lastSeenUpdated - WATERMARK_GUARD_MS` so an edit
 *  landing in the same millisecond as the boundary is still picked up
 *  on the next sweep. One second is generous for the public API. */
const WATERMARK_GUARD_MS = 1_000;

/** Initial-backfill page size. Tasks API tops out at 100. */
const TASKS_PAGE_SIZE = 100;

/** Hard cap on idempotency-search pages — 4 pages × 100 = 400 tasks
 *  before we give up. Above realistic personal task list size; the
 *  worst case is a single duplicate insert if a Connection has a
 *  pathologically large task list AND a mid-handler crash mid-create. */
const SENTINEL_SEARCH_PAGE_LIMIT = 4;

/** Default-write task list — the user's primary list when configuration
 *  doesn't override it. `@default` is the Tasks API's own alias for the
 *  primary list and resolves the same as the actual id. */
const DEFAULT_TASK_LIST_ID = "@default";

interface TasksCursor {
  /** Map of Tasks `task.id` → Myme item id. Flat shape — the per-list
   *  context lives alongside in `mapping_lists`. */
  mappings: Record<string, string>;
  /** Per-task task list id, so updates and deletes route back to the
   *  correct list. Tasks API is list-scoped on every CRUD verb. */
  mapping_lists: Record<string, string>;
  /** Per-list watermark (ISO timestamp). The next inbound sweep passes
   *  this as `updatedMin`. */
  per_list: Record<
    string,
    { updated_min: string | null; last_inbound_at: string | null }
  >;
  /** ISO timestamp of the last successful schedule run (diagnostic only). */
  last_inbound_at: string | null;
}

interface ConnectionConfig {
  /** Single list to write new outbound tasks into. */
  default_write_task_list_id: string;
  /** When non-empty, restrict inbound polling to this allowlist. When
   *  empty, the handler discovers every task list under the account
   *  on each sweep (the Tasks API caps lists at a few dozen per
   *  account; iteration is cheap). */
  selected_task_list_ids: string[];
  /** Target type for inbound items. Default `google.tasks.task` for
   *  upstream fidelity. */
  target_type: string;
}

async function resolveConnectionConfig(
  ctx: ConnectionContext,
): Promise<ConnectionConfig> {
  try {
    const connection = await ctx.myme.getItem(ctx.connection_id);
    const props = connection?.properties as
      | { configuration?: Record<string, unknown> }
      | undefined;
    const cfg = props?.configuration ?? {};
    const rawSelected = cfg.selected_task_list_ids;
    const selected: string[] = Array.isArray(rawSelected)
      ? rawSelected.filter((v): v is string => typeof v === "string")
      : [];
    const defaultWrite =
      typeof cfg.default_write_task_list_id === "string" &&
      cfg.default_write_task_list_id.length > 0
        ? cfg.default_write_task_list_id
        : DEFAULT_TASK_LIST_ID;
    const targetType =
      typeof cfg.target_type === "string" && cfg.target_type.length > 0
        ? cfg.target_type
        : DEFAULT_TARGET_TYPE;
    return {
      default_write_task_list_id: defaultWrite,
      selected_task_list_ids: selected,
      target_type: targetType,
    };
  } catch {
    return {
      default_write_task_list_id: DEFAULT_TASK_LIST_ID,
      selected_task_list_ids: [],
      target_type: DEFAULT_TARGET_TYPE,
    };
  }
}

interface TasksTaskResource {
  id: string;
  title?: string;
  notes?: string;
  status?: "needsAction" | "completed";
  due?: string;
  completed?: string;
  updated?: string;
  position?: string;
  parent?: string;
  selfLink?: string;
  webViewLink?: string;
  etag?: string;
  hidden?: boolean;
  deleted?: boolean;
}

interface TasksListResponse {
  items?: TasksTaskResource[];
  nextPageToken?: string;
}

interface TaskListResource {
  id: string;
  title?: string;
  updated?: string;
}

interface TaskListsListResponse {
  items?: TaskListResource[];
  nextPageToken?: string;
}

export async function handleSchedule(
  ctx: ConnectionContext,
  message: ScheduleMessage,
): Promise<HandlerResult> {
  void message;
  const config = await resolveConnectionConfig(ctx);
  const cursor: TasksCursor = ((await ctx.cursor.read(
    CURSOR_KEY,
  )) as TasksCursor | null) ?? {
    mappings: {},
    mapping_lists: {},
    per_list: {},
    last_inbound_at: null,
  };

  let listIds: string[];
  if (config.selected_task_list_ids.length > 0) {
    listIds = config.selected_task_list_ids;
  } else {
    const discovered = await discoverTaskLists(ctx);
    if (discovered === null) {
      return { ok: false, retry: true, reason: "tasklists.list failed" };
    }
    listIds = discovered;
  }

  let totalUpserted = 0;
  let totalSkippedEcho = 0;
  let totalTrashed = 0;
  const perListOutcomes: Record<
    string,
    { upserted: number; skipped: number; trashed: number }
  > = {};

  for (const listId of listIds) {
    const perList = cursor.per_list[listId] ?? {
      updated_min: null,
      last_inbound_at: null,
    };

    let pageToken: string | undefined;
    let upserted = 0;
    let skippedEcho = 0;
    let trashed = 0;
    let maxSeenUpdated: string | null = null;

    do {
      const params = new URLSearchParams();
      params.set("maxResults", String(TASKS_PAGE_SIZE));
      params.set("showDeleted", "true");
      params.set("showHidden", "true");
      params.set("showCompleted", "true");
      if (perList.updated_min !== null) {
        params.set("updatedMin", perList.updated_min);
      }
      if (pageToken !== undefined) params.set("pageToken", pageToken);
      const path = `${TASKS_API_BASE}/lists/${encodeURIComponent(listId)}/tasks?${params.toString()}`;

      let response: Response;
      try {
        response = await ctx.myme.proxyRequest("GET", path);
      } catch (err) {
        await ctx.activity.emit({
          severity: "action_required",
          summary: `google-tasks: tasks.list fetch failed for ${listId}`,
          detail: { error: errorMessage(err) },
        });
        break;
      }

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        await ctx.activity.emit({
          severity: "action_required",
          summary: `google-tasks: tasks.list returned ${String(response.status)} for ${listId}`,
          detail: {
            status: response.status,
            response_text: text.slice(0, 500),
          },
        });
        break;
      }

      let payload: TasksListResponse;
      try {
        payload = await response.json();
      } catch (err) {
        await ctx.activity.emit({
          severity: "action_required",
          summary: `google-tasks: tasks.list parse failed for ${listId}`,
          detail: { error: errorMessage(err) },
        });
        break;
      }

      for (const task of payload.items ?? []) {
        if (typeof task.updated === "string") {
          if (maxSeenUpdated === null || task.updated > maxSeenUpdated) {
            maxSeenUpdated = task.updated;
          }
        }

        const myme_id = cursor.mappings[task.id];
        if (task.deleted === true) {
          if (myme_id !== undefined) {
            try {
              await ctx.myme.transitionItem(myme_id, "trashed");
              trashed += 1;
              Reflect.deleteProperty(cursor.mappings, task.id);
              Reflect.deleteProperty(cursor.mapping_lists, task.id);
            } catch (err) {
              await ctx.activity.emit({
                severity: "action_required",
                summary: `google-tasks: trash failed for ${task.id}`,
                detail: { error: errorMessage(err) },
              });
            }
          }
          continue;
        }

        const hash = contentHashForTask(task);
        if (await ctx.echo.shouldSkipReactive(task.id, hash)) {
          skippedEcho += 1;
          continue;
        }

        const input = buildTaskInput(task, config.target_type, listId);
        try {
          if (myme_id !== undefined) {
            await ctx.myme.updateItem(myme_id, input);
          } else {
            const created = await ctx.myme.createItem({
              ...input,
              source_id: task.id,
            });
            cursor.mappings[task.id] = created.id;
            cursor.mapping_lists[task.id] = listId;
          }
          upserted += 1;
        } catch (err) {
          await ctx.activity.emit({
            severity: "action_required",
            summary: `google-tasks: upsert failed for task ${task.id}`,
            detail: { error: errorMessage(err) },
          });
        }
      }

      pageToken = payload.nextPageToken;
    } while (pageToken !== undefined);

    if (maxSeenUpdated !== null) {
      const advanced = new Date(
        Math.max(
          Date.parse(maxSeenUpdated) - WATERMARK_GUARD_MS,
          perList.updated_min !== null ? Date.parse(perList.updated_min) : 0,
        ),
      ).toISOString();
      perList.updated_min = advanced;
    } else {
      perList.updated_min ??= new Date(
        Date.now() - WATERMARK_GUARD_MS,
      ).toISOString();
    }
    perList.last_inbound_at = new Date().toISOString();
    cursor.per_list[listId] = perList;

    perListOutcomes[listId] = { upserted, skipped: skippedEcho, trashed };
    totalUpserted += upserted;
    totalSkippedEcho += skippedEcho;
    totalTrashed += trashed;
  }

  cursor.last_inbound_at = new Date().toISOString();
  await ctx.cursor.write(CURSOR_KEY, cursor);

  await ctx.activity.emit({
    severity: "info",
    summary: `google-tasks inbound: upserted=${String(totalUpserted)} echo_skipped=${String(totalSkippedEcho)} trashed=${String(totalTrashed)}`,
    detail: { lists_swept: listIds.length, per_list: perListOutcomes },
  });

  return { ok: true };
}

async function discoverTaskLists(
  ctx: ConnectionContext,
): Promise<string[] | null> {
  const ids: string[] = [];
  let pageToken: string | undefined;
  do {
    const params = new URLSearchParams();
    params.set("maxResults", "100");
    if (pageToken !== undefined) params.set("pageToken", pageToken);
    const path = `${TASKS_API_BASE}/users/@me/lists?${params.toString()}`;
    let resp: Response;
    try {
      resp = await ctx.myme.proxyRequest("GET", path);
    } catch (err) {
      await ctx.activity.emit({
        severity: "action_required",
        summary: "google-tasks: tasklists.list fetch failed",
        detail: { error: errorMessage(err) },
      });
      return null;
    }
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      await ctx.activity.emit({
        severity: "action_required",
        summary: `google-tasks: tasklists.list returned ${String(resp.status)}`,
        detail: { status: resp.status, response_text: text.slice(0, 500) },
      });
      return null;
    }
    let payload: TaskListsListResponse;
    try {
      payload = await resp.json();
    } catch (err) {
      await ctx.activity.emit({
        severity: "action_required",
        summary: "google-tasks: tasklists.list parse failed",
        detail: { error: errorMessage(err) },
      });
      return null;
    }
    for (const list of payload.items ?? []) {
      if (typeof list.id === "string") ids.push(list.id);
    }
    pageToken = payload.nextPageToken;
  } while (pageToken !== undefined);
  return ids;
}

export async function handleItemEvent(
  ctx: ConnectionContext,
  message: ItemEventMessage,
): Promise<HandlerResult> {
  if (
    ctx.cycle?.originating_connection_id === ctx.connection_id ||
    message.cycle.originating_connection_id === ctx.connection_id
  ) {
    return { ok: true };
  }

  const config = await resolveConnectionConfig(ctx);
  const cursor: TasksCursor = ((await ctx.cursor.read(
    CURSOR_KEY,
  )) as TasksCursor | null) ?? {
    mappings: {},
    mapping_lists: {},
    per_list: {},
    last_inbound_at: null,
  };

  const item = await ctx.myme.getItem(message.item_id);
  if (item === null) {
    return ackHandledIfMappedAsDelete(ctx, cursor, message.item_id);
  }

  const externalId = findExternalIdFor(cursor, item.id);

  if (externalId !== null && (await ctx.echo.inLagWindow(externalId))) {
    return { ok: false, retry: true, reason: "in_lag_window" };
  }

  const mappedListId =
    externalId !== null
      ? (cursor.mapping_lists[externalId] ?? config.default_write_task_list_id)
      : config.default_write_task_list_id;

  if (item.state === "trashed") {
    if (externalId !== null) {
      const path = `${TASKS_API_BASE}/lists/${encodeURIComponent(mappedListId)}/tasks/${encodeURIComponent(externalId)}`;
      const resp = await ctx.myme.proxyRequest("DELETE", path);
      if (!resp.ok && resp.status !== 404 && resp.status !== 410) {
        return reportOutboundFailure(ctx, "DELETE", externalId, resp);
      }
      Reflect.deleteProperty(cursor.mappings, externalId);
      Reflect.deleteProperty(cursor.mapping_lists, externalId);
      await ctx.cursor.write(CURSOR_KEY, cursor);
      await ctx.activity.emit({
        severity: "info",
        summary: `google-tasks outbound: deleted task ${externalId} on ${mappedListId}`,
      });
    }
    return { ok: true };
  }

  const tasksPayload = buildTasksPayload(item);

  if (externalId === null) {
    const writeListId = config.default_write_task_list_id;
    const sentinel = `[myme-id:${item.id}]`;
    const existing = await findExistingByMymeIdSentinel(
      ctx,
      writeListId,
      sentinel,
    );
    if (existing !== null) {
      cursor.mappings[existing.id] = item.id;
      cursor.mapping_lists[existing.id] = writeListId;
      await ctx.echo.trackOutboundWrite(
        existing.id,
        contentHashForTask(existing),
      );
      await ctx.cursor.write(CURSOR_KEY, cursor);
      await ctx.activity.emit({
        severity: "info",
        summary: `google-tasks outbound: idempotent recovery on ${writeListId} for Myme item ${item.id}`,
      });
      return { ok: true };
    }

    const payloadWithSentinel = injectSentinel(tasksPayload, sentinel);
    const postPath = `${TASKS_API_BASE}/lists/${encodeURIComponent(writeListId)}/tasks`;
    const resp = await ctx.myme.proxyRequest(
      "POST",
      postPath,
      payloadWithSentinel,
    );
    if (!resp.ok) {
      return reportOutboundFailure(ctx, "POST", "(new)", resp);
    }
    const body: TasksTaskResource = await resp.json();
    cursor.mappings[body.id] = item.id;
    cursor.mapping_lists[body.id] = writeListId;
    await ctx.echo.trackOutboundWrite(body.id, contentHashForTask(body));
    await ctx.cursor.write(CURSOR_KEY, cursor);
    await ctx.activity.emit({
      severity: "info",
      summary: `google-tasks outbound: created task ${body.id} on ${writeListId}`,
    });
    return { ok: true };
  }

  const path = `${TASKS_API_BASE}/lists/${encodeURIComponent(mappedListId)}/tasks/${encodeURIComponent(externalId)}`;
  const resp = await ctx.myme.proxyRequest("PATCH", path, tasksPayload);
  if (!resp.ok) {
    return reportOutboundFailure(ctx, "PATCH", externalId, resp);
  }
  const body: TasksTaskResource = await resp.json();
  await ctx.echo.trackOutboundWrite(externalId, contentHashForTask(body));
  await ctx.activity.emit({
    severity: "info",
    summary: `google-tasks outbound: patched task ${externalId} on ${mappedListId}`,
  });
  return { ok: true };
}

export function registerHandlers(): void {
  registerScheduleHandler(handleSchedule);
  registerItemEventHandler(handleItemEvent);
}

/**
 * Scan the target list for an existing task whose `notes` carry the
 * `[myme-id:<itemId>]` sentinel. Used to recover the mapping after a
 * mid-handler crash that wrote to Google but failed to persist the
 * cursor delta — the sentinel is the only deterministic, retry-safe
 * way to find the prior insert because Tasks API rejects client-
 * supplied `id` values.
 */
async function findExistingByMymeIdSentinel(
  ctx: ConnectionContext,
  listId: string,
  sentinel: string,
): Promise<TasksTaskResource | null> {
  let pageToken: string | undefined;
  let pages = 0;
  while (pages < SENTINEL_SEARCH_PAGE_LIMIT) {
    const params = new URLSearchParams();
    params.set("maxResults", String(TASKS_PAGE_SIZE));
    params.set("showCompleted", "true");
    params.set("showHidden", "true");
    if (pageToken !== undefined) params.set("pageToken", pageToken);
    const path = `${TASKS_API_BASE}/lists/${encodeURIComponent(listId)}/tasks?${params.toString()}`;
    let resp: Response;
    try {
      resp = await ctx.myme.proxyRequest("GET", path);
    } catch {
      return null;
    }
    if (!resp.ok) return null;
    let payload: TasksListResponse;
    try {
      payload = await resp.json();
    } catch {
      return null;
    }
    for (const t of payload.items ?? []) {
      if (typeof t.notes === "string" && t.notes.includes(sentinel)) {
        return t;
      }
    }
    if (typeof payload.nextPageToken !== "string") return null;
    pageToken = payload.nextPageToken;
    pages += 1;
  }
  return null;
}

function injectSentinel(
  payload: Record<string, unknown>,
  sentinel: string,
): Record<string, unknown> {
  const existing = typeof payload.notes === "string" ? payload.notes : "";
  if (existing.includes(sentinel)) return payload;
  const merged = existing.length > 0 ? `${existing}\n\n${sentinel}` : sentinel;
  return { ...payload, notes: merged };
}

function buildTaskInput(
  task: TasksTaskResource,
  targetType: string,
  sourceListId: string,
): CreateItemInput {
  const properties: Record<string, unknown> = {
    title: task.title ?? "Untitled task",
  };
  if (task.notes !== undefined) {
    properties.notes = stripSentinel(task.notes);
  }
  if (task.due !== undefined) properties.due_at = task.due;
  if (task.completed !== undefined) properties.completed_at = task.completed;
  if (task.status !== undefined) properties.status = task.status;
  if (targetType === "core.task") {
    if (task.webViewLink !== undefined) {
      properties.url = task.webViewLink;
    } else if (task.selfLink !== undefined) {
      properties.url = task.selfLink;
    }
    return { type: targetType, properties };
  }
  // Upstream-fidelity target.
  if (task.position !== undefined) properties.position = task.position;
  if (task.parent !== undefined) properties.parent = task.parent;
  if (task.webViewLink !== undefined) {
    properties.html_link = task.webViewLink;
  } else if (task.selfLink !== undefined) {
    properties.html_link = task.selfLink;
  }
  if (task.etag !== undefined) properties.etag = task.etag;
  if (task.hidden !== undefined) properties.hidden = task.hidden;
  properties.source_task_list_id = sourceListId;
  return { type: targetType, properties };
}

function stripSentinel(notes: string): string {
  return notes
    .replace(/\n*\[myme-id:[^\]]+\]\n*/g, "\n")
    .replace(/^\n+|\n+$/g, "");
}

function buildTasksPayload(item: ItemResource): Record<string, unknown> {
  const props = (item.properties ?? {}) as {
    title?: unknown;
    notes?: unknown;
    body?: unknown;
    description?: unknown;
    due_at?: unknown;
    completed_at?: unknown;
    status?: unknown;
  };
  const payload: Record<string, unknown> = {};
  if (typeof props.title === "string") payload.title = props.title;
  if (typeof props.notes === "string") {
    payload.notes = props.notes;
  } else if (typeof props.body === "string") {
    payload.notes = props.body;
  } else if (typeof props.description === "string") {
    payload.notes = props.description;
  }
  if (typeof props.due_at === "string") payload.due = props.due_at;
  if (typeof props.completed_at === "string") {
    payload.completed = props.completed_at;
  }
  if (props.status === "needsAction" || props.status === "completed") {
    payload.status = props.status;
  } else if (typeof props.status === "string") {
    const s = props.status.toLowerCase();
    if (s === "completed" || s === "done") {
      payload.status = "completed";
    } else {
      payload.status = "needsAction";
    }
  }
  return payload;
}

function findExternalIdFor(
  cursor: TasksCursor,
  myme_id: string,
): string | null {
  for (const [ext, m] of Object.entries(cursor.mappings)) {
    if (m === myme_id) return ext;
  }
  return null;
}

async function ackHandledIfMappedAsDelete(
  ctx: ConnectionContext,
  cursor: TasksCursor,
  myme_id: string,
): Promise<HandlerResult> {
  const externalId = findExternalIdFor(cursor, myme_id);
  if (externalId === null) return { ok: true };
  const listId = cursor.mapping_lists[externalId] ?? DEFAULT_TASK_LIST_ID;
  const path = `${TASKS_API_BASE}/lists/${encodeURIComponent(listId)}/tasks/${encodeURIComponent(externalId)}`;
  const resp = await ctx.myme.proxyRequest("DELETE", path);
  if (!resp.ok && resp.status !== 404 && resp.status !== 410) {
    return reportOutboundFailure(ctx, "DELETE", externalId, resp);
  }
  Reflect.deleteProperty(cursor.mappings, externalId);
  Reflect.deleteProperty(cursor.mapping_lists, externalId);
  await ctx.cursor.write(CURSOR_KEY, cursor);
  return { ok: true };
}

function contentHashForTask(task: TasksTaskResource): string {
  if (typeof task.etag === "string" && task.etag.length > 0) return task.etag;
  return [
    task.title ?? "",
    stripSentinel(task.notes ?? ""),
    task.due ?? "",
    task.completed ?? "",
    task.status ?? "",
    task.position ?? "",
    task.parent ?? "",
  ].join("|");
}

async function reportOutboundFailure(
  ctx: ConnectionContext,
  verb: string,
  externalId: string,
  resp: Response,
): Promise<HandlerResult> {
  const text = await resp.text().catch(() => "");
  const isServerError = resp.status >= 500;
  await ctx.activity.emit({
    severity: "action_required",
    summary: `google-tasks outbound: ${verb} ${externalId} returned ${String(resp.status)}`,
    detail: { status: resp.status, response_text: text.slice(0, 500) },
  });
  if (isServerError) {
    return {
      ok: false,
      retry: true,
      reason: `upstream_${String(resp.status)}`,
    };
  }
  return { ok: true };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
