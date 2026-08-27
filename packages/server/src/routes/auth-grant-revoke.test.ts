/**
 * What revoking an app's grant has to guarantee.
 *
 * Two properties, both about the relationship between the record on
 * `/auth/security` and the access it describes:
 *
 *   - **A revoke that cannot revoke does not claim it did.** The cascade
 *     through the plugin's token tables runs before the projection is
 *     rewritten, so a failure leaves the record saying "active" — which
 *     is the truth, because the tokens are still live. The inverse order
 *     produces the one state worse than the failure: a security page
 *     showing revoked access that still works.
 *   - **The device-consent approval serializes with it.** Approving on a
 *     device is a fourth writer of the same standing grant, and left
 *     outside the consent lock its read-modify-write can straddle a whole
 *     revoke and put the grant back to active afterwards.
 *   - **Nothing the revoke leaves behind can still be exchanged.** The
 *     cascade sweeps the outstanding authorization codes and device codes,
 *     and both token surfaces refuse a grant that is no longer live. Two
 *     mechanisms per surface, because a sweep has a window and a guard
 *     alone leaves live state on a revoked connection.
 *
 * The device flow is the vehicle throughout because it is the shortest path
 * to a real projected grant: initiate, approve, and the
 * `system.connection { kind: "app" }` row exists with the right space.
 */
import { createHash, createHmac } from "node:crypto";
import { describe, it, expect, afterEach, vi } from "vitest";
import {
  createTestContext,
  markEmailVerified,
  request,
  waitForConsentLockDepth,
  TEST_API_KEY_SALT,
} from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { DEVICE_CODE_GRANT_TYPE } from "./auth-pages.js";

// Every test here boots a server, signs a user up and in (two password
// hashes), and drives at least one full device flow before it asserts
// anything. That is a lot of real work to fit inside the default budget
// on a machine running the rest of the suite beside it, and an overrun
// reports as a timeout — a result that says nothing about the property
// the test exists to check.
vi.setConfig({ testTimeout: 45_000 });

let ctx: TestContext | undefined;

afterEach(async () => {
  await ctx?.cleanup();
  ctx = undefined;
});

const ORIGIN = "http://localhost:0";

/** Seed an `auth_oauth_client` row. These tests drive the device flow, so
 *  the row registers the device grant: initiation refuses a client whose
 *  registration does not name it, and an unregistered grant reads as
 *  `authorization_code` alone per RFC 7591 §2. */
async function seedClient(c: TestContext): Promise<string> {
  const clientId = `client_${Math.random().toString(36).slice(2, 10)}`;
  if (!c.storage.betterAuthDb) {
    throw new Error("seedClient: storage.betterAuthDb missing");
  }
  const schemaModule =
    c.storage.betterAuthDialect === "pg"
      ? await import("../storage/pg/schema.js")
      : await import("../storage/sqlite/schema.js");
  const db = c.storage.betterAuthDb as {
    insert: (table: unknown) => {
      values: (v: Record<string, unknown>) => {
        run?: () => Promise<unknown>;
        execute?: () => Promise<unknown>;
      };
    };
  };
  const asColumn = (v: readonly string[]): unknown =>
    c.storage.betterAuthDialect === "pg" ? [...v] : JSON.stringify(v);
  const redirectUris = asColumn([`${ORIGIN}/callback`]);
  const now = new Date();
  const op = db.insert(schemaModule.auth_oauth_client).values({
    id: `pk_${Math.random().toString(36).slice(2, 10)}`,
    clientId,
    name: "Revoke Test CLI",
    redirectUris,
    grantTypes: asColumn(["urn:ietf:params:oauth:grant-type:device_code"]),
    disabled: false,
    createdAt: now,
    updatedAt: now,
    public: true,
    tokenEndpointAuthMethod: "none",
  });
  await (op.execute?.() ?? op.run?.() ?? Promise.resolve());
  return clientId;
}

/** Insert an access token the plugin's store will resolve, so "the
 *  cascade actually had something to revoke" is checkable. */
