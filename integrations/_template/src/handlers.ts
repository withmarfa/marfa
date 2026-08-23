/**
 * Template handlers — minimal end-to-end demonstration of the runtime
 * SDK. The schedule handler reads the cursor, advances it, emits a
 * `system.activity` row reporting the run, and returns ok.
 *
 * No external service calls — by design. This integration's purpose is
 * to exercise the substrate (cursor + activity + connection client)
 * in isolation.
 */
import {
  registerScheduleHandler,
  registerWebhookHandler,
  registerItemEventHandler,
} from "@withmarfa/runtime-sdk";
import type {
  ConnectionContext,
  ScheduleMessage,
  WebhookHandlerInput,
  ItemEventMessage,
  HandlerResult,
} from "@withmarfa/runtime-sdk";

interface TemplateCursor {
  /** ISO timestamp the last successful run completed. */
  last_run_at: string;
  /** Total run count since first install. */
  run_count: number;
}

const CURSOR_KEY = "main";

export async function handleSchedule(
  ctx: ConnectionContext,
  message: ScheduleMessage,
): Promise<HandlerResult> {
  const previous = (await ctx.cursor.read(CURSOR_KEY)) as TemplateCursor | null;
  const next: TemplateCursor = {
    last_run_at: new Date(message.scheduled_for_ms).toISOString(),
    run_count: (previous?.run_count ?? 0) + 1,
  };
  await ctx.cursor.write(CURSOR_KEY, next);

  await ctx.activity.emit({
    severity: "info",
    summary: `Template ran (count=${String(next.run_count)})`,
    detail: { previous: previous?.last_run_at ?? null },
  });

  return { ok: true };
}

export function handleWebhook(
  ctx: ConnectionContext,
  input: WebhookHandlerInput,
): Promise<HandlerResult> {
  void ctx;
  void input;
  // `input.body` is an `ArrayBuffer`, not a string. Decode it before
  // parsing, which is the one thing about this surface that catches people.
  //
  // Silent for the same reason the item-event handler below is: a webhook
  // handler runs once per upstream write, so a row saying it ran is a row
  // per write. A real one reports what it built, and says nothing when the
  // delivery built nothing.
  return Promise.resolve({ ok: true });
}

export function handleItemEvent(
  ctx: ConnectionContext,
  message: ItemEventMessage,
): Promise<HandlerResult> {
  void ctx;
  void message;
  // A real integration reads `message.cycle` here and refuses to act when
  // the hop count is at the budget.
  //
  // When a handler publishes a downstream event that carries cycle
  // metadata (`originating_connection_id` and `hop_count`), use
  // `nextHopMetadata` from `@withmarfa/runtime-sdk` to compute the
  // metadata. Never roll your own: getting the origin propagation or the
  // hop_count increment off-by-one breaks cycle prevention. The SDK's
  // `ctx.marfa.*` calls do not yet accept cycle metadata directly; this
  // contract applies to any future SDK surface that does.
  //
  // Deliberately silent, and this is the part to copy. A reactive handler
  // runs once per upstream write, so a row saying it ran is a row per
  // write, and a template that emits one teaches every integration copied
  // from it to do the same. One integration doing exactly this accounted
  // for 88% of every activity row on production. Report what a run did and
  // say nothing when it did nothing; `integrations/AGENTS.md` has the rule.
  return Promise.resolve({ ok: true });
}

/** Wire the handlers into the runtime-sdk registry. Called once at
 *  module-load time from the Worker entry. */
export function registerHandlers(): void {
  registerScheduleHandler(handleSchedule);
  registerWebhookHandler(handleWebhook);
  registerItemEventHandler(handleItemEvent);
}
