/**
 * End-to-end (in-memory) test of the template Integration's handlers.
 *
 * Demonstrates the substrate works without any Cloudflare runtime —
 * tests build a ConnectionContext from in-memory pieces and assert the
 * observable side effects (cursor advanced, activity emitted).
 *
 * The full @mymehq/runtime-test harness ships in PR 5; this test
 * builds the context inline because the helpers it needs are tiny.
 */
import { describe, it, expect } from "vitest";
import {
  createCursorStore,
  createActivitySink,
  createEchoSuppression,
  type ConnectionContext,
  type ConnectionClient,
  type CreateItemInput,
} from "@mymehq/runtime-sdk";
import { handleSchedule, handleWebhook, handleItemEvent } from "./handlers.js";

interface InMemoryStorage {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
}

function createMemoryStorage(): InMemoryStorage {
  const data = new Map<string, unknown>();
  return {
    get(key: string): Promise<unknown> {
      return Promise.resolve(data.get(key));
    },
    put(key: string, value: unknown): Promise<void> {
      data.set(key, value);
      return Promise.resolve();
    },
    delete(key: string): Promise<boolean> {
      return Promise.resolve(data.delete(key));
    },
  };
}

interface CapturedActivity extends CreateItemInput {
  type: "system.activity";
}

function buildContext(connectionId = "conn_template_test"): {
  ctx: ConnectionContext;
  emitted: CapturedActivity[];
} {
  const storage = createMemoryStorage();
  const emitted: CapturedActivity[] = [];
  const client = {
    createItem: (input: CreateItemInput) => {
      emitted.push(input as CapturedActivity);
      return Promise.resolve({ id: "act_x", type: input.type });
    },
  } as unknown as ConnectionClient;
  const ctx: ConnectionContext = {
    connection_id: connectionId,
    integration_name: "myme.template",
    myme: client,
    cursor: createCursorStore(storage),
    activity: createActivitySink(client, connectionId),
    echo: createEchoSuppression(storage, { echo_ttl_seconds: 60 }),
    cycle: null,
  };
  return { ctx, emitted };
}

describe("template integration handlers", () => {
  it("schedule handler advances the cursor and emits an info activity", async () => {
    const { ctx, emitted } = buildContext();
    const result = await handleSchedule(ctx, {
      kind: "schedule",
      integration_name: "myme.template",
      connection_id: "conn_template_test",
      scheduled_for_ms: 1_700_000_000_000,
    });
    expect(result).toEqual({ ok: true });
    expect(await ctx.cursor.read("main")).toMatchObject({
      last_run_at: new Date(1_700_000_000_000).toISOString(),
      run_count: 1,
    });
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.properties).toMatchObject({
      severity: "info",
      summary: "Template ran (count=1)",
    });
  });

  it("schedule handler increments run_count across runs", async () => {
    const { ctx } = buildContext();
    await handleSchedule(ctx, {
      kind: "schedule",
      integration_name: "myme.template",
      connection_id: "conn_template_test",
      scheduled_for_ms: 1_700_000_000_000,
    });
    await handleSchedule(ctx, {
      kind: "schedule",
      integration_name: "myme.template",
      connection_id: "conn_template_test",
      scheduled_for_ms: 1_700_000_300_000,
    });
    expect(await ctx.cursor.read("main")).toMatchObject({ run_count: 2 });
  });

  it("webhook handler emits an activity row", async () => {
    const { ctx, emitted } = buildContext();
    const result = await handleWebhook(ctx, {
      kind: "webhook",
      integration_name: "myme.template",
      connection_id: "conn_template_test",
      delivery_id: "d_1",
      headers: {},
      body: new ArrayBuffer(0),
      verified_at_ms: 1_700_000_000_000,
    });
    expect(result).toEqual({ ok: true });
    expect(emitted[0]!.properties).toMatchObject({
      summary: "Template received a webhook",
    });
  });

  it("item-event handler propagates hop count into the activity summary", async () => {
    const { ctx, emitted } = buildContext();
    await handleItemEvent(ctx, {
      kind: "item-event",
      integration_name: "myme.template",
      connection_id: "conn_template_test",
      event_type: "updated",
      item_id: "item_1",
      cycle: { originating_connection_id: "conn_other", hop_count: 2 },
      payload: {},
    });
    expect(emitted[0]!.properties).toMatchObject({
      summary: "Template saw item.updated (hop=2)",
    });
  });
});