async function seedAccessToken(
  c: TestContext,
  clientId: string,
  authUserId: string,
  scopes: string[],
): Promise<string> {
  if (!c.storage.betterAuthDb) throw new Error("no betterAuthDb");
  const schemaModule =
    c.storage.betterAuthDialect === "pg"
      ? await import("../storage/pg/schema.js")
      : await import("../storage/sqlite/schema.js");
  const db = c.storage.betterAuthDb as {
    insert: (table: unknown) => {
      values: (v: Record<string, unknown>) => {
        run?: () => Promise<unknown>;
        execute?: () => Promise<unknown>;
      };
    };
  };
  const tokenHash = `hash_${Math.random().toString(36).slice(2)}`;
  const op = db.insert(schemaModule.auth_oauth_access_token).values({
    id: `at_${Math.random().toString(36).slice(2)}`,
    token: tokenHash,
    clientId,
    userId: authUserId,
    referenceId: null,
    expiresAt: new Date(Date.now() + 3600_000),
    createdAt: new Date(),
    scopes:
      c.storage.betterAuthDialect === "pg" ? scopes : JSON.stringify(scopes),
  });
  await (op.execute?.() ?? op.run?.() ?? Promise.resolve());
  return tokenHash;
}

/** Sign up + verify + sign in; returns the session cookie header value. */
async function signInUser(c: TestContext, email: string): Promise<string> {
  const password = "correct horse battery";
  await request(c.app, "POST", "/auth/sign-up/email", {
    body: { email, password, name: "Tester" },
    headers: { origin: ORIGIN },
  });
  await markEmailVerified(c.storage, email);
  const signIn = await request(c.app, "POST", "/auth/sign-in/email", {
    body: { email, password },
    headers: { origin: ORIGIN },
  });
  expect(signIn.status).toBe(200);
  const setCookie = signIn.headers.get("set-cookie");
  if (!setCookie) throw new Error("sign-in: no Set-Cookie header");
  for (const entry of setCookie.split(/,\s*(?=[a-zA-Z0-9_-]+=)/)) {
    const head = entry.split(";")[0];
    if (head?.includes("session_token")) return head;
  }
  throw new Error("sign-in: session_token cookie not found");
}

/** The Better Auth user id for a signed-up email. */
async function authUserIdFor(c: TestContext, email: string): Promise<string> {
  const schemaModule =
    c.storage.betterAuthDialect === "pg"
      ? await import("../storage/pg/schema.js")
      : await import("../storage/sqlite/schema.js");
  const { eq } = await import("drizzle-orm");
  const db = c.storage.betterAuthDb as {
    select: () => {
      from: (t: unknown) => {
        where: (w: unknown) => Promise<{ id: string }[]>;
      };
    };
  };
  const rows = await db
    .select()
    .from(schemaModule.auth_user)
    .where(eq(schemaModule.auth_user.email, email));
  const id = rows[0]?.id;
  if (!id) throw new Error(`authUserIdFor: no auth_user for ${email}`);
  return id;
}

/** Start a device-flow authorization. The `user_code` drives the consent
 *  screen and the `device_code` drives the poll, so both come back. */
async function initiateDeviceFlow(
  c: TestContext,
  clientId: string,
  scope: string,
): Promise<{ device_code: string; user_code: string }> {
  const res = await request(c.app, "POST", "/auth/device", {
    body: { client_id: clientId, scope },
    headers: { origin: ORIGIN },
  });
  expect(res.status).toBe(200);
  return (await res.json()) as { device_code: string; user_code: string };
}

/** Poll the terminal token step for a device code. */
function pollDeviceToken(
  c: TestContext,
  deviceCode: string,
  clientId: string,
): Promise<Response> {
  return request(c.app, "POST", "/auth/device/token", {
    form: {
      grant_type: DEVICE_CODE_GRANT_TYPE,
      device_code: deviceCode,
      client_id: clientId,
    },
    headers: { origin: ORIGIN },
  });
}

/** The hash `oauth_device_codes` keys on, matching what the route computes. */
function deviceCodeHash(deviceCode: string): string {
  return createHash("sha256").update(deviceCode).digest("base64url");
}

function approveDeviceFlow(
  c: TestContext,
  userCode: string,
  cookie: string,
): Promise<Response> {
  return request(c.app, "POST", "/auth/device/consent", {
    form: { user_code: userCode, decision: "approve" },
    headers: { origin: ORIGIN, cookie },
  });
}

/** The single projected `system.connection` grant, whatever its state. */
async function onlyGrant(c: TestContext) {
  const items = await c.storage.items.list({ type: "system.connection" });
  expect(items.data.length).toBe(1);
  return items.data[0]!;
}

