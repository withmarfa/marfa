import { describe, expect, it, vi } from "vitest";
import { CloudflareTransport } from "./cloudflare-backend.js";
import type { EmailMessage } from "./transport.js";

type FetchArgs = Parameters<typeof fetch>;

function getCall(mock: ReturnType<typeof vi.fn>, idx: number): FetchArgs {
  return mock.mock.calls[idx] as FetchArgs;
}

function getBody(args: FetchArgs): Record<string, unknown> {
  const init = args[1];
  if (!init || typeof init.body !== "string") {
    throw new Error("expected stringified body");
  }
  return JSON.parse(init.body) as Record<string, unknown>;
}

function getHeaders(args: FetchArgs): Record<string, string> {
  const init = args[1];
  if (!init) throw new Error("expected init");
  return init.headers as Record<string, string>;
}

function makeMessage(overrides: Partial<EmailMessage> = {}): EmailMessage {
  return {
    to: "alice@gmail.com",
    subject: "Reset your password",
    html: "<p>Click the link</p>",
    text: "Click the link",
    idempotencyKey: "reset-password/user-123/token-abc",
    tags: { template: "reset-password" },
    ...overrides,
  };
}

function jsonResponse(body: unknown, init: { status?: number } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("CloudflareTransport", () => {
  it("POSTs to the CF send endpoint with bearer auth and the expected body", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        success: true,
        result: { delivered: ["alice@gmail.com"] },
      }),
    );
    const transport = new CloudflareTransport({
      accountId: "acct_123",
      apiToken: "tok_456",
      from: "Marfa <hello@mail.marfa.so>",
      replyTo: "support@mail.marfa.so",
      fetchImpl,
    });

    const result = await transport.send(makeMessage());

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.messageId).toMatch(/^cf_[a-f0-9]{24}$/);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const args = getCall(fetchImpl, 0);
    expect(args[0]).toBe(
      "https://api.cloudflare.com/client/v4/accounts/acct_123/email/sending/send",
    );
    expect(args[1]?.method).toBe("POST");
    const headers = getHeaders(args);
    expect(headers.Authorization).toBe("Bearer tok_456");
    expect(headers["Content-Type"]).toBe("application/json");

    expect(getBody(args)).toEqual({
      from: "Marfa <hello@mail.marfa.so>",
      to: "alice@gmail.com",
      subject: "Reset your password",
      html: "<p>Click the link</p>",
      text: "Click the link",
      reply_to: "support@mail.marfa.so",
    });
  });

  it("omits optional text and reply_to when not provided", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ success: true, result: { delivered: ["a@b.co"] } }),
      );
    const transport = new CloudflareTransport({
      accountId: "acct_123",
      apiToken: "tok_456",
      from: "hello@mail.marfa.so",
      fetchImpl,
    });

    await transport.send(
      makeMessage({ to: "a@b.co", text: undefined, replyTo: undefined }),
    );

    const body = getBody(getCall(fetchImpl, 0));
    expect(body.text).toBeUndefined();
    expect(body.reply_to).toBeUndefined();
  });

  it("prefers message.replyTo over the default", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ success: true, result: { delivered: ["a@b.co"] } }),
      );
    const transport = new CloudflareTransport({
      accountId: "acct_123",
      apiToken: "tok_456",
      from: "hello@mail.marfa.so",
      replyTo: "default@mail.marfa.so",
      fetchImpl,
    });

    await transport.send(makeMessage({ replyTo: "override@mail.marfa.so" }));
    const body = getBody(getCall(fetchImpl, 0));
    expect(body.reply_to).toBe("override@mail.marfa.so");
  });

  it("returns retryable: false on 200 with non-empty permanent_bounces", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        success: true,
        result: {
          delivered: [],
          queued: [],
          permanent_bounces: ["alice@gmail.com"],
        },
      }),
    );
    const transport = new CloudflareTransport({
      accountId: "acct",
      apiToken: "tok",
      from: "hello@mail.marfa.so",
      fetchImpl,
    });

    const result = await transport.send(makeMessage());
    expect(result).toEqual({
      ok: false,
      error: "permanent_bounce",
      retryable: false,
    });
  });

  it("returns retryable: false on 4xx", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(
        {
          success: false,
          errors: [
            {
              code: 10001,
              message: "email.sending.error.invalid_request_schema",
            },
          ],
        },
        { status: 400 },
      ),
    );
    const transport = new CloudflareTransport({
      accountId: "acct",
      apiToken: "tok",
      from: "hello@mail.marfa.so",
      fetchImpl,
    });

    const result = await transport.send(makeMessage());
    expect(result).toEqual({
      ok: false,
      error: "email.sending.error.invalid_request_schema",
      retryable: false,
    });
  });

  it("returns retryable: true on 5xx", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(
        {
          success: false,
          errors: [{ code: 99999, message: "internal" }],
        },
        { status: 503 },
      ),
    );
    const transport = new CloudflareTransport({
      accountId: "acct",
      apiToken: "tok",
      from: "hello@mail.marfa.so",
      fetchImpl,
    });

    const result = await transport.send(makeMessage());
    expect(result).toEqual({
      ok: false,
      error: "internal",
      retryable: true,
    });
  });

  it("returns retryable: true on 429", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(
        {
          success: false,
          errors: [{ code: 10013, message: "rate limited" }],
        },
        { status: 429 },
      ),
    );
    const transport = new CloudflareTransport({
      accountId: "acct",
      apiToken: "tok",
      from: "hello@mail.marfa.so",
      fetchImpl,
    });

    const result = await transport.send(makeMessage());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.retryable).toBe(true);
  });

  it("returns retryable: true on fetch network error", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("ECONNRESET"));
    const transport = new CloudflareTransport({
      accountId: "acct",
      apiToken: "tok",
      from: "hello@mail.marfa.so",
      fetchImpl,
    });

    const result = await transport.send(makeMessage());
    expect(result).toEqual({
      ok: false,
      error: "cloudflare_network_error",
      retryable: true,
    });
  });

  it("throws when idempotencyKey is missing", async () => {
    const transport = new CloudflareTransport({
      accountId: "acct",
      apiToken: "tok",
      from: "hello@mail.marfa.so",
      fetchImpl: vi.fn(),
    });

    await expect(
      transport.send(makeMessage({ idempotencyKey: "" })),
    ).rejects.toThrow("idempotencyKey is required");
  });

  it("produces a stable synthetic messageId per idempotency key", async () => {
    const fetchImpl = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(
          jsonResponse({ success: true, result: { delivered: ["a@b.co"] } }),
        ),
      );
    const transport = new CloudflareTransport({
      accountId: "acct",
      apiToken: "tok",
      from: "hello@mail.marfa.so",
      fetchImpl,
    });

    const r1 = await transport.send(
      makeMessage({ idempotencyKey: "k1", to: "a@b.co" }),
    );
    const r2 = await transport.send(
      makeMessage({ idempotencyKey: "k1", to: "a@b.co" }),
    );
    const r3 = await transport.send(
      makeMessage({ idempotencyKey: "k2", to: "a@b.co" }),
    );

    expect(r1.ok && r2.ok && r3.ok).toBe(true);
    if (r1.ok && r2.ok) expect(r1.messageId).toBe(r2.messageId);
    if (r1.ok && r3.ok) expect(r1.messageId).not.toBe(r3.messageId);
  });
});
