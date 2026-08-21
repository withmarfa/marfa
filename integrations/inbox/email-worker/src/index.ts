/**
 * Cloudflare Email Worker for the `marfa/inbox` integration.
 *
 * Pipeline:
 *   1. Cloudflare Email Routing matches the capture address (e.g.
 *      `capture@inbox.marfa.so`) and invokes `email()` on this Worker
 *      with the inbound `ForwardableEmailMessage`.
 *   2. We parse MIME via `postal-mime` into a structured envelope
 *      (from, to, subject, text/html bodies, headers, attachments).
 *   3. We HMAC-SHA256 the JSON body with `WEBHOOK_SECRET` (= the
 *      per-connection subscription secret on the Marfa server).
 *   4. POST the signed body over HTTPS to the Marfa server's webhook
 *      receipt route, `<MARFA_API_URL>/runtime/webhook/<CONNECTION_ID>`.
 *      The server's `cloudflare-email` adapter verifies the HMAC over
 *      the exact body bytes, idempotency-checks on the Message-ID, and
 *      enqueues a `WebhookMessage` for the `marfa/inbox` handler.
 *
 * This Worker exists because Email Routing can only deliver inbound
 * mail to a Worker or forward it to a mailbox; it cannot POST to a
 * server. It is a stateless translator from "email envelope" to
 * "signed JSON webhook", and the one Cloudflare Worker the hosted
 * deployment keeps.
 *
 * On a non-2xx response or a fetch failure, we LOG and ACK — throwing
 * would bounce the email. Cloudflare Email Routing offers at-least-
 * once delivery on its own retry path; the receiver-side Message-ID
 * idempotency makes duplicate forwards safe.
 *
 * Attachments: v1 captures metadata only (`filename`, `mime_type`,
 * `size_bytes`). Attachment content is not included in the JSON
 * envelope — that would balloon the webhook body well past the
 * substrate's small-body fast path. Blob upload can be wired once
 * the runtime SDK ships an `uploadBlob` primitive.
 */
import PostalMime, {
  type Email,
  type Header,
  type Attachment,
} from "postal-mime";

interface Env {
  /**
   * The Marfa server's public API origin (e.g. `https://api.marfa.so`),
   * set as a deploy-time secret alongside the two below. Same name and
   * meaning as the `MARFA_API_URL` every integration Worker held on the
   * retired hosted substrate.
   */
  MARFA_API_URL: string;
  /**
   * The `system.connection` id this Email Worker dispatches against.
   * Baked in at deploy time (one Email Worker per Connection in the v1
   * single-space shape). Forms the receipt path:
   * `/runtime/webhook/<CONNECTION_ID>`.
   */
  CONNECTION_ID: string;
  /**
   * Per-connection subscription secret. Same value the Marfa server
   * stores encrypted under `inbound_webhooks.secret_encrypted`. The
   * `cloudflare-email` verification adapter HMACs the body and
   * compares against the `X-Marfa-Signature` header.
   */
  WEBHOOK_SECRET: string;
  /** Deployment label (`dev` / `staging` / `prod`) — log enrichment only. */
  ENVIRONMENT?: string;
}

/** JSON envelope wire shape. Mirrors `marfa.captured_email`'s
 *  property bag — the integration handler decodes this and lands it
 *  as an item without further translation. */
export interface EmailEnvelope {
  from: { address: string; name?: string };
  to: string;
  subject: string;
  text_body?: string;
  html_body?: string;
  sent_at?: string;
  message_id?: string;
  in_reply_to?: string;
  references?: string[];
  headers: Record<string, string>;
  attachments: { filename: string; mime_type: string; size_bytes: number }[];
}

/** Allowlist of headers that flow through to the envelope. Everything
 *  else is dropped at the Worker — keeps the wire shape bounded +
 *  avoids leaking internal routing metadata. */
const HEADER_ALLOWLIST = new Set<string>([
  "list-id",
  "list-unsubscribe",
  "list-unsubscribe-post",
  "reply-to",
  "return-path",
  "x-mailer",
]);

/** Bound on the receipt POST. The email() handler has no caller waiting
 *  on it, but an unbounded fetch against an unresponsive server would
 *  pin the invocation until the platform kills it; a bounded one fails
 *  into the same log-and-ack path as any other dispatch error. */
const DISPATCH_TIMEOUT_MS = 15_000;

/** The server's webhook receipt route for this connection. The origin
 *  is normalized so a trailing slash on the configured URL cannot
 *  produce a `//runtime` path the server would 404. */
export function buildReceiptUrl(apiUrl: string, connectionId: string): string {
  return `${apiUrl.replace(/\/+$/, "")}/runtime/webhook/${connectionId}`;
}