describe("POST /auth/grants/:id/revoke — the record never overstates the revoke", () => {
  it("REGRESSION: a cascade that fails leaves the grant reading active, because it is", async () => {
    ctx = await createTestContext({ authAllowSignup: true });
    const c = ctx;
    const clientId = await seedClient(c);
    const cookie = await signInUser(c, "revoke-cascade@example.com");

    const flow = await initiateDeviceFlow(c, clientId, "core.note:read");
    expect((await approveDeviceFlow(c, flow.user_code, cookie)).status).toBe(
      200,
    );
    const grant = await onlyGrant(c);
    const tokenHash = await seedAccessToken(
      c,
      clientId,
      grant.properties.user_id as string,
      ["core.note:read"],
    );

    // The plugin's token tables are unreachable. Whatever the cause, the
    // access the user is trying to withdraw keeps working.
    const provider = c.storage.oauthProvider!;
    provider.revokeTokensForGrant = () =>
      Promise.reject(new Error("token store unavailable"));

    const res = await request(
      c.app,
      "POST",
      `/auth/grants/${grant.id}/revoke`,
      {
        headers: { origin: ORIGIN, cookie },
      },
    );

    // Told the truth, and told it on the page the user is already on.
    expect(res.status).toBe(302);
    expect(res.headers.get("location") ?? "").toContain(
      "notice=grant_revoke_failed",
    );

    // The record still describes the access the app really has, and the
    // token that access runs on is still there to be described.
    const after = await c.storage.items.get(grant.id);
    expect(after?.properties.status).toBe("active");
    expect(after?.properties.revoked_at).toBeUndefined();
    expect(
      await c.storage.oauthProvider?.validateAccessToken(tokenHash),
    ).not.toBeNull();
  });
});

