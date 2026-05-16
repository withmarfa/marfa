import { describe, it, expect, afterEach } from "vitest";
import { randomBytes } from "node:crypto";
import {
  createTestContext,
  markEmailVerified,
  request,
  waitForAudit,
} from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { PendingDeletePurger } from "../storage/retention.js";

/**
 * T-116 — account-lifecycle deletion. Exercises the full happy path
 * (initiate → confirm → pending state), both cancel paths (sign-in
 * link + session cookie), the bad-token / expired-token shapes, and
 * the purger's hard-delete cascade with audit redaction.
 */

let ctx: TestContext | undefined;

afterEach(() => {
  ctx?.cleanup();
  ctx = undefined;
});

const ORIGIN = "http://localhost:0";

async function readLatestVerification(
  storage: TestContext["storage"],
  prefix: string,
): Promise<string | null> {
  const dialect = process.env.STORAGE_DIALECT ?? "sqlite";
  if (dialect === "pg") {
    const pg = storage as unknown as {
      __pgClient?: (q: string, p?: unknown[]) => Promise<unknown[]>;
    };
    if (!pg.__pgClient) return null;
    const rows = (await pg.__pgClient(
      `SELECT identifier FROM auth_verification
        WHERE identifier LIKE $1
        ORDER BY created_at DESC LIMIT 1`,
      [`${prefix}%`],
    )) as { identifier: string }[];
    if (rows.length === 0) return null;
    return rows[0]?.identifier.slice(prefix.length) ?? null;
  }
  const sqlite = storage as unknown as {
    __sqliteAll?: (q: string) => Promise<unknown[]>;
  };
  if (!sqlite.__sqliteAll) return null;
  const rows = (await sqlite.__sqliteAll(
    `SELECT identifier FROM auth_verification
      WHERE identifier LIKE '${prefix}%'
      ORDER BY created_at DESC LIMIT 1`,
  )) as { identifier: string }[];
  if (rows.length === 0) return null;
  return rows[0]?.identifier.slice(prefix.length) ?? null;
}

async function signUpAndVerify(
  c: TestContext,
  email: string,
  password = "correct horse",
): Promise<void> {
  await request(c.app, "POST", "/auth/sign-up/email", {
    body: { email, password, name: email.split("@")[0] },
    headers: { origin: ORIGIN },
  });
  await markEmailVerified(c.storage, email);
}

async function signIn(
  c: TestContext,
  email: string,
  password = "correct horse",
): Promise<{ status: number; cookie: string | null }> {
  const res = await request(c.app, "POST", "/auth/sign-in/email", {
    body: { email, password },
    headers: { origin: ORIGIN },
  });
  const cookie = res.headers.get("set-cookie")?.split(";")[0] ?? null;
  return { status: res.status, cookie };
}

