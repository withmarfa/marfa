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
  WebhookHandlerInput,
  QueueMessage,
} from "./types.js";
import { decodeBase64ToArrayBuffer } from "./types.js";
import type { ConnectionContext } from "./connection-context.js";

export type ScheduleHandler = (
  ctx: ConnectionContext,
  message: ScheduleMessage,
) => Promise<HandlerResult>;

/**
 * Webhook handlers receive a decoded `WebhookHandlerInput` — `body` is an
 * `ArrayBuffer` rather than the wire-format `body_base64` string. The
 * dispatcher (`dispatchMessage`) does the decode at the seam.
 */
export type WebhookHandler = (
  ctx: ConnectionContext,
  input: WebhookHandlerInput,
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
      // Decode the wire-format body_base64 once at the seam.
      // Handlers always receive the runtime form with `body: ArrayBuffer`.
      const input: WebhookHandlerInput = {
        delivery_id: message.delivery_id,
        headers: message.headers,
        body: decodeBase64ToArrayBuffer(message.body_base64),
        ...(message.body_url !== undefined && { body_url: message.body_url }),
        verified_at_ms: message.verified_at_ms,
      };
      return handler(ctx, input);
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