describe("POST /auth/device/consent — the approval serializes with a revoke", () => {
  it("REGRESSION: an approval in flight cannot put back a grant revoked while it ran", async () => {
    ctx = await createTestContext({ authAllowSignup: true });
    const c = ctx;
    const clientId = await seedClient(c);
    const cookie = await signInUser(c, "device-vs-revoke@example.com");

    // A standing grant for the client, so there is something to revoke
    // and the second approval takes the update-in-place branch.
    const first = await initiateDeviceFlow(c, clientId, "core.note:read");
    expect((await approveDeviceFlow(c, first.user_code, cookie)).status).toBe(
      200,
    );
    const grant = await onlyGrant(c);

    // Park the second approval between resolving the projection and
    // writing it — the window the lock has to cover.
    const provider = c.storage.oauthProvider!;
    const resolveGrantItemId = provider.findGrantItemId.bind(provider);
    let reachedRead!: () => void;
    const reached = new Promise<void>((resolve) => {
      reachedRead = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let parked = false;
    provider.findGrantItemId = async (opts) => {
      const id = await resolveGrantItemId(opts);
      if (!parked) {
        parked = true;
        reachedRead();
        await gate;
      }
      return id;
    };

    const second = await initiateDeviceFlow(c, clientId, "core.task:write");
    const approving = approveDeviceFlow(c, second.user_code, cookie);
    await reached;

    // Meanwhile the user revokes the app from /auth/security.
    const revoking = request(c.app, "POST", `/auth/grants/${grant.id}/revoke`, {
      headers: { origin: ORIGIN, cookie },
    });
    // The revoke has to be queued on the lock before the approval is let
    // go. It does not get past the lock — that is the point — but a revoke
    // that arrives after the approval has already finished leaves the same
    // end state as one that arrived in time, so waiting for the arrival is
    // the only thing that tells the two apart.
    await waitForConsentLockDepth(
      clientId,
      grant.properties.user_id as string,
      2,
    );
    release();

    const [approveRes, revokeRes] = await Promise.all([approving, revoking]);
    expect(approveRes.status).toBe(200);
    expect(revokeRes.headers.get("location") ?? "").toContain(
      "notice=grant_revoked",
    );

    // The revoke ran second and is what the record has to reflect. With
    // the approval's read-modify-write outside the lock it lands after
    // the whole cascade instead, and the grant is active again with
    // `revoked_at` cleared — an app the user just disconnected, showing
    // as connected.
    const after = await c.storage.items.get(grant.id);
    expect(after?.properties.status).toBe("revoked");
    expect(after?.properties.revoked_at).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Outstanding authorization codes
// ---------------------------------------------------------------------------

/**
 * Seed an outstanding authorization code exactly as the plugin stores one:
 * an `auth_verification` row whose identifier is the hashed code and whose
 * value is the JSON blob naming the grant. Seeding rather than driving a
 * browser consent flow keeps the test about the revocation property, and
 * the shape is copied from the plugin's own writer so it cannot drift into
 * testing a fiction.
 */
async function seedAuthorizationCode(
  c: TestContext,
  clientId: string,
  authUserId: string,
  identifier?: string,
): Promise<string> {
  if (!c.storage.betterAuthDb) throw new Error("no betterAuthDb");
  const schemaModule =
    c.storage.betterAuthDialect === "pg"
      ? await import("../storage/pg/schema.js")
      : await import("../storage/sqlite/schema.js");
  const db = c.storage.betterAuthDb as {
    insert: (table: unknown) => {
      values: (v: Record<string, unknown>) => {
        run?: () => Promise<unknown>;
        execute?: () => Promise<unknown>;
      };
    };
  };
  const code = `code_${Math.random().toString(36).slice(2, 14)}`;
  const now = new Date();
  const op = db.insert(schemaModule.auth_verification).values({
    id: `ver_${Math.random().toString(36).slice(2)}`,
    // The store looks codes up by the hashed identifier. A test asserting
    // on deletion by grant rather than by identifier can use any stable
    // value, and the raw code keeps the row readable when debugging; a test
    // that drives the token endpoint has to seed the hash the guard will
    // compute, and passes it explicitly.
    identifier: identifier ?? code,
    value: JSON.stringify({
      type: "authorization_code",
      query: { client_id: clientId, redirect_uri: `${ORIGIN}/callback` },
      userId: authUserId,
      sessionId: "sess_test",
    }),
    expiresAt: new Date(Date.now() + 600_000),
    createdAt: now,
    updatedAt: now,
  });
  await (op.execute?.() ?? op.run?.() ?? Promise.resolve());
  return code;
}

/** Seed the consent row a live grant carries. */
async function seedConsent(
  c: TestContext,
  clientId: string,
  authUserId: string,
): Promise<void> {
  if (!c.storage.betterAuthDb) throw new Error("no betterAuthDb");
  const schemaModule =
    c.storage.betterAuthDialect === "pg"
      ? await import("../storage/pg/schema.js")
      : await import("../storage/sqlite/schema.js");
  const db = c.storage.betterAuthDb as {
    insert: (table: unknown) => {
      values: (v: Record<string, unknown>) => {
        run?: () => Promise<unknown>;
        execute?: () => Promise<unknown>;
      };
    };
  };
  const now = new Date();
  const op = db.insert(schemaModule.auth_oauth_consent).values({
    id: `cons_${Math.random().toString(36).slice(2)}`,
    clientId,
    userId: authUserId,
    scopes:
      c.storage.betterAuthDialect === "pg"
        ? ["core.note:read"]
        : JSON.stringify(["core.note:read"]),
    consentGiven: true,
    createdAt: now,
    updatedAt: now,
  });
  await (op.execute?.() ?? op.run?.() ?? Promise.resolve());
}

describe("revocation reaches outstanding authorization codes", () => {
  it("REGRESSION: revoking a grant deletes its outstanding codes", async () => {
    ctx = await createTestContext({ authMode: "hosted" });
    const email = `codes-${Math.random().toString(36).slice(2, 8)}@cyzr.me`;
    await signInUser(ctx, email);
    const authUserId = await authUserIdFor(ctx, email);
    const clientId = await seedClient(ctx);
    await seedConsent(ctx, clientId, authUserId);
    await seedAuthorizationCode(ctx, clientId, authUserId);

    // A second grant's code must survive: revocation is per-grant, and a
    // delete that swept the table would pass the assertion below while
    // logging every other user out of every other app.
    const otherClient = await seedClient(ctx);
    await seedConsent(ctx, otherClient, authUserId);
    await seedAuthorizationCode(ctx, otherClient, authUserId);

    await ctx.storage.oauthProvider!.revokeTokensForGrant(clientId, authUserId);

    // The revoked grant's code is gone; the untouched grant's is not.
    const rows = await countAuthorizationCodes(ctx);
    expect(rows.get(clientId) ?? 0).toBe(0);
    expect(rows.get(otherClient) ?? 0).toBe(1);
  });

  it("REGRESSION: a code whose grant is revoked cannot be redeemed", async () => {
    ctx = await createTestContext({ authMode: "hosted" });
    const email = `exch-${Math.random().toString(36).slice(2, 8)}@cyzr.me`;
    await signInUser(ctx, email);
    const authUserId = await authUserIdFor(ctx, email);
    const clientId = await seedClient(ctx);
    await seedConsent(ctx, clientId, authUserId);
    const code = await seedAuthorizationCode(ctx, clientId, authUserId);

    // While consented, the store reports the grant as live.
    const live =
      await ctx.storage.oauthProvider!.findAuthorizationCodeGrantKey(code);
    expect(live?.hasConsent).toBe(true);
    expect(live?.clientId).toBe(clientId);

    // Drop only the consent row, reproducing the window the sweep leaves:
    // a code minted between the consent delete and the code delete.
    await dropConsent(ctx, clientId, authUserId);

    const afterRevoke =
      await ctx.storage.oauthProvider!.findAuthorizationCodeGrantKey(code);
    // Still present, and now correctly reported as belonging to no grant.
    // That is what the exchange guard refuses on.
    expect(afterRevoke).not.toBeNull();
    expect(afterRevoke?.hasConsent).toBe(false);
  });

  it("REGRESSION: the token endpoint refuses a revoked grant's code", async () => {
    // The sweep and the guard are two mechanisms, and the tests above only
    // reach the first. They assert on the store, which is the layer the
    // sweep writes to; the guard is a before-hook on `/oauth2/token` and is
    // never in their path, so removing it entirely left them all green.
    //
    // The guard exists for the window the sweep cannot close — a code minted
    // between the consent delete and the code delete — and for the next
    // revocation path that forgets the codes, which is how this defect arose
    // the first time. A defence against a future mistake with no test is
    // removed by the first person tidying an unused-looking hook.
    //
    // So this one drives the endpoint. The seeded identifier is the hashed
    // code, because that is what the guard looks up.
    ctx = await createTestContext({ authMode: "hosted" });
    const email = `guard-${Math.random().toString(36).slice(2, 8)}@cyzr.me`;
    await signInUser(ctx, email);
    const authUserId = await authUserIdFor(ctx, email);
    const clientId = await seedClient(ctx);
    await seedConsent(ctx, clientId, authUserId);

    const code = `code_${Math.random().toString(36).slice(2, 14)}`;
    await seedAuthorizationCode(ctx, clientId, authUserId, hashCode(code));

    // Exactly the window the sweep leaves: the consent row is gone and the
    // code is not.
    await dropConsent(ctx, clientId, authUserId);

    const res = await ctx.app.request("/auth/oauth2/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: clientId,
        redirect_uri: `${ORIGIN}/callback`,
      }).toString(),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error?: string;
      error_description?: string;
    };
    expect(body.error).toBe("invalid_grant");
    // The guard's own wording, not the plugin's. Without it the request
    // reaches the plugin, which has its own opinion about a code it can
    // still resolve, and the two are not the same answer.
    expect(body.error_description).toContain("revoked");
  });
});

// ---------------------------------------------------------------------------
// Outstanding device codes
// ---------------------------------------------------------------------------

/**
 * The device sibling of the block above, and the same two mechanisms.
 *
 * The ordering is the whole reproduction: approve a device code, revoke the
 * connection, poll inside the code's remaining TTL. A test that revokes
 * before the approval or after the poll sees nothing, because every check
 * the terminal step performs passes on a revoked grant: revocation leaves
 * the scope list verbatim on the row it flips.
 *
 * Both tests revoke through `POST /auth/grants/:id/revoke` rather than
 * writing the item directly. A store write bypasses `revokeProjectedGrant`
 * entirely, which is where the sweep lives, so a test that took the short
 * route would exercise the poll-time guard alone while reading as though it
 * covered both.
 */
describe("revocation reaches outstanding device codes", () => {
  it("REGRESSION: a poll after a revoke does not mint, though the device code has not expired", async () => {
    ctx = await createTestContext({ authAllowSignup: true });
    const c = ctx;
    const clientId = await seedClient(c);
    const cookie = await signInUser(c, "device-poll-after-revoke@example.com");

    // A first device login, approved and polled. It mints, which is what
    // makes the refusal below mean anything: this fixture shape is one the
    // endpoint admits, so the later 400 is about the revoke rather than
    // about a device code that was never good.
    const first = await initiateDeviceFlow(c, clientId, "core.note:read");
    expect((await approveDeviceFlow(c, first.user_code, cookie)).status).toBe(
      200,
    );
    const minted = await pollDeviceToken(c, first.device_code, clientId);
    expect(minted.status).toBe(200);
    expect(
      ((await minted.json()) as { access_token?: string }).access_token,
    ).toBeTruthy();

    const grant = await onlyGrant(c);

    // A second device login, parked between the grant write and the flip
    // that binds the code to it. That is the window the sweep cannot close
    // and the reason the guard is worth having on its own: the projection
    // write runs under the consent lock and `approveDeviceCode` runs after
    // the lock is released, so a revoke can land its whole cascade in
    // between and pass over a code that is not bound to the grant yet.
    const second = await initiateDeviceFlow(c, clientId, "core.note:read");
    const flipDeviceCode = c.storage.oauth.approveDeviceCode.bind(
      c.storage.oauth,
    );
    let reachedFlip!: () => void;
    const reached = new Promise<void>((resolve) => {
      reachedFlip = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let parked = false;
    c.storage.oauth.approveDeviceCode = async (id, connectionItemId) => {
      if (!parked) {
        parked = true;
        reachedFlip();
        await gate;
      }
      return flipDeviceCode(id, connectionItemId);
    };

    const approving = approveDeviceFlow(c, second.user_code, cookie);
    await reached;

    const revoked = await request(
      c.app,
      "POST",
      `/auth/grants/${grant.id}/revoke`,
      { headers: { origin: ORIGIN, cookie } },
    );
    expect(revoked.headers.get("location") ?? "").toContain(
      "notice=grant_revoked",
    );
    release();
    expect((await approving).status).toBe(200);

    // The code the poll is about to present: bound to the revoked grant,
    // still approved, and provably unexpired. The expiry check sits ABOVE
    // the lifecycle guard and answers 400 as well, so without this the
    // status code alone could not tell an expiry from a revoke.
    const row = await c.storage.oauth.findDeviceCodeByHash(
      deviceCodeHash(second.device_code),
    );
    expect(row?.status).toBe("approved");
    expect(row?.connection_item_id).toBe(grant.id);
    expect(new Date(row!.expires_at).getTime()).toBeGreaterThan(Date.now());

    const res = await pollDeviceToken(c, second.device_code, clientId);
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error?: string;
      access_token?: string;
      refresh_token?: string;
    };
    expect(body.error).toBe("invalid_grant");
    expect(body.error).not.toBe("expired_token");
    // The refresh token is the half that outlives the window, so its
    // absence is asserted beside the access token's rather than implied.
    expect(body.access_token).toBeUndefined();
    expect(body.refresh_token).toBeUndefined();
  });

  it("REGRESSION: revoking a grant deletes the device codes approved against it", async () => {
    ctx = await createTestContext({ authAllowSignup: true });
    const c = ctx;
    const clientId = await seedClient(c);
    const cookie = await signInUser(c, "device-codes-swept@example.com");

    const flow = await initiateDeviceFlow(c, clientId, "core.note:read");
    expect((await approveDeviceFlow(c, flow.user_code, cookie)).status).toBe(
      200,
    );
    const grant = await onlyGrant(c);

    // Present before the revoke, so the assertion after it is about the
    // sweep rather than about a code that was never stored.
    expect(
      await c.storage.oauth.findDeviceCodeByHash(
        deviceCodeHash(flow.device_code),
      ),
    ).not.toBeNull();

    const revoked = await request(
      c.app,
      "POST",
      `/auth/grants/${grant.id}/revoke`,
      { headers: { origin: ORIGIN, cookie } },
    );
    expect(revoked.headers.get("location") ?? "").toContain(
      "notice=grant_revoked",
    );

    expect(
      await c.storage.oauth.findDeviceCodeByHash(
        deviceCodeHash(flow.device_code),
      ),
    ).toBeNull();

    // And the poll it would have answered has nothing left to answer from.
    const res = await pollDeviceToken(c, flow.device_code, clientId);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error?: string }).error).toBe(
      "invalid_grant",
    );
  });

  it("leaves another user's pending device code for the same client alone", async () => {
    ctx = await createTestContext({ authAllowSignup: true });
    const c = ctx;
    const clientId = await seedClient(c);
    const cookieA = await signInUser(c, "device-sweep-a@example.com");
    const cookieB = await signInUser(c, "device-sweep-b@example.com");

    const flowA = await initiateDeviceFlow(c, clientId, "core.note:read");
    expect((await approveDeviceFlow(c, flowA.user_code, cookieA)).status).toBe(
      200,
    );
    const grant = await onlyGrant(c);

    // B is mid-flow on the same client: initiated, not approved, so the row
    // carries the client and nobody's user. There is no user column on that
    // table because a pending row is pre-consent, which is exactly why the
    // sweep keys on the grant item and not on the client.
    const flowB = await initiateDeviceFlow(c, clientId, "core.note:read");

    const revoked = await request(
      c.app,
      "POST",
      `/auth/grants/${grant.id}/revoke`,
      { headers: { origin: ORIGIN, cookie: cookieA } },
    );
    expect(revoked.headers.get("location") ?? "").toContain(
      "notice=grant_revoked",
    );

    // A's code went, so the sweep did run.
    expect(
      await c.storage.oauth.findDeviceCodeByHash(
        deviceCodeHash(flowA.device_code),
      ),
    ).toBeNull();

    // B's did not, and still answers the way an unapproved code should.
    // Sweeping by client instead would sign B out of a login they are
    // standing in front of, on the strength of somebody else's revoke.
    const res = await pollDeviceToken(c, flowB.device_code, clientId);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error?: string }).error).toBe(
      "authorization_pending",
    );

    // And B carries it through to a token, which is the part that matters:
    // "still pending" would also be the answer if the code had survived in
    // a state nothing could finish.
    expect((await approveDeviceFlow(c, flowB.user_code, cookieB)).status).toBe(
      200,
    );
    const mintedForB = await pollDeviceToken(c, flowB.device_code, clientId);
    expect(mintedForB.status).toBe(200);
    expect(
      ((await mintedForB.json()) as { access_token?: string }).access_token,
    ).toBeTruthy();
  });
});

