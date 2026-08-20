/**
 * Handler-level tests for the withmarfa.inbox integration.
 *
 * Builds ConnectionContext inline; HMAC verification is exercised
 * server-side (the `cloudflare-email` adapter has its own test in
 * `@withmarfa/webhooks`). These tests assume verification has already
 * passed and the delivery has reached the handler.
 */
import { describe, it, expect } from "vitest";
import {
  createCursorStore,
  createActivitySink,
  createEchoSuppression,
  type ConnectionContext,
  type ConnectionClient,
  type CreateItemInput,
  type WebhookHandlerInput,
  familyOnlyMappingResolver,
} from "@withmarfa/runtime-sdk";
import { handleInboxWebhook, __internals } from "./handlers.js";
import { DELIVERY_RING_SIZE } from "./manifest.js";

interface InMemoryStorage {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
}

function createMemoryStorage(): InMemoryStorage {
  const data = new Map<string, unknown>();
  return {
    get(key) {
      return Promise.resolve(data.get(key));
    },
    put(key, value) {
      data.set(key, value);
      return Promise.resolve();
    },
    delete(key) {
      return Promise.resolve(data.delete(key));
    },
  };
}

interface CapturedActivity {
  type: string;
  properties?: Record<string, unknown>;
}

interface BuildOpts {
  failCreate?: boolean;
}

interface BuiltContext {
  ctx: ConnectionContext;
  emitted: CapturedActivity[];
  created: CreateItemInput[];
}

function buildContext(opts: BuildOpts = {}): BuiltContext {
  const storage = createMemoryStorage();
  const emitted: CapturedActivity[] = [];
  const created: CreateItemInput[] = [];
  let itemAttempts = 0;
  const connectionId = "conn_inbox_test";

  const client = {
    createItem: (input: CreateItemInput) => {
      if (input.type === "system.activity") {
        emitted.push({ type: input.type, properties: input.properties });
        return Promise.resolve({ id: "act_x", type: input.type });
      }
      itemAttempts += 1;
      if (opts.failCreate === true && itemAttempts === 1) {
        return Promise.reject(new Error("server 500"));
      }
      created.push(input);
      return Promise.resolve({
        id: `itm_${String(created.length)}`,
        type: input.type,
      });
    },
    getItem: () => Promise.resolve(null),
  } as unknown as ConnectionClient;

  const ctx: ConnectionContext = {
    connection_id: connectionId,
    integration_name: "withmarfa.inbox",
    marfa: client,
    cursor: createCursorStore(storage),
    activity: createActivitySink(client, connectionId),
    echo: createEchoSuppression(storage, { echo_ttl_seconds: 60 }),
    mapping: familyOnlyMappingResolver(),
    cycle: null,
  };
  return { ctx, emitted, created };
}

const FROM_SENDER = {
  from: { address: "sender@example.com", name: "Test Sender" },
  to: "capture@inbox.marfa.so",
  subject: "Read this later",
  text_body: "Interesting article: https://example.com/x",
  html_body:
    "<p>Interesting article: <a href='https://example.com/x'>x</a></p>",
  sent_at: "2026-05-24T15:00:00Z",
  message_id: "<CAabc123@mail.gmail.com>",
  headers: { "list-unsubscribe": "<mailto:u@example.com>" },
};

const ENVELOPE_NO_BODY = {
  from: { address: "noreply@example.com" },
  to: "capture@inbox.marfa.so",
  subject: "Empty body case",
  message_id: "<empty-body@example.com>",
};

const ENVELOPE_WITH_ATTACHMENTS = {
  ...FROM_SENDER,
  message_id: "<with-attachments@example.com>",
  attachments: [
    { filename: "report.pdf", mime_type: "application/pdf", size_bytes: 14523 },
    {
      filename: "spreadsheet.xlsx",
      mime_type:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      size_bytes: 89012,
    },
    { filename: "missing-size.bin", mime_type: "application/octet-stream" }, // should be filtered
  ],
};

