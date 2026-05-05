/**
 * Template handlers — minimal end-to-end demonstration of the runtime
 * SDK. The schedule handler reads the cursor, advances it, emits a
 * `system.activity` row reporting the run, and returns ok.
 *
 * No external service calls — by design. This integration's purpose is
 * to exercise the substrate (cursor + activity + connection client)
 * during Layer 1 acceptance.
 */
import {
  registerScheduleHandler,
  registerWebhookHandler,
  registerItemEventHandler,
} from "@mymehq/runtime-sdk";
import type {
  ConnectionContext,
  ScheduleMessage,
  WebhookHandlerInput,
  ItemEventMessage,
  HandlerResult,
} from "@mymehq/runtime-sdk";

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

export async function handleWebhook(
  ctx: ConnectionContext,
  input: WebhookHandlerInput,
): Promise<HandlerResult> {
  void input;
  await ctx.activity.emit({
    severity: "info",
    summary: "Template received a webhook",
  });
  return { ok: true };
}

export async function handleItemEvent(
  ctx: ConnectionContext,
  message: ItemEventMessage,
): Promise<HandlerResult> {
  // Demonstrate cycle metadata propagation. A real integration would
  // refuse to act when the hop count is at the budget.
  //
  // Cycle-metadata contract (T-037): if your handler ever publishes a
  // downstream event whose cycle metadata is exposed to a publish API
  // that takes `originating_connection_id` and `hop_count`, use
  // `nextHopMetadata` from `@mymehq/runtime-sdk` to compute the
  // metadata. Never roll your own — getting the origin propagation or
  // the hop_count increment off-by-one breaks cycle prevention. Today
  // none of the SDK's `ctx.myme.*` calls accept cycle metadata
  // directly, so this contract is forward-looking for any future SDK
  // surface that does.
  await ctx.activity.emit({
    severity: "info",
    summary: `Template saw item.${message.event_type} (hop=${String(
      message.cycle.hop_count,
    )})`,
  });
  return { ok: true };
}

/** Wire the handlers into the runtime-sdk registry. Called once at
 *  module-load time from the Worker entry. */
export function registerHandlers(): void {
  registerScheduleHandler(handleSchedule);
  registerWebhookHandler(handleWebhook);
  registerItemEventHandler(handleItemEvent);
}