/** The identifier the exchange guard looks a code up by. */
function hashCode(code: string): string {
  return createHmac("sha256", TEST_API_KEY_SALT).update(code).digest("hex");
}

/** Count outstanding authorization codes per client id. */
async function countAuthorizationCodes(
  c: TestContext,
): Promise<Map<string, number>> {
  const schemaModule =
    c.storage.betterAuthDialect === "pg"
      ? await import("../storage/pg/schema.js")
      : await import("../storage/sqlite/schema.js");
  const db = c.storage.betterAuthDb as {
    select: () => {
      from: (t: unknown) => Promise<{ value: string }[]>;
    };
  };
  const rows = await db.select().from(schemaModule.auth_verification);
  const out = new Map<string, number>();
  for (const row of rows) {
    let parsed: { type?: string; query?: { client_id?: string } };
    try {
      parsed = JSON.parse(row.value) as typeof parsed;
    } catch {
      continue;
    }
    if (parsed.type !== "authorization_code") continue;
    const cid = parsed.query?.client_id;
    if (!cid) continue;
    out.set(cid, (out.get(cid) ?? 0) + 1);
  }
  return out;
}

/** Delete just the consent row, leaving codes behind. */
async function dropConsent(
  c: TestContext,
  clientId: string,
  authUserId: string,
): Promise<void> {
  const schemaModule =
    c.storage.betterAuthDialect === "pg"
      ? await import("../storage/pg/schema.js")
      : await import("../storage/sqlite/schema.js");
  const { and, eq } = await import("drizzle-orm");
  const db = c.storage.betterAuthDb as {
    delete: (t: unknown) => {
      where: (w: unknown) => {
        run?: () => Promise<unknown>;
        execute?: () => Promise<unknown>;
      };
    };
  };
  const op = db
    .delete(schemaModule.auth_oauth_consent)
    .where(
      and(
        eq(schemaModule.auth_oauth_consent.clientId, clientId),
        eq(schemaModule.auth_oauth_consent.userId, authUserId),
      ),
    );
  await (op.execute?.() ?? op.run?.() ?? Promise.resolve());
}