function makeWebhookMessage(
  envelope: unknown,
  deliveryId: string,
  opts: { lowercase?: boolean } = {},
): WebhookHandlerInput {
  const headers: Record<string, string> = opts.lowercase
    ? {
        "x-marfa-signature": "sha256=stub",
        "x-marfa-delivery-id": deliveryId,
        "content-type": "application/json",
      }
    : {
        "X-Marfa-Signature": "sha256=stub",
        "X-Marfa-Delivery-Id": deliveryId,
        "Content-Type": "application/json",
      };
  const bodyBuffer = new TextEncoder().encode(JSON.stringify(envelope)).buffer;
  return {
    delivery_id: deliveryId,
    headers,
    body: bodyBuffer,
    verified_at_ms: Date.now(),
  };
}

describe("withmarfa.inbox handler", () => {
  it("creates a withmarfa.captured_email on a well-formed envelope", async () => {
    const { ctx, created, emitted } = buildContext();
    const result = await handleInboxWebhook(
      ctx,
      makeWebhookMessage(FROM_SENDER, "<CAabc123@mail.gmail.com>"),
    );
    expect(result).toEqual({ ok: true });
    expect(created).toHaveLength(1);
    expect(created[0]!.type).toBe("withmarfa.captured_email");
    expect(created[0]!.properties).toMatchObject({
      from_address: "sender@example.com",
      from_name: "Test Sender",
      to_address: "capture@inbox.marfa.so",
      subject: "Read this later",
      text_body: "Interesting article: https://example.com/x",
      body: "Interesting article: https://example.com/x",
      message_id: "<CAabc123@mail.gmail.com>",
      sent_at: "2026-05-24T15:00:00Z",
    });
    // source_id is the Message-ID — threads the (source, source_id)
    // natural-key contract so re-delivery resolves to the same item.
    expect(created[0]!.source_id).toBe("<CAabc123@mail.gmail.com>");
    const summary = emitted.at(-1);
    expect(summary?.properties?.summary).toMatch(/captured email itm_\d+/);
  });

  it("dedupes duplicate deliveries via the bounded ring keyed on Message-ID", async () => {
    const { ctx, created, emitted } = buildContext();
    await handleInboxWebhook(
      ctx,
      makeWebhookMessage(FROM_SENDER, "<CAabc123@mail.gmail.com>"),
    );
    expect(created).toHaveLength(1);

    // Send the same Message-ID again with a different header-level
    // delivery id — handler dedupes on the envelope's message_id.
    await handleInboxWebhook(
      ctx,
      makeWebhookMessage(FROM_SENDER, "different-delivery-header"),
    );
    expect(created).toHaveLength(1);
    expect(emitted.at(-1)?.properties?.summary).toBe(
      "withmarfa.inbox: duplicate delivery <CAabc123@mail.gmail.com> ignored",
    );
  });

  it("falls back to header delivery id when Message-ID is absent", async () => {
    const { ctx, created } = buildContext();
    const noMsgId = { ...FROM_SENDER };
    delete (noMsgId as Record<string, unknown>).message_id;
    await handleInboxWebhook(
      ctx,
      makeWebhookMessage(noMsgId, "envelope-only-delivery"),
    );
    // Item still created — fall-back path lands fine.
    expect(created).toHaveLength(1);
    // source_id absent because there's no Message-ID.
    expect(created[0]!.source_id).toBeUndefined();
  });

  it("rejects an envelope missing required from / to", async () => {
    const { ctx, created, emitted } = buildContext();
    const result = await handleInboxWebhook(
      ctx,
      makeWebhookMessage({ subject: "no recipients" }, "no-from-to"),
    );
    expect(result).toEqual({
      ok: false,
      retry: false,
      reason: "envelope_invalid",
    });
    expect(created).toHaveLength(0);
    expect(emitted[0]?.properties?.severity).toBe("action_required");
  });

  it("returns parse_failed (no retry) on malformed body", async () => {
    const { ctx, emitted } = buildContext();
    const broken: WebhookHandlerInput = {
      delivery_id: "delivery_bad",
      headers: {
        "X-Marfa-Signature": "sha256=stub",
        "X-Marfa-Delivery-Id": "delivery_bad",
      },
      body: new TextEncoder().encode("not-json").buffer,
      verified_at_ms: Date.now(),
    };
    const result = await handleInboxWebhook(ctx, broken);
    expect(result).toEqual({
      ok: false,
      retry: false,
      reason: "parse_failed",
    });
    expect(emitted[0]?.properties?.severity).toBe("action_required");
  });

  it("retries on Marfa-side createItem failure (delivery NOT recorded)", async () => {
    const { ctx, created, emitted } = buildContext({ failCreate: true });
    const r1 = await handleInboxWebhook(
      ctx,
      makeWebhookMessage(FROM_SENDER, "<CAabc123@mail.gmail.com>"),
    );
    expect(r1).toEqual({
      ok: false,
      retry: true,
      reason: "create_failed",
    });
    expect(created).toHaveLength(0);
    expect(
      emitted.some((e) => e.properties?.severity === "action_required"),
    ).toBe(true);

    // Retry should NOT dedupe — delivery wasn't recorded.
    const r2 = await handleInboxWebhook(
      ctx,
      makeWebhookMessage(FROM_SENDER, "<CAabc123@mail.gmail.com>"),
    );
    expect(r2).toEqual({ ok: true });
    expect(created).toHaveLength(1);
  });

  it("accepts headers in lowercase form (Hono normalization)", async () => {
    const { ctx, created } = buildContext();
    await handleInboxWebhook(
      ctx,
      makeWebhookMessage(FROM_SENDER, "<lower@example.com>", {
        lowercase: true,
      }),
    );
    expect(created).toHaveLength(1);
  });

  it("handles an envelope without a body", async () => {
    const { ctx, created } = buildContext();
    await handleInboxWebhook(
      ctx,
      makeWebhookMessage(ENVELOPE_NO_BODY, "<empty-body@example.com>"),
    );
    expect(created).toHaveLength(1);
    expect(created[0]!.properties?.text_body).toBeUndefined();
    expect(created[0]!.properties?.body).toBe("");
    expect(created[0]!.properties?.subject).toBe("Empty body case");
  });

  it("delivery ring stays bounded at DELIVERY_RING_SIZE", async () => {
    const { ctx } = buildContext();
    const seeded = Array.from(
      { length: DELIVERY_RING_SIZE },
      (_, i) => `seed_${String(i)}`,
    );
    await ctx.cursor.write("delivery_ring", { ids: seeded });

    await handleInboxWebhook(
      ctx,
      makeWebhookMessage(FROM_SENDER, "<CAabc123@mail.gmail.com>"),
    );
    const ring = (await ctx.cursor.read("delivery_ring")) as { ids: string[] };
    expect(ring.ids).toHaveLength(DELIVERY_RING_SIZE);
    expect(ring.ids.includes("seed_0")).toBe(false);
    expect(ring.ids.at(-1)).toBe("<CAabc123@mail.gmail.com>");
  });

  it("buildCapturedEmail filters incomplete attachments", () => {
    const input = __internals.buildCapturedEmail(
      ENVELOPE_WITH_ATTACHMENTS,
      "sender@example.com",
      "capture@inbox.marfa.so",
    );
    expect(input.properties?.attachments).toEqual([
      {
        filename: "report.pdf",
        mime_type: "application/pdf",
        size_bytes: 14523,
      },
      {
        filename: "spreadsheet.xlsx",
        mime_type:
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        size_bytes: 89012,
      },
    ]);
  });

  it("buildCapturedEmail mirrors text_body → body for core.note compatibility", () => {
    const input = __internals.buildCapturedEmail(
      { from: { address: "x" }, to: "y", text_body: "hello world" },
      "x",
      "y",
    );
    expect(input.properties?.text_body).toBe("hello world");
    expect(input.properties?.body).toBe("hello world");
  });

  it("buildCapturedEmail omits source_id when message_id absent", () => {
    const input = __internals.buildCapturedEmail(
      { from: { address: "x" }, to: "y" },
      "x",
      "y",
    );
    expect(input.source_id).toBeUndefined();
  });
});
