/**
 * Email transport — pluggable interface for outbound transactional email.
 *
 * Three backends ship in-tree (`cloudflare`, `smtp`, `none`), selected by
 * `MARFA_EMAIL_BACKEND`. Backends are constructed once at boot in
 * `index.ts` and threaded into `createMarfaAuth` and any route that sends
 * email (forgot-password, email-verify, magic-link).
 *
 * Contract:
 * - `send(message)` is the only call site. Idempotency-key validation
 *   lives inside the transport so every caller benefits without
 *   re-implementing it.
 * - Returns a discriminated `EmailSendResult`. **Never throws** for
 *   transport-level failures — keeps the caller's error handling
 *   tractable. (Programming errors — missing config, malformed message
 *   — still throw, since those are bugs not transport conditions.)
 *
 * Hard-bounce suppression is no longer maintained server-side. Cloudflare
 * Email Service handles its own internal suppression list; SMTP self-hosters
 * own their domain reputation. Sends to a suppressed address surface as
 * a `{ ok: false, retryable: false }` result with structured logging.
 */

/**
 * Outbound email payload. Fields are deliberately minimal — every
 * transactional email Marfa sends fits this shape today (forgot-password,
 * magic-link, email-verify). If a future need pulls in attachments or
 * scheduling, add explicit optional fields rather than widening this
 * type unbounded.
 */
export interface EmailMessage {
  /** Single recipient. Transactional pattern — no batching. */
  to: string;
  /** Subject line. Should be specific (e.g. `Reset your password for Marfa`),
   *  not generic ("Action required"). */
  subject: string;
  /** Mandatory HTML body. Mobile-first design — 16px body min, single
   *  column, 44px tap targets. */
  html: string;
  /** Plain-text part. When omitted, no plain-text part is sent;
   *  HTML-only mail can hurt deliverability, so templates should
   *  always supply one. */
  text?: string;
  /** Optional override for the per-message Reply-To. When omitted the
   *  transport uses the configured `MARFA_EMAIL_REPLY_TO`. */
  replyTo?: string;
  /**
   * Mandatory idempotency key. Format `<event-type>/<entity-id>` (e.g.
   * `password-reset/user-123/token-jti`). Threads through to log
   * correlation — the Cloudflare backend hashes it into the synthesised
   * `messageId` on success. The Cloudflare backend does NOT honour
   * this for send-time dedup (CF Email has no documented idempotency
   * header); retries can produce duplicate sends — acceptable for the
   * three transactional flows since each ships a single-use token.
   */
  idempotencyKey: string;
  /**
   * Optional metadata tags surfaced on the audit row and on every
   * structured log emitted by the transport. Useful for observability
   * — e.g. `{ template: "password-reset", trigger: "user-initiated" }`.
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
 *   — retry is futile.
 *
 * On `ok: true`, `messageId` is the transport's identifier. Surfaced on
 * the audit row so an operator can correlate a delivery event back to
 * the send call. The Cloudflare backend synthesises this from the
 * idempotency key (CF Email returns no native id); SMTP uses the
 * Message-ID header.
 */
export type EmailSendResult =
  | { ok: true; messageId: string }
  | { ok: false; error: string; retryable: boolean };

/**
 * Pluggable email transport. Three implementations ship in-tree:
 * `CloudflareTransport`, `SmtpTransport`, `NoneTransport`. Picked by
 * `createEmailTransport(config)` at boot.
 */
export interface EmailTransport {
  /**
   * The backend identifier. Surfaced on logs and the audit row's tags
   * for observability.
   */
  readonly backend: EmailBackend;
  /**
   * Send a transactional email. See `EmailMessage` / `EmailSendResult`
   * for the shape. Idempotency-key validation happens inside the
   * transport.
   */
  send(message: EmailMessage): Promise<EmailSendResult>;
}

export type EmailBackend = "cloudflare" | "smtp" | "none";

/**
 * Backend-agnostic configuration accepted by `createEmailTransport`.
 * `index.ts` reads from `loadConfig()` and constructs this; tests
 * wire it directly with their preferred backend.
 */
export interface EmailTransportConfig {
  backend: EmailBackend;
  /** Default `from` address. Domain must match a verified Cloudflare
   *  Email sending domain when `backend === "cloudflare"` —
   *  `senderDomainCheck` enforces this at boot. Format: `Name <addr@domain>`
   *  or just `addr@domain`. */
  from: string;
  /** Default Reply-To. Optional. Recommend a monitored inbox so
   *  user replies don't bounce silently. */
  replyTo?: string;
  /** Cloudflare Email Service backend config. Required when
   *  `backend === "cloudflare"`. */
  cloudflare?: {
    accountId: string;
    apiToken: string;
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
