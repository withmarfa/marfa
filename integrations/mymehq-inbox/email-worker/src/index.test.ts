/**
 * Worker-side unit tests for the envelope-builder and signing path.
 * End-to-end (real MIME → real upstream POST) lives in the validation
 * harness at `_local/validate-mymehq-inbox.ts`; this file covers the
 * pure functions.
 */
import { describe, it, expect } from "vitest";
import { __internals } from "./index.js";
import type { Email } from "postal-mime";

const { buildEnvelope, hmacSha256Hex, filterHeaders } = __internals;

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
      from: { name: "August Cayzer", address: "august@cayzer.me" },
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
      { from: "august@cayzer.me", to: "capture@inbox.myme.so" },
      parsed,
    );

    expect(envelope.from).toEqual({
      address: "august@cayzer.me",
      name: "August Cayzer",
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
