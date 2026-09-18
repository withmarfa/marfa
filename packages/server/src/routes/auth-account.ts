/**
 * Account-lifecycle deletion routes.
 *
 * Surfaces:
 *   - POST /auth/account/delete           — initiate. Mints a confirm
 *     token, emails the link. Idempotent on re-call within TTL.
 *   - GET  /auth/account/delete/confirm   — confirm. Flips state to
 *     `pending_deletion`, revokes credentials, mints the cancel token,
 *     emails the pending-deletion notification, renders a themed page.
 *   - POST /auth/account/delete/cancel    — session-cookie cancel.
 *   - GET  /auth/account/cancel           — email-cancel-by-link.
 *
 * **The JSON endpoints take a session cookie and nothing else.** Deleting an
 * account is a person's act, and the only credential that can prove a person
 * is here is the one they signed in with. An operator deletes an account
 * through the instance route instead, which names the account in its path.
 *
 * This file used to admit any bearer bound to the account holder's space,
 * asking for no permission at all, and its docblock described a check on rank
 * that the code never made. While nearly every credential in a space was broad
 * anyway the two sets were almost the same; under one permission model a narrow
 * credential is ordinary, and a consented app holding nothing but `openid` is
 * space-bound by construction — so an app that could read nothing could make
 * the account holder receive a genuine, correctly-signed "confirm your account
 * deletion" email whenever it liked, and keep a live confirm token in
 * circulation. It could not finish the deletion, which needs the emailed
 * token, but that is not much of a fence to be standing behind.
 *
 * **No twelfth space permission was added for it.** None of the eleven governs
 * deleting the account holder's account, and inventing one to fit a single
 * route would widen the model to suit a line of code.
 *
 * Email recipients click the GET endpoints, which are token-gated directly —
 * no caller credential needed.
 */
import { randomBytes } from "node:crypto";
import type { Context } from "hono";
import { Hono } from "hono";
import { and, desc, eq, like } from "drizzle-orm";
import { MarfaError, ErrorCode } from "@withmarfa/shared";
import type { AppEnv } from "../middleware/auth.js";
import type { Storage } from "../storage/interface.js";
import type { MarfaAuth } from "../auth/instance.js";
import type { EmailTransport as MarfaEmailTransport } from "../email/transport.js";
import { renderAccountDeleteConfirmEmail } from "../auth/email-templates/account-delete-confirm.js";
import { renderAccountPendingDeletionEmail } from "../auth/email-templates/account-pending-deletion.js";
import { renderAuthLayout } from "./auth-layout.js";
import { confirmIcon } from "./auth-html.js";
import { setNoStore } from "./no-store.js";

const CONFIRM_TTL_MS = 60 * 60 * 1000; // 1 hour
const MS_PER_DAY = 24 * 60 * 60 * 1000;

const CONFIRM_IDENTIFIER_PREFIX = "account-delete:";
const CANCEL_IDENTIFIER_PREFIX = "account-cancel:";

function newToken(): string {
  return randomBytes(32).toString("hex");
}

/**
 * Resolve the signed-in person into an `auth_user.id`.
 *
 * The session cookie is the whole of it. A bearer credential is deliberately
 * not a path here — see the note at the top of the file — and one presented to
 * these routes resolves to nobody, so the handlers answer `UNAUTHORIZED` the
 * same way they answer an anonymous caller. A refusal that named the missing
 * credential would be telling an app how to get closer to a door it is not
 * meant to reach.
 *
 * Returns null when no session resolves.
 */
async function resolveAuthUserId(
  c: Context<AppEnv>,
  auth: MarfaAuth | undefined,
): Promise<string | null> {
  if (!auth) return null;
  const session = await auth.getSession(c.req.raw.headers);
  return session?.user.id ?? null;
}

