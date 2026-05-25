/**
 * Task Auto-Archive handlers.
 *
 * Two triggers, one shared sweep:
 *   - `item-event`: any core.task event (created, updated,
 *     state_changed, deleted, restored) fires a bounded sweep.
 *     The reactive-run bridge already drops the connector's own
 *     writes (Layer 2 PR 3 self-event suppression) so own-archive
 *     events don't loop.
 *   - `schedule`: daily fallback for guarantee under low event
 *     volume.
 *
 * Sweep is two-phase (T-019): collect-then-act, never iterate a
 * paginated filter while mutating items out of that filter.
 *
 *   1. Pagination phase. Page through `core.task` items in
 *      `state: active`, sorted by `created_at asc`, capped at
 *      MAX_PAGES_PER_TICK pages of PAGE_SIZE each. For each item,
 *      compare `created_at` against the cutoff derived from
 *      `archive_after_days`. Collect the IDs of items past the
 *      cutoff into a snapshot array. Stop walking pages early if
 *      we hit the first item newer than the cutoff (ascending sort
 *      guarantees the rest of the list is also newer).
 *   2. Transition phase. Iterate the snapshot array and transition
 *      each id to `archived`. The list call has already returned;
 *      the cursor is not at risk from mid-iteration mutations.
 *
 *   The pre-T-019 shape transitioned items inside the page loop. It
 *   relied on the cursor being opaque keyset (stable across the
 *   filter snapshot). If a future cursor change made it offset-based,
 *   page 2 would skip items that page 1 archived — silently. The
 *   collect-then-act split removes that coupling: the handler now
 *   works correctly under either cursor model. Memory-bounded by
 *   `MAX_PAGES_PER_TICK * PAGE_SIZE` (1000 IDs at current settings).
 *
 * Failure handling: per-item transition errors don't abort the
 * sweep; each surfaces as a `system.activity` row with severity
 * `action_required`. The outer handler still returns ok=true so
 * the queue ack proceeds.
 */
import {
  registerScheduleHandler,
  registerItemEventHandler,
  type ConnectionContext,
  type ScheduleMessage,
  type ItemEventMessage,
  type HandlerResult,
  type ItemResource,
} from "@withmarfa/runtime-sdk";
import { DEFAULT_ARCHIVE_AFTER_DAYS } from "./manifest.js";

export const PAGE_SIZE = 200;
export const MAX_PAGES_PER_TICK = 5;
const CURSOR_KEY = "main";

interface AutoArchiveCursor {
  /** ISO timestamp of the most recent successful sweep. */
  last_sweep_at: string | null;
  /** Last sweep's archive count, for observability. */
  last_archive_count: number;
}

export async function handleSchedule(
  ctx: ConnectionContext,
  message: ScheduleMessage,
): Promise<HandlerResult> {
  const archiveAfterDays = await resolveArchiveAfterDays(ctx);
  await runSweep(ctx, archiveAfterDays, "schedule", message.scheduled_for_ms);
  return { ok: true };
}

export async function handleItemEvent(
  ctx: ConnectionContext,
  message: ItemEventMessage,
): Promise<HandlerResult> {
  const archiveAfterDays = await resolveArchiveAfterDays(ctx);
  await runSweep(
    ctx,
    archiveAfterDays,
    `item-event(${message.event_type})`,
    Date.now(),
  );
  return { ok: true };
}

export function registerHandlers(): void {
  registerScheduleHandler(handleSchedule);
  registerItemEventHandler(handleItemEvent);
}

async function runSweep(
  ctx: ConnectionContext,
  archiveAfterDays: number,
  triggerLabel: string,
  nowMs: number,
): Promise<void> {
  const cutoffMs = nowMs - archiveAfterDays * 24 * 60 * 60 * 1000;
  const cutoffIso = new Date(cutoffMs).toISOString();

  // Phase 1 — collect. Walk pages, collect IDs of items older than
  // the cutoff. Do NOT transition while paginating; that's what
  // T-019 guards against.
  let inspected = 0;
  let cursor: string | undefined;
  let pages = 0;
  let stopReason: "complete" | "no_more_due" | "page_cap" = "complete";
  const dueIds: string[] = [];

  outer: while (pages < MAX_PAGES_PER_TICK) {
    pages += 1;
    const page = await ctx.marfa.listItems({
      type: "core.task",
      state: "active",
      sort: "created_at",
      direction: "asc",
      limit: PAGE_SIZE,
      cursor,
    });
    inspected += page.data.length;
    for (const item of page.data) {
      if (!isOlderThan(item, cutoffMs)) {
        // Ascending sort: subsequent items are also newer.
        stopReason = "no_more_due";
        break outer;
      }
      dueIds.push(item.id);
    }
    if (!page.has_more || page.cursor === null) {
      stopReason = "complete";
      break;
    }
    cursor = page.cursor;
  }
  if (pages >= MAX_PAGES_PER_TICK && stopReason === "complete") {
    stopReason = "page_cap";
  }

  // Phase 2 — act. The pagination is complete; transitioning items
  // out of `state: active` no longer interacts with the cursor.
  let archived = 0;
  for (const id of dueIds) {
    try {
      await ctx.marfa.transitionItem(id, "archived");
      archived += 1;
    } catch (err) {
      await ctx.activity.emit({
        severity: "action_required",
        summary: `task-auto-archive: failed to archive task ${id}`,
        detail: { error: errorMessage(err) },
      });
    }
  }

  const cursorBlob: AutoArchiveCursor = {
    last_sweep_at: new Date(nowMs).toISOString(),
    last_archive_count: archived,
  };
  await ctx.cursor.write(CURSOR_KEY, cursorBlob);

  await ctx.activity.emit({
    severity: archived === 0 ? "info" : "info",
    summary:
      archived === 0
        ? `task-auto-archive sweep — nothing due (${triggerLabel})`
        : `task-auto-archive archived ${String(archived)} task(s) (${triggerLabel})`,
    detail: {
      archive_after_days: archiveAfterDays,
      cutoff_iso: cutoffIso,
      inspected,
      archived,
      pages_walked: pages,
      stop_reason: stopReason,
    },
  });
}

function isOlderThan(item: ItemResource, cutoffMs: number): boolean {
  if (item.created_at === undefined) return false;
  const createdMs = Date.parse(item.created_at);
  if (!Number.isFinite(createdMs)) return false;
  return createdMs < cutoffMs;
}

async function resolveArchiveAfterDays(
  ctx: ConnectionContext,
): Promise<number> {
  try {
    const connection = await ctx.marfa.getItem(ctx.connection_id);
    const props = connection?.properties as
      | { configuration?: unknown }
      | undefined;
    const config = props?.configuration;
    if (
      typeof config === "object" &&
      config !== null &&
      "archive_after_days" in config
    ) {
      const raw = (config as { archive_after_days?: unknown })
        .archive_after_days;
      if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
        return Math.floor(raw);
      }
    }
  } catch {
    // Fall through.
  }
  return DEFAULT_ARCHIVE_AFTER_DAYS;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
