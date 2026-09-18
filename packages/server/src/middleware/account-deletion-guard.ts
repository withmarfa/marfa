/**
 * Sign-in pre-check for accounts in `pending_deletion`.
 *
 * Sits AFTER `spaceSuspensionMiddleware` and BEFORE the better-auth
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
 *      a. Reuse an existing valid cancel token if one is present;
 *         otherwise mint a fresh one (TTL = the configured grace window)
 *         and insert it.
 *      b. Dispatch the `account-delete-cancel` email — gated by a
 *         per-account cooldown so repeated sign-in attempts can't
 *         flood the targeted user's inbox or burn email quota.
 *      c. Audit `auth.account.sign_in_blocked_pending_deletion`
 *         (operator-visible only — no PII in details).
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
 * (default 1h, env override `MARFA_ACCOUNT_DELETE_CANCEL_COOLDOWN_MS`).
 * The cooldown map is in-memory; multi-instance deployments get at
 * most N × one-email-per-cooldown-window globally.
 */
import { createMiddleware } from "hono/factory";
import { randomBytes } from "node:crypto";
import { and, desc, eq, gt, like } from "drizzle-orm";
import type { AppEnv } from "./auth.js";
import type { Storage } from "../storage/interface.js";
import type { EmailTransport as MarfaEmailTransport } from "../email/transport.js";
import { renderAccountDeleteCancelEmail } from "../auth/email-templates/account-delete-cancel.js";

/**
 * The paths this guard decides on, in every spelling that reaches the
 * same handler.
 *
 * Both with and without a trailing slash, for the reason
 * `routes/oauth-plugin-fence.ts` gives about the endpoints it fences: the
 * catch-all `/auth/*` mount is a wildcard, so `/auth/sign-in/email/` skips
 * an exact-string set and is then closed only by Better Auth's own
 * default of refusing a trailing slash. A guard that depends on a library
 * default nobody here is watching is not a guard, and dropping the entry
 * turns the case in `routes/auth-account.test.ts` from a 401 into a 404.
 *
 * A percent-escaped spelling needs no entry, and that is measured rather
 * than assumed: the handler behind the catch-all routes no sign-in for
 * one, so the request that skips this set reaches nothing. The same case
 * is what notices if that ever changes.
 */
const TARGET_PATHS = new Set([
  "/auth/sign-in/email",
  "/auth/sign-in/email/",
  "/auth/sign-in/magic-link",
  "/auth/sign-in/magic-link/",
]);

/**
 * The bare pending-deletion check shared between the middleware and the
 * human-facing sign-in wrapper. Returns `true` when the account is
 * `pending_deletion` (sign-in blocked, cancel email + audit row already
 * handled), `false` otherwise.
 */
export type EvaluatePendingDeletion = (
  email: string,
  clientIp: string | null,
) => Promise<boolean>;

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const CANCEL_IDENTIFIER_PREFIX = "account-cancel:";

/**
 * Default per-account cooldown on the cancel-email send (1h).
 *
 * Override via env: `MARFA_ACCOUNT_DELETE_CANCEL_COOLDOWN_MS`. Accepts
 * any non-negative integer milliseconds. **`0` means "no cooldown"** —
 * every sign-in attempt fires a fresh email send. Useful for tests +
 * rare operator-debug scenarios; in production this restores the
 * spam vector the cooldown closes, so don't set it to 0 outside of tests.
 * Negative or malformed values fall back to the default.
 */
const DEFAULT_CANCEL_EMAIL_COOLDOWN_MS = 60 * 60 * 1000;

function resolveCooldownMs(): number {
  const raw = process.env.MARFA_ACCOUNT_DELETE_CANCEL_COOLDOWN_MS;
  if (!raw) return DEFAULT_CANCEL_EMAIL_COOLDOWN_MS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0
    ? parsed
    : DEFAULT_CANCEL_EMAIL_COOLDOWN_MS;
}

