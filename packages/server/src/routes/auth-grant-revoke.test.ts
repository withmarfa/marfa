/**
 * What revoking an app's grant has to guarantee.
 *
 *   - **A failed revoke preserves its prior authority.** Tokens, pending
 *     codes, consent, projection and audit commit or roll back together.
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
 * `system.connection { kind: "app" }` row exists.
 */
import { DEVICE_CODE_GRANT_TYPE } from "@better-auth/oauth-provider";
import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { itemWrites } from "../storage/item-writes.js";
import type { TestContext } from "../test-utils.js";
import {
  createTestContext,
  request,
  storedDeviceCode,
  TEST_API_KEY_SALT,
} from "../test-utils.js";

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
  const schemaModule = await import("../storage/sqlite/schema.js");
  const db = c.storage.betterAuthDb as {
    insert: (table: unknown) => {
      values: (v: Record<string, unknown>) => {
        run?: () => Promise<unknown>;
        execute?: () => Promise<unknown>;
      };
    };
  };
  const asColumn = (v: readonly string[]): unknown => JSON.stringify(v);
  const redirectUris = asColumn([`${ORIGIN}/callback`]);
  const now = new Date();
  const op = db.insert(schemaModule.auth_oauth_client).values({
    id: `pk_${Math.random().toString(36).slice(2, 10)}`,
    clientId,
    name: "Revoke Test CLI",
    redirectUris,
    // The refresh grant beside the device grant: the plugin mints a refresh
    // token for `offline_access` only when the client is registered for it,
    // and the refresh token is the half the severity argument below rests on.
    grantTypes: asColumn([
      "urn:ietf:params:oauth:grant-type:device_code",
      "refresh_token",
    ]),
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
  const schemaModule = await import("../storage/sqlite/schema.js");
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
    expiresAt: new Date(Date.now() + 3600_000),
    createdAt: new Date(),
    scopes: JSON.stringify(scopes),
  });
  await (op.execute?.() ?? op.run?.() ?? Promise.resolve());
  return tokenHash;
}