export function authAccountRoutes(
  storage: Storage,
  auth: MarfaAuth | undefined,
  emailTransport: MarfaEmailTransport | undefined,
  baseURL: string,
  graceDays: number,
): Hono<AppEnv> {
  const router = new Hono<AppEnv>();

  const accountLifecycle = storage.accountLifecycle;
  if (!accountLifecycle) {
    // No-op router. The account-lifecycle store isn't wired on this
    // instance. Every route falls through to 404 via Hono's
    // missing-handler behavior. Documented; intentional.
    return router;
  }

  // -----------------------------------------------------------------------
  // POST /auth/account/delete — initiate
  // -----------------------------------------------------------------------
  router.post("/account/delete", async (c) => {
    const authUserId = await resolveAuthUserId(c, auth);
    if (!authUserId) {
      throw new MarfaError(
        ErrorCode.UNAUTHORIZED,
        "Deleting an account is done from a signed-in session",
      );
    }
    let email: string | null = null;
    let name: string | null = null;
    if (storage.users) {
      const emailRow = await storage.users.getAuthUserEmail(authUserId);
      email = emailRow?.email ?? null;
      const profile = await storage.users.getByAuthUserId(authUserId);
      name = profile?.name ?? null;
    }

    // Idempotent on re-call within TTL — read any existing confirm
    // token for this user and reuse it. The lookup is keyed on `value`
    // (which is the auth_user_id) restricted to identifiers starting
    // with the confirm prefix.
    const existing = await findVerificationByValue(
      storage,
      authUserId,
      CONFIRM_IDENTIFIER_PREFIX,
    );
    let token: string;
    if (existing && existing.expiresAt.getTime() > Date.now()) {
      token = existing.identifier.slice(CONFIRM_IDENTIFIER_PREFIX.length);
    } else {
      token = newToken();
      const expiresAt = new Date(Date.now() + CONFIRM_TTL_MS);
      await insertVerification(storage, {
        identifier: `${CONFIRM_IDENTIFIER_PREFIX}${token}`,
        value: authUserId,
        expiresAt,
      });
    }

    const url = `${baseURL.replace(/\/$/, "")}/auth/account/delete/confirm?token=${encodeURIComponent(token)}`;

    if (emailTransport && email) {
      const rendered = renderAccountDeleteConfirmEmail({
        url,
        name,
        expiresInMinutes: 60,
      });
      await emailTransport.send({
        to: email,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
        idempotencyKey: `account-delete-confirm/${authUserId}/${token}`,
        tags: { template: "account-delete-confirm" },
      });
    }

    // No plaintext email in audit details. The auth_user_id in resource_id
    // correlates back to the email via the auth_user row when operators
    // need it; logging the email here would re-introduce a PII trail
    // that was deliberately removed from email-transport logs.
    void storage.audit.log({
      action: "auth.account.delete_requested",
      resource_type: "auth_account",
      resource_id: authUserId,
      client_ip: c.var.clientIp ?? null,
    });

    // A form post is a person pressing the button on the security page, and a
    // browser handed a 202 of JSON would show them the JSON. This route takes
    // a session and nothing else now, so every caller is a browser; the
    // content type is only which kind of browser call it was.
    const contentType = c.req.header("content-type") ?? "";
    if (contentType.startsWith("application/x-www-form-urlencoded")) {
      return c.redirect("/auth/security?notice=account_delete_sent", 302);
    }
    return c.json({ ok: true }, 202);
  });

  // -----------------------------------------------------------------------
  // GET /auth/account/delete/confirm?token=…
  // -----------------------------------------------------------------------
  router.get("/account/delete/confirm", async (c) => {
    setNoStore(c);
    const url = new URL(c.req.url);
    const token = url.searchParams.get("token") ?? "";
    if (!token) return c.html(renderBadTokenPage(), 404);

    const identifier = `${CONFIRM_IDENTIFIER_PREFIX}${token}`;
    const row = await findVerificationByIdentifier(storage, identifier);
    if (!row || row.expiresAt.getTime() < Date.now()) {
      return c.html(renderBadTokenPage(), 404);
    }
    const authUserId = row.value;
    // Single-use — delete the row before further work so a replay sees
    // bad-token.
    await deleteVerificationByIdentifier(storage, identifier);

    const nowIso = new Date().toISOString();
    await accountLifecycle.markPendingDeletion(authUserId, nowIso);

    // Mint cancel token.
    const cancelToken = newToken();
    // The cancel link must stay valid for the whole grace window so the
    // user can restore any time before the purger hard-deletes.
    const cancelExpiresAt = new Date(Date.now() + graceDays * MS_PER_DAY);
    await insertVerification(storage, {
      identifier: `${CANCEL_IDENTIFIER_PREFIX}${cancelToken}`,
      value: authUserId,
      expiresAt: cancelExpiresAt,
    });

    let email: string | null = null;
    let name: string | null = null;
    if (storage.users) {
      const emailRow = await storage.users.getAuthUserEmail(authUserId);
      email = emailRow?.email ?? null;
      const profile = await storage.users.getByAuthUserId(authUserId);
      name = profile?.name ?? null;
    }

    const cancelUrl = `${baseURL.replace(/\/$/, "")}/auth/account/cancel?token=${encodeURIComponent(cancelToken)}`;
    if (emailTransport && email) {
      const rendered = renderAccountPendingDeletionEmail({
        url: cancelUrl,
        deletionDate: cancelExpiresAt.toISOString().slice(0, 10),
        graceDays,
        name,
      });
      await emailTransport.send({
        to: email,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
        idempotencyKey: `account-pending-deletion/${authUserId}/${cancelToken}`,
        tags: { template: "account-pending-deletion" },
      });
    }

    // No plaintext email in audit details — same rationale as POST /account/delete above.
    void storage.audit.log({
      action: "auth.account.delete_confirmed",
      resource_type: "auth_account",
      resource_id: authUserId,
      client_ip: c.var.clientIp ?? null,
    });

    return c.html(renderConfirmedPage());
  });

  // -----------------------------------------------------------------------
  // POST /auth/account/delete/cancel — session/bearer cancel
  // -----------------------------------------------------------------------
  router.post("/account/delete/cancel", async (c) => {
    const authUserId = await resolveAuthUserId(c, auth);
    if (!authUserId) {
      throw new MarfaError(
        ErrorCode.UNAUTHORIZED,
        "Canceling a deletion is done from a signed-in session",
      );
    }
    const lifecycle = await accountLifecycle.getAccountLifecycle(authUserId);
    if (lifecycle?.deletion_state !== "pending_deletion") {
      return c.json(
        {
          error: {
            code: "not_pending_deletion",
            message: "Account is not pending deletion.",
          },
        },
        400,
      );
    }
    // Branch on whether the UPDATE actually flipped a row. The
    // `getAccountLifecycle` pre-check has a TOCTOU window with the
    // purger's cascade — `getAccountLifecycle` can read pending, the
    // cascade can commit (hard-deleting the auth_user), then this
    // UPDATE no-ops. Without this branch the audit row + JSON response
    // would lie about a cancel that never happened.
    const cancelled = await accountLifecycle.cancelPendingDeletion(authUserId);
    await deleteVerificationsByValueAndPrefix(
      storage,
      authUserId,
      CANCEL_IDENTIFIER_PREFIX,
    );
    if (!cancelled) {
      void storage.audit.log({
        action: "auth.account.cancel_attempted_but_already_purged",
        resource_type: "auth_account",
        resource_id: authUserId,
        client_ip: c.var.clientIp ?? null,
        details: { source: "session" },
      });
      return c.json({ ok: false, code: "already_purged" });
    }
    void storage.audit.log({
      action: "auth.account.delete_cancelled",
      resource_type: "auth_account",
      resource_id: authUserId,
      client_ip: c.var.clientIp ?? null,
      details: { source: "session" },
    });
    return c.json({ ok: true });
  });

  // -----------------------------------------------------------------------
  // GET /auth/account/cancel?token=… — cancel-by-link (public)
  // -----------------------------------------------------------------------
  router.get("/account/cancel", async (c) => {
    setNoStore(c);
    const url = new URL(c.req.url);
    const token = url.searchParams.get("token") ?? "";
    if (!token) return c.html(renderBadTokenPage(), 404);

    const identifier = `${CANCEL_IDENTIFIER_PREFIX}${token}`;
    const row = await findVerificationByIdentifier(storage, identifier);
    if (!row || row.expiresAt.getTime() < Date.now()) {
      return c.html(renderBadTokenPage(), 404);
    }
    const authUserId = row.value;
    await deleteVerificationByIdentifier(storage, identifier);
    // Branch on whether the UPDATE actually flipped a row. The
    // verification row can resolve before the cascade commits, but by
    // the time `cancelPendingDeletion` runs the auth_user row may be
    // gone — at which point the UPDATE matches zero rows. The "Account
    // restored" page would be a lie; render the honest one instead and
    // write a distinct audit action.
    const cancelled = await accountLifecycle.cancelPendingDeletion(authUserId);
    if (!cancelled) {
      void storage.audit.log({
        action: "auth.account.cancel_attempted_but_already_purged",
        resource_type: "auth_account",
        resource_id: authUserId,
        client_ip: c.var.clientIp ?? null,
        details: { source: "link" },
      });
      return c.html(renderAlreadyDeletedPage());
    }
    void storage.audit.log({
      action: "auth.account.delete_cancelled",
      resource_type: "auth_account",
      resource_id: authUserId,
      client_ip: c.var.clientIp ?? null,
      details: { source: "link" },
    });
    return c.html(renderCancelledPage());
  });

  return router;
}