/**
 * The shared pending-deletion gate. Closes over a single in-memory
 * cooldown map so the cooldown state is unified across both consumers:
 *
 *   - `middleware` — the Hono middleware that intercepts better-auth's
 *     JSON sign-in endpoints (`/auth/sign-in/email`,
 *     `/auth/sign-in/magic-link`).
 *   - `evaluatePendingDeletion` — the bare check the human-facing
 *     `POST /auth/sign-in` wrapper calls before dispatching to
 *     `auth.handler`. That wrapper bypasses Hono middleware entirely
 *     (it calls `auth.handler(upstream)` directly), so without this
 *     shared check the guard never fires for web-form sign-ins — a
 *     pending-deletion account could sign in via the form and the
 *     cancel email would never be sent.
 *
 * Both paths funnel through `evaluatePendingDeletion`, so the
 * token-reuse logic and the per-account email cooldown are the same
 * Map regardless of which surface the sign-in arrived on.
 */
export function createAccountDeletionGate(
  storage: Storage,
  emailTransport: MarfaEmailTransport | undefined,
  baseURL: string,
  graceDays: number,
): {
  middleware: ReturnType<typeof createMiddleware<AppEnv>>;
  evaluatePendingDeletion: EvaluatePendingDeletion;
} {
  // In-memory per-account cooldown on cancel-email sends. Closed-over
  // by the gate so it persists across requests inside one server
  // process and is SHARED between the middleware and the web-form
  // wrapper path. Multi-instance deployments are not coordinated —
  // each instance enforces independently. Acceptable for a worst-case
  // bound of N × one-email-per-cooldown.
  const lastSendMs = new Map<string, number>();
  const cooldownMs = resolveCooldownMs();

  /**
   * Core gate. Returns `true` when the email belongs to a
   * `pending_deletion` account (sign-in is BLOCKED) — having already
   * minted/reused the cancel token, sent the cancel email (respecting
   * the cooldown), and written the block audit row. Returns `false`
   * when the account is absent, active, or the lifecycle store is
   * unavailable — sign-in proceeds normally.
   */
  async function evaluatePendingDeletion(
    email: string,
    clientIp: string | null,
  ): Promise<boolean> {
    const accountLifecycle = storage.accountLifecycle;
    if (!accountLifecycle) return false;
    if (!email) return false;

    const lifecycle = await accountLifecycle.getAccountLifecycleByEmail(email);
    if (lifecycle?.deletion_state !== "pending_deletion") {
      return false;
    }

    // Reuse an existing valid token rather than minting a new one on every
    // attempt — caps table growth and limits the spam vector.
    const nowMs = Date.now();
    let token = await findExistingValidCancelToken(
      storage,
      lifecycle.auth_user_id,
      nowMs,
    );
    if (!token) {
      token = randomBytes(32).toString("hex");
      const expiresAt = new Date(nowMs + graceDays * MS_PER_DAY);
      await insertCancelToken(
        storage,
        `${CANCEL_IDENTIFIER_PREFIX}${token}`,
        lifecycle.auth_user_id,
        expiresAt,
      );
    }

    const lastSent = lastSendMs.get(lifecycle.auth_user_id);
    const cooldownActive =
      lastSent !== undefined && nowMs - lastSent < cooldownMs;
    if (emailTransport && !cooldownActive) {
      const url = `${baseURL.replace(/\/$/, "")}/auth/account/cancel?token=${encodeURIComponent(token)}`;
      const rendered = renderAccountDeleteCancelEmail({
        url,
        deletionDate: lifecycle.pending_deletion_at?.slice(0, 10),
      });
      // Fire-and-forget — transport failure must not block the gate.
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

    void storage.audit.log({
      action: "auth.account.sign_in_blocked_pending_deletion",
      resource_type: "auth_account",
      resource_id: lifecycle.auth_user_id,
      client_ip: clientIp,
    });

    return true;
  }

  const middleware = createMiddleware<AppEnv>(async (c, next) => {
    if (c.req.method !== "POST") return next();
    const path = new URL(c.req.url).pathname;
    if (!TARGET_PATHS.has(path)) return next();

    const email = await extractEmail(c.req.raw);
    if (!email) return next();

    const blocked = await evaluatePendingDeletion(
      email,
      c.var.clientIp ?? null,
    );
    if (!blocked) return next();

    // Generic 401 matching better-auth's wrong-credentials response
    // shape. Indistinguishable from the unknown-email and
    // active-wrong-password paths in body shape, status, statusText,
    // and content-type — so a network observer comparing responses
    // cannot enumerate pending-deletion accounts. The user-facing
    // signal lives entirely in the cancel email above.
    //
    // Constructed via `new Response(...)` rather than `c.json(...)`
    // because Hono defers `statusText` to the runtime default
    // (`"Unauthorized"` in Node), while better-auth's
    // `APIError.from("UNAUTHORIZED", ...)` serializes to
    // `statusText: "UNAUTHORIZED"`. Matching upstream verbatim.
    //
    // Known residual leak: response timing differs (the guard does a
    // DB lookup + token mint while better-auth's wrong-password does
    // a bcrypt compare). Acceptable for the threat model — closing
    // the timing leak would require constant-time padding or
    // post-response async work, both of which add complexity.
    return new Response(
      JSON.stringify({
        message: "Invalid email or password",
        code: "INVALID_EMAIL_OR_PASSWORD",
      }),
      {
        status: 401,
        statusText: "UNAUTHORIZED",
        headers: { "content-type": "application/json" },
      },
    );
  });

  return { middleware, evaluatePendingDeletion };
}

/**
 * Thin compat shim — preserves the original middleware export so any
 * existing importer keeps working. New wiring uses
 * `createAccountDeletionGate` directly so it can also thread
 * `evaluatePendingDeletion` into the web-form sign-in wrapper.
 */
export function accountDeletionGuardMiddleware(
  storage: Storage,
  emailTransport: MarfaEmailTransport | undefined,
  baseURL: string,
  graceDays: number,
) {
  return createAccountDeletionGate(storage, emailTransport, baseURL, graceDays)
    .middleware;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function extractEmail(rawReq: Request): Promise<string | null> {
  // The body shape varies — JSON (`/auth/sign-in/email` from
  // browser fetch) or form-encoded (form posts). Clone before
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
    // Malformed body — let the request handler surface the error.
  }
  return null;
}

/**
 * Probe `auth_verification` for an existing valid cancel token bound
 * to this `auth_user_id`. Returns the token suffix (without the
 * `account-cancel:` prefix) when found, else null. Uses Drizzle's
 * query builder — fully parameterized.
 */
async function findExistingValidCancelToken(
  storage: Storage,
  authUserId: string,
  nowMs: number,
): Promise<string | null> {
  const db = storage.betterAuthDb;
  if (!db) return null;
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

async function insertCancelToken(
  storage: Storage,
  identifier: string,
  value: string,
  expiresAt: Date,
): Promise<void> {
  const db = storage.betterAuthDb;
  if (!db) return;
  // Typed Drizzle insert against the same `auth_verification` table the
  // delete-request flow writes to. The timestamp-mode columns encode a
  // Date as INTEGER, so no manual ISO/unix conversion is needed.
  const id = randomBytes(16).toString("hex");
  const now = new Date();
  const { auth_verification } = await import("../storage/sqlite/schema.js");
  await (
    db as {
      insert: (t: typeof auth_verification) => {
        values: (row: Record<string, unknown>) => {
          run: () => Promise<unknown>;
        };
      };
    }
  )
    .insert(auth_verification)
    .values({
      id,
      identifier,
      value,
      expiresAt,
      createdAt: now,
      updatedAt: now,
    })
    .run();
}