/** Sign up + verify + sign in; returns the session cookie header value. */
async function signInUser(c: TestContext): Promise<string> {
  const { email, password } = c.owner;
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

/** Start a device-flow authorization. The `user_code` drives the consent
 *  screen and the `device_code` drives the poll, so both come back. */
async function initiateDeviceFlow(
  c: TestContext,
  clientId: string,
  scope: string,
): Promise<{ device_code: string; user_code: string; scope: string }> {
  const res = await request(c.app, "POST", "/auth/device/code", {
    body: { client_id: clientId, scope },
    headers: { origin: ORIGIN },
  });
  expect(res.status).toBe(200);
  // The scope rides along because approving needs it: the consent form
  // carries a checkbox per requested scope, so an approval has to say what
  // it is ticking.
  const body = (await res.json()) as { device_code: string; user_code: string };
  return { ...body, scope };
}

/** Poll the terminal token step for a device code. */
function pollDeviceToken(
  c: TestContext,
  deviceCode: string,
  clientId: string,
): Promise<Response> {
  return request(c.app, "POST", "/auth/oauth2/token", {
    form: {
      grant_type: DEVICE_CODE_GRANT_TYPE,
      device_code: deviceCode,
      client_id: clientId,
    },
    headers: { origin: ORIGIN },
  });
}

interface DeviceCodeRow {
  status: string;
  userId: string | null;
  clientId: string | null;
  expiresAt: Date;
}

/** The plugin's row for a device code, or null once it has been swept. */
async function deviceCodeRow(
  c: TestContext,
  deviceCode: string,
): Promise<DeviceCodeRow | null> {
  const schemaModule = await import("../storage/sqlite/schema.js");
  const { eq } = await import("drizzle-orm");
  const db = c.storage.betterAuthDb as {
    select: () => {
      from: (t: unknown) => {
        where: (w: unknown) => Promise<DeviceCodeRow[]>;
      };
    };
  };
  const rows = await db
    .select()
    .from(schemaModule.auth_oauth_device_code)
    .where(
      eq(
        schemaModule.auth_oauth_device_code.deviceCode,
        storedDeviceCode(deviceCode),
      ),
    );
  return rows[0] ?? null;
}

interface UpdatingDb {
  update: (t: unknown) => {
    set: (v: Record<string, unknown>) => {
      where: (w: unknown) => Promise<unknown>;
    };
  };
}

/** Flip a pending code to approved for a user, the state the plugin's
 *  approve endpoint leaves, without going through the consent screen. */
async function approveCodeDirectly(
  c: TestContext,
  deviceCode: string,
  authUserId: string,
): Promise<void> {
  const schemaModule = await import("../storage/sqlite/schema.js");
  const { eq } = await import("drizzle-orm");
  const db = c.storage.betterAuthDb as UpdatingDb;
  await db
    .update(schemaModule.auth_oauth_device_code)
    .set({ status: "approved", userId: authUserId })
    .where(
      eq(
        schemaModule.auth_oauth_device_code.deviceCode,
        storedDeviceCode(deviceCode),
      ),
    );
}

/** The plugin holds a poller to its interval, and a poll stamps the row.
 *  Clear the stamp so a second poll in the same test is answered on the
 *  code's state rather than with `slow_down`. */
async function allowRepoll(c: TestContext, deviceCode: string): Promise<void> {
  const schemaModule = await import("../storage/sqlite/schema.js");
  const { eq } = await import("drizzle-orm");
  const db = c.storage.betterAuthDb as UpdatingDb;
  await db
    .update(schemaModule.auth_oauth_device_code)
    .set({ lastPolledAt: null })
    .where(
      eq(
        schemaModule.auth_oauth_device_code.deviceCode,
        storedDeviceCode(deviceCode),
      ),
    );
}

function approveDeviceFlow(
  c: TestContext,
  flow: { user_code: string; scope: string },
  cookie: string,
): Promise<Response> {
  return request(c.app, "POST", "/auth/device/consent", {
    form: {
      user_code: flow.user_code,
      decision: "approve",
      // Everything ticked, which is what the screen submits untouched: the
      // approval form carries a checkbox per requested scope, so a post with
      // none is a denial rather than a full approval.
      scopes: flow.scope.split(" ").filter(Boolean),
    },
    headers: { origin: ORIGIN, cookie },
  });
}

/** The single projected `system.connection` grant, in whatever lifecycle
 *  state it sits: a revocation moves `properties.status` and a soft delete
 *  moves `state`, and this helper has to see a row either one produced. */
async function onlyGrant(c: TestContext) {
  const items = await c.storage.items.list({
    type: "system.connection",
    all_states: true,
  });
  expect(items.data.length).toBe(1);
  return items.data[0]!;
}

describe("DELETE /auth/grants/:id — the record never overstates the revoke", () => {
  it("REGRESSION: a cascade that fails leaves the grant reading active, because it is", async () => {
    ctx = await createTestContext({});
    const c = ctx;
    const clientId = await seedClient(c);
    const cookie = await signInUser(c);

    const flow = await initiateDeviceFlow(c, clientId, "core.note:read");
    expect((await approveDeviceFlow(c, flow, cookie)).status).toBe(200);
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

    const res = await request(c.app, "DELETE", `/auth/grants/${grant.id}`, {
      key: c.workingKey,
    });

    // Told the truth: the cascade refused, and so did the door.
    expect(res.status).toBe(500);

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
    ctx = await createTestContext({});
    const c = ctx;
    const clientId = await seedClient(c);
    const cookie = await signInUser(c);

    // A standing grant for the client, so there is something to revoke
    // and the second approval takes the update-in-place branch.
    const first = await initiateDeviceFlow(c, clientId, "core.note:read");
    expect((await approveDeviceFlow(c, first, cookie)).status).toBe(200);
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
    const approving = approveDeviceFlow(c, second, cookie);
    await reached;

    // The writer also serializes authentication reads. Observe the request
    // entering validation before releasing the active approval transaction.
    let reachedRevoke!: () => void;
    const revokeArrived = new Promise<void>((resolve) => {
      reachedRevoke = resolve;
    });
    const validate = c.storage.keys.validate.bind(c.storage.keys);
    c.storage.keys.validate = (hash) => {
      reachedRevoke();
      return validate(hash);
    };
    const revoking = request(c.app, "DELETE", `/auth/grants/${grant.id}`, {
      key: c.workingKey,
    });
    await revokeArrived;
    release();

    const [approveRes, revokeRes] = await Promise.all([approving, revoking]);
    expect(approveRes.status).toBe(200);
    expect(revokeRes.status).toBe(204);

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
  const schemaModule = await import("../storage/sqlite/schema.js");
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
  const schemaModule = await import("../storage/sqlite/schema.js");
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
    scopes: JSON.stringify(["core.note:read"]),
    consentGiven: true,
    createdAt: now,
    updatedAt: now,
  });
  await (op.execute?.() ?? op.run?.() ?? Promise.resolve());
}

describe("revocation reaches outstanding authorization codes", () => {
  it("REGRESSION: revoking a grant deletes its outstanding codes", async () => {
    ctx = await createTestContext({});
    await signInUser(ctx);
    const authUserId = ctx.owner.id;
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
    ctx = await createTestContext({});
    await signInUser(ctx);
    const authUserId = ctx.owner.id;
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
    // the first time. A defense against a future mistake with no test is
    // removed by the first person tidying an unused-looking hook.
    //
    // So this one drives the endpoint. The seeded identifier is the hashed
    // code, because that is what the guard looks up.
    ctx = await createTestContext({});
    await signInUser(ctx);
    const authUserId = ctx.owner.id;
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
 * Both tests revoke through `DELETE /auth/grants/:id` rather than
 * writing the item directly. A store write bypasses `revokeProjectedGrant`
 * entirely, which is where the sweep lives, so a test that took the short
 * route would exercise the poll-time guard alone while reading as though it
 * covered both.
 */
describe("revocation reaches outstanding device codes", () => {
  it("REGRESSION: a poll after a revoke does not mint, though the device code has not expired", async () => {
    ctx = await createTestContext({});
    const c = ctx;
    const clientId = await seedClient(c);
    const cookie = await signInUser(c);

    // A first device login, approved and polled. It mints, which is what
    // makes the refusal below mean anything: this fixture shape is one the
    // endpoint admits, so the later 400 is about the revoke rather than
    // about a device code that was never good.
    //
    // **`offline_access` is in the scope on purpose, and both flows carry
    // it.** The refresh token is the whole severity argument — the access
    // token expires in an hour, the refresh token rotates indefinitely —
    // but a poll only ever mints one when the issued scopes name
    // `offline_access`. On a `core.note:read` fixture a successful poll
    // returns no refresh token either, so asserting its absence after the
    // revoke would pass identically on both sides of the defect. The mint
    // here is what proves it: this shape does hand one back, so its absence
    // below is the guard's doing.
    const first = await initiateDeviceFlow(
      c,
      clientId,
      "core.note:read offline_access",
    );
    expect((await approveDeviceFlow(c, first, cookie)).status).toBe(200);
    const minted = await pollDeviceToken(c, first.device_code, clientId);
    expect(minted.status).toBe(200);
    const mintedBody = (await minted.json()) as {
      access_token?: string;
      refresh_token?: string;
    };
    expect(mintedBody.access_token).toBeTruthy();
    expect(mintedBody.refresh_token).toBeTruthy();

    const grant = await onlyGrant(c);

    // A second device code, bound to the grant AFTER the revoke.
    //
    // **This used to park a request inside `approveDeviceCode` and revoke
    // while it waited.** That worked because the binding ran outside the
    // consent lock; closing that window moved the binding inside the lock,
    // so a parked approval holds it and the revoke below would block on it
    // forever. The old fixture deadlocks against the fix, which is the fix
    // being real rather than a problem with it.
    //
    // **The guard this test is about is unaffected and still worth having.**
    // It refuses at poll time on the grant's own state, and it now defends a
    // state the approval path can no longer produce — which is what defense
    // in depth means, not a reason to delete it. A grant revoked while a code
    // was outstanding, a row restored from a backup taken mid-flight, or a
    // future path that binds somewhere else all arrive here.
    //
    // So the state is constructed through the store rather than raced into
    // existence. The revoke still goes through the route, because the sweep
    // lives in `revokeProjectedGrant` and a store write would skip it: the
    // code is bound after the sweep has run and found nothing, which is
    // precisely the shape the guard exists for.
    const second = await initiateDeviceFlow(
      c,
      clientId,
      "core.note:read offline_access",
    );

    const revoked = await request(c.app, "DELETE", `/auth/grants/${grant.id}`, {
      key: c.workingKey,
    });
    expect(revoked.status).toBe(204);

    const pending = await deviceCodeRow(c, second.device_code);
    expect(pending?.status).toBe("pending");
    const authUserId = c.owner.id;
    await approveCodeDirectly(c, second.device_code, authUserId);

    // The code the poll is about to present: approved for the person whose
    // grant was just revoked, and provably unexpired. The expiry check sits
    // ABOVE the lifecycle guard and answers 400 as well, so without this the
    // status code alone could not tell an expiry from a revoke. The
    // `expiresAt` assertion is the one doing that work — the error code
    // below cannot, because both refusals are 400.
    const row = await deviceCodeRow(c, second.device_code);
    expect(row?.status).toBe("approved");
    expect(row?.userId).toBe(authUserId);
    expect(row?.clientId).toBe(clientId);
    expect(row!.expiresAt.getTime()).toBeGreaterThan(Date.now());

    const res = await pollDeviceToken(c, second.device_code, clientId);
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error?: string;
      access_token?: string;
      refresh_token?: string;
    };
    expect(body.error).toBe("invalid_grant");
    // The refresh token is the half that outlives the window, so its
    // absence is asserted beside the access token's rather than implied.
    // It observes only because the fixture asked for `offline_access`: the
    // successful poll above proves this shape mints one.
    expect(body.access_token).toBeUndefined();
    expect(body.refresh_token).toBeUndefined();
  });

  it("REGRESSION: revoking a grant deletes the device codes approved against it", async () => {
    ctx = await createTestContext({});
    const c = ctx;
    const clientId = await seedClient(c);
    const cookie = await signInUser(c);

    const flow = await initiateDeviceFlow(c, clientId, "core.note:read");
    expect((await approveDeviceFlow(c, flow, cookie)).status).toBe(200);
    const grant = await onlyGrant(c);

    // Present before the revoke, so the assertion after it is about the
    // sweep rather than about a code that was never stored.
    expect(await deviceCodeRow(c, flow.device_code)).not.toBeNull();

    const revoked = await request(c.app, "DELETE", `/auth/grants/${grant.id}`, {
      key: c.workingKey,
    });
    expect(revoked.status).toBe(204);

    expect(await deviceCodeRow(c, flow.device_code)).toBeNull();

    // And the poll it would have answered has nothing left to answer from.
    const res = await pollDeviceToken(c, flow.device_code, clientId);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error?: string }).error).toBe(
      "invalid_grant",
    );
  });

  it("leaves another user's pending device code for the same client alone", async () => {
    ctx = await createTestContext({});
    const c = ctx;
    const clientId = await seedClient(c);
    const cookieA = await signInUser(c);
    const cookieB = await signInUser(c);

    const flowA = await initiateDeviceFlow(c, clientId, "core.note:read");
    expect((await approveDeviceFlow(c, flowA, cookieA)).status).toBe(200);
    const grant = await onlyGrant(c);

    // B is mid-flow on the same client: initiated, not yet claimed on the
    // consent screen, so the row carries the client and nobody's user. The
    // sweep keys on the (client, user) pair, which is exactly why B's row
    // is outside it.
    const flowB = await initiateDeviceFlow(c, clientId, "core.note:read");

    const revoked = await request(c.app, "DELETE", `/auth/grants/${grant.id}`, {
      key: c.workingKey,
    });
    expect(revoked.status).toBe(204);

    // A's code went, so the sweep did run.
    expect(await deviceCodeRow(c, flowA.device_code)).toBeNull();

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
    expect((await approveDeviceFlow(c, flowB, cookieB)).status).toBe(200);
    await allowRepoll(c, flowB.device_code);
    const mintedForB = await pollDeviceToken(c, flowB.device_code, clientId);
    expect(mintedForB.status).toBe(200);
    expect(
      ((await mintedForB.json()) as { access_token?: string }).access_token,
    ).toBeTruthy();
  });

  it("rolls back the complete revoke when the device-code sweep fails and permits retry", async () => {
    ctx = await createTestContext({});
    const c = ctx;
    const clientId = await seedClient(c);
    const cookie = await signInUser(c);

    const flow = await initiateDeviceFlow(c, clientId, "core.note:read");
    expect((await approveDeviceFlow(c, flow, cookie)).status).toBe(200);
    const grant = await onlyGrant(c);
    const tokenHash = await seedAccessToken(
      c,
      clientId,
      grant.properties.user_id as string,
      ["core.note:read"],
    );
    // Live before the revoke, so the assertion after it is about the cascade
    // rather than about a token that was never resolvable.
    expect(
      await c.storage.oauthProvider?.validateAccessToken(tokenHash),
    ).not.toBeNull();

    // The device-code table is unreachable. Lock contention, a permissions
    // change, a corrupt index — the cause does not matter, only that it
    // persists.
    const sweep = c.storage.oauthProvider!.deleteDeviceCodesForGrant.bind(
      c.storage.oauthProvider,
    );
    c.storage.oauthProvider!.deleteDeviceCodesForGrant = () =>
      Promise.reject(new Error("device code table unavailable"));

    const res = await request(c.app, "DELETE", `/auth/grants/${grant.id}`, {
      key: c.workingKey,
    });
    expect(res.status).toBe(500);

    expect(
      await c.storage.oauthProvider?.validateAccessToken(tokenHash),
    ).not.toBeNull();

    const after = await c.storage.items.get(grant.id);
    expect(after?.properties.status).toBe("active");
    expect(after?.properties.revoked_at).toBeUndefined();
    c.storage.oauthProvider!.deleteDeviceCodesForGrant = sweep;
    expect(
      (
        await request(c.app, "DELETE", `/auth/grants/${grant.id}`, {
          key: c.workingKey,
        })
      ).status,
    ).toBe(204);
    expect(
      await c.storage.oauthProvider?.validateAccessToken(tokenHash),
    ).toBeNull();
    expect((await c.storage.items.get(grant.id))?.properties.status).toBe(
      "revoked",
    );
  });

  it("REGRESSION: a poll refuses a grant soft-deleted out of the active state", async () => {
    // The item's own lifecycle axis, which the guard reads separately from
    // `properties.status`. A `system.*` soft delete lands on `revoked`
    // rather than `trashed` and touches nothing inside `properties`, so this
    // is a grant every read surface hides — and so nobody can revoke through
    // the interface built for revoking it — while its `status` still says
    // `active`. The status half of the guard passes on this row; only the
    // state half refuses it.
    ctx = await createTestContext({});
    const c = ctx;
    const clientId = await seedClient(c);
    const cookie = await signInUser(c);

    const flow = await initiateDeviceFlow(c, clientId, "core.note:read");
    expect((await approveDeviceFlow(c, flow, cookie)).status).toBe(200);
    // A second code bound to the same grant. A code is spent by its one
    // exchange, so the code that proves the fixture mints cannot also be
    // the code the refusal below is measured on.
    const probe = await initiateDeviceFlow(c, clientId, "core.note:read");
    expect((await approveDeviceFlow(c, probe, cookie)).status).toBe(200);
    const grant = await onlyGrant(c);

    // A code bound to this grant mints while the grant is live, so the
    // refusal below is about the state axis and nothing else about the
    // fixture.
    expect((await pollDeviceToken(c, probe.device_code, clientId)).status).toBe(
      200,
    );

    await itemWrites(c.storage).delete(grant.id);

    // Exactly the disagreement described: one axis moved, the other did not.
    const soft = await c.storage.items.getIncludingTrashed(grant.id);
    expect(soft?.state).toBe("revoked");
    expect(soft?.properties.status).toBe("active");

    // Nothing swept the code — a store-level soft delete does not run
    // `revokeProjectedGrant` — so it is still approved, still the person's,
    // and still unexpired. The expiry check answers 400 too, so the
    // assertion rather than the status code is what rules that reading out.
    const row = await deviceCodeRow(c, flow.device_code);
    expect(row?.status).toBe("approved");
    expect(row?.userId).toBe(grant.properties.user_id);
    expect(row!.expiresAt.getTime()).toBeGreaterThan(Date.now());

    const res = await pollDeviceToken(c, flow.device_code, clientId);
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error?: string;
      access_token?: string;
    };
    expect(body.error).toBe("invalid_grant");
    expect(body.access_token).toBeUndefined();
  });

  it("REGRESSION: a poll refuses an approved code whose grant item was purged", async () => {
    // The plugin's row names the client and the person, not the projection,
    // so a hard purge of the grant item leaves an approved code whose grant
    // no longer exists. That is a reachable state rather than a broken
    // invariant, and it earns the same refusal a revoked one gets rather
    // than a token minted against nothing.
    ctx = await createTestContext({});
    const c = ctx;
    const clientId = await seedClient(c);
    const cookie = await signInUser(c);

    const flow = await initiateDeviceFlow(c, clientId, "core.note:read");
    expect((await approveDeviceFlow(c, flow, cookie)).status).toBe(200);
    // A second code bound to the same grant, for the reason the sibling
    // case above gives: a code is spent by its one exchange.
    const probe = await initiateDeviceFlow(c, clientId, "core.note:read");
    expect((await approveDeviceFlow(c, probe, cookie)).status).toBe(200);
    const grant = await onlyGrant(c);

    // Admitted before the purge, so the refusal below is about the missing
    // grant rather than about the fixture.
    expect((await pollDeviceToken(c, probe.device_code, clientId)).status).toBe(
      200,
    );

    // The purge route's own two steps: soft delete first, because purge
    // refuses an item that has not been soft-deleted.
    await itemWrites(c.storage).delete(grant.id);
    await itemWrites(c.storage).purge(grant.id);
    expect(await c.storage.items.getIncludingTrashed(grant.id)).toBeNull();

    // The row survived, its grant did not.
    const row = await deviceCodeRow(c, flow.device_code);
    expect(row?.status).toBe("approved");
    expect(row!.expiresAt.getTime()).toBeGreaterThan(Date.now());

    const res = await pollDeviceToken(c, flow.device_code, clientId);
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error?: string;
      access_token?: string;
    };
    expect(body.error).toBe("invalid_grant");
    expect(body.access_token).toBeUndefined();
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
  const schemaModule = await import("../storage/sqlite/schema.js");
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
  const schemaModule = await import("../storage/sqlite/schema.js");
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
