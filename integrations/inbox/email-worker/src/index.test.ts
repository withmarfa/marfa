/**
 * Worker-side unit tests for the envelope-builder, signing path, and
 * the HTTPS dispatch to the server's webhook receipt route. End-to-end
 * (real MIME → real CF Email Routing → real server) lives in the
 * validation harness; this file covers the pure functions + the
 * dispatch contract.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import workerHandler, { __internals } from "./index.js";
import type { Email } from "postal-mime";

const { buildEnvelope, hmacSha256Hex, filterHeaders, buildReceiptUrl } =
  __internals;

function makeEmail(overrides: Partial<Email>): Email {
  // postal-mime's Email type requires `headers`, `headerLines`,
  // `attachments` to be arrays — every other field is optional. Build
  // the minimum + spread the test-supplied overrides.
  return {
    headers: [],
    headerLines: [],
    attachments: [],
    ...overrides,
  };
}

describe("buildEnvelope", () => {
  it("constructs the wire shape from a fully-populated postal-mime parse", () => {
    const parsed = makeEmail({
      from: { name: "Test Sender", address: "sender@example.com" },
      to: [{ name: "", address: "capture@inbox.marfa.so" }],
      subject: "Test capture",
      text: "Plain body",
      html: "<p>Plain body</p>",
      messageId: "<abc123@mail.gmail.com>",
      date: "2026-05-24T15:00:00Z",
      inReplyTo: "<prev@mail.gmail.com>",
      references: "<root@mail.gmail.com> <prev@mail.gmail.com>",
      headers: [
        {
          key: "list-id",
          originalKey: "List-Id",
          value: "<my-list.example.com>",
        },
        { key: "x-mailer", originalKey: "X-Mailer", value: "Mail/16.0" },
        { key: "x-spam-score", originalKey: "X-Spam-Score", value: "0.0" }, // not in allowlist
      ],
      attachments: [
        {
          filename: "doc.pdf",
          mimeType: "application/pdf",
          disposition: "attachment",
          content: new ArrayBuffer(2048),
        },
        // Filtered — missing mimeType
        {
          filename: "no-mime",
          mimeType: "",
          disposition: "attachment",
          content: new ArrayBuffer(8),
        },
        // Filtered — null filename (inline part)
        {
          filename: null,
          mimeType: "image/png",
          disposition: "inline",
          content: new ArrayBuffer(16),
        },
      ],
    });

    const envelope = buildEnvelope(
      { from: "sender@example.com", to: "capture@inbox.marfa.so" },
      parsed,
    );

    expect(envelope.from).toEqual({
      address: "sender@example.com",
      name: "Test Sender",
    });
    expect(envelope.to).toBe("capture@inbox.marfa.so");
    expect(envelope.subject).toBe("Test capture");
    expect(envelope.text_body).toBe("Plain body");
    expect(envelope.html_body).toBe("<p>Plain body</p>");
    expect(envelope.sent_at).toBe("2026-05-24T15:00:00Z");
    expect(envelope.message_id).toBe("<abc123@mail.gmail.com>");
    expect(envelope.in_reply_to).toBe("<prev@mail.gmail.com>");
    expect(envelope.references).toEqual([
      "<root@mail.gmail.com>",
      "<prev@mail.gmail.com>",
    ]);
    expect(envelope.headers).toEqual({
      "list-id": "<my-list.example.com>",
      "x-mailer": "Mail/16.0",
    });
    expect(envelope.attachments).toEqual([
      { filename: "doc.pdf", mime_type: "application/pdf", size_bytes: 2048 },
    ]);
  });

  it("falls back to message.from when postal-mime's from is absent", () => {
    const parsed = makeEmail({ subject: "Subj" });
    const envelope = buildEnvelope(
      { from: "Someone@EXAMPLE.com", to: "capture@inbox.marfa.so" },
      parsed,
    );
    // Lower-cased
    expect(envelope.from.address).toBe("someone@example.com");
    expect(envelope.from.name).toBeUndefined();
    expect(envelope.subject).toBe("Subj");
    expect(envelope.text_body).toBeUndefined();
    expect(envelope.html_body).toBeUndefined();
    expect(envelope.message_id).toBeUndefined();
    expect(envelope.attachments).toEqual([]);
  });
});

describe("filterHeaders", () => {
  it("keeps allowlisted headers only and uses the lowercase key", () => {
    const result = filterHeaders([
      {
        key: "reply-to",
        originalKey: "Reply-To",
        value: "noreply@example.com",
      },
      { key: "x-mailer", originalKey: "X-Mailer", value: "Mail/16" },
      { key: "x-trace", originalKey: "X-Trace", value: "secret-id-123" },
      {
        key: "list-unsubscribe",
        originalKey: "List-Unsubscribe",
        value: "<mailto:u@example.com>",
      },
    ]);
    expect(result).toEqual({
      "reply-to": "noreply@example.com",
      "x-mailer": "Mail/16",
      "list-unsubscribe": "<mailto:u@example.com>",
    });
  });

  it("returns empty when headers absent", () => {
    expect(filterHeaders(undefined)).toEqual({});
  });
});

describe("hmacSha256Hex", () => {
  it("produces a 64-character hex digest", async () => {
    const sig = await hmacSha256Hex("topsecret", "hello world");
    expect(sig).toHaveLength(64);
    expect(/^[0-9a-f]+$/.test(sig)).toBe(true);
  });

  it("is deterministic for the same inputs", async () => {
    const a = await hmacSha256Hex("s", "body");
    const b = await hmacSha256Hex("s", "body");
    expect(a).toBe(b);
  });

  it("changes when the body changes", async () => {
    const a = await hmacSha256Hex("s", "body1");
    const b = await hmacSha256Hex("s", "body2");
    expect(a).not.toBe(b);
  });
});

describe("buildReceiptUrl", () => {
  it("joins origin and path", () => {
    expect(buildReceiptUrl("https://api.marfa.so", "abc")).toBe(
      "https://api.marfa.so/runtime/webhook/abc",
    );
  });

  it("normalizes a trailing slash on the origin", () => {
    expect(buildReceiptUrl("https://api.marfa.so/", "abc")).toBe(
      "https://api.marfa.so/runtime/webhook/abc",
    );
  });
});

// ---------------------------------------------------------------------------
// HTTPS dispatch to the server's webhook receipt route
// ---------------------------------------------------------------------------

describe("email() — server dispatch", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  // Build a fake `ForwardableEmailMessage` shaped enough that
  // postal-mime parses the raw stream and the handler reaches the
  // dispatch step.
  function makeMessage(rawRfc822: string): {
    from: string;
    to: string;
    raw: ReadableStream<Uint8Array>;
  } {
    const bytes = new TextEncoder().encode(rawRfc822);
    return {
      from: "sender@example.com",
      to: "capture@inbox.marfa.so",
      raw: new ReadableStream({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      }),
    };
  }

  const RFC822 = [
    "From: sender@example.com",
    "To: capture@inbox.marfa.so",
    "Subject: Server dispatch smoke",
    "Message-ID: <server-dispatch-smoke@example.com>",
    "Date: Sun, 24 May 2026 20:00:00 +0000",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Body bytes for the dispatch smoke.",
  ].join("\r\n");

  const ENV = {
    MARFA_API_URL: "https://api.test.example",
    CONNECTION_ID: "019e5acf-a55a-7c9b-8be9-ced0d1b9386b",
    WEBHOOK_SECRET: "shared-secret-for-test",
    ENVIRONMENT: "test",
  };

  it("POSTs to the server's receipt route with the signature header and JSON body", async () => {
    const fetchSpy = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);

    await workerHandler.email(
      makeMessage(RFC822) as ForwardableEmailMessage,
      ENV,
    );

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0] ?? [];
    if (typeof url !== "string" || init === undefined)
      throw new Error("expected fetch(url, init) to be called");
    expect(url).toBe(
      "https://api.test.example/runtime/webhook/019e5acf-a55a-7c9b-8be9-ced0d1b9386b",
    );
    expect(init.method).toBe("POST");
    // Headers: signature shape + delivery id from Message-ID
    const headers = new Headers(init.headers);
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(headers.get("X-Marfa-Delivery-Id")).toBe(
      "<server-dispatch-smoke@example.com>",
    );
    expect(headers.get("X-Marfa-Signature")).toMatch(/^sha256=[0-9a-f]{64}$/);
    // The dispatch is bounded; an unresponsive server must not pin the
    // invocation open.
    expect(init.signal).toBeInstanceOf(AbortSignal);
    // Body: the implementation passes a pre-serialized string (the exact
    // bytes the HMAC covers), so anything else here is itself a failure.
    if (typeof init.body !== "string")
      throw new Error("expected a string body");
    const body = JSON.parse(init.body) as {
      subject: string;
      message_id: string;
    };
    expect(body.subject).toBe("Server dispatch smoke");
    expect(body.message_id).toBe("<server-dispatch-smoke@example.com>");
  });

  it("ACKs (returns without throwing) when the server answers non-2xx", async () => {
    const fetchSpy = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("nope", { status: 500 }));
    vi.stubGlobal("fetch", fetchSpy);
    await expect(
      workerHandler.email(makeMessage(RFC822) as ForwardableEmailMessage, ENV),
    ).resolves.toBeUndefined();
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it("ACKs when the fetch itself fails (network error / timeout)", async () => {
    const fetchSpy = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error("connect timeout"));
    vi.stubGlobal("fetch", fetchSpy);
    await expect(
      workerHandler.email(makeMessage(RFC822) as ForwardableEmailMessage, ENV),
    ).resolves.toBeUndefined();
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it("ACKs and never dispatches when MARFA_API_URL is unset", async () => {
    const fetchSpy = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchSpy);
    const env = { ...ENV, MARFA_API_URL: "" };
    await expect(
      workerHandler.email(makeMessage(RFC822) as ForwardableEmailMessage, env),
    ).resolves.toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
