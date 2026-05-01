/**
 * Typed handler registration for an Integration Worker. An integration
 * defines its handlers in module scope by calling the `register*`
 * functions; the runtime's queue consumer dispatches incoming messages
 * by `kind`.
 *
 * Each handler is async and returns a HandlerResult. The runtime
 * translates `{ ok: false, retry: true }` into a queue message retry,
 * and `{ ok: false, retry: false }` into a permanent failure that
 * lands on the DLQ + emits a `system.activity` row.
 *
 * One handler per kind per integration. Re-registering replaces the
 * prior handler; tests rely on this for setup/teardown.
 */
import type {
  HandlerResult,
  ItemEventMessage,
  ScheduleMessage,
  WebhookMessage,
  QueueMessage,
} from "./types.js";
import type { ConnectionContext } from "./connection-context.js";

export type ScheduleHandler = (
  ctx: ConnectionContext,
  message: ScheduleMessage,
) => Promise<HandlerResult>;

export type WebhookHandler = (
  ctx: ConnectionContext,
  message: WebhookMessage,
) => Promise<HandlerResult>;

export type ItemEventHandler = (
  ctx: ConnectionContext,
  message: ItemEventMessage,
) => Promise<HandlerResult>;

interface HandlerRegistry {
  schedule?: ScheduleHandler;
  webhook?: WebhookHandler;
  itemEvent?: ItemEventHandler;
}

const REGISTRY: HandlerRegistry = {};

export function registerScheduleHandler(handler: ScheduleHandler): void {
  REGISTRY.schedule = handler;
}

export function registerWebhookHandler(handler: WebhookHandler): void {
  REGISTRY.webhook = handler;
}

export function registerItemEventHandler(handler: ItemEventHandler): void {
  REGISTRY.itemEvent = handler;
}

/** Test-only — clears all registered handlers. The runtime never
 *  calls this in production. */
export function _resetHandlers(): void {
  delete REGISTRY.schedule;
  delete REGISTRY.webhook;
  delete REGISTRY.itemEvent;
}

/** Dispatch a single queue message. Returns the handler's result, or
 *  a `{ ok: false, retry: false, reason: "no_handler_registered" }`
 *  result if the integration didn't register one for this kind. */
export async function dispatchMessage(
  ctx: ConnectionContext,
  message: QueueMessage,
): Promise<HandlerResult> {
  switch (message.kind) {
    case "schedule": {
      const handler = REGISTRY.schedule;
      if (!handler) {
        return {
          ok: false,
          retry: false,
          reason: "no_schedule_handler_registered",
        };
      }
      return handler(ctx, message);
    }
    case "webhook": {
      const handler = REGISTRY.webhook;
      if (!handler) {
        return {
          ok: false,
          retry: false,
          reason: "no_webhook_handler_registered",
        };
      }
      return handler(ctx, message);
    }
    case "item-event": {
      const handler = REGISTRY.itemEvent;
      if (!handler) {
        return {
          ok: false,
          retry: false,
          reason: "no_item_event_handler_registered",
        };
      }
      return handler(ctx, message);
    }
  }
}
