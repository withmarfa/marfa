import { describe, it, expect, afterEach, vi } from "vitest";
import { randomBytes } from "node:crypto";
import {
  createTestContext,
  markEmailVerified,
  request,
  waitForAudit,
  TEST_API_KEY_SALT,
} from "../test-utils.js";
import { hashApiKey } from "../middleware/auth.js";
import type { TestContext } from "../test-utils.js";

// Each case here drives a whole account lifecycle — sign-up and sign-in are
// two password hashes apiece, then a delete and its cascade — against a
// machine that also hosts the CI pool. The project default of 20 s is a
// duration, not a property, and overrunning it reports a timeout that says
// nothing about what was being checked. Same reasoning as
// `auth-grant-revoke.test.ts`.
vi.setConfig({ testTimeout: 60_000 });
import { PendingDeletePurger } from "../storage/retention.js";

/**
 * Account-lifecycle deletion tests. Exercises the full happy path
 * (initiate → confirm → pending state), both cancel paths (sign-in
 * link + session cookie), the bad-token / expired-token shapes, and
 * the purger's hard-delete cascade with audit redaction.
 */

let ctx: TestContext | undefined;

afterEach(async () => {
  await ctx?.cleanup();
  ctx = undefined;
});

const ORIGIN = "http://localhost:0";

