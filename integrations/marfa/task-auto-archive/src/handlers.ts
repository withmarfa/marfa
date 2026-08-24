/**
 * Task Auto-Archive handlers.
 *
 * Two triggers, one shared sweep:
 *   - `item-event`: any core.task event (created, updated,
 *     state_changed, deleted, restored) fires a bounded sweep.
 *     The reactive-run bridge already drops the integration's own
 *     writes (self-event suppression) so own-archive events don't loop.
 *   - `schedule`: daily fallback for guarantee under low event
 *     volume.
 *
 * Sweep is two-phase: collect-then-act, never iterate a paginated
 * filter while mutating items out of that filter.
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
 *   The collect-then-act split matters: transitioning items inside the
 *   page loop would rely on the cursor being opaque keyset (stable
 *   across the filter snapshot), and an offset-based cursor would let
 *   page 2 silently skip items that page 1 archived. Collecting the
 *   snapshot first, then transitioning, works correctly under either
 *   cursor model. Memory-bounded by `MAX_PAGES_PER_TICK * PAGE_SIZE`
 *   (1000 IDs at current settings).
 *
 * Failure handling: per-item transition errors don't abort the
 * sweep; each surfaces as a `system.activity` row with severity
 * `action_required`. The outer handler still returns ok=true so
 * the queue ack proceeds.
 *
 * Reporting: a sweep that archived something says so, whatever fired it.
 * A sweep that found nothing reports only on the schedule, because one
 * row a day is a heartbeat and one row per `core.task` write is not.
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
  await runSweep(
    ctx,
    archiveAfterDays,
    { kind: "schedule", label: "schedule" },
    message.scheduled_for_ms,
  );
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
    { kind: "item-event", label: `item-event(${message.event_type})` },
    Date.now(),
  );
  return { ok: true };
}

export function registerHandlers(): void {
  registerScheduleHandler(handleSchedule);
  registerItemEventHandler(handleItemEvent);
}

interface SweepTrigger {
  kind: "schedule" | "item-event";
  /** How the run is named in an activity row. */
  label: string;
}

async function runSweep(
  ctx: ConnectionContext,
  archiveAfterDays: number,
  trigger: SweepTrigger,
  nowMs: number,
): Promise<void> {
  const cutoffMs = nowMs - archiveAfterDays * 24 * 60 * 60 * 1000;
  const cutoffIso = new Date(cutoffMs).toISOString();

  // Phase 1 — collect. Walk pages; do NOT transition while paginating.
  // Transitioning inside the page loop silently skips rows under
  // offset-based cursors.
  let inspected = 0;
  let cursor: string | undefined;
  let pages = 0;
  let stopReason: "complete" | "no_more_due" | "page_cap" = "complete";
  /** Set when the walk ran out of pages to ask for, rather than out of budget. */
  let exhausted = false;
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
      exhausted = true;
      break;
    }
    cursor = page.cursor;
  }
  // Only the cap stopping the walk is a page cap. A sweep that reached the
  // end of the list on its last allowed page has finished, and reporting a
  // backlog it does not have would send somebody looking for one.
  if (!exhausted && stopReason === "complete") {
    stopReason = "page_cap";
  }

  // Phase 2 — act. Pagination complete; transitions can't shift the cursor.
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

  // A sweep that changed nothing does not write a row.
  //
  // Both outcomes used to be reported as steady-state information, which is
  // true of one a day and not of one per `core.task` write. Measured on
  // production: 5,365 of 6,062 activity rows were this integration saying it
  // had nothing to do, and the hourly purge only bounds how many exist at
  // once. Every one of them costs a transaction, a quota reservation, an
  // index update and a published event.
  //
  // The liveness signal survives without them. The cursor above records
  // `last_sweep_at` on every sweep including this one, and the schedule run
  // still reports, so a reader still sees the integration is alive at a
  // cadence a person can read.
  //
  // Stopping on the page cap needs no condition of its own. Every page it
  // walked held due tasks, so either some were archived and the row goes out
  // anyway, or every transition failed and each failure has already emitted
  // an `action_required` row, which is louder than this summary.
  const changedSomething = archived > 0;
  if (!changedSomething && trigger.kind !== "schedule") {
    return;
  }

  await ctx.activity.emit({
    severity: "info",
    // Off the due count as well as the archived one, because a run where
    // every transition failed archived nothing and had plenty due, and
    // calling that "nothing due" contradicts the detail beside it.
    //
    // Qualified when the walk stopped on its page cap, where `dueIds` is
    // what this tick collected rather than what is due. Without that,
    // "1000 of 1000 due" reads as completeness in the same row whose stop
    // reason says there is more, and somebody stops looking.
    summary:
      dueIds.length === 0
        ? `task-auto-archive sweep, nothing due (${trigger.label})`
        : `task-auto-archive archived ${String(archived)} of ${String(dueIds.length)} due${stopReason === "page_cap" ? " so far" : ""} (${trigger.label})`,
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
      { configuration?: unknown } | undefined;
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
    // Swallowing and defaulting is the shape the reporting rule in
    // `integrations/AGENTS.md` names as the one it exists against, and this
    // is a live instance of it: a read that fails takes the default, and
    // the sweep then archives against a window nobody chose. Against a
    // longer configured window it archives more than it was asked to;
    // against a shorter one it quietly stops archiving what was due.
    //
    // Left here deliberately. Fixing it means the sweep refuses to run
    // rather than guessing, which changes this handler's control flow, and
    // that is a different change from what a run reports.
  }
  return DEFAULT_ARCHIVE_AFTER_DAYS;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
