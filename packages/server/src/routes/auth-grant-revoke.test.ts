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
 *
 * The device flow is the vehicle for both because it is the shortest path
 * to a real projected grant: initiate, approve, and the
 * `system.connection { kind: "app" }` row exists with the right tenant.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import {
  createTestContext,
  markEmailVerified,
  request,
  waitForConsentLockDepth,
} from "../test-utils.js";
import type { TestContext } from "../test-utils.js";

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

/** Seed an `auth_oauth_client` row — the device handlers only need the
 *  business key to resolve. */
async function seedClient(c: TestContext): Promise<string> {
  const clientId = `client_${Math.random().toString(36).slice(2, 10)}`;
  if (!c.storage.betterAuthDb) {
    throw new Error("seedClient: storage.betterAuthDb missing");
  }
  const schemaModule =
    c.storage.betterAuthDialect === "pg"
      ? await import("../storage/pg/schema.js")
      : await import("../storage/sqlite/schema.js");
  const db = c.storage.betterAuthDb as unknown as {
    insert: (table: unknown) => {
      values: (v: Record<string, unknown>) => {
        run?: () => Promise<unknown>;
        execute?: () => Promise<unknown>;
      };
    };
  };
  const redirectUris: unknown =
    c.storage.betterAuthDialect === "pg"
      ? [`${ORIGIN}/callback`]
      : JSON.stringify([`${ORIGIN}/callback`]);
  const now = new Date();
  const op = db.insert(schemaModule.auth_oauth_client).values({
    id: `pk_${Math.random().toString(36).slice(2, 10)}`,
    clientId,
    name: "Revoke Test CLI",
    redirectUris,
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
  const db = c.storage.betterAuthDb as unknown as {
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

/** Start a device-flow authorization; returns its `user_code`. */
async function initiateDeviceFlow(
  c: TestContext,
  clientId: string,
  scope: string,
): Promise<string> {
  const res = await request(c.app, "POST", "/auth/device", {
    body: { client_id: clientId, scope },
    headers: { origin: ORIGIN },
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { user_code: string };
  return body.user_code;
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

    const userCode = await initiateDeviceFlow(c, clientId, "core.note:read");
    expect((await approveDeviceFlow(c, userCode, cookie)).status).toBe(200);
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
