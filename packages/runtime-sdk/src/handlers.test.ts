import { describe, it, expect, beforeEach } from "vitest";
import {
  registerScheduleHandler,
  registerWebhookHandler,
  registerItemEventHandler,
  dispatchMessage,
  _resetHandlers,
} from "./handlers.js";
import type { ConnectionContext } from "./connection-context.js";
import type {
  ItemEventMessage,
  ScheduleMessage,
  WebhookMessage,
} from "./types.js";

const FAKE_CTX = {
  connection_id: "conn_x",
  integration_name: "demo",
  cycle: null,
} as unknown as ConnectionContext;

const SCHEDULE_MSG: ScheduleMessage = {
  kind: "schedule",
  integration_name: "demo",
  connection_id: "conn_x",
  scheduled_for_ms: 1000,
};

const WEBHOOK_MSG: WebhookMessage = {
  kind: "webhook",
  integration_name: "demo",
  connection_id: "conn_x",
  delivery_id: "delivery_1",
  headers: {},
  body_base64: "",
  verified_at_ms: 1000,
};

const ITEM_EVENT_MSG: ItemEventMessage = {
  kind: "item-event",
  integration_name: "demo",
  connection_id: "conn_x",
  event_type: "item.updated",
  item_id: "item_1",
  cycle: { originating_connection_id: null, hop_count: 0 },
  payload: {},
};

describe("handler registration + dispatch", () => {
  beforeEach(() => {
    _resetHandlers();
  });

  it("returns no_*_handler_registered when no handler is registered", async () => {
    expect(await dispatchMessage(FAKE_CTX, SCHEDULE_MSG)).toEqual({
      ok: false,
      retry: false,
      reason: "no_schedule_handler_registered",
    });
    expect(await dispatchMessage(FAKE_CTX, WEBHOOK_MSG)).toEqual({
      ok: false,
      retry: false,
      reason: "no_webhook_handler_registered",
    });
    expect(await dispatchMessage(FAKE_CTX, ITEM_EVENT_MSG)).toEqual({
      ok: false,
      retry: false,
      reason: "no_item_event_handler_registered",
    });
  });

  it("dispatches a schedule message to the registered handler", async () => {
    let captured: unknown = null;
    registerScheduleHandler((_ctx, msg) => {
      captured = msg;
      return Promise.resolve({ ok: true });
    });
    const result = await dispatchMessage(FAKE_CTX, SCHEDULE_MSG);
    expect(result).toEqual({ ok: true });
    expect(captured).toEqual(SCHEDULE_MSG);
  });

  it("dispatches a webhook message to the registered handler", async () => {
    registerWebhookHandler(() => Promise.resolve({ ok: true }));
    expect(await dispatchMessage(FAKE_CTX, WEBHOOK_MSG)).toEqual({ ok: true });
  });

  it("dispatches an item-event message to the registered handler", async () => {
    registerItemEventHandler(() =>
      Promise.resolve({ ok: false, retry: true, reason: "rate_limited" }),
    );
    expect(await dispatchMessage(FAKE_CTX, ITEM_EVENT_MSG)).toEqual({
      ok: false,
      retry: true,
      reason: "rate_limited",
    });
  });

  it("re-registering a handler replaces the previous one", async () => {
    registerScheduleHandler(() => Promise.resolve({ ok: true }));
    registerScheduleHandler(() =>
      Promise.resolve({ ok: false, retry: false, reason: "second" }),
    );
    expect(await dispatchMessage(FAKE_CTX, SCHEDULE_MSG)).toEqual({
      ok: false,
      retry: false,
      reason: "second",
    });
  });
});
