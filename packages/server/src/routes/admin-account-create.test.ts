/**
 * `POST /admin/accounts` — the operator route that mints an email +
 * password account on an instance where hosted sign-up is closed.
 *
 * Every context here runs with `authAllowSignup: false` and
 * `authRequireEmailVerification: true`, which is the hosted shape: the
 * sign-up endpoints refuse, and an unverified account cannot sign in.
 * If the route ever regresses into calling the sign-up path, or into
 * leaving the address unproven, these tests stop passing rather than
 * quietly producing an account nobody can use.
 *
 * What they pin: the platform-admin gate on both its arms; the account
 * lands verified with its own space and `space_admin` on it, the same as
 * a sign-up's; the password is the one the sign-in path accepts; a
 * duplicate address is a conflict rather than a second account; and a
 * password under Better Auth's own minimum is refused before anything is
 * written.
 */
import { describe, expect, it, afterEach } from "vitest";
import {
  createTestContext,
  request,
  TEST_API_KEY_SALT,
} from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { hashApiKey } from "../middleware/auth.js";

const ORIGIN = "http://localhost:0";
const PASSWORD = "correct horse battery staple";

let ctx: TestContext | undefined;

afterEach(async () => {
  await ctx?.cleanup();
  ctx = undefined;
});

/** A hosted instance with sign-up closed and verification required — what
 *  staging runs, and the only configuration this route exists for. */
async function hostedContext(): Promise<TestContext> {
  return createTestContext({
    authMode: "hosted",
    authAllowSignup: false,
    authRequireEmailVerification: true,
  });
}

/** A space-scoped, non-platform key. The 403 arm needs a credential that
 *  authenticates and still is not a platform admin. */
async function mintSpaceKey(c: TestContext): Promise<string> {
  if (!c.storage.spaces) throw new Error("hosted storage has spaces");
  const space = await c.storage.spaces.create("not-a-platform-admin");
  const suffix = Math.random().toString(36).slice(2, 10);
  const raw = `marfa_k1_test_member_${suffix}`;
  await c.storage.keys.create(
    {
      label: `test-member-${suffix}`,
      source: `test-member-${suffix}`,
      role: "member",
      type_permissions: {},
      default_tier: "library",
      is_platform: false,
    },
    hashApiKey(raw, TEST_API_KEY_SALT),
    space.id,
  );
  return raw;
}

async function createAccount(
  c: TestContext,
  body: unknown,
  key?: string,
): Promise<Response> {
  return request(c.app, "POST", "/admin/accounts", {
    ...(key === undefined ? {} : { key }),
    body,
  });
}

describe("POST /admin/accounts", () => {
  it("refuses without credentials, and with a credential that is not a platform admin", async () => {
    ctx = await hostedContext();
    const anonymous = await createAccount(ctx, {
      email: "nobody@test.marfa.so",
      password: PASSWORD,
    });
    expect(anonymous.status).toBe(401);

    const memberKey = await mintSpaceKey(ctx);
    const member = await createAccount(
      ctx,
      { email: "nobody@test.marfa.so", password: PASSWORD },
      memberKey,
    );
    expect(member.status).toBe(403);

    // Neither refusal left anything behind.
    expect(
      await ctx.storage.accountLifecycle?.getAccountLifecycleByEmail(
        "nobody@test.marfa.so",
      ),
    ).toBeFalsy();
  });

  it("creates an account that owns its space and can sign in, where sign-up is closed", async () => {
    ctx = await hostedContext();
    const email = "smoke@test.marfa.so";

    // The premise: this instance mints no accounts through sign-up.
    const signUp = await request(ctx.app, "POST", "/auth/sign-up/email", {
      body: { email, password: PASSWORD, name: "Smoke" },
      headers: { origin: ORIGIN },
    });
    expect(signUp.status).toBe(400);

    const res = await createAccount(
      ctx,
      { email, password: PASSWORD, name: "Smoke" },
      ctx.adminKey,
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(typeof body.id).toBe("string");
    expect(typeof body.space_id).toBe("string");
    expect(body.email).toBe(email);
    // The password never comes back, under any spelling.
    expect(JSON.stringify(body)).not.toContain(PASSWORD);

    // The provisioning hook ran: its own space, and space_admin on it —
    // the same shape a sign-up gets, which is what lets the smoke suite
    // purge rather than trash.
    const user = await ctx.storage.users?.getByAuthUserId(body.id as string);
    expect(user?.space_id).toBe(body.space_id);
    expect(user?.role).toBe("space_admin");
    const space = await ctx.storage.spaces?.get(body.space_id as string);
    expect(space?.id).toBe(body.space_id);

    // Verified on arrival, so the sign-in path accepts it with no email
    // round-trip — and it accepts the password we sent, which is what
    // makes the hash the one better-auth wrote.
    const signIn = await request(ctx.app, "POST", "/auth/sign-in/email", {
      body: { email, password: PASSWORD },
      headers: { origin: ORIGIN },
    });
    if (signIn.status !== 200) {
      const text = await signIn.text();
      throw new Error(
        `sign-in/email returned ${String(signIn.status)}: ${text.slice(0, 400)}`,
      );
    }
    expect(signIn.headers.get("set-cookie")).toBeTruthy();

    // The wrong password is still the wrong password.
    const wrong = await request(ctx.app, "POST", "/auth/sign-in/email", {
      body: { email, password: `${PASSWORD} not` },
      headers: { origin: ORIGIN },
    });
    expect(wrong.status).not.toBe(200);
  });

  it("refuses an address that already has an account", async () => {
    ctx = await hostedContext();
    const email = "twice@test.marfa.so";
    const first = await createAccount(
      ctx,
      { email, password: PASSWORD },
      ctx.adminKey,
    );
    expect(first.status).toBe(201);

    for (const spelling of [email, email.toUpperCase()]) {
      const again = await createAccount(
        ctx,
        { email: spelling, password: PASSWORD },
        ctx.adminKey,
      );
      expect(again.status, spelling).toBe(409);
    }
  });

  it("refuses a password the sign-in path would not accept, and a malformed address", async () => {
    ctx = await hostedContext();
    // Better Auth's own minimum is 8; anything shorter is refused by the
    // sign-in path's hasher config rather than by a number spelled here.
    const short = await createAccount(
      ctx,
      { email: "short@test.marfa.so", password: "abc" },
      ctx.adminKey,
    );
    expect(short.status).toBe(400);
    expect(
      await ctx.storage.accountLifecycle?.getAccountLifecycleByEmail(
        "short@test.marfa.so",
      ),
    ).toBeFalsy();

    const malformed = await createAccount(
      ctx,
      { email: "not-an-address", password: PASSWORD },
      ctx.adminKey,
    );
    expect(malformed.status).toBe(400);
  });
});
