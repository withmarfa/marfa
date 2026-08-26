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
  DispatchResult,
  SweepResult,
  WebhookHandlerInput,
  QueueMessage,
} from "./types.js";
import { decodeBase64ToArrayBuffer } from "./types.js";
import type { ConnectionContext } from "./connection-context.js";

/**
 * A scheduled sweep, which may report that it has not finished.
 *
 * Returns `SweepResult` rather than `HandlerResult`, so `done` is required
 * and the old shape no longer compiles. That break is the point: an
 * additive variant would have been read as a success by both translations
 * that consume a result, so a handler saying "not finished" would have
 * been acknowledged as finished and its continuation dropped, green in
 * every test.
 */
export type ScheduleHandler = (
  ctx: ConnectionContext,
  message: ScheduleMessage,
) => Promise<SweepResult>;

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
): Promise<DispatchResult> {
  switch (message.kind) {
    case "manual": {
      // A manual run is the integration's scheduled sweep, asked for now.
      // Routing it to the schedule handler is what makes "Run now" work
      // for every scheduled integration without a line of handler code;
      // a separate handler slot would have meant every author opting in
      // twice for one behaviour.
      const handler = REGISTRY.schedule;
      if (!handler) {
        return {
          ok: false,
          retry: false,
          reason: "no_schedule_handler_registered",
        };
      }
      return handler(ctx, {
        kind: "schedule",
        integration_name: message.integration_name,
        connection_id: message.connection_id,
        ...(message.space_id !== undefined
          ? { space_id: message.space_id }
          : {}),
        scheduled_for_ms: message.requested_at_ms,
        // Carried through, or a manual run that parks loses its resume
        // payload on the next slice and silently restarts from the
        // watermark. The synthesis below already rewrites `kind` to
        // `schedule`, so this is the only thing keeping a continued
        // manual run pointed at where it stopped.
        ...(message.continuation !== undefined
          ? { continuation: message.continuation }
          : {}),
      });
    }
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
    default: {
      // Unreachable while `QueueMessage` is the four kinds above, and
      // `message` narrows to `never` here so a fifth kind fails to compile
      // rather than falling through.
      //
      // It is written out because the switch had no default and returned
      // `undefined` against a `Promise<HandlerResult>` annotation. Nothing
      // produced a fifth kind, so nothing noticed — but a continuation
      // envelope built with an absent `kind` would have reached it, and
      // the caller would have read a property off `undefined` a queue hop
      // later, where the cause is no longer visible.
      const unreachable: never = message;
      return {
        ok: false,
        retry: false,
        reason: `unknown_message_kind: ${String((unreachable as { kind?: unknown }).kind)}`,
      };
    }
  }
}