// ---------------------------------------------------------------------------
// auth_verification helpers
// ---------------------------------------------------------------------------
//
// The auth_* tables are managed by better-auth; we reach in directly
// rather than through a dedicated store. The Drizzle schema is exposed
// on `storage.betterAuthDb` (the unwrapped instance).

interface VerificationRow {
  identifier: string;
  value: string;
  expiresAt: Date;
}

async function insertVerification(
  storage: Storage,
  row: VerificationRow,
): Promise<void> {
  const db = storage.betterAuthDb;
  if (!db) throw new Error("betterAuthDb not wired");
  const now = new Date();
  const id = randomBytes(16).toString("hex");
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
      identifier: row.identifier,
      value: row.value,
      expiresAt: row.expiresAt,
      createdAt: now,
      updatedAt: now,
    })
    .run();
}

async function findVerificationByIdentifier(
  storage: Storage,
  identifier: string,
): Promise<VerificationRow | null> {
  const db = storage.betterAuthDb;
  if (!db) return null;
  const { auth_verification } = await import("../storage/sqlite/schema.js");
  const row = await (
    db as {
      select: () => {
        from: (t: typeof auth_verification) => {
          where: (c: unknown) => {
            get: () => Promise<
              { identifier: string; value: string; expiresAt: Date } | undefined
            >;
          };
        };
      };
    }
  )
    .select()
    .from(auth_verification)
    .where(eq(auth_verification.identifier, identifier))
    .get();
  if (!row) return null;
  return {
    identifier: row.identifier,
    value: row.value,
    expiresAt: row.expiresAt,
  };
}

