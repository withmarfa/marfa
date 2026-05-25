/**
 * Worker-side unit tests for the envelope-builder, signing path, and
 * Service-Binding dispatch shape (T-250). End-to-end (real MIME →
 * real CF Email Routing → real bound Worker) lives in the validation
 * harness at `_local/validate-mymehq-inbox.ts`; this file covers the
 * pure functions + the dispatch contract.
 */
import { describe, it, expect, vi } from "vitest";
import workerHandler, { __internals } from "./index.js";
import type { Email } from "postal-mime";

const { buildEnvelope, hmacSha256Hex, filterHeaders, SERVICE_BINDING_HOST } =
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
      to: [{ name: "", address: "capture@inbox.myme.so" }],
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
      { from: "sender@example.com", to: "capture@inbox.myme.so" },
      parsed,
    );

    expect(envelope.from).toEqual({
      address: "sender@example.com",
      name: "Test Sender",
    });
    expect(envelope.to).toBe("capture@inbox.myme.so");
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
      { from: "Someone@EXAMPLE.com", to: "capture@inbox.myme.so" },
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

// ---------------------------------------------------------------------------
// Service-Binding dispatch shape (T-250)
// ---------------------------------------------------------------------------

describe("email() — Service-Binding dispatch (T-250)", () => {
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
      to: "capture@inbox.myme.so",
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
    "To: capture@inbox.myme.so",
    "Subject: T-250 dispatch smoke",
    "Message-ID: <t250-smoke@example.com>",
    "Date: Sun, 24 May 2026 20:00:00 +0000",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Body bytes for the dispatch smoke.",
  ].join("\r\n");

  it("calls env.RUNTIME_CONTROL.fetch with the correct path, signature header, and JSON body", async () => {
    const fetchSpy = vi
      .fn<(request: Request) => Promise<Response>>()
      .mockResolvedValue(new Response("ok", { status: 200 }));
    const env = {
      RUNTIME_CONTROL: { fetch: fetchSpy } as unknown as Fetcher,
      CONNECTION_ID: "019e5acf-a55a-7c9b-8be9-ced0d1b9386b",
      WEBHOOK_SECRET: "shared-secret-for-test",
      ENVIRONMENT: "test",
    };

    await workerHandler.email(
      makeMessage(RFC822) as ForwardableEmailMessage,
      env,
    );

    expect(fetchSpy).toHaveBeenCalledOnce();
    const sent = fetchSpy.mock.calls[0]?.[0];
    if (!sent) throw new Error("expected RUNTIME_CONTROL.fetch to be called");
    // URL: synthetic host + the connection_id baked into the path
    expect(new URL(sent.url).pathname).toBe(
      "/webhooks/inbound/019e5acf-a55a-7c9b-8be9-ced0d1b9386b",
    );
    expect(sent.url.startsWith(SERVICE_BINDING_HOST)).toBe(true);
    expect(sent.method).toBe("POST");
    // Headers: signature shape + delivery id from Message-ID
    expect(sent.headers.get("Content-Type")).toBe("application/json");
    expect(sent.headers.get("X-Myme-Delivery-Id")).toBe(
      "<t250-smoke@example.com>",
    );
    expect(sent.headers.get("X-Myme-Signature")).toMatch(
      /^sha256=[0-9a-f]{64}$/,
    );
    // Body: a parseable envelope with the expected subject
    const body = await sent.json<{ subject: string; message_id: string }>();
    expect(body.subject).toBe("T-250 dispatch smoke");
    expect(body.message_id).toBe("<t250-smoke@example.com>");
  });

  it("ACKs (returns without throwing) when the binding rejects with a non-2xx", async () => {
    const fetchSpy = vi.fn(
      (): Promise<Response> =>
        Promise.resolve(new Response("nope", { status: 500 })),
    );
    const env = {
      RUNTIME_CONTROL: { fetch: fetchSpy } as unknown as Fetcher,
      CONNECTION_ID: "019e5acf-a55a-7c9b-8be9-ced0d1b9386b",
      WEBHOOK_SECRET: "s",
      ENVIRONMENT: "test",
    };
    await expect(
      workerHandler.email(makeMessage(RFC822) as ForwardableEmailMessage, env),
    ).resolves.toBeUndefined();
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it("ACKs when the binding throws (bound Worker missing / errored)", async () => {
    const fetchSpy = vi.fn(
      (): Promise<Response> =>
        Promise.reject(new Error("binding target not found")),
    );
    const env = {
      RUNTIME_CONTROL: { fetch: fetchSpy } as unknown as Fetcher,
      CONNECTION_ID: "019e5acf-a55a-7c9b-8be9-ced0d1b9386b",
      WEBHOOK_SECRET: "s",
      ENVIRONMENT: "test",
    };
    await expect(
      workerHandler.email(makeMessage(RFC822) as ForwardableEmailMessage, env),
    ).resolves.toBeUndefined();
    expect(fetchSpy).toHaveBeenCalledOnce();
  });
});
