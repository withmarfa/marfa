/**
 * Cloudflare Email Service backend — production transactional email transport
 * for hosted Myme. REST API only — the Atlas server runs on Node, not in a
 * Worker, so the `send_email` Worker binding isn't an option.
 *
 * Endpoint: `POST /client/v4/accounts/{account_id}/email/sending/send`.
 * Authentication: `Authorization: Bearer <CLOUDFLARE_EMAIL_API_TOKEN>` —
 * a token with the "Send Email" permission scoped to the myme account.
 *
 * # Idempotency
 *
 * CF Email Service does NOT document any send-time idempotency header
 * (verified against the REST API reference as of 2026-05-15). We do not
 * attach any header to request server-side dedup. Implication: a transient
 * retry of the same send (network error + retry-with-same-idempotency-key
 * from the caller) can produce duplicate deliveries.
 *
 * Acceptable for the three transactional flows wired today:
 *   - forgot-password — recipient gets two emails with the same reset
 *     token; clicking either lands on the same reset form. The token is
 *     single-use server-side, so only the first click succeeds.
 *   - email-verify — same shape: same single-use token, second click
 *     fails idempotently.
 *   - magic-link — same shape: single-use token; second link fails after
 *     first consumes it.
 *
 * The `message.idempotencyKey` field stays mandatory on the EmailMessage
 * contract for callers — it threads through to the synthesised
 * `messageId` for log-correlation continuity (never logged directly) —
 * but it does not influence the CF send path. Revisit if CF ships an
 * idempotency header (track via the CF Email changelog) or if a flow
 * lands that can't tolerate a duplicate.
 *
 * # Suppression
 *
 * CF maintains hard-bounce suppression internally across the account.
 * Sends to a suppressed address return a 4xx from CF; we surface it as
 * `{ ok: false, retryable: false }` and structured-log. No server-side
 * `email_suppressions` table — that surface was removed alongside the
 * prior backend (T-107).
 *
 * # Structured logging on non-2xx
 *
 * Logged: HTTP status code, CF error code (`response.errors[0].code`),
 * CF error message, recipient *domain* only (e.g. `"gmail.com"`),
 * backend identifier (`"cloudflare"`), tags from `EmailMessage.tags`
 * (template, trigger — already non-PII).
 *
 * NEVER logged: full recipient address (local-part is PII), email body
 * (html / text), subject line (may carry user-specific tokens or names),
 * idempotency-key contents (may carry user id / token jti).
 *
 * Privacy posture: the prior backend kept structured per-recipient
 * suppression records server-side; we now rely on CF's internal list,
 * so server logs MUST NOT introduce a parallel PII trail through the
 * back door.
 *
 * # Response shape (verified live against the open-beta API)
 *
 * Success (2xx): `{ success: true, result: { delivered: [addr...],
 * queued: [addr...], permanent_bounces: [addr...] } }`. CF does not
 * return a native per-send message id, so we synthesise one for
 * `EmailSendResult.messageId` by hashing the idempotency key — gives
 * log-correlation continuity even without a CF-side identifier.
 *
 * `permanent_bounces` is non-empty when CF rejected the recipient
 * upstream (CF's internal suppression list, invalid mailbox, etc.) —
 * the HTTP status is still 200, but we surface as
 * `{ ok: false, retryable: false, error: "permanent_bounce" }` so the
 * caller doesn't treat it as a successful send.
 *
 * Error (4xx/5xx): `{ success: false, errors: [{ code, message }] }`.
 * 5xx / 429 / fetch-network errors map to `retryable: true`; 4xx maps
 * to `retryable: false`.
 */
import type {
  EmailMessage,
  EmailSendResult,
  EmailTransport,
  EmailTransportConfig,
} from "./transport.js";
import { log } from "../middleware/logger.js";
import { createHash } from "node:crypto";

interface CloudflareSendResponse {
  success: boolean;
  errors?: { code: number; message: string }[];
  result?: {
    delivered?: string[];
    permanent_bounces?: string[];
    queued?: string[];
  } | null;
}

export class CloudflareTransport implements EmailTransport {
  readonly backend = "cloudflare" as const;