export default {
  async email(message: ForwardableEmailMessage, env: Env): Promise<void> {
    if (
      typeof env.MARFA_API_URL !== "string" ||
      env.MARFA_API_URL.length === 0
    ) {
      // Misconfiguration, not a transient fault. ACK so mail is not
      // bounced while the deployment is being fixed; the log line is
      // the operator's signal.
      console.error(
        `[email-worker] MARFA_API_URL is not set env=${env.ENVIRONMENT ?? "unknown"}; dropping delivery`,
      );
      return;
    }

    let parsed: Email;
    try {
      const arrayBuffer = await new Response(message.raw).arrayBuffer();
      parsed = await PostalMime.parse(arrayBuffer);
    } catch (err) {
      // A malformed MIME blob is rare but possible — log + ACK.
      console.error(
        `[email-worker] parse failed env=${env.ENVIRONMENT ?? "unknown"} from=${message.from} err=${describeError(err)}`,
      );
      return;
    }

    const envelope = buildEnvelope(message, parsed);
    const body = JSON.stringify(envelope);
    const signatureHex = await hmacSha256Hex(env.WEBHOOK_SECRET, body);
    const deliveryId = envelope.message_id ?? crypto.randomUUID();
    const url = buildReceiptUrl(env.MARFA_API_URL, env.CONNECTION_ID);

    let resp: Response;
    try {
      resp = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Marfa-Signature": `sha256=${signatureHex}`,
          "X-Marfa-Delivery-Id": deliveryId,
          "User-Agent": "withmarfa-inbox-email-worker/0.3.0",
        },
        body,
        signal: AbortSignal.timeout(DISPATCH_TIMEOUT_MS),
      });
    } catch (err) {
      // Network-level failure or timeout. ACK rather than bouncing —
      // at-least-once retries via the server-side idempotency map
      // make duplicate forwards safe.
      console.error(
        `[email-worker] server dispatch failed env=${env.ENVIRONMENT ?? "unknown"} delivery=${deliveryId} err=${describeError(err)}`,
      );
      return;
    }

    if (!resp.ok) {
      const text = await safeReadText(resp);
      console.error(
        `[email-worker] server non-2xx env=${env.ENVIRONMENT ?? "unknown"} status=${String(resp.status)} delivery=${deliveryId} body=${text.slice(0, 256)}`,
      );
      return;
    }

    // Quiet success log — useful when tailing Worker logs.
    console.log(
      `[email-worker] dispatched env=${env.ENVIRONMENT ?? "unknown"} delivery=${deliveryId} subject="${envelope.subject.slice(0, 80)}"`,
    );
  },
};

export function buildEnvelope(
  message: { from: string; to: string },
  parsed: Email,
): EmailEnvelope {
  const fromAddress = pickFromAddress(parsed, message.from);
  const fromName = pickFromName(parsed);
  const subject = typeof parsed.subject === "string" ? parsed.subject : "";

  const envelope: EmailEnvelope = {
    from:
      fromName === undefined
        ? { address: fromAddress }
        : { address: fromAddress, name: fromName },
    to: message.to,
    subject,
    headers: filterHeaders(parsed.headers),
    attachments: extractAttachments(parsed.attachments),
  };

  if (typeof parsed.text === "string" && parsed.text.length > 0) {
    envelope.text_body = parsed.text;
  }
  if (typeof parsed.html === "string" && parsed.html.length > 0) {
    envelope.html_body = parsed.html;
  }
  if (typeof parsed.date === "string" && parsed.date.length > 0) {
    envelope.sent_at = parsed.date;
  }
  if (typeof parsed.messageId === "string" && parsed.messageId.length > 0) {
    envelope.message_id = parsed.messageId;
  }
  if (typeof parsed.inReplyTo === "string" && parsed.inReplyTo.length > 0) {
    envelope.in_reply_to = parsed.inReplyTo;
  }
  // `References:` is a single space-separated header value per postal-mime;
  // split into an array for the envelope. Each entry should be a
  // <Message-ID> form per RFC 5322.
  if (typeof parsed.references === "string" && parsed.references.length > 0) {
    const refs = parsed.references
      .split(/\s+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (refs.length > 0) envelope.references = refs;
  }
  return envelope;
}

function extractAttachments(
  attachments: Attachment[] | undefined,
): EmailEnvelope["attachments"] {
  if (!Array.isArray(attachments)) return [];
  const out: EmailEnvelope["attachments"] = [];
  for (const a of attachments) {
    // Skip inline parts with no filename or MIME type.
    if (
      typeof a.filename !== "string" ||
      a.filename.length === 0 ||
      typeof a.mimeType !== "string" ||
      a.mimeType.length === 0
    ) {
      continue;
    }
    let sizeBytes: number;
    if (typeof a.content === "string") {
      // Approximate base64 → byte length without decoding the content.
      sizeBytes = Math.floor((a.content.length * 3) / 4);
    } else if (a.content instanceof ArrayBuffer) {
      sizeBytes = a.content.byteLength;
    } else {
      sizeBytes = a.content.byteLength; // Uint8Array
    }
    out.push({
      filename: a.filename,
      mime_type: a.mimeType,
      size_bytes: sizeBytes,
    });
  }
  return out;
}

function pickFromAddress(parsed: Email, fallback: string): string {
  const from = parsed.from;
  // postal-mime's `from` is typed `Address | undefined`. An Address
  // is either a `Mailbox` (carries `.address`) or a group form
  // (`{ name, group: Mailbox[], address: undefined }`). Discriminate
  // on `address` being a non-empty string.
  if (from !== undefined && typeof from.address === "string") {
    const addr = from.address;
    if (addr.length > 0) return addr.toLowerCase();
  }
  return fallback.toLowerCase();
}

function pickFromName(parsed: Email): string | undefined {
  const from = parsed.from;
  if (from !== undefined && typeof from.name === "string") {
    const name = from.name;
    if (name.length > 0) return name;
  }
  return undefined;
}

function filterHeaders(headers: Header[] | undefined): Record<string, string> {
  if (!Array.isArray(headers)) return {};
  const out: Record<string, string> = {};
  for (const h of headers) {
    if (typeof h.key !== "string" || typeof h.value !== "string") continue;
    // postal-mime lowercases `Header.key`; the allowlist is lower-keyed to match.
    if (HEADER_ALLOWLIST.has(h.key)) out[h.key] = h.value;
  }
  return out;
}

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(message),
  );
  const bytes = new Uint8Array(sig);
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex;
}

function describeError(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}

async function safeReadText(resp: Response): Promise<string> {
  try {
    return await resp.text();
  } catch {
    return "<no-body>";
  }
}

export const __internals = {
  buildEnvelope,
  hmacSha256Hex,
  filterHeaders,
  buildReceiptUrl,
};
