/**
 * T-116 — sign-in pre-check for accounts in `pending_deletion`.
 *
 * Sits AFTER `tenantSuspensionMiddleware` and BEFORE the better-auth
 * catch-all in `app.ts`. Triggers only on the sign-in endpoints
 * better-auth exposes:
 *
 *   - POST /auth/sign-in/email
 *   - POST /auth/sign-in/magic-link
 *
 * Flow:
 *   1. Clone the request body, extract `email`.
 *   2. Look up `accountLifecycle.getAccountLifecycleByEmail(email)`.
 *   3. If the account is `'pending_deletion'`:
 *      a. Mint a cancel-by-link token (30d TTL).
 *      b. Dispatch the `account-delete-cancel` email.
 *      c. Audit `auth.account.sign_in_blocked_pending_deletion`.
 *      d. Return a themed HTML page; do NOT call `next()` — the user
 *         must restore the account before signing in.
 *   4. Otherwise call `next()` and let better-auth handle sign-in.
 *
 * `next()` is also called when the lookup returns null (unknown
 * email) — no-enumeration invariant. The middleware never branches on
 * "account exists vs not".
 */
import { createMiddleware } from "hono/factory";
import { randomBytes } from "node:crypto";
import type { AppEnv } from "./auth.js";
import type { Storage } from "../storage/interface.js";
import type { EmailTransport as MymeEmailTransport } from "../email/transport.js";
import { renderAccountDeleteCancelEmail } from "../auth/email-templates/account-delete-cancel.js";
import { renderAuthLayout } from "../routes/auth-layout.js";
import { setNoStore } from "../routes/no-store.js";

const TARGET_PATHS = new Set([
  "/auth/sign-in/email",
  "/auth/sign-in/magic-link",
]);

const CANCEL_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const CANCEL_IDENTIFIER_PREFIX = "account-cancel:";

export function accountDeletionGuardMiddleware(
  storage: Storage,
  emailTransport: MymeEmailTransport | undefined,
  baseURL: string,
) {
  return createMiddleware<AppEnv>(async (c, next) => {
    if (c.req.method !== "POST") return next();
    const path = new URL(c.req.url).pathname;
    if (!TARGET_PATHS.has(path)) return next();

    const accountLifecycle = storage.accountLifecycle;
    if (!accountLifecycle) return next();

    const email = await extractEmail(c.req.raw);
    if (!email) return next();

    const lifecycle = await accountLifecycle.getAccountLifecycleByEmail(email);
    if (lifecycle?.deletion_state !== "pending_deletion") {
      return next();
    }

    // Mint a single-use cancel token (we always mint a fresh one — the
    // user may have lost the original email).
    const token = randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + CANCEL_TTL_MS);
    await insertCancelToken(
      storage,
      `${CANCEL_IDENTIFIER_PREFIX}${token}`,
      lifecycle.auth_user_id,
      expiresAt,
    );

    if (emailTransport) {
      const url = `${baseURL.replace(/\/$/, "")}/auth/account/cancel?token=${encodeURIComponent(token)}`;
      const rendered = renderAccountDeleteCancelEmail({
        url,
        deletionDate: lifecycle.pending_deletion_at?.slice(0, 10),
      });
      // Fire-and-forget — a transport failure must not affect the
      // gate. The audit row + the themed page already deliver the
      // critical user-facing signal.
      void emailTransport.send({
        to: email,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
        idempotencyKey: `account-delete-cancel/${lifecycle.auth_user_id}/${token}`,
        tags: { template: "account-delete-cancel" },
      });
    }

    void storage.audit.log({
      action: "auth.account.sign_in_blocked_pending_deletion",
      resource_type: "auth_account",
      resource_id: lifecycle.auth_user_id,
      client_ip: c.var.clientIp ?? null,
      details: { email },
    });

    setNoStore(c);
    return c.html(
      renderAuthLayout({
        title: "Account scheduled for deletion",
        bodyHtml: `
          <h1>Account scheduled for deletion</h1>
          <div class="banner banner--success" role="status">This account is scheduled for deletion. We've sent a cancellation link to your email — click it to restore the account, then sign in.</div>
          <p class="aux"><a href="/auth/sign-in">Back to sign-in</a></p>
        `,
      }),
      403,
    );
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function extractEmail(rawReq: Request): Promise<string | null> {
  // The body shape varies — JSON (`/auth/sign-in/email` from
  // browser fetch) or form-encoded (legacy callers). Clone before
  // reading so the downstream handler can re-read the body intact.
  try {
    const cloned = rawReq.clone();
    const contentType = cloned.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      const body = (await cloned.json()) as { email?: unknown };
      const e = body.email;
      return typeof e === "string" ? e.trim().toLowerCase() : null;
    }
    if (contentType.includes("application/x-www-form-urlencoded")) {
      // Parse as URLSearchParams to avoid the deprecation marker on
      // Request.formData (which the lint flags because it's not
      // appropriate for multipart/form-data parsing). Sign-in posts
      // are url-encoded in every flow we actually receive — the
      // better-auth client wraps the body before sending.
      const text = await cloned.text();
      const params = new URLSearchParams(text);
      const e = params.get("email");
      return typeof e === "string" ? e.trim().toLowerCase() : null;
    }
  } catch {
    // Malformed body — let downstream surface the error normally.
  }
  return null;
}

async function insertCancelToken(
  storage: Storage,
  identifier: string,
  value: string,
  expiresAt: Date,
): Promise<void> {
  const id = randomBytes(16).toString("hex");
  const now = new Date();
  if (storage.betterAuthDialect === "pg") {
    const pgStorage = storage as unknown as {
      __pgClient?: (q: string, p?: unknown[]) => Promise<unknown[]>;
    };
    if (!pgStorage.__pgClient) return;
    // `client.unsafe(query, params)` in postgres-js doesn't accept Date
    // binds via parameterised query (the prepared-statement path treats
    // params as primitives). Send ISO strings; the TIMESTAMP column
    // accepts them.
    await pgStorage.__pgClient(
      `INSERT INTO auth_verification
        (id, identifier, value, expires_at, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        id,
        identifier,
        value,
        expiresAt.toISOString(),
        now.toISOString(),
        now.toISOString(),
      ],
    );
  } else {
    const sqliteStorage = storage as unknown as {
      __sqliteRun?: (q: string, p: unknown[]) => Promise<{ changes: number }>;
    };
    if (!sqliteStorage.__sqliteRun) return;
    // SQLite encodes timestamps as unix-second INTEGERs.
    await sqliteStorage.__sqliteRun(
      `INSERT INTO auth_verification
        (id, identifier, value, expires_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)`,
      [
        id,
        identifier,
        value,
        Math.floor(expiresAt.getTime() / 1000),
        Math.floor(now.getTime() / 1000),
        Math.floor(now.getTime() / 1000),
      ],
    );
  }
}