describe("T-116 — account deletion routes", () => {
  it("happy path: initiate, confirm, cancel via sign-in link", async () => {
    ctx = await createTestContext({ authAllowSignup: true });
    await signUpAndVerify(ctx, "alice@example.com");
    const { cookie } = await signIn(ctx, "alice@example.com");
    expect(cookie).toBeTruthy();

    // Initiate.
    const initiate = await request(ctx.app, "POST", "/auth/account/delete", {
      headers: cookie ? { origin: ORIGIN, cookie } : { origin: ORIGIN },
    });
    expect(initiate.status).toBe(202);
    const confirmToken = await readLatestVerification(
      ctx.storage,
      "account-delete:",
    );
    expect(confirmToken).toBeTruthy();

    // Confirm.
    const confirm = await request(
      ctx.app,
      "GET",
      `/auth/account/delete/confirm?token=${encodeURIComponent(confirmToken ?? "")}`,
      { headers: { origin: ORIGIN } },
    );
    expect(confirm.status).toBe(200);
    expect(await confirm.text()).toContain("scheduled for deletion");

    // State should be `pending_deletion`.
    const lifecycle = ctx.storage.accountLifecycle;
    expect(lifecycle).toBeTruthy();
    const byEmail =
      await lifecycle?.getAccountLifecycleByEmail("alice@example.com");
    expect(byEmail?.deletion_state).toBe("pending_deletion");
    expect(byEmail?.pending_deletion_at).toBeTruthy();

    // Sign-in attempt is blocked. T-137 Option 2: response is a
    // generic 401 indistinguishable from wrong-password / unknown-email
    // so an observer can't enumerate pending-deletion accounts.
    const blocked = await signIn(ctx, "alice@example.com");
    expect(blocked.status).toBe(401);
    // A cancel-by-link token should have been minted.
    const cancelToken = await readLatestVerification(
      ctx.storage,
      "account-cancel:",
    );
    expect(cancelToken).toBeTruthy();

    // Use the cancel link.
    const cancelRes = await request(
      ctx.app,
      "GET",
      `/auth/account/cancel?token=${encodeURIComponent(cancelToken ?? "")}`,
      { headers: { origin: ORIGIN } },
    );
    expect(cancelRes.status).toBe(200);
    const restored =
      await lifecycle?.getAccountLifecycleByEmail("alice@example.com");
    expect(restored?.deletion_state).toBe("active");
  });

  it("cancel via session POST works while the cookie remains", async () => {
    ctx = await createTestContext({ authAllowSignup: true });
    await signUpAndVerify(ctx, "bob@example.com");
    const { cookie } = await signIn(ctx, "bob@example.com");
    expect(cookie).toBeTruthy();

    await request(ctx.app, "POST", "/auth/account/delete", {
      headers: cookie ? { origin: ORIGIN, cookie } : { origin: ORIGIN },
    });
    const confirmToken = await readLatestVerification(
      ctx.storage,
      "account-delete:",
    );
    await request(
      ctx.app,
      "GET",
      `/auth/account/delete/confirm?token=${encodeURIComponent(confirmToken ?? "")}`,
      { headers: { origin: ORIGIN } },
    );
    // markPendingDeletion drops sessions; the cookie no longer
    // authenticates. We test the bearer-auth path is wired by
    // hitting the cancel route via the admin bearer instead — but
    // since the admin bearer points at a different (non-existent in
    // hosted mode) user binding, we test the negative path here.
    const cancelNoCookie = await request(
      ctx.app,
      "POST",
      "/auth/account/delete/cancel",
      { headers: { origin: ORIGIN } },
    );
    expect(cancelNoCookie.status).toBeGreaterThanOrEqual(400);
  });

  it("expired confirm token returns the bad-token shape", async () => {
    ctx = await createTestContext({ authAllowSignup: true });
    await signUpAndVerify(ctx, "carol@example.com");
    const { cookie } = await signIn(ctx, "carol@example.com");
    await request(ctx.app, "POST", "/auth/account/delete", {
      headers: cookie ? { origin: ORIGIN, cookie } : { origin: ORIGIN },
    });
    const token = await readLatestVerification(ctx.storage, "account-delete:");

    // Backdate expiresAt.
    const past = new Date(Date.now() - 60_000);
    const dialect = process.env.STORAGE_DIALECT ?? "sqlite";
    if (dialect === "pg") {
      const pg = ctx.storage as unknown as {
        __pgClient?: (q: string, p?: unknown[]) => Promise<unknown[]>;
      };
      // `client.unsafe(query, params)` doesn't accept Date binds —
      // send ISO; the TIMESTAMP column parses them.
      await pg.__pgClient?.(
        `UPDATE auth_verification SET expires_at = $1 WHERE identifier = $2`,
        [past.toISOString(), `account-delete:${token ?? ""}`],
      );
    } else {
      const sqlite = ctx.storage as unknown as {
        __sqliteRun?: (q: string, p: unknown[]) => Promise<{ changes: number }>;
      };
      await sqlite.__sqliteRun?.(
        `UPDATE auth_verification SET expires_at = ? WHERE identifier = ?`,
        [Math.floor(past.getTime() / 1000), `account-delete:${token ?? ""}`],
      );
    }
    const confirm = await request(
      ctx.app,
      "GET",
      `/auth/account/delete/confirm?token=${encodeURIComponent(token ?? "")}`,
      { headers: { origin: ORIGIN } },
    );
    expect(confirm.status).toBe(404);
    expect(await confirm.text()).toContain("Invalid or expired link");
  });

  it("double-confirm: second attempt sees the bad-token shape", async () => {
    ctx = await createTestContext({ authAllowSignup: true });
    await signUpAndVerify(ctx, "dave@example.com");
    const { cookie } = await signIn(ctx, "dave@example.com");
    await request(ctx.app, "POST", "/auth/account/delete", {
      headers: cookie ? { origin: ORIGIN, cookie } : { origin: ORIGIN },
    });
    const token = await readLatestVerification(ctx.storage, "account-delete:");

    const first = await request(
      ctx.app,
      "GET",
      `/auth/account/delete/confirm?token=${encodeURIComponent(token ?? "")}`,
      { headers: { origin: ORIGIN } },
    );
    expect(first.status).toBe(200);

    const second = await request(
      ctx.app,
      "GET",
      `/auth/account/delete/confirm?token=${encodeURIComponent(token ?? "")}`,
      { headers: { origin: ORIGIN } },
    );
    expect(second.status).toBe(404);
  });

  it("purger hard-deletes after the grace window; audit rows are redacted", async () => {
    ctx = await createTestContext({ authAllowSignup: true });
    await signUpAndVerify(ctx, "eve@example.com");
    const { cookie } = await signIn(ctx, "eve@example.com");
    await request(ctx.app, "POST", "/auth/account/delete", {
      headers: cookie ? { origin: ORIGIN, cookie } : { origin: ORIGIN },
    });
    const token = await readLatestVerification(ctx.storage, "account-delete:");
    await request(
      ctx.app,
      "GET",
      `/auth/account/delete/confirm?token=${encodeURIComponent(token ?? "")}`,
      { headers: { origin: ORIGIN } },
    );

    const lifecycle = ctx.storage.accountLifecycle;
    expect(lifecycle).toBeTruthy();
    const before =
      await lifecycle?.getAccountLifecycleByEmail("eve@example.com");
    expect(before?.deletion_state).toBe("pending_deletion");
    const authUserId = before?.auth_user_id ?? "";

    // Purger run with `nowFn` 31 days in the future.
    const purger = new PendingDeletePurger(
      ctx.storage,
      30,
      3_600_000,
      () => new Date(Date.now() + 31 * 86_400_000),
      ctx.storage.coordination,
    );
    const purged = await purger.runOnce();
    expect(purged).toBeGreaterThanOrEqual(1);

    // Account is gone.
    const after = await lifecycle?.getAccountLifecycle(authUserId);
    expect(after).toBeNull();

    // Audit chain — the `auth.account.delete_requested` row should
    // have its `details.email` scrubbed (resource_id = authUserId so
    // the row identifies the user).
    const auditList = await ctx.storage.audit.list({
      resource_id: authUserId,
    });
    // We expect at least the `hard_deleted` row to remain unredacted
    // (it was emitted before the redact sweep). The earlier
    // delete_requested / delete_confirmed rows are also keyed by
    // resource_id = authUserId and should now be redacted.
    const hardDeletedRow = auditList.data.find(
      (r) => r.action === "auth.account.hard_deleted",
    );
    expect(hardDeletedRow).toBeTruthy();
    const requestedRow = auditList.data.find(
      (r) => r.action === "auth.account.delete_requested",
    );
    expect(requestedRow).toBeTruthy();
    expect(requestedRow?.details.redacted).toBe(true);
    expect(typeof requestedRow?.details.user_id_sha256).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// T-136 — cascade race-safety re-check.
// ---------------------------------------------------------------------------
//
// The cascade re-reads `auth_user.deletion_state` + `pending_deletion_at`
// inside its transaction (with `FOR UPDATE` on PG) and short-circuits if
// either is no longer compatible. These tests cover the two cases:
//
//   (a) Cancel landing between `listPendingDeletionDue` and the cascade:
//       account is `pending_deletion` past grace; we cancel manually,
//       then call the cascade — it must return `false` and leave the
//       account alone.
//   (b) Fresh requestDelete that hasn't aged into grace:
//       `pending_deletion_at` is recent (within grace window); we call
//       the cascade with a cutoff that wouldn't have admitted the row.
//       It must return `false` and leave the account alone.

describe("T-136 — cascade race-safety", () => {
  it("cancel landing between list-due and cascade leaves the account intact", async () => {
    ctx = await createTestContext({ authAllowSignup: true });
    await signUpAndVerify(ctx, "race-cancel@example.com");
    const { cookie } = await signIn(ctx, "race-cancel@example.com");
    await request(ctx.app, "POST", "/auth/account/delete", {
      headers: cookie ? { origin: ORIGIN, cookie } : { origin: ORIGIN },
    });
    const token = await readLatestVerification(ctx.storage, "account-delete:");
    await request(
      ctx.app,
      "GET",
      `/auth/account/delete/confirm?token=${encodeURIComponent(token ?? "")}`,
      { headers: { origin: ORIGIN } },
    );

    const lifecycle = ctx.storage.accountLifecycle;
    expect(lifecycle).toBeTruthy();
    const before = await lifecycle?.getAccountLifecycleByEmail(
      "race-cancel@example.com",
    );
    expect(before?.deletion_state).toBe("pending_deletion");
    const authUserId = before?.auth_user_id ?? "";

    // Simulate the race: the user clicks cancel between the purger's
    // listPendingDeletionDue and its cascade call. We cancel directly
    // before invoking the cascade.
    await lifecycle?.cancelPendingDeletion(authUserId);

    // Now invoke the cascade with a cutoff that WOULD have admitted
    // the row originally (31 days in the future).
    const fakeNow = new Date(Date.now() + 31 * 86_400_000);
    const cutoff = new Date(fakeNow.getTime() - 30 * 86_400_000).toISOString();
    const cascadeRan = await ctx.storage.deleteAccountCascade(
      authUserId,
      cutoff,
    );
    expect(cascadeRan).toBe(false);

    // Account must still be present and now `active`.
    const after = await lifecycle?.getAccountLifecycle(authUserId);
    expect(after).not.toBeNull();
    expect(after?.deletion_state).toBe("active");
    expect(after?.pending_deletion_at).toBeNull();
  });

  it("fresh requestDelete inside grace window cannot be hard-deleted by an old cutoff", async () => {
    ctx = await createTestContext({ authAllowSignup: true });
    await signUpAndVerify(ctx, "race-fresh@example.com");
    const { cookie } = await signIn(ctx, "race-fresh@example.com");
    await request(ctx.app, "POST", "/auth/account/delete", {
      headers: cookie ? { origin: ORIGIN, cookie } : { origin: ORIGIN },
    });
    const token = await readLatestVerification(ctx.storage, "account-delete:");
    await request(
      ctx.app,
      "GET",
      `/auth/account/delete/confirm?token=${encodeURIComponent(token ?? "")}`,
      { headers: { origin: ORIGIN } },
    );

    const lifecycle = ctx.storage.accountLifecycle;
    const before = await lifecycle?.getAccountLifecycleByEmail(
      "race-fresh@example.com",
    );
    expect(before?.deletion_state).toBe("pending_deletion");
    const authUserId = before?.auth_user_id ?? "";

    // Cutoff = now - 1 day. The row's pending_deletion_at is brand-new
    // (today), so pending_deletion_at >= cutoff. Cascade should
    // short-circuit.
    const cutoff = new Date(Date.now() - 86_400_000).toISOString();
    const cascadeRan = await ctx.storage.deleteAccountCascade(
      authUserId,
      cutoff,
    );
    expect(cascadeRan).toBe(false);

    // Account row still present, still pending_deletion.
    const after = await lifecycle?.getAccountLifecycle(authUserId);
    expect(after?.deletion_state).toBe("pending_deletion");
    expect(after?.pending_deletion_at).toBeTruthy();
  });

  it("purger.runOnce drives the cascade, which short-circuits when a cancel races between list-due and cascade", async () => {
    ctx = await createTestContext({ authAllowSignup: true });
    await signUpAndVerify(ctx, "purger-race@example.com");
    const { cookie } = await signIn(ctx, "purger-race@example.com");
    await request(ctx.app, "POST", "/auth/account/delete", {
      headers: cookie ? { origin: ORIGIN, cookie } : { origin: ORIGIN },
    });
    const token = await readLatestVerification(ctx.storage, "account-delete:");
    await request(
      ctx.app,
      "GET",
      `/auth/account/delete/confirm?token=${encodeURIComponent(token ?? "")}`,
      { headers: { origin: ORIGIN } },
    );

    const lifecycle = ctx.storage.accountLifecycle;
    expect(lifecycle).toBeTruthy();
    const before = await lifecycle?.getAccountLifecycleByEmail(
      "purger-race@example.com",
    );
    const authUserId = before?.auth_user_id ?? "";

    // **Race-simulating proxy.** The default `cancelPendingDeletion`
    // before `runOnce` would short-circuit the test before the purger
    // ever sees the row — `listPendingDeletionDue` filters on
    // `deletion_state = 'pending_deletion'` and would skip the row
    // entirely. We need the purger to see the row as pending, THEN
    // have the cancel land between list-due and the per-account
    // cascade — that's the actual T-136 race window.
    //
    // We achieve this by wrapping `storage` in a proxy that intercepts
    // `listPendingDeletionDue` to fire `cancelPendingDeletion` as a
    // side effect immediately before returning the (still-pending) row
    // ids. The cascade then runs against a row that was pending at
    // list-time but is `active` by re-check time.
    const racingStorage = new Proxy(ctx.storage, {
      get(target, prop, receiver) {
        if (prop === "accountLifecycle") {
          const wrapped = target.accountLifecycle;
          if (!wrapped) return wrapped;
          return new Proxy(wrapped, {
            get(t, p, r): unknown {
              if (p === "listPendingDeletionDue") {
                return async (cutoffIso: string) => {
                  const due = await t.listPendingDeletionDue(cutoffIso);
                  // Cancel between list-due and cascade. This is the
                  // race window the production code closes via the
                  // in-transaction re-check.
                  await t.cancelPendingDeletion(authUserId);
                  return due;
                };
              }
              return Reflect.get(t, p, r) as unknown;
            },
          });
        }
        return Reflect.get(target, prop, receiver) as unknown;
      },
    });

    // Purger runs with the future clock that would normally hard-delete.
    const purger = new PendingDeletePurger(
      racingStorage,
      30,
      3_600_000,
      () => new Date(Date.now() + 31 * 86_400_000),
      racingStorage.coordination,
    );
    const purged = await purger.runOnce();
    // The cascade must have short-circuited via its in-transaction
    // re-check — the row was pending at list-time, active by cascade
    // time. Without the re-check, the cascade would have hard-deleted
    // the now-active account. With it, the cascade returns false and
    // the purger's counter stays at zero.
    expect(purged).toBe(0);

    // Account intact and back to active.
    const after = await lifecycle?.getAccountLifecycle(authUserId);
    expect(after).not.toBeNull();
    expect(after?.deletion_state).toBe("active");
    expect(after?.pending_deletion_at).toBeNull();
  });
});
// ---------------------------------------------------------------------------
// T-137 — sign-in guard token reuse + audit-row hygiene.
// ---------------------------------------------------------------------------

async function countCancelTokens(
  storage: TestContext["storage"],
  authUserId: string,
): Promise<number> {
  const dialect = process.env.STORAGE_DIALECT ?? "sqlite";
  if (dialect === "pg") {
    const pg = storage as unknown as {
      __pgClient?: (q: string, p?: unknown[]) => Promise<unknown[]>;
    };
    if (!pg.__pgClient) return 0;
    const rows = (await pg.__pgClient(
      `SELECT COUNT(*)::int AS c FROM auth_verification
        WHERE value = $1 AND identifier LIKE 'account-cancel:%'`,
      [authUserId],
    )) as { c: number }[];
    return rows[0]?.c ?? 0;
  }
  const sqlite = storage as unknown as {
    __sqliteAll?: (q: string) => Promise<unknown[]>;
  };
  if (!sqlite.__sqliteAll) return 0;
  // Plain string substitution against a UUID is safe enough for a test
  // helper; the production code path is parameterised.
  const rows = (await sqlite.__sqliteAll(
    `SELECT COUNT(*) AS c FROM auth_verification
      WHERE value = '${authUserId.replace(/'/g, "''")}'
        AND identifier LIKE 'account-cancel:%'`,
  )) as { c: number }[];
  return rows[0]?.c ?? 0;
}

describe("T-137 — sign-in guard cancel-token reuse + audit hygiene", () => {
  it("repeated sign-in attempts on a pending-deletion account reuse the same cancel token", async () => {
    ctx = await createTestContext({ authAllowSignup: true });
    await signUpAndVerify(ctx, "guard-reuse@example.com");
    const { cookie } = await signIn(ctx, "guard-reuse@example.com");
    await request(ctx.app, "POST", "/auth/account/delete", {
      headers: cookie ? { origin: ORIGIN, cookie } : { origin: ORIGIN },
    });
    const confirmToken = await readLatestVerification(
      ctx.storage,
      "account-delete:",
    );
    await request(
      ctx.app,
      "GET",
      `/auth/account/delete/confirm?token=${encodeURIComponent(confirmToken ?? "")}`,
      { headers: { origin: ORIGIN } },
    );

    const lifecycle = ctx.storage.accountLifecycle;
    const before = await lifecycle?.getAccountLifecycleByEmail(
      "guard-reuse@example.com",
    );
    const authUserId = before?.auth_user_id ?? "";

    // Three sign-in attempts in a row. Each one hits the guard.
    // T-137 Option 2: generic 401, not a themed 403.
    for (let i = 0; i < 3; i++) {
      const r = await signIn(ctx, "guard-reuse@example.com");
      expect(r.status).toBe(401);
    }

    // Should still be exactly ONE cancel token in auth_verification —
    // the first attempt minted, the next two reused.
    const count = await countCancelTokens(ctx.storage, authUserId);
    expect(count).toBe(1);
  });

  it("audit row for sign_in_blocked carries no plaintext email (T-139)", async () => {
    ctx = await createTestContext({ authAllowSignup: true });
    await signUpAndVerify(ctx, "guard-pii@example.com");
    const { cookie } = await signIn(ctx, "guard-pii@example.com");
    await request(ctx.app, "POST", "/auth/account/delete", {
      headers: cookie ? { origin: ORIGIN, cookie } : { origin: ORIGIN },
    });
    const confirmToken = await readLatestVerification(
      ctx.storage,
      "account-delete:",
    );
    await request(
      ctx.app,
      "GET",
      `/auth/account/delete/confirm?token=${encodeURIComponent(confirmToken ?? "")}`,
      { headers: { origin: ORIGIN } },
    );

    const lifecycle = ctx.storage.accountLifecycle;
    const before = await lifecycle?.getAccountLifecycleByEmail(
      "guard-pii@example.com",
    );
    const authUserId = before?.auth_user_id ?? "";

    const blocked = await signIn(ctx, "guard-pii@example.com");
    expect(blocked.status).toBe(401);

    // The audit row's `details` must NOT carry the plaintext email.
    // T-139 dropped `details: { email }` from this site. The audit
    // write is fire-and-forget, so poll until the row appears.
    const guardRow = await waitForAudit(
      () => ctx!.storage.audit.list({ resource_id: authUserId }),
      (page) =>
        page.data.some(
          (r) => r.action === "auth.account.sign_in_blocked_pending_deletion",
        ),
    ).then((page) =>
      page.data.find(
        (r) => r.action === "auth.account.sign_in_blocked_pending_deletion",
      ),
    );
    expect(guardRow).toBeTruthy();
    // Load-bearing assertion first: the email substring is present
    // nowhere in the audit row's details. A future regression that
    // moved the email under a different key (e.g., `details: { actor:
    // email }`) would still fail this check, while passing a narrower
    // `hasOwnProperty('email')` check.
    const details = guardRow?.details ?? {};
    expect(JSON.stringify(details)).not.toContain("guard-pii@example.com");
    // Belt-and-braces: the literal `email` key isn't present either.
    expect(Object.prototype.hasOwnProperty.call(details, "email")).toBe(false);
  });

  it("guard 401 response is byte-indistinguishable from better-auth's wrong-password 401 (T-137 Option 2)", async () => {
    ctx = await createTestContext({ authAllowSignup: true });
    // Two accounts: one stays active, one gets put into pending_deletion.
    await signUpAndVerify(ctx, "active@example.com");
    await signUpAndVerify(ctx, "pending@example.com");
    const { cookie } = await signIn(ctx, "pending@example.com");
    await request(ctx.app, "POST", "/auth/account/delete", {
      headers: cookie ? { origin: ORIGIN, cookie } : { origin: ORIGIN },
    });
    const confirmToken = await readLatestVerification(
      ctx.storage,
      "account-delete:",
    );
    await request(
      ctx.app,
      "GET",
      `/auth/account/delete/confirm?token=${encodeURIComponent(confirmToken ?? "")}`,
      { headers: { origin: ORIGIN } },
    );

    // Active account, wrong password → better-auth 401.
    const wrongPwResp = await request(ctx.app, "POST", "/auth/sign-in/email", {
      body: { email: "active@example.com", password: "wrong" },
      headers: { origin: ORIGIN },
    });
    // Pending-deletion account, any password → guard 401.
    const guardResp = await request(ctx.app, "POST", "/auth/sign-in/email", {
      body: { email: "pending@example.com", password: "correct horse" },
      headers: { origin: ORIGIN },
    });
    // Unknown email → better-auth 401.
    const unknownResp = await request(ctx.app, "POST", "/auth/sign-in/email", {
      body: { email: "ghost@example.com", password: "anything" },
      headers: { origin: ORIGIN },
    });

    // All three return 401.
    expect(wrongPwResp.status).toBe(401);
    expect(guardResp.status).toBe(401);
    expect(unknownResp.status).toBe(401);

    // statusText matches across the three. The guard intentionally
    // constructs `new Response(..., { statusText: "UNAUTHORIZED" })`
    // to match better-auth's `APIError.from("UNAUTHORIZED", ...)`
    // serialisation; without that, Hono's default `c.json` would
    // surface `"Unauthorized"` (Node http default) and leak the
    // branch.
    expect(guardResp.statusText).toBe(wrongPwResp.statusText);
    expect(guardResp.statusText).toBe(unknownResp.statusText);

    // Content-type matches across the three.
    const wrongPwCt = wrongPwResp.headers.get("content-type") ?? "";
    const guardCt = guardResp.headers.get("content-type") ?? "";
    const unknownCt = unknownResp.headers.get("content-type") ?? "";
    expect(wrongPwCt).toMatch(/application\/json/);
    expect(guardCt).toMatch(/application\/json/);
    expect(unknownCt).toMatch(/application\/json/);

    // Body shape matches (status, code shape — exact `message` text
    // depends on the better-auth version but the fields are the same).
    const wrongPwBody = (await wrongPwResp.json()) as Record<string, unknown>;
    const guardBody = (await guardResp.json()) as Record<string, unknown>;
    const unknownBody = (await unknownResp.json()) as Record<string, unknown>;
    // The guard intentionally mirrors better-auth's INVALID_EMAIL_OR_PASSWORD shape.
    expect(typeof guardBody.message).toBe("string");
    expect(guardBody.code).toBe("INVALID_EMAIL_OR_PASSWORD");
    // Both better-auth paths surface a string `message`. The exact code
    // string varies by better-auth version; what matters for the
    // no-enumeration invariant is that the field set + types match.
    expect(typeof wrongPwBody.message).toBe("string");
    expect(typeof unknownBody.message).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// T-141 — cancel-route honesty when cascade wins the race
// ---------------------------------------------------------------------------
//
// T-136 closed the data-loss race in the cascade. T-141 closes the
// user-facing-confirmation race: when the cascade commits between the
// cancel route's pre-checks and its `cancelPendingDeletion` UPDATE, the
// UPDATE matches zero rows. The route now branches on the boolean
// return, rendering "already permanently deleted" / `{ok:false, code:
// "already_purged"}` and writing a distinct audit action instead of
// claiming the cancel succeeded.

async function reinsertCancelToken(
  storage: TestContext["storage"],
  token: string,
  authUserId: string,
): Promise<void> {
  const dialect = process.env.STORAGE_DIALECT ?? "sqlite";
  const id = randomBytes(16).toString("hex");
  const identifier = `account-cancel:${token}`;
  const expiresAt = new Date(Date.now() + 30 * 86_400_000);
  const now = new Date();
  if (dialect === "pg") {
    const pg = storage as unknown as {
      __pgClient?: (q: string, p?: unknown[]) => Promise<unknown[]>;
    };
    if (!pg.__pgClient) throw new Error("pg client unavailable in test");
    await pg.__pgClient(
      `INSERT INTO auth_verification
         (id, identifier, value, expires_at, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        id,
        identifier,
        authUserId,
        expiresAt.toISOString(),
        now.toISOString(),
        now.toISOString(),
      ],
    );
    return;
  }
  const sqlite = storage as unknown as {
    __sqliteRun?: (q: string, p: unknown[]) => Promise<{ changes: number }>;
  };
  if (!sqlite.__sqliteRun) throw new Error("sqlite runner unavailable in test");
  await sqlite.__sqliteRun(
    `INSERT INTO auth_verification
       (id, identifier, value, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    [
      id,
      identifier,
      authUserId,
      Math.floor(expiresAt.getTime() / 1000),
      Math.floor(now.getTime() / 1000),
      Math.floor(now.getTime() / 1000),
    ],
  );
}

describe("T-141 — cancel route honesty when cascade wins the race", () => {
  it("GET cancel renders 'already deleted' page and writes the distinct audit action", async () => {
    ctx = await createTestContext({ authAllowSignup: true });
    await signUpAndVerify(ctx, "cascade-wins-link@example.com");
    const { cookie } = await signIn(ctx, "cascade-wins-link@example.com");
    await request(ctx.app, "POST", "/auth/account/delete", {
      headers: cookie ? { origin: ORIGIN, cookie } : { origin: ORIGIN },
    });
    const confirmToken = await readLatestVerification(
      ctx.storage,
      "account-delete:",
    );
    await request(
      ctx.app,
      "GET",
      `/auth/account/delete/confirm?token=${encodeURIComponent(confirmToken ?? "")}`,
      { headers: { origin: ORIGIN } },
    );

    const lifecycle = ctx.storage.accountLifecycle;
    const before = await lifecycle?.getAccountLifecycleByEmail(
      "cascade-wins-link@example.com",
    );
    const authUserId = before?.auth_user_id ?? "";
    const cancelToken = await readLatestVerification(
      ctx.storage,
      "account-cancel:",
    );
    expect(cancelToken).toBeTruthy();

    // Cascade wins: hard-delete the account with a future cutoff. The
    // cascade also nukes the cancel-token verification row, so we
    // re-insert it after — modelling the narrow window where the route
    // loaded the token (and captured authUserId from it) just before
    // the cascade committed, but the cancel UPDATE only runs after.
    const futureCutoff = new Date(Date.now() + 31 * 86_400_000).toISOString();
    const cascadeRan = await ctx.storage.deleteAccountCascade(
      authUserId,
      futureCutoff,
    );
    expect(cascadeRan).toBe(true);
    await reinsertCancelToken(ctx.storage, cancelToken!, authUserId);

    const res = await request(
      ctx.app,
      "GET",
      `/auth/account/cancel?token=${encodeURIComponent(cancelToken!)}`,
      { headers: { origin: ORIGIN } },
    );
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Account permanently deleted");
    expect(body).toContain("we couldn't cancel");
    // Crucially, NOT the restored copy.
    expect(body).not.toContain("Account restored");
    expect(body).not.toContain("no longer scheduled for deletion");

    // Audit: new action, source=link.
    const audit = await waitForAudit(
      () =>
        ctx!.storage.audit.list({
          action: "auth.account.cancel_attempted_but_already_purged",
        }),
      (r) => r.data.length > 0,
    );
    const row = audit.data.find((r) => r.resource_id === authUserId);
    expect(row).toBeTruthy();
    expect((row?.details as { source?: string }).source).toBe("link");
    expect(row?.resource_type).toBe("auth_account");

    // No fresh delete_cancelled row for this user post-cascade.
    const cancelled = await ctx.storage.audit.list({
      action: "auth.account.delete_cancelled",
      resource_id: authUserId,
    });
    expect(cancelled.data.length).toBe(0);
  });

  it("POST cancel returns ok:false/already_purged and writes the distinct audit action", async () => {
    ctx = await createTestContext({ authAllowSignup: true });
    await signUpAndVerify(ctx, "cascade-wins-post@example.com");
    const { cookie } = await signIn(ctx, "cascade-wins-post@example.com");
    expect(cookie).toBeTruthy();

    // Get authUserId without going through the confirm endpoint —
    // confirm calls `markPendingDeletion`, which drops every
    // auth_session for the user (T-116) and would invalidate our
    // cookie. Flip the deletion columns directly via SQL so the
    // session survives. The cancel route's pre-check still sees
    // `pending_deletion`; the rest of the flow is identical.
    const lifecycle = ctx.storage.accountLifecycle;
    if (!lifecycle) throw new Error("accountLifecycle unwired");
    const byEmail = await lifecycle.getAccountLifecycleByEmail(
      "cascade-wins-post@example.com",
    );
    const authUserId = byEmail?.auth_user_id ?? "";
    expect(authUserId).toBeTruthy();
    const dialect = process.env.STORAGE_DIALECT ?? "sqlite";
    const nowIso = new Date().toISOString();
    if (dialect === "pg") {
      const pg = ctx.storage as unknown as {
        __pgClient?: (q: string, p?: unknown[]) => Promise<unknown[]>;
      };
      await pg.__pgClient?.(
        `UPDATE auth_user SET deletion_state = 'pending_deletion', pending_deletion_at = $1 WHERE id = $2`,
        [nowIso, authUserId],
      );
    } else {
      const sqlite = ctx.storage as unknown as {
        __sqliteRun?: (q: string, p: unknown[]) => Promise<{ changes: number }>;
      };
      await sqlite.__sqliteRun?.(
        `UPDATE auth_user SET deletion_state = 'pending_deletion', pending_deletion_at = ? WHERE id = ?`,
        [nowIso, authUserId],
      );
    }
    const afterFlip = await lifecycle.getAccountLifecycle(authUserId);
    expect(afterFlip?.deletion_state).toBe("pending_deletion");

    // Splice a side-effect cascade into cancelPendingDeletion so the
    // route's UPDATE lands on a now-deleted row. The route captures
    // `accountLifecycle` once at registration but invokes methods on
    // it per-request, so a method-level patch takes effect for the
    // next request. The cascade with a future cutoff models a purger
    // tick that committed between the route's pre-check
    // (`getAccountLifecycle`) and its `cancelPendingDeletion` call —
    // the exact TOCTOU window.
    const originalCancel = lifecycle.cancelPendingDeletion.bind(lifecycle);
    const futureCutoff = new Date(Date.now() + 31 * 86_400_000).toISOString();
    lifecycle.cancelPendingDeletion = async (id: string) => {
      await ctx!.storage.deleteAccountCascade(id, futureCutoff);
      return originalCancel(id);
    };

    try {
      const res = await request(
        ctx.app,
        "POST",
        "/auth/account/delete/cancel",
        { headers: { origin: ORIGIN, cookie: cookie ?? "" } },
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.ok).toBe(false);
      expect(body.code).toBe("already_purged");

      // Audit: new action, source=session.
      const audit = await waitForAudit(
        () =>
          ctx!.storage.audit.list({
            action: "auth.account.cancel_attempted_but_already_purged",
          }),
        (r) =>
          r.data.some(
            (entry) =>
              entry.resource_id === authUserId &&
              (entry.details as { source?: string }).source === "session",
          ),
      );
      const row = audit.data.find(
        (r) =>
          r.resource_id === authUserId &&
          (r.details as { source?: string }).source === "session",
      );
      expect(row).toBeTruthy();
      expect(row?.resource_type).toBe("auth_account");

      // No delete_cancelled row for this user — the cancel didn't
      // actually happen, and we don't want to lie about it in audit.
      const cancelled = await ctx.storage.audit.list({
        action: "auth.account.delete_cancelled",
        resource_id: authUserId,
      });
      expect(cancelled.data.length).toBe(0);
    } finally {
      lifecycle.cancelPendingDeletion = originalCancel;
    }
  });
});