  private readonly accountId: string;
  private readonly apiToken: string;
  private readonly from: string;
  private readonly defaultReplyTo?: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: {
    accountId: string;
    apiToken: string;
    from: string;
    replyTo?: string;
    /** Test-injection hook. Production callers leave this undefined. */
    fetchImpl?: typeof fetch;
  }) {
    this.accountId = opts.accountId;
    this.apiToken = opts.apiToken;
    this.from = opts.from;
    this.defaultReplyTo = opts.replyTo;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  }

  async send(message: EmailMessage): Promise<EmailSendResult> {
    if (!message.idempotencyKey) {
      throw new Error("EmailMessage.idempotencyKey is required");
    }

    const replyTo = message.replyTo ?? this.defaultReplyTo;
    const body: Record<string, unknown> = {
      from: this.from,
      to: message.to,
      subject: message.subject,
      html: message.html,
    };
    if (message.text) body.text = message.text;
    if (replyTo) body.reply_to = replyTo;

    const url = `https://api.cloudflare.com/client/v4/accounts/${this.accountId}/email/sending/send`;

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      log("warn", "Email send failed (Cloudflare network error)", {
        backend: "cloudflare",
        recipient_domain: domainOf(message.to),
        error_class: err instanceof Error ? err.constructor.name : typeof err,
        error_message: err instanceof Error ? err.message : String(err),
        tags: message.tags,
        retryable: true,
      });
      return {
        ok: false,
        error: "cloudflare_network_error",
        retryable: true,
      };
    }

    let payload: CloudflareSendResponse;
    try {
      payload = (await response.json()) as CloudflareSendResponse;
    } catch {
      log("warn", "Email send failed (Cloudflare unparseable response)", {
        backend: "cloudflare",
        recipient_domain: domainOf(message.to),
        status: response.status,
        tags: message.tags,
        retryable: response.status >= 500 || response.status === 429,
      });
      return {
        ok: false,
        error: "cloudflare_unparseable_response",
        retryable: response.status >= 500 || response.status === 429,
      };
    }

    if (!response.ok || !payload.success) {
      const retryable = response.status >= 500 || response.status === 429;
      const cfError = payload.errors?.[0];
      log("warn", "Email send failed (Cloudflare error)", {
        backend: "cloudflare",
        recipient_domain: domainOf(message.to),
        status: response.status,
        cf_error_code: cfError?.code,
        cf_error_message: cfError?.message,
        tags: message.tags,
        retryable,
      });
      return {
        ok: false,
        error: cfError?.message ?? "cloudflare_send_failed",
        retryable,
      };
    }

    // 2xx + success: true. Inspect the result envelope —
    // CF returns `delivered`, `queued`, `permanent_bounces` arrays.
    // A non-empty `permanent_bounces` means the recipient was rejected
    // upstream (CF's own suppression list, invalid mailbox, etc.) —
    // surface as a non-retryable failure even though the HTTP status
    // is 200.
    const result = payload.result ?? {};
    const permanentBounces = result.permanent_bounces ?? [];
    if (permanentBounces.length > 0) {
      log("warn", "Email send rejected (Cloudflare permanent bounce)", {
        backend: "cloudflare",
        recipient_domain: domainOf(message.to),
        bounce_count: permanentBounces.length,
        tags: message.tags,
        retryable: false,
      });
      return {
        ok: false,
        error: "permanent_bounce",
        retryable: false,
      };
    }

    const messageId = synthesiseMessageId(message.idempotencyKey);
    log("info", "Email sent", {
      backend: "cloudflare",
      recipient_domain: domainOf(message.to),
      message_id: messageId,
      delivered_count: (result.delivered ?? []).length,
      queued_count: (result.queued ?? []).length,
      tags: message.tags,
    });
    return { ok: true, messageId };
  }
}

/**
 * Extract the domain part of an email address for non-PII logging.
 * `"alice@gmail.com"` → `"gmail.com"`. Returns `"unknown"` if the
 * address isn't well-formed (defensive — never throws).
 */
function domainOf(address: string): string {
  const at = address.lastIndexOf("@");
  if (at < 0 || at === address.length - 1) return "unknown";
  return address.slice(at + 1).toLowerCase();
}

/**
 * Synthesise a stable message id from the idempotency key. CF Email
 * doesn't return a native id, so this gives log-correlation continuity
 * via the audit row — `messageId` lands as a hex prefix of
 * `sha256(idempotencyKey)`. Stable per (send-attempt + key) pair.
 */
function synthesiseMessageId(idempotencyKey: string): string {
  const hash = createHash("sha256").update(idempotencyKey).digest("hex");
  return `cf_${hash.slice(0, 24)}`;
}

/**
 * Constructs a CloudflareTransport from `EmailTransportConfig`. Throws
 * if the config is missing the `cloudflare` block (programming error —
 * `createEmailTransport` should have validated already).
 */
export function createCloudflareTransport(
  config: EmailTransportConfig,
): CloudflareTransport {
  if (!config.cloudflare) {
    throw new Error(
      "CloudflareTransport requires config.cloudflare.{accountId, apiToken}",
    );
  }
  return new CloudflareTransport({
    accountId: config.cloudflare.accountId,
    apiToken: config.cloudflare.apiToken,
    from: config.from,
    replyTo: config.replyTo,
  });
}