async function readLatestVerification(
  storage: TestContext["storage"],
  prefix: string,
): Promise<string | null> {
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

describe("deleting an account is a person's act", () => {
  /**
   * The route used to admit any bearer whose space resolved an account
   * holder, asking for no permission at all. It could not finish a deletion —
   * that needs the emailed token — but it could make the account holder
   * receive a genuine, correctly signed confirmation email whenever it liked,
   * and keep a live confirm token in circulation. Under one permission model
   * a consented app holding nothing but `openid` is space-bound by
   * construction, so that is not a theoretical caller.
   *
   * Nothing replaced it with a twelfth space permission. The session cookie
   * is the only credential that can show a person is here.
   */
  async function personAndKey(
    email: string,
  ): Promise<{ cookie: string; key: string }> {
    const c = ctx!;
    await signUpAndVerify(c, email);
    const { cookie } = await signIn(c, email);
    expect(cookie).toBeTruthy();

    // **The fixture has to satisfy the removed arm's own precondition**, or
    // these cases pass for the wrong reason. That arm read the caller's space,
    // looked up that space's account holder, and answered with their id — so a
    // space-less key, or a space with no `users` row behind it, was refused
    // before the change and would be refused after it, and the test would be
    // saying nothing. Hosted mode is what puts a person, a space and the
    // bridge row in place; keys mode has no user store at all.
    const allSpaces = c.storage.spaces ? await c.storage.spaces.list() : [];
    const spaceId = allSpaces.at(-1)?.id;
    expect(spaceId).toBeTruthy();
    const holder = c.storage.users
      ? await c.storage.users.getBySpaceId(spaceId ?? "")
      : null;
    expect(holder?.auth_user_id).toBeTruthy();

    const suffix = randomBytes(4).toString("hex");
    const raw = `marfa_k1_bearer_${suffix}`;
    await c.storage.keys.create(
      {
        label: `bearer-${suffix}`,
        source: `account-delete-bearer-${suffix}`,
        // The narrowest credential the model allows: bound to the space,
        // holding nothing.
        space_permissions: [],
        type_permissions: {},
        extension_permissions: {},
        edge_permissions: {},
        metadata_permissions: {},
        default_tier: "library",
        is_operator: false,
      },
      hashApiKey(raw, TEST_API_KEY_SALT),
      spaceId,
    );
    return { cookie: cookie ?? "", key: raw };
  }

  it("refuses a space-bound credential holding nothing", async () => {
    ctx = await createTestContext({
      authMode: "hosted",
      authAllowSignup: true,
    });
    const { key } = await personAndKey("bearer-refused@example.com");

    const res = await request(ctx.app, "POST", "/auth/account/delete", {
      key,
      headers: { origin: ORIGIN },
    });
    expect(res.status).toBe(401);
    // And no token was minted, so nothing is left in circulation.
    expect(await readLatestVerification(ctx.storage, "account-delete:")).toBe(
      null,
    );
  });

  // The operator key was never admitted by the old arm either — it carries no
  // space, so the lookup it did could not resolve. The case is here to pin
  // that it gains no path of its own: an operator deletes an account through
  // the instance route, which names the account in its path.
  it("refuses the operator key, which has no person behind it", async () => {
    ctx = await createTestContext({
      authMode: "hosted",
      authAllowSignup: true,
    });
    await personAndKey("operator-refused@example.com");

    const res = await request(ctx.app, "POST", "/auth/account/delete", {
      key: ctx.spaceKey,
      headers: { origin: ORIGIN },
    });
    expect(res.status).toBe(401);
  });

  it("refuses a bearer canceling a deletion too", async () => {
    // The cancel door resolved its caller the same way, so it had the same
    // hole and gets the same answer.
    ctx = await createTestContext({
      authMode: "hosted",
      authAllowSignup: true,
    });
    const { key } = await personAndKey("bearer-cancel@example.com");

    const res = await request(ctx.app, "POST", "/auth/account/delete/cancel", {
      key,
      headers: { origin: ORIGIN },
    });
    expect(res.status).toBe(401);
  });

  it("still admits the person whose account it is", async () => {
    // The control. Same instance, same account, a session instead of a key.
    ctx = await createTestContext({
      authMode: "hosted",
      authAllowSignup: true,
    });
    const { cookie } = await personAndKey("person-admitted@example.com");

    const res = await request(ctx.app, "POST", "/auth/account/delete", {
      headers: { origin: ORIGIN, cookie },
    });
    expect(res.status).toBe(202);
    expect(
      await readLatestVerification(ctx.storage, "account-delete:"),
    ).toBeTruthy();
  });

  it("sends a form post back to the security page rather than to JSON", async () => {
    ctx = await createTestContext({
      authMode: "hosted",
      authAllowSignup: true,
    });
    const { cookie } = await personAndKey("form-post@example.com");

    const res = await request(ctx.app, "POST", "/auth/account/delete", {
      form: {},
      headers: { origin: ORIGIN, cookie },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      "/auth/security?notice=account_delete_sent",
    );
  });
});

describe("account deletion routes", () => {
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
    const confirmBody = await confirm.text();
    expect(confirmBody).toContain("scheduled for deletion");
    // Centered confirmation treatment, consistent with the other confirm
    // screens (an icon chip inside the centered card).
    expect(confirmBody).toContain("confirm-icon");
    expect(confirmBody).toContain("card--confirm");

    // State should be `pending_deletion`.
    const lifecycle = ctx.storage.accountLifecycle;
    expect(lifecycle).toBeTruthy();
    const byEmail =
      await lifecycle?.getAccountLifecycleByEmail("alice@example.com");
    expect(byEmail?.deletion_state).toBe("pending_deletion");
    expect(byEmail?.pending_deletion_at).toBeTruthy();

    // Sign-in attempt is blocked. Response is a generic 401
    // indistinguishable from wrong-password / unknown-email so an
    // observer can't enumerate pending-deletion accounts.
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
    const sqlite = ctx.storage as unknown as {
      __sqliteRun?: (q: string, p: unknown[]) => Promise<{ changes: number }>;
    };
    await sqlite.__sqliteRun?.(
      `UPDATE auth_verification SET expires_at = ? WHERE identifier = ?`,
      [Math.floor(past.getTime() / 1000), `account-delete:${token ?? ""}`],
    );
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
// Cascade race-safety re-check.
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

describe("cascade race-safety", () => {
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
    // cascade — the precise race window the in-transaction re-check
    // closes.
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
                  // Cancel between list-due and cascade — the race
                  // window the in-transaction re-check closes.
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
// Sign-in guard token reuse + audit-row hygiene.
// ---------------------------------------------------------------------------

async function countCancelTokens(
  storage: TestContext["storage"],
  authUserId: string,
): Promise<number> {
  const sqlite = storage as unknown as {
    __sqliteAll?: (q: string) => Promise<unknown[]>;
  };
  if (!sqlite.__sqliteAll) return 0;
  // Plain string substitution against a UUID is safe enough for a test
  // helper; the production code path is parameterized.
  const rows = (await sqlite.__sqliteAll(
    `SELECT COUNT(*) AS c FROM auth_verification
      WHERE value = '${authUserId.replace(/'/g, "''")}'
        AND identifier LIKE 'account-cancel:%'`,
  )) as { c: number }[];
  return rows[0]?.c ?? 0;
}

describe("sign-in guard cancel-token reuse + audit hygiene", () => {
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
    // Response is a generic 401, not a themed 403.
    for (let i = 0; i < 3; i++) {
      const r = await signIn(ctx, "guard-reuse@example.com");
      expect(r.status).toBe(401);
    }

    // Should still be exactly ONE cancel token in auth_verification —
    // the first attempt minted, the next two reused.
    const count = await countCancelTokens(ctx.storage, authUserId);
    expect(count).toBe(1);
  });

  it("holds on a trailing slash and on a percent-escaped spelling", async () => {
    // The guard decides on the raw pathname against a set of two literal
    // strings, which is an enumeration over a value whose spelling is not
    // canonical: `/auth/sign-%69n/email` is the same path and is not in
    // the set. The catch-all `/auth/*` mount is a wildcard, so the request
    // does reach the auth handler rather than stopping at the router.
    //
    // It is safe, and this pins why rather than asserting that it is. The
    // handler behind the catch-all does not route a re-encoded spelling
    // either, so the path that skips the guard reaches no sign-in at all.
    // Both halves are asserted, because the guard opens silently if the
    // second one ever changes.
    ctx = await createTestContext({ authAllowSignup: true });
    await signUpAndVerify(ctx, "guard-encoded@example.com");
    const { cookie } = await signIn(ctx, "guard-encoded@example.com");
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

    const credentials = {
      email: "guard-encoded@example.com",
      password: "correct horse",
    };
    // The control: the account really is blocked on the spelling the
    // guard knows, so a 401 below is the guard and not a bad password.
    const plain = await request(ctx.app, "POST", "/auth/sign-in/email", {
      body: credentials,
      headers: { origin: ORIGIN },
    });
    expect(plain.status).toBe(401);

    const encoded = await request(ctx.app, "POST", "/auth/sign-%69n/email", {
      body: credentials,
      headers: { origin: ORIGIN },
    });
    expect(encoded.status).toBe(404);
    expect(encoded.headers.get("set-cookie")).toBeNull();

    // The trailing slash is the spelling the guard has to carry itself,
    // because it is the one the catch-all would otherwise pass to a
    // handler whose refusal is a library default rather than anything
    // here. It is in the set now, so this is the guard answering.
    const slashed = await request(ctx.app, "POST", "/auth/sign-in/email/", {
      body: credentials,
      headers: { origin: ORIGIN },
    });
    expect(slashed.status).toBe(401);
    expect(slashed.headers.get("set-cookie")).toBeNull();
  });

  it("audit row for sign_in_blocked carries no plaintext email", async () => {
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
    // Audit writes are fire-and-forget, so poll until the row appears.
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

  it("guard 401 response is byte-indistinguishable from better-auth's wrong-password 401", async () => {
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
    // serialization; without that, Hono's default `c.json` would
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
// Cancel-route honesty when cascade wins the race
// ---------------------------------------------------------------------------
//
// When the cascade commits between the cancel route's pre-checks and its
// `cancelPendingDeletion` UPDATE, the UPDATE matches zero rows. The route
// branches on the boolean return, rendering "already permanently deleted"
// / `{ok:false, code:"already_purged"}` and writing a distinct audit
// action instead of claiming the cancel succeeded.

async function reinsertCancelToken(
  storage: TestContext["storage"],
  token: string,
  authUserId: string,
): Promise<void> {
  const id = randomBytes(16).toString("hex");
  const identifier = `account-cancel:${token}`;
  const expiresAt = new Date(Date.now() + 30 * 86_400_000);
  const now = new Date();
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

describe("cancel route honesty when cascade wins the race", () => {
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
    // re-insert it after — modeling the narrow window where the route
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
    // auth_session for the user and would invalidate our cookie. Flip the deletion columns directly via SQL so the
    // session survives. The cancel route's pre-check still sees
    // `pending_deletion`; the rest of the flow is identical.
    const lifecycle = ctx.storage.accountLifecycle;
    if (!lifecycle) throw new Error("accountLifecycle unwired");
    const byEmail = await lifecycle.getAccountLifecycleByEmail(
      "cascade-wins-post@example.com",
    );
    const authUserId = byEmail?.auth_user_id ?? "";
    expect(authUserId).toBeTruthy();
    const nowIso = new Date().toISOString();
    const sqlite = ctx.storage as unknown as {
      __sqliteRun?: (q: string, p: unknown[]) => Promise<{ changes: number }>;
    };
    await sqlite.__sqliteRun?.(
      `UPDATE auth_user SET deletion_state = 'pending_deletion', pending_deletion_at = ? WHERE id = ?`,
      [nowIso, authUserId],
    );
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

// ---------------------------------------------------------------------------
// Web-form sign-in path is guarded for pending-deletion accounts.
// ---------------------------------------------------------------------------
//
// The deletion guard is mounted as Hono middleware on better-auth's JSON
// sign-in endpoints (`/auth/sign-in/email`, `/auth/sign-in/magic-link`).
// The HUMAN sign-in form posts to `POST /auth/sign-in`, whose wrapper
// dispatches to `auth.handler` directly — bypassing all Hono middleware.
// Without the shared gate threaded into the wrapper, a pending-deletion
// account could sign in via the form and the cancel email would never
// fire. These tests prove the wrapper now runs the same check, in BOTH
// password and magic mode, while preserving the no-enumeration shape.

/** Minimal spy transport — records every `send()` call. The
 *  cooldown-disabling env (`MARFA_ACCOUNT_DELETE_CANCEL_COOLDOWN_MS=0`)
 *  keeps the cancel email firing deterministically per attempt. */
function makeEmailSpy(): {
  transport: import("../email/transport.js").EmailTransport;
  sent: import("../email/transport.js").EmailMessage[];
} {
  const sent: import("../email/transport.js").EmailMessage[] = [];
  const transport: import("../email/transport.js").EmailTransport = {
    backend: "none",
    send(message) {
      sent.push(message);
      return Promise.resolve({
        ok: true,
        messageId: `spy/${message.idempotencyKey}`,
      });
    },
  };
  return { transport, sent };
}

/** Flip an existing account into `pending_deletion` directly via SQL,
 *  leaving the auth_user row + password otherwise intact. Avoids the
 *  full initiate→confirm flow (which would drop sessions); the guard's
 *  lookup only reads `deletion_state`. */
async function flipToPendingDeletion(
  storage: TestContext["storage"],
  email: string,
): Promise<string> {
  const lifecycle = storage.accountLifecycle;
  if (!lifecycle) throw new Error("accountLifecycle unwired");
  const byEmail = await lifecycle.getAccountLifecycleByEmail(email);
  const authUserId = byEmail?.auth_user_id ?? "";
  if (!authUserId) throw new Error(`no auth_user for ${email}`);
  const nowIso = new Date().toISOString();
  const sqlite = storage as unknown as {
    __sqliteRun?: (q: string, p: unknown[]) => Promise<{ changes: number }>;
  };
  await sqlite.__sqliteRun?.(
    `UPDATE auth_user SET deletion_state = 'pending_deletion', pending_deletion_at = ? WHERE id = ?`,
    [nowIso, authUserId],
  );
  const after = await lifecycle.getAccountLifecycle(authUserId);
  expect(after?.deletion_state).toBe("pending_deletion");
  return authUserId;
}

describe("web-form sign-in guard for pending-deletion accounts", () => {
  const prevCooldown = process.env.MARFA_ACCOUNT_DELETE_CANCEL_COOLDOWN_MS;
  afterEach(() => {
    if (prevCooldown === undefined) {
      delete process.env.MARFA_ACCOUNT_DELETE_CANCEL_COOLDOWN_MS;
    } else {
      process.env.MARFA_ACCOUNT_DELETE_CANCEL_COOLDOWN_MS = prevCooldown;
    }
  });

  it("password mode: form POST to /auth/sign-in is blocked, no session minted, cancel email + audit row fire", async () => {
    process.env.MARFA_ACCOUNT_DELETE_CANCEL_COOLDOWN_MS = "0";
    const spy = makeEmailSpy();
    ctx = await createTestContext({ authAllowSignup: true }, spy.transport);
    await signUpAndVerify(ctx, "form-pending@example.com");
    const authUserId = await flipToPendingDeletion(
      ctx.storage,
      "form-pending@example.com",
    );

    // Sanity: the correct password really is correct (an active sign-in
    // via the JSON endpoint would 200 + set a session). We don't sign in
    // here — the point is the FORM path must NOT.
    const res = await request(ctx.app, "POST", "/auth/sign-in", {
      form: {
        mode: "password",
        email: "form-pending@example.com",
        password: "correct horse",
      },
      headers: { origin: ORIGIN },
    });

    // Blocked: 302 back to the sign-in page with the invalid_credentials
    // error — the SAME shape as a wrong password — NOT a 302 to `/` with
    // a session cookie.
    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(location.startsWith("/auth/sign-in")).toBe(true);
    expect(location).toContain("error=invalid_credentials");
    // No session was minted.
    expect(res.headers.get("set-cookie")).toBeNull();

    // The cancel email fired (the user-facing signal), template tag set.
    expect(spy.sent.length).toBeGreaterThanOrEqual(1);
    const cancelMail = spy.sent.find(
      (m) => m.tags?.template === "account-delete-cancel",
    );
    expect(cancelMail).toBeTruthy();
    expect(cancelMail?.to).toBe("form-pending@example.com");

    // The block audit row was written by the shared gate.
    const audit = await waitForAudit(
      () => ctx!.storage.audit.list({ resource_id: authUserId }),
      (page) =>
        page.data.some(
          (r) => r.action === "auth.account.sign_in_blocked_pending_deletion",
        ),
    );
    expect(
      audit.data.some(
        (r) => r.action === "auth.account.sign_in_blocked_pending_deletion",
      ),
    ).toBe(true);

    // No `auth.sign_in.success` row for this user — they were never
    // signed in.
    const success = await ctx.storage.audit.list({
      action: "auth.sign_in.success",
      resource_id: "form-pending@example.com",
    });
    expect(success.data.length).toBe(0);
  });

  it("magic mode: form POST to /auth/sign-in returns the 'sent' redirect, no magic link issued, cancel email fires", async () => {
    process.env.MARFA_ACCOUNT_DELETE_CANCEL_COOLDOWN_MS = "0";
    const spy = makeEmailSpy();
    ctx = await createTestContext({ authAllowSignup: true }, spy.transport);
    await signUpAndVerify(ctx, "form-magic@example.com");
    const authUserId = await flipToPendingDeletion(
      ctx.storage,
      "form-magic@example.com",
    );

    const res = await request(ctx.app, "POST", "/auth/sign-in", {
      form: {
        mode: "magic",
        email: "form-magic@example.com",
      },
      headers: { origin: ORIGIN },
    });

    // Indistinguishable from the magic-link success shape: 302 with
    // `sent=1`, mode=magic — so a pending account can't be enumerated.
    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(location.startsWith("/auth/sign-in")).toBe(true);
    expect(location).toContain("mode=magic");
    expect(location).toContain("sent=1");

    // The ONLY email sent is the cancel email — better-auth's magic-link
    // dispatch was never reached, so no magic-link email exists.
    const cancelMail = spy.sent.find(
      (m) => m.tags?.template === "account-delete-cancel",
    );
    expect(cancelMail).toBeTruthy();
    expect(cancelMail?.to).toBe("form-magic@example.com");
    const magicMail = spy.sent.find(
      (m) => m.tags?.template === "magic-link" || /magic/i.test(m.subject),
    );
    expect(magicMail).toBeUndefined();

    // The block audit row was written.
    const audit = await waitForAudit(
      () => ctx!.storage.audit.list({ resource_id: authUserId }),
      (page) =>
        page.data.some(
          (r) => r.action === "auth.account.sign_in_blocked_pending_deletion",
        ),
    );
    expect(
      audit.data.some(
        (r) => r.action === "auth.account.sign_in_blocked_pending_deletion",
      ),
    ).toBe(true);
  });

  it("active account still signs in via the form (guard is pending-deletion-only)", async () => {
    process.env.MARFA_ACCOUNT_DELETE_CANCEL_COOLDOWN_MS = "0";
    const spy = makeEmailSpy();
    ctx = await createTestContext({ authAllowSignup: true }, spy.transport);
    await signUpAndVerify(ctx, "form-active@example.com");

    const res = await request(ctx.app, "POST", "/auth/sign-in", {
      form: {
        mode: "password",
        email: "form-active@example.com",
        password: "correct horse",
      },
      headers: { origin: ORIGIN },
    });

    // Active account: 302 to `/` (returnTo) WITH a session cookie.
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/");
    expect(res.headers.get("set-cookie")).toBeTruthy();
    // No cancel email — the account isn't pending deletion.
    expect(
      spy.sent.some((m) => m.tags?.template === "account-delete-cancel"),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Full account-lifecycle arc
// ---------------------------------------------------------------------------
//
// Walks the complete user arc as a single test:
//
//   sign-up → verify → sign-in → request-delete → confirm → cancel →
//   re-sign-in → re-request → confirm → purge → hard-deleted.
//
// Deliberately re-asserts invariants covered piecewise in the suites
// above. The value is a single readable thread an operator can point
// at to confirm the lifecycle works end-to-end against the current
// build. Failures localize to a clear assertion in the arc.

describe("full account-lifecycle arc", () => {
  it("sign-up → verify → sign-in → request → confirm → cancel → re-request → confirm → purge", async () => {
    ctx = await createTestContext({ authAllowSignup: true });
    const email = "lifecycle@example.com";
    const lifecycle = ctx.storage.accountLifecycle;
    expect(lifecycle).toBeTruthy();

    // Step 1: sign-up. Test-side `markEmailVerified` stands in for
    // clicking the real verify link.
    await signUpAndVerify(ctx, email);

    // Step 2: sign-in. Cookie authenticates the consent surface for
    // POST /auth/account/delete. The exact status varies (better-auth
    // returns 200 with Set-Cookie); the load-bearing assertion is
    // that we got a session cookie back.
    const firstSignIn = await signIn(ctx, email);
    expect(firstSignIn.cookie).toBeTruthy();

    // Step 3: request-delete. Confirm token issued.
    const initiate1 = await request(ctx.app, "POST", "/auth/account/delete", {
      headers: { origin: ORIGIN, cookie: firstSignIn.cookie ?? "" },
    });
    expect(initiate1.status).toBe(202);
    const confirmToken1 = await readLatestVerification(
      ctx.storage,
      "account-delete:",
    );
    expect(confirmToken1).toBeTruthy();

    // Step 4: confirm. State flips to pending_deletion; sessions are
    // dropped; cancel-by-link token gets minted on the next blocked
    // sign-in attempt.
    const confirm1 = await request(
      ctx.app,
      "GET",
      `/auth/account/delete/confirm?token=${encodeURIComponent(confirmToken1 ?? "")}`,
      { headers: { origin: ORIGIN } },
    );
    expect(confirm1.status).toBe(200);
    const pending = await lifecycle?.getAccountLifecycleByEmail(email);
    expect(pending?.deletion_state).toBe("pending_deletion");
    const authUserId = pending?.auth_user_id ?? "";
    expect(authUserId).toBeTruthy();

    // Step 5: sign-in blocked. Generic 401 indistinguishable from
    // wrong-password; cancel-by-link token minted side-effect.
    const blocked = await signIn(ctx, email);
    expect(blocked.status).toBe(401);
    const cancelToken = await readLatestVerification(
      ctx.storage,
      "account-cancel:",
    );
    expect(cancelToken).toBeTruthy();

    // Step 6: cancel via link. Account back to active. No cascade race
    // here — the audit row is the standard `delete_cancelled` shape.
    const cancelRes = await request(
      ctx.app,
      "GET",
      `/auth/account/cancel?token=${encodeURIComponent(cancelToken ?? "")}`,
      { headers: { origin: ORIGIN } },
    );
    expect(cancelRes.status).toBe(200);
    const restored = await lifecycle?.getAccountLifecycleByEmail(email);
    expect(restored?.deletion_state).toBe("active");
    expect(restored?.pending_deletion_at).toBeNull();

    // Step 7: re-sign-in succeeds. The cancel actually restored access.
    const secondSignIn = await signIn(ctx, email);
    expect(secondSignIn.cookie).toBeTruthy();

    // Step 8: second request-delete + confirm. Same shape as steps 3-4.
    const initiate2 = await request(ctx.app, "POST", "/auth/account/delete", {
      headers: { origin: ORIGIN, cookie: secondSignIn.cookie ?? "" },
    });
    expect(initiate2.status).toBe(202);
    const confirmToken2 = await readLatestVerification(
      ctx.storage,
      "account-delete:",
    );
    expect(confirmToken2).toBeTruthy();
    expect(confirmToken2).not.toBe(confirmToken1);

    const confirm2 = await request(
      ctx.app,
      "GET",
      `/auth/account/delete/confirm?token=${encodeURIComponent(confirmToken2 ?? "")}`,
      { headers: { origin: ORIGIN } },
    );
    expect(confirm2.status).toBe(200);
    const pending2 = await lifecycle?.getAccountLifecycleByEmail(email);
    expect(pending2?.deletion_state).toBe("pending_deletion");

    // Step 9: purge. Run the cascade against a cutoff 31 days in the
    // future. The in-transaction re-check guards against stale state.
    const purger = new PendingDeletePurger(
      ctx.storage,
      30,
      3_600_000,
      () => new Date(Date.now() + 31 * 86_400_000),
      ctx.storage.coordination,
    );
    const purged = await purger.runOnce();
    expect(purged).toBeGreaterThanOrEqual(1);
    expect(await lifecycle?.getAccountLifecycle(authUserId)).toBeNull();

    // Step 10: audit hygiene. The earlier delete_requested /
    // delete_confirmed / delete_cancelled rows are keyed by
    // `resource_id = authUserId` and got redacted by the post-cascade
    // sweep. The `hard_deleted` row survives (emitted inside the
    // cascade transaction). Across every row assert no plaintext
    // email leaks in the details payload.
    const audit = await ctx.storage.audit.list({ resource_id: authUserId });
    expect(audit.data.length).toBeGreaterThan(0);
    const hardDeleted = audit.data.find(
      (r) => r.action === "auth.account.hard_deleted",
    );
    expect(hardDeleted).toBeTruthy();
    for (const row of audit.data) {
      const detailsStr = JSON.stringify(row.details);
      expect(detailsStr.toLowerCase()).not.toContain(email.toLowerCase());
    }

    // Step 11: re-sign-in fails after purge. Account is gone.
    const postPurgeSignIn = await signIn(ctx, email);
    expect(postPurgeSignIn.status).toBe(401);
  });
});
