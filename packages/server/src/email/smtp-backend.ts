/**
 * SMTP backend — universal fallback for self-hosters who don't want
 * to depend on Resend. Uses `nodemailer`. Same contract as the Resend
 * backend (pre-send suppression check, no exceptions, retryable flag).
 *
 * Transient failures: SMTP connection errors, 4xx temp / 5xx codes
 * surface as `retryable: true`. Permanent rejections (550 / 553)
 * surface as `retryable: false`.
 *
 * Idempotency is a fiction at the SMTP layer (no API-level dedupe
 * window). The key still flows through to the audit row + a custom
 * `X-Idempotency-Key` header so an MTA-side log inspection can
 * correlate retries.
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
 * Minimal nodemailer transporter shape. Like the Resend backend,
 * defining locally keeps the import dynamic and the dep optional.
 */
interface NodemailerTransporter {
  sendMail(opts: {
    from: string;
    to: string;
    subject: string;
    html: string;
    text?: string;
    replyTo?: string;
    headers?: Record<string, string>;
  }): Promise<{ messageId: string }>;
}

export class SmtpTransport implements EmailTransport {
  readonly backend = "smtp" as const;

  private readonly transporter: NodemailerTransporter;
  private readonly from: string;
  private readonly defaultReplyTo?: string;
  private readonly storage?: Storage;

  constructor(opts: {
    transporter: NodemailerTransporter;
    from: string;
    replyTo?: string;
    storage?: Storage;
  }) {
    this.transporter = opts.transporter;
    this.from = opts.from;
    this.defaultReplyTo = opts.replyTo;
    this.storage = opts.storage;
  }

  async send(message: EmailMessage): Promise<EmailSendResult> {
    if (!message.idempotencyKey) {
      throw new Error("EmailMessage.idempotencyKey is required");
    }

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

    try {
      const { messageId } = await this.transporter.sendMail({
        from: this.from,
        to: message.to,
        subject: message.subject,
        html: message.html,
        text: message.text,
        replyTo: message.replyTo ?? this.defaultReplyTo,
        headers: { "X-Idempotency-Key": message.idempotencyKey },
      });
      log("info", "Email sent", {
        to: message.to,
        message_id: messageId,
        idempotency_key: message.idempotencyKey,
      });
      return { ok: true, messageId };
    } catch (err) {
      const retryable = isSmtpRetryable(err);
      const errMessage = err instanceof Error ? err.message : String(err);
      log("warn", "Email send failed (SMTP)", {
        to: message.to,
        error_message: errMessage,
        retryable,
      });
      return {
        ok: false,
        error: errMessage,
        retryable,
      };
    }
  }
}

/**
 * SMTP error codes — `4xx` temp failures and connection errors are
 * retryable; `5xx` permanent rejections are not. nodemailer surfaces
 * the SMTP code as `responseCode` on its error object.
 */
function isSmtpRetryable(err: unknown): boolean {
  if (!(err instanceof Error)) return true;
  const code = (err as { responseCode?: number }).responseCode;
  if (code === undefined) return true; // connection / DNS — transient
  if (code >= 400 && code < 500) return true;
  return false;
}

/**
 * Constructs an SmtpTransport. Dynamic import of `nodemailer`
 * matches the Resend pattern.
 */
export async function createSmtpTransport(
  config: EmailTransportConfig,
): Promise<SmtpTransport> {
  if (!config.smtp) {
    throw new Error("SmtpTransport requires config.smtp.host");
  }
  const nodemailerMod = (await import("nodemailer")) as {
    createTransport: (opts: {
      host: string;
      port: number;
      secure: boolean;
      auth?: { user: string; pass: string };
    }) => NodemailerTransporter;
  };
  const transporter = nodemailerMod.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure,
    auth:
      config.smtp.user && config.smtp.pass
        ? { user: config.smtp.user, pass: config.smtp.pass }
        : undefined,
  });
  return new SmtpTransport({
    transporter,
    from: config.from,
    replyTo: config.replyTo,
    storage: config.storage,
  });
}
