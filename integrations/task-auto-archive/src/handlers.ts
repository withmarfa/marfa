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
 * Sweep:
 *   1. Page through `core.task` items in `state: active`, sorted
 *      by `created_at asc`, capped at MAX_PAGES_PER_TICK pages of
 *      PAGE_SIZE each. Bounding keeps a single tick predictable.
 *   2. For each item, compare item.created_at against the cutoff
 *      derived from `archive_after_days`. If older, transition to
 *      `archived`.
 *   3. Stop early when the first item newer than the cutoff is
 *      seen — ascending sort means the rest of the list is also
 *      newer.
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
} from "@mymehq/runtime-sdk";
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

  let archived = 0;
  let inspected = 0;
  let cursor: string | undefined;
  let pages = 0;
  let stopReason: "complete" | "no_more_due" | "page_cap" = "complete";

  outer: while (pages < MAX_PAGES_PER_TICK) {
    pages += 1;
    const page = await ctx.myme.listItems({
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
      try {
        await ctx.myme.transitionItem(item.id, "archived");
        archived += 1;
      } catch (err) {
        await ctx.activity.emit({
          severity: "action_required",
          summary: `task-auto-archive: failed to archive task ${item.id}`,
          detail: { error: errorMessage(err) },
        });
      }
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
    const connection = await ctx.myme.getItem(ctx.connection_id);
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
