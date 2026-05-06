/**
 * Resend backend — production transactional email transport for hosted Myme.
 *
 * Uses the `resend` Node SDK. Key gotchas baked in:
 *
 * - SDK does not throw on API errors — returns `{ data, error }`.
 *   We translate to our `EmailSendResult` discriminated union so callers
 *   never see an exception they have to catch.
 * - Idempotency key is mandatory on every send (24h dedupe window).
 * - Pre-send suppression check against the local mirror first; saves
 *   the API call and explicit rejection lets the caller distinguish
 *   "address suppressed" from "send failed".
 * - Sender domain must match a verified Resend domain — enforced at
 *   boot via `senderDomainCheck`. (Bypassed in tests.)
 *
 * Transient failures (5xx, 429, network) flag `retryable: true`; the
 * caller decides whether to retry with the same idempotency key.
 */
import type {
  EmailMessage,
  EmailSendResult,
  EmailTransport,
  EmailTransportConfig,
} from "./transport.js";
import type { Storage } from "../storage/interface.js";
import { log } from "../middleware/logger.js";

/**
 * Minimal subset of the Resend SDK shape we depend on. Defining it
 * locally keeps the `resend` import dynamic (so tests can vitest-mock
 * the module without dragging the real SDK into every server bundle)
 * and avoids a circular type dance with the resend package's own type
 * exports.
 */
interface ResendSdkShape {
  emails: {
    send: (
      params: {
        from: string;
        to: string;
        subject: string;
        html: string;
        text?: string;
        replyTo?: string;
        tags?: { name: string; value: string }[];
      },
      options?: { idempotencyKey?: string },
    ) => Promise<{
      data: { id: string } | null;
      error: { name: string; message: string; statusCode?: number } | null;
    }>;
  };
}

export class ResendTransport implements EmailTransport {
  readonly backend = "resend" as const;

  private readonly client: ResendSdkShape;
  private readonly from: string;
  private readonly defaultReplyTo?: string;
  private readonly storage?: Storage;

  constructor(opts: {
    client: ResendSdkShape;
    from: string;
    replyTo?: string;
    storage?: Storage;
  }) {
    this.client = opts.client;
    this.from = opts.from;
    this.defaultReplyTo = opts.replyTo;
    this.storage = opts.storage;
  }

  async send(message: EmailMessage): Promise<EmailSendResult> {
    if (!message.idempotencyKey) {
      throw new Error("EmailMessage.idempotencyKey is required");
    }

    // Pre-send suppression check. Empty-string tenant is the platform-
    // level sentinel (matches blob T-049 convention) — used by pre-
    // sign-in flows like forgot-password.
    if (this.storage?.emailSuppressions) {
      const tenantId = message.tenantId ?? "";
      const suppressed = await this.storage.emailSuppressions.isSuppressed(
        tenantId,
        message.to,
      );
      if (suppressed) {
        log("info", "Email send blocked by suppression", {
          to: message.to,
          tenant_id: tenantId,
          reason: suppressed.reason,
        });
        return {
          ok: false,
          error: "email_suppressed",
          retryable: false,
        };
      }
    }

    const tags = message.tags
      ? Object.entries(message.tags).map(([name, value]) => ({ name, value }))
      : undefined;

    const { data, error } = await this.client.emails.send(
      {
        from: this.from,
        to: message.to,
        subject: message.subject,
        html: message.html,
        text: message.text,
        replyTo: message.replyTo ?? this.defaultReplyTo,
        tags,
      },
      { idempotencyKey: message.idempotencyKey },
    );

    if (error) {
      const retryable = isRetryable(error.statusCode);
      log("warn", "Email send failed (Resend)", {
        to: message.to,
        error_name: error.name,
        error_message: error.message,
        status_code: error.statusCode,
        retryable,
      });
      return {
        ok: false,
        error: error.message,
        retryable,
      };
    }

    if (!data) {
      // Defensive — should never happen per Resend SDK contract. Treat
      // as transient.
      return {
        ok: false,
        error: "resend_returned_no_data",
        retryable: true,
      };
    }

    log("info", "Email sent", {
      to: message.to,
      message_id: data.id,
      idempotency_key: message.idempotencyKey,
    });
    return { ok: true, messageId: data.id };
  }
}

/**
 * 5xx / 429 / network → retryable. 4xx (validation, auth, domain
 * mismatch) → not retryable; retrying just burns rate limit budget.
 */
function isRetryable(statusCode: number | undefined): boolean {
  if (statusCode === undefined) return true; // network error
  if (statusCode === 429) return true;
  if (statusCode >= 500) return true;
  return false;
}

/**
 * Constructs a ResendTransport from `EmailTransportConfig`. Dynamic
 * import of `resend` keeps non-Resend deployments from pulling in the
 * SDK at build time. Throws if the config is missing the `resend`
 * block (programming error — `createEmailTransport` should have
 * validated already).
 */
export async function createResendTransport(
  config: EmailTransportConfig,
): Promise<ResendTransport> {
  if (!config.resend) {
    throw new Error("ResendTransport requires config.resend.apiKey");
  }
  const { Resend } = (await import("resend")) as {
    Resend: new (apiKey: string) => ResendSdkShape;
  };
  const client = new Resend(config.resend.apiKey);
  return new ResendTransport({
    client,
    from: config.from,
    replyTo: config.replyTo,
    storage: config.storage,
  });
}
