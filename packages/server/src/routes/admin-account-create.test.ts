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
 * What they pin: the operator-key gate, including against the space-bound
 * key holding every space permission a widened gate would let through; the
 * account lands verified with its own space, the same as a sign-up's; the
 * password is the one the sign-in path accepts;
 * the operator's audit row is platform level and carries no address; a
 * duplicate address is a conflict rather than a second account, while a
 * failure to provision is a failure rather than a conflict; a password
 * under Better Auth's own minimum is refused before anything is written;
 * and a deployment with no accounts at all says so.
 */
import { describe, expect, it, afterEach } from "vitest";
import {
  createTestContext,
  request,
  TEST_API_KEY_SALT,
  waitForAudit,
} from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { hashApiKey } from "../middleware/auth.js";
import { SPACE_PERMISSIONS } from "@withmarfa/shared";
import type { SpacePermission } from "@withmarfa/shared";

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

/** A space-bound key holding the named space permissions. The gate refuses
 *  both of the shapes it is called with: one holding nothing, which has no
 *  administrative reach at all, and one holding every space permission,
 *  because operator authority is authority not confined to a space and no
 *  permission set adds up to it. The second is the one a widened gate would
 *  let through, so both arms are exercised rather than the easy one. */
async function mintSpaceKey(
  c: TestContext,
  name: string,
  spacePermissions: SpacePermission[],
): Promise<string> {
  if (!c.storage.spaces) throw new Error("hosted storage has spaces");
  const space = await c.storage.spaces.create(`not-an-operator-${name}`);
  const suffix = Math.random().toString(36).slice(2, 10);
  const raw = `marfa_k1_test_member_${suffix}`;
  await c.storage.keys.create(
    {
      label: `test-member-${suffix}`,
      source: `test-member-${suffix}`,
      space_permissions: spacePermissions,
      type_permissions: {},
      default_tier: "library",
      is_operator: false,
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
  it("refuses without credentials, and with any credential confined to a space", async () => {
    ctx = await hostedContext();
    const anonymous = await createAccount(ctx, {
      email: "nobody@test.marfa.so",
      password: PASSWORD,
    });
    expect(anonymous.status).toBe(401);

    for (const [name, permissions] of [
      ["holds nothing", []],
      ["holds every space permission", [...SPACE_PERMISSIONS]],
    ] as const) {
      const key = await mintSpaceKey(ctx, name, [...permissions]);
      const res = await createAccount(
        ctx,
        { email: "nobody@test.marfa.so", password: PASSWORD },
        key,
      );
      expect(res.status, name).toBe(403);
    }

    // No refusal left anything behind.
    expect(
      await ctx.storage.accountLifecycle?.getAccountLifecycleByEmail(
        "nobody@test.marfa.so",
      ),
    ).toBeFalsy();
  });

  it("answers a deployment with no user accounts rather than crashing", async () => {
    // Keys mode: no auth server, no users table. The router is mounted
    // either way, so the route has to say so itself.
    ctx = await createTestContext({ authMode: "keys" });
    const res = await createAccount(
      ctx,
      { email: "nobody@test.marfa.so", password: PASSWORD },
      ctx.adminKey,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("validation_error");
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

    // The provisioning hook ran: its own space, the same shape a sign-up
    // gets, which is what lets the smoke suite purge rather than trash.
    const user = await ctx.storage.users?.getByAuthUserId(body.id as string);
    expect(user?.space_id).toBe(body.space_id);
    expect(await ctx.storage.spaces?.get(body.space_id as string)).toBeTruthy();

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

    // The wrong password is still the wrong password, and is refused as
    // one rather than by anything else going wrong.
    const wrong = await request(ctx.app, "POST", "/auth/sign-in/email", {
      body: { email, password: `${PASSWORD} not` },
      headers: { origin: ORIGIN },
    });
    expect(wrong.status).toBe(401);

    // The operator's action is recorded, and the record is platform
    // level: stamping it with the space would put the operator's key id
    // inside the `GET /audit` feed of the account just created, which is
    // its own space's admin. The address is on no part of the row.
    const audit = await waitForAudit(
      () => ctx!.storage.audit.list({ action: "admin.account.create" }),
      (page) => page.data.some((row) => row.resource_id === body.id),
    );
    const row = audit.data.find((entry) => entry.resource_id === body.id);
    expect(row?.space_id ?? null).toBeNull();
    expect(JSON.stringify(row)).not.toContain(email);
    expect(JSON.stringify(row?.details)).toContain(body.space_id as string);
  });

  it("reports a failure to provision as a failure, not as a conflict", async () => {
    ctx = await hostedContext();
    const spaces = ctx.storage.spaces;
    if (!spaces) throw new Error("hosted storage has spaces");
    const email = "unprovisioned@test.marfa.so";

    // The provisioning hook runs inline on the account create and
    // rethrows when it fails. That throw reaches the same place a
    // duplicate address reaches, and the two have to be told apart: an
    // operator answered "an account already exists" would go looking for
    // an account, and every retry would say the same thing.
    const create = spaces.create.bind(spaces);
    spaces.create = () => Promise.reject(new Error("space store unavailable"));
    try {
      const res = await createAccount(
        ctx,
        { email, password: PASSWORD },
        ctx.adminKey,
      );
      expect(res.status).not.toBe(409);
      expect(res.status).toBe(500);
    } finally {
      spaces.create = create;
    }
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
