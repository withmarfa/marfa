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
 *      a. Reuse an existing valid cancel token if one is present (T-137);
 *         otherwise mint a fresh one (30d TTL) and insert it.
 *      b. Dispatch the `account-delete-cancel` email — gated by a
 *         per-account cooldown (T-137) so repeated sign-in attempts
 *         can't flood the targeted user's inbox or burn CF Email
 *         quota.
 *      c. Audit `auth.account.sign_in_blocked_pending_deletion` (operator-visible
 *         only — no PII in details, T-139).
 *      d. Return a generic 401 with better-auth's wrong-credentials
 *         shape; do NOT call `next()` — better-auth has no
 *         `deletion_state` awareness and would mint a session on
 *         correct password, defeating the gate.
 *   4. Otherwise call `next()` and let better-auth handle sign-in.
 *
 * **No-enumeration invariant.** The response shape is byte-identical
 * across three cases — unknown email (better-auth's 401), active
 * account with wrong password (better-auth's 401), and pending-deletion
 * account (this middleware's 401). The user-facing signal for the
 * pending-deletion case lives entirely in the email channel: the
 * targeted user receives a "someone tried to sign in to your
 * scheduled-for-deletion account" notice with a restore link, while
 * an attacker observing the HTTP response cannot distinguish between
 * the three branches. Operators still get full visibility via the
 * audit row.
 *
 * **Token reuse + cooldown.** Reusing the existing valid token bounds
 * the worst-case to one fresh email per account per cooldown window
 * (default 1h, env override `MYME_ACCOUNT_DELETE_CANCEL_COOLDOWN_MS`).
 * The cooldown map is in-memory; multi-instance deployments get at
 * most N × one-email-per-cooldown-window globally.
 */
import { createMiddleware } from "hono/factory";
import { randomBytes } from "node:crypto";
import { and, desc, eq, gt, like } from "drizzle-orm";
import type { AppEnv } from "./auth.js";
import type { Storage } from "../storage/interface.js";
import type { EmailTransport as MymeEmailTransport } from "../email/transport.js";
import { renderAccountDeleteCancelEmail } from "../auth/email-templates/account-delete-cancel.js";

const TARGET_PATHS = new Set([
  "/auth/sign-in/email",
  "/auth/sign-in/magic-link",
]);

const CANCEL_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const CANCEL_IDENTIFIER_PREFIX = "account-cancel:";

/** Default per-account cooldown on the cancel-email send (1h). */
const DEFAULT_CANCEL_EMAIL_COOLDOWN_MS = 60 * 60 * 1000;

function resolveCooldownMs(): number {
  const raw = process.env.MYME_ACCOUNT_DELETE_CANCEL_COOLDOWN_MS;
  if (!raw) return DEFAULT_CANCEL_EMAIL_COOLDOWN_MS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0
    ? parsed
    : DEFAULT_CANCEL_EMAIL_COOLDOWN_MS;
}

export function accountDeletionGuardMiddleware(
  storage: Storage,
  emailTransport: MymeEmailTransport | undefined,
  baseURL: string,
) {
  // In-memory per-account cooldown on cancel-email sends. Closed-over
  // by the middleware closure so it persists across requests inside
  // one server process. Multi-instance deployments are not coordinated
  // — each instance enforces independently. Acceptable for a worst-case
  // bound of N × one-email-per-cooldown.
  const lastSendMs = new Map<string, number>();
  const cooldownMs = resolveCooldownMs();

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

    // T-137 token reuse: look for an existing valid cancel token bound
    // to this auth_user_id; reuse if present. The user may have lost
    // the original email, but issuing a brand-new token on every attempt
    // is what enables the spam vector — token reuse caps the
    // auth_verification table growth at one row per (account, TTL).
    const nowMs = Date.now();
    let token = await findExistingValidCancelToken(
      storage,
      lifecycle.auth_user_id,
      nowMs,
    );
    if (!token) {
      token = randomBytes(32).toString("hex");
      const expiresAt = new Date(nowMs + CANCEL_TTL_MS);
      await insertCancelToken(
        storage,
        `${CANCEL_IDENTIFIER_PREFIX}${token}`,
        lifecycle.auth_user_id,
        expiresAt,
      );
    }

    // T-137 cooldown: skip the email send when we're inside the
    // per-account cooldown window. The themed page still renders + the
    // audit row still writes, so the user-facing signal arrives via the
    // page; the email channel is rate-limited to one per cooldown
    // window per account.
    const lastSent = lastSendMs.get(lifecycle.auth_user_id);
    const cooldownActive =
      lastSent !== undefined && nowMs - lastSent < cooldownMs;
    if (emailTransport && !cooldownActive) {
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
      lastSendMs.set(lifecycle.auth_user_id, nowMs);
    }

    // T-139: no plaintext email in audit details — the auth_user_id in
    // resource_id correlates back via the auth_user row when needed.
    void storage.audit.log({
      action: "auth.account.sign_in_blocked_pending_deletion",
      resource_type: "auth_account",
      resource_id: lifecycle.auth_user_id,
      client_ip: c.var.clientIp ?? null,
    });

    // Generic 401 matching better-auth's wrong-credentials response
    // shape (T-137). Indistinguishable from the unknown-email and
    // active-wrong-password paths, so a network observer cannot
    // enumerate pending-deletion accounts. The user-facing signal
    // lives entirely in the cancel email above.
    return c.json(
      {
        message: "Invalid email or password",
        code: "INVALID_EMAIL_OR_PASSWORD",
      },
      401,
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

/**
 * T-137: probe `auth_verification` for an existing valid cancel token
 * bound to this `auth_user_id`. Returns the token suffix (without the
 * `account-cancel:` prefix) when found, else null. Uses Drizzle's
 * query builder on both dialects — fully parameterised, mirrors the
 * T-138 fix to the analogous helper in `routes/auth-account.ts`.
 */
async function findExistingValidCancelToken(
  storage: Storage,
  authUserId: string,
  nowMs: number,
): Promise<string | null> {
  const db = storage.betterAuthDb;
  if (!db) return null;
  if (storage.betterAuthDialect === "pg") {
    const { auth_verification } = await import("../storage/pg/schema.js");
    const rows = await (
      db as {
        select: () => {
          from: (t: typeof auth_verification) => {
            where: (c: unknown) => {
              orderBy: (c: unknown) => {
                limit: (
                  n: number,
                ) => Promise<{ identifier: string; expiresAt: Date }[]>;
              };
            };
          };
        };
      }
    )
      .select()
      .from(auth_verification)
      .where(
        and(
          eq(auth_verification.value, authUserId),
          like(auth_verification.identifier, `${CANCEL_IDENTIFIER_PREFIX}%`),
          gt(auth_verification.expiresAt, new Date(nowMs)),
        ),
      )
      .orderBy(desc(auth_verification.createdAt))
      .limit(1);
    const r = rows[0];
    if (!r) return null;
    return r.identifier.slice(CANCEL_IDENTIFIER_PREFIX.length);
  } else {
    const { auth_verification } = await import("../storage/sqlite/schema.js");
    const row = await (
      db as {
        select: () => {
          from: (t: typeof auth_verification) => {
            where: (c: unknown) => {
              orderBy: (c: unknown) => {
                limit: (n: number) => {
                  get: () => Promise<
                    { identifier: string; expiresAt: Date } | undefined
                  >;
                };
              };
            };
          };
        };
      }
    )
      .select()
      .from(auth_verification)
      .where(
        and(
          eq(auth_verification.value, authUserId),
          like(auth_verification.identifier, `${CANCEL_IDENTIFIER_PREFIX}%`),
          gt(auth_verification.expiresAt, new Date(nowMs)),
        ),
      )
      .orderBy(desc(auth_verification.createdAt))
      .limit(1)
      .get();
    if (!row) return null;
    return row.identifier.slice(CANCEL_IDENTIFIER_PREFIX.length);
  }
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