async function findVerificationByValue(
  storage: Storage,
  value: string,
  identifierPrefix: string,
): Promise<VerificationRow | null> {
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
                  | { identifier: string; value: string; expiresAt: Date }
                  | undefined
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
        eq(auth_verification.value, value),
        like(auth_verification.identifier, `${identifierPrefix}%`),
      ),
    )
    .orderBy(desc(auth_verification.createdAt))
    .limit(1)
    .get();
  if (!row) return null;
  return {
    identifier: row.identifier,
    value: row.value,
    expiresAt: row.expiresAt,
  };
}

async function deleteVerificationByIdentifier(
  storage: Storage,
  identifier: string,
): Promise<void> {
  const db = storage.betterAuthDb;
  if (!db) return;
  const { auth_verification } = await import("../storage/sqlite/schema.js");
  await (
    db as {
      delete: (t: typeof auth_verification) => {
        where: (c: unknown) => { run: () => Promise<unknown> };
      };
    }
  )
    .delete(auth_verification)
    .where(eq(auth_verification.identifier, identifier))
    .run();
}

async function deleteVerificationsByValueAndPrefix(
  storage: Storage,
  value: string,
  identifierPrefix: string,
): Promise<void> {
  const sqliteStorage = storage as unknown as {
    __sqliteRun?: (q: string, p: unknown[]) => Promise<{ changes: number }>;
  };
  if (!sqliteStorage.__sqliteRun) return;
  await sqliteStorage.__sqliteRun(
    `DELETE FROM auth_verification WHERE value = ? AND identifier LIKE ?`,
    [value, `${identifierPrefix}%`],
  );
}

// ---------------------------------------------------------------------------
// HTML renderers
// ---------------------------------------------------------------------------

export function renderBadTokenPage(): string {
  return renderAuthLayout({
    title: "Invalid or expired link",
    centered: true,
    bodyHtml: `
      ${confirmIcon("alert")}
      <h1 class="title">Invalid or expired link</h1>
      <p class="sub" role="alert">If you still want to delete your account, sign in and request deletion again.</p>
      <p class="aux"><a href="/auth/sign-in">Sign in</a></p>
    `,
  });
}

export function renderConfirmedPage(): string {
  return renderAuthLayout({
    title: "Account scheduled for deletion",
    centered: true,
    bodyHtml: `
      ${confirmIcon("alert")}
      <h1 class="title">Account scheduled for deletion</h1>
      <p class="sub" role="status">Your account and everything in it will be deleted after the grace period. We've emailed you a cancel link.</p>
      <p class="aux">Changed your mind? The cancel link is in your inbox.</p>
    `,
  });
}

export function renderCancelledPage(): string {
  return renderAuthLayout({
    title: "Account restored",
    centered: true,
    bodyHtml: `
      ${confirmIcon("check")}
      <h1 class="title">Account restored</h1>
      <p class="sub" role="status">Your account is no longer scheduled for deletion. You can pick up where you left off.</p>
      <div class="actions">
        <a href="/auth/sign-in" class="btn btn--primary">Sign in</a>
      </div>
    `,
  });
}

// Rendered when the cancel UPDATE matched zero rows because the
// account-deletion cascade had already committed. The user clicked the
// cancel link in time — the system just couldn't honor it. Don't imply
// they missed a deadline.
export function renderAlreadyDeletedPage(): string {
  return renderAuthLayout({
    title: "Account permanently deleted",
    centered: true,
    bodyHtml: `
      ${confirmIcon("alert")}
      <h1 class="title">Account permanently deleted</h1>
      <p class="sub" role="alert">Your account has already been permanently deleted, so we couldn't cancel it.</p>
      <p class="aux">Want to use Marfa again? <a href="/auth/sign-up">Create a new account</a>.</p>
    `,
  });
}
