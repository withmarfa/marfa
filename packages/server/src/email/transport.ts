/**
 * Email transport — pluggable interface for outbound transactional email.
 *
 * Wave C PR1. Three backends ship in-tree (`resend`, `smtp`, `none`),
 * selected by `MYME_EMAIL_BACKEND`. Backends are constructed once at
 * boot in `index.ts` and threaded into `createMymeAuth` and any future
 * route that sends email (forgot-password, email-verify, etc.).
 *
 * Contract:
 * - `send(message)` is the only call site. Pre-send checks (suppression
 *   list, idempotency key required) live inside the transport so every
 *   caller benefits without re-implementing them.
 * - Returns a discriminated `EmailSendResult`. **Never throws** for
 *   transport-level failures — matches the Resend SDK's own shape and
 *   keeps the caller's error handling tractable. (Programming errors —
 *   missing config, malformed message — still throw, since those are
 *   bugs not transport conditions.)
 * - `tenantId` on the message scopes suppression-list checks. Empty
 *   string is the platform-level / single-tenant sentinel (matches the
 *   blob storage T-049 convention).
 */
import type { Storage } from "../storage/interface.js";

/**
 * Outbound email payload. Fields are deliberately minimal — every
 * transactional email Myme sends fits this shape today (forgot-password,
 * magic-link, email-verify, future password-reset confirmation). If a
 * future need pulls in attachments or scheduling, add explicit optional
 * fields rather than widening this type unbounded.
 */
export interface EmailMessage {
  /** Single recipient. Transactional pattern — no batching. */
  to: string;
  /** Subject line. Should be specific (e.g. `Reset your password for Myme`),
   *  not generic ("Action required"). */
  subject: string;
  /** Mandatory HTML body. Mobile-first design — 16px body min, single
   *  column, 44px tap targets. */
  html: string;
  /** Plain-text fallback. When omitted the transport derives a basic
   *  text version from the HTML — but providing an explicit text block
   *  is preferred for templates with non-trivial content. */
  text?: string;
  /** Optional override for the per-message Reply-To. When omitted the
   *  transport uses the configured `MYME_EMAIL_REPLY_TO`. */
  replyTo?: string;
  /**
   * Mandatory idempotency key. Format `<event-type>/<entity-id>` (e.g.
   * `password-reset/user-123/token-jti`). 24-hour de-dupe window upstream.
   * Same key + same payload returns the same `messageId`; same key +
   * different payload errors. Required because every transactional path
   * worth wiring is also worth being safe under retry.
   */
  idempotencyKey: string;
  /**
   * Per-tenant suppression scope. Empty string is the platform-level
   * sentinel (matches blob T-049 convention) — pre-sign-in flows
   * (forgot-password, magic-link) operate without a tenant context and
   * use the empty-string row.
   */
  tenantId?: string;
  /**
   * Optional metadata tags surfaced through to Resend (Resend supports
   * tags on send) and the audit row. Useful for observability — e.g.
   * `{ template: "password-reset", trigger: "user-initiated" }`.
   */
  tags?: Record<string, string>;
}

/**
 * Result of `transport.send()`. Discriminated on `ok`. The `retryable`
 * flag on failure tells the caller whether a retry might succeed:
 *
 * - `retryable: true` for 5xx / 429 / network errors — caller may
 *   retry with the same idempotency key.
 * - `retryable: false` for 4xx / domain mismatch / invalid recipient
 *   / suppressed — retry is futile.
 *
 * On `ok: true`, `messageId` is the transport's identifier (Resend
 * email id, SMTP Message-ID header, etc.). Surfaced on the audit row
 * so an operator can correlate a delivery event back to the send call.
 */
export type EmailSendResult =
  | { ok: true; messageId: string }
  | { ok: false; error: string; retryable: boolean };

/**
 * Pluggable email transport. Three implementations ship in-tree:
 * `ResendTransport`, `SmtpTransport`, `NoneTransport`. Picked by
 * `createEmailTransport(config)` at boot.
 */
export interface EmailTransport {
  /**
   * The backend identifier. `"resend" | "smtp" | "none"`. Surfaced
   * on logs and the audit row's tags for observability.
   */
  readonly backend: EmailBackend;
  /**
   * Send a transactional email. See `EmailMessage` / `EmailSendResult`
   * for the shape. Pre-send suppression check + idempotency key
   * validation happen inside the transport.
   */
  send(message: EmailMessage): Promise<EmailSendResult>;
}

export type EmailBackend = "resend" | "smtp" | "none";

/**
 * Backend-agnostic configuration accepted by `createEmailTransport`.
 * `index.ts` reads from `loadConfig()` and constructs this; tests
 * wire it directly with their preferred backend.
 */
export interface EmailTransportConfig {
  backend: EmailBackend;
  /** Default `from` address. Domain must match a verified Resend
   *  domain when `backend === "resend"` — `senderDomainCheck` enforces
   *  this at boot. Format: `Name <addr@domain>` or just `addr@domain`. */
  from: string;
  /** Default Reply-To. Optional. Recommend a monitored inbox so
   *  user replies don't bounce silently. */
  replyTo?: string;
  /** Storage handle for the suppression-list pre-send check.
   *  Optional in tests that want to skip the check; production paths
   *  always pass it. */
  storage?: Storage;
  /** Resend backend config. Required when `backend === "resend"`. */
  resend?: {
    apiKey: string;
  };
  /** SMTP backend config. Required when `backend === "smtp"`. */
  smtp?: {
    host: string;
    port: number;
    user?: string;
    pass?: string;
    secure: boolean;
  };
}
