/**
 * A device approval writes both halves of the grant.
 *
 * A grant is two records: the `system.connection` projection Marfa keeps and
 * the plugin's `auth_oauth_consent` row. The device flow writes the
 * projection itself and issues tokens from Marfa's own table, so it never
 * passed through the plugin's consent endpoint and never left a consent row
 * behind. Neither consent check could then see a device grant, the plugin's
 * exact-membership skip nor Marfa's coverage check: a browser authorize for
 * the same app rendered the consent screen as if the person had never
 * approved it. The revoke cascade deletes the row by pair whether or not one
 * exists, so nothing leaked; the record was absent.
 *
 * The cases drive the real flow, with two exceptions that seed what the flow
 * cannot produce on demand: a consent row standing with no projection (the
 * shape a failed projection write leaves), and a drifted space binding. A
 * device approval leaves one row carrying the merged scopes and the grant's
 * space; a browser authorize is then answered silently; a re-approval widens
 * the one row; in hosted mode the row is bound to the space and a drifted
 * binding is re-stamped; a standalone row is narrowed to the approval,
 * deliberately; the row equals the merged set where merging is not a union;
 * an approval whose bind fails leaves no row; revoking the grant removes the
 * row and the browser is asked again.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import {
  createTestContext,
  markEmailVerified,
  request,
} from "../test-utils.js";
import type { TestContext } from "../test-utils.js";

// Each case signs a user up and in and drives a device flow end to end
// before asserting, which is more than the default budget allows on a
// machine running the rest of the suite beside it.
vi.setConfig({ testTimeout: 45_000 });

let ctx: TestContext | undefined;

afterEach(async () => {
  await ctx?.cleanup();
  ctx = undefined;
});

const ORIGIN = "http://localhost:0";
const CALLBACK = "http://localhost:0/callback";
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

async function betterAuthSchema(c: TestContext) {
  return c.storage.betterAuthDialect === "pg"
    ? await import("../storage/pg/schema.js")
    : await import("../storage/sqlite/schema.js");
}

/** A public client registered for the device grant and the code flow, with
 *  no scope ceiling, so one client can approve on a device and then
 *  authorize in a browser. */
async function seedClient(c: TestContext): Promise<string> {
  const clientId = `client_${randomBytes(5).toString("hex")}`;
  if (!c.storage.betterAuthDb) {
    throw new Error("seedClient: storage.betterAuthDb missing");
  }
  const schema = await betterAuthSchema(c);
  const db = c.storage.betterAuthDb as unknown as {
    insert: (table: unknown) => {
      values: (v: Record<string, unknown>) => {
        run?: () => Promise<unknown>;
        execute?: () => Promise<unknown>;
      };
    };
  };
  const isPg = c.storage.betterAuthDialect === "pg";
  const asColumn = (values: readonly string[]): unknown =>
    isPg ? [...values] : JSON.stringify([...values]);
  const now = new Date();
  const op = db.insert(schema.auth_oauth_client).values({
    id: `pk_${randomBytes(5).toString("hex")}`,
    clientId,
    name: "Device Then Browser",
    redirectUris: asColumn([CALLBACK]),
    grantTypes: asColumn([DEVICE_GRANT, "authorization_code"]),
    responseTypes: asColumn(["code"]),
    scopes: null,
    disabled: false,
    createdAt: now,
    updatedAt: now,
    public: true,
    tokenEndpointAuthMethod: "none",
  });
  await (op.execute?.() ?? op.run?.() ?? Promise.resolve());
  return clientId;
}

async function signInUser(c: TestContext, email: string): Promise<string> {
  const password = "correct horse battery";
  const signUpRes = await request(c.app, "POST", "/auth/sign-up/email", {
    body: { email, password, name: "Test User" },
    headers: { origin: ORIGIN },
  });
  if (signUpRes.status !== 200) {
    throw new Error(`sign-up failed (${String(signUpRes.status)})`);
  }
  await markEmailVerified(c.storage, email);
  const signInRes = await request(c.app, "POST", "/auth/sign-in/email", {
    body: { email, password },
    headers: { origin: ORIGIN },
  });
  if (signInRes.status !== 200) {
    throw new Error(`sign-in failed (${String(signInRes.status)})`);
  }
  const setCookie = signInRes.headers.get("set-cookie");
  if (!setCookie) throw new Error("sign-in: no Set-Cookie header");
  const match = /(?:^|,\s*)([\w.-]*session_token=[^;]+)/.exec(setCookie);
  if (!match?.[1]) throw new Error("sign-in: session_token cookie not found");
  return match[1];
}

async function authUserIdFor(c: TestContext, email: string): Promise<string> {
  const schema = await betterAuthSchema(c);
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
    .from(schema.auth_user)
    .where(eq(schema.auth_user.email, email));
  const id = rows[0]?.id;
  if (!id) throw new Error(`authUserIdFor: no auth_user for ${email}`);
  return id;
}

/** Initiate and approve a device flow for `scope`; returns the user code. */
async function approveOnDevice(
  c: TestContext,
  clientId: string,
  cookie: string,
  scope: string,
): Promise<void> {
  const init = await request(c.app, "POST", "/auth/device", {
    body: { client_id: clientId, scope },
    headers: { origin: ORIGIN },
  });
  expect(init.status).toBe(200);
  const { user_code } = (await init.json()) as { user_code: string };
  const approve = await request(c.app, "POST", "/auth/device/consent", {
    form: {
      user_code,
      decision: "approve",
      // Everything ticked, which is what the screen submits untouched:
      // the approval form carries a checkbox per requested scope, so a
      // post with none is a denial rather than a full approval.
      scopes: scope.split(" ").filter(Boolean),
    },
    headers: { origin: ORIGIN, cookie },
  });
  expect(approve.status).toBe(200);
}

/** Point the pair's row at a space it does not belong to, the shape a
 *  binding that drifted (or a row written before the binding existed)
 *  leaves behind. */
async function driftReferenceId(
  c: TestContext,
  clientId: string,
  authUserId: string,
): Promise<void> {
  const schema = await betterAuthSchema(c);
  const { and, eq } = await import("drizzle-orm");
  const db = c.storage.betterAuthDb as {
    update: (table: unknown) => {
      set: (values: Record<string, unknown>) => {
        where: (cond: unknown) => Promise<unknown>;
      };
    };
  };
  await db
    .update(schema.auth_oauth_consent)
    .set({ referenceId: "space_drifted" })
    .where(
      and(
        eq(schema.auth_oauth_consent.clientId, clientId),
        eq(schema.auth_oauth_consent.userId, authUserId),
      ),
    );
}

/** The consent rows for the pair, scopes normalized across the array column
 *  and the JSON-string column. */
async function consentRows(
  c: TestContext,
  clientId: string,
  authUserId: string,
): Promise<{ scopes: string[]; referenceId: string | null }[]> {
  const schema = await betterAuthSchema(c);
  const { and, eq } = await import("drizzle-orm");
  const db = c.storage.betterAuthDb as {
    select: () => {
      from: (t: unknown) => {
        where: (
          w: unknown,
        ) => Promise<{ scopes: unknown; referenceId: string | null }[]>;
      };
    };
  };
  const rows = await db
    .select()
    .from(schema.auth_oauth_consent)
    .where(
      and(
        eq(schema.auth_oauth_consent.clientId, clientId),
        eq(schema.auth_oauth_consent.userId, authUserId),
      ),
    );
  return rows.map((row) => ({
    scopes: (Array.isArray(row.scopes)
      ? (row.scopes as string[])
      : (JSON.parse(String(row.scopes)) as string[])
    ).sort(),
    referenceId: row.referenceId,
  }));
}

async function onlyGrant(c: TestContext) {
  const items = await c.storage.items.list({ type: "system.connection" });
  expect(items.data.length).toBe(1);
  return items.data[0]!;
}

/** What a browser authorize for the app does: reaches the consent screen, or
 *  is answered silently with a code because a consent row covers it. The
 *  silent answer has two shapes, the plugin's own skip straight from its
 *  authorize endpoint and Marfa's skip on the consent route. */
async function authorizeOutcome(
  c: TestContext,
  clientId: string,
  cookie: string,
  scope: string,
): Promise<"consent_screen" | "silent_code"> {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: CALLBACK,
    state: "device-then-browser",
    scope,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  const authorizeRes = await request(
    c.app,
    "GET",
    `/auth/oauth2/authorize?${params.toString()}`,
    { headers: { cookie } },
  );
  expect(authorizeRes.status).toBe(302);
  const location = authorizeRes.headers.get("location") ?? "";
  if (isCallbackWithCode(location)) return "silent_code";
  if (!location.includes("/auth/authorize?")) {
    throw new Error(`authorize did not reach the consent route: ${location}`);
  }
  const consentRes = await request(c.app, "GET", location, {
    headers: { cookie },
  });
  if (consentRes.status === 200) return "consent_screen";
  const next = consentRes.headers.get("location") ?? "";
  if (consentRes.status === 302 && isCallbackWithCode(next)) {
    return "silent_code";
  }
  throw new Error(
    `unexpected consent outcome: ${String(consentRes.status)} ${next}`,
  );
}

function isCallbackWithCode(location: string): boolean {
  return (
    location.startsWith(CALLBACK) &&
    new URL(location).searchParams.get("code") !== null
  );
}

describe("POST /auth/device/consent writes the plugin's consent row", () => {
  it("an approval leaves a consent row carrying the merged scopes and the grant's space", async () => {
    ctx = await createTestContext({ authAllowSignup: true });
    const clientId = await seedClient(ctx);
    const cookie = await signInUser(ctx, "device@example.com");
    const authUserId = await authUserIdFor(ctx, "device@example.com");

    await approveOnDevice(ctx, clientId, cookie, "core.note:read");

    const grant = await onlyGrant(ctx);
    const rows = await consentRows(ctx, clientId, authUserId);
    expect(rows).toEqual([
      {
        scopes: ["core.note:read"],
        referenceId: grant.space_id ?? null,
      },
    ]);
  });

  it("a browser authorize for the same app is then answered silently", async () => {
    ctx = await createTestContext({ authAllowSignup: true });
    const clientId = await seedClient(ctx);
    const cookie = await signInUser(ctx, "browser@example.com");

    // Before any grant the browser is asked.
    expect(
      await authorizeOutcome(ctx, clientId, cookie, "core.note:read"),
    ).toBe("consent_screen");

    await approveOnDevice(ctx, clientId, cookie, "core.note:read");

    // After the device approval it is not: the consent row covers it.
    expect(
      await authorizeOutcome(ctx, clientId, cookie, "core.note:read"),
    ).toBe("silent_code");
  });

  it("a re-approval widens the one row rather than adding a second", async () => {
    ctx = await createTestContext({ authAllowSignup: true });
    const clientId = await seedClient(ctx);
    const cookie = await signInUser(ctx, "again@example.com");
    const authUserId = await authUserIdFor(ctx, "again@example.com");

    await approveOnDevice(ctx, clientId, cookie, "core.note:read");
    await approveOnDevice(ctx, clientId, cookie, "core.task:read");

    const grant = await onlyGrant(ctx);
    const rows = await consentRows(ctx, clientId, authUserId);
    expect(rows.length).toBe(1);
    // The approval merges into the standing grant, and the row mirrors the
    // record the merge produced rather than either request alone.
    expect(rows[0]!.scopes).toEqual(
      [...(grant.properties.scopes as string[])].sort(),
    );
    expect(rows[0]!.scopes).toEqual(["core.note:read", "core.task:read"]);
  });

  it("in hosted mode the row is bound to the grant's space, and a re-approval re-stamps a drifted binding", async () => {
    // The plugin's own lookup filters on `reference_id` whenever the value
    // it computes is truthy, and in hosted mode that is the space id. A row
    // bound to nothing, or to the wrong space, is one the plugin's skip
    // never matches; only Marfa's coverage check would still fire, and the
    // repair the update half does is what keeps the two in step.
    ctx = await createTestContext({
      authMode: "hosted",
      authAllowSignup: true,
    });
    const clientId = await seedClient(ctx);
    const cookie = await signInUser(ctx, "hosted@example.com");
    const authUserId = await authUserIdFor(ctx, "hosted@example.com");

    await approveOnDevice(ctx, clientId, cookie, "core.note:read");
    const grant = await onlyGrant(ctx);
    expect(grant.space_id).toBeTruthy();
    expect(await consentRows(ctx, clientId, authUserId)).toEqual([
      { scopes: ["core.note:read"], referenceId: grant.space_id },
    ]);

    await driftReferenceId(ctx, clientId, authUserId);
    await approveOnDevice(ctx, clientId, cookie, "core.task:read");
    const rows = await consentRows(ctx, clientId, authUserId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.referenceId).toBe(grant.space_id);
    expect(rows[0]!.scopes).toEqual(
      expect.arrayContaining(["core.note:read", "core.task:read"]),
    );
  });

  it("a consent row standing with no projection is narrowed to the approval, deliberately", async () => {
    // The code flow logs a failed projection write and issues its code
    // anyway, so a row can stand alone holding what the browser granted.
    // The projection is the grant and the row mirrors it: the next device
    // approval rebuilds the projection from its own request and the row
    // follows, which withdraws consent rather than widening it, and the
    // browser asks again for the rest. This pins that the shrink is chosen,
    // not an accident of replace-versus-merge.
    ctx = await createTestContext({ authAllowSignup: true });
    const clientId = await seedClient(ctx);
    const cookie = await signInUser(ctx, "standalone@example.com");
    const authUserId = await authUserIdFor(ctx, "standalone@example.com");
    await ctx.storage.oauthProvider!.upsertConsent({
      clientId,
      authUserId,
      referenceId: null,
      scopes: ["core.note:read", "core.task:write"],
    });

    await approveOnDevice(ctx, clientId, cookie, "core.note:read");

    const grant = await onlyGrant(ctx);
    expect(grant.properties.scopes).toEqual(["core.note:read"]);
    const rows = await consentRows(ctx, clientId, authUserId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.scopes).toEqual(["core.note:read"]);
  });

  it("the row mirrors the merged set where merging is not a union", async () => {
    // Read then write on one type: the merge keeps one entry per key, so
    // the row must equal what the projection holds rather than the two
    // requests concatenated. Disjoint keys cannot tell those apart.
    ctx = await createTestContext({ authAllowSignup: true });
    const clientId = await seedClient(ctx);
    const cookie = await signInUser(ctx, "merge@example.com");
    const authUserId = await authUserIdFor(ctx, "merge@example.com");

    await approveOnDevice(ctx, clientId, cookie, "core.note:read");
    await approveOnDevice(ctx, clientId, cookie, "core.note:write");

    const grant = await onlyGrant(ctx);
    const rows = await consentRows(ctx, clientId, authUserId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.scopes).toEqual(
      [...(grant.properties.scopes as string[])].sort(),
    );
    expect(rows[0]!.scopes).toContain("core.note:write");
  });

  it("an approval that does not bind the code leaves no row behind", async () => {
    // Two tabs on one user code: the loser is told its approval did not
    // take effect, and a consent row written regardless would answer the
    // next browser authorize with a code and no screen. The bind is the
    // gate, so the row is written only behind it.
    ctx = await createTestContext({ authAllowSignup: true });
    const clientId = await seedClient(ctx);
    const cookie = await signInUser(ctx, "loser@example.com");
    const authUserId = await authUserIdFor(ctx, "loser@example.com");
    vi.spyOn(ctx.storage.oauth, "approveDeviceCode").mockResolvedValueOnce(
      false,
    );

    const init = await request(ctx.app, "POST", "/auth/device", {
      body: { client_id: clientId, scope: "core.note:read" },
      headers: { origin: ORIGIN },
    });
    expect(init.status).toBe(200);
    const { user_code } = (await init.json()) as { user_code: string };
    const approve = await request(ctx.app, "POST", "/auth/device/consent", {
      form: {
        user_code,
        decision: "approve",
        scopes: ["core.note:read"],
      },
      headers: { origin: ORIGIN, cookie },
    });
    expect(approve.status).toBe(302);
    expect(approve.headers.get("location")).toContain("already_resolved");
    expect(await consentRows(ctx, clientId, authUserId)).toEqual([]);
  });

  it("revoking the grant removes the row with the rest", async () => {
    ctx = await createTestContext({ authAllowSignup: true });
    const clientId = await seedClient(ctx);
    const cookie = await signInUser(ctx, "revoke@example.com");
    const authUserId = await authUserIdFor(ctx, "revoke@example.com");

    await approveOnDevice(ctx, clientId, cookie, "core.note:read");
    expect((await consentRows(ctx, clientId, authUserId)).length).toBe(1);

    const grant = await onlyGrant(ctx);
    const revoke = await request(
      ctx.app,
      "POST",
      `/auth/grants/${grant.id}/revoke`,
      { headers: { origin: ORIGIN, cookie } },
    );
    expect(revoke.status).toBe(302);
    expect(revoke.headers.get("location")).toContain("notice=grant_revoked");

    expect(await consentRows(ctx, clientId, authUserId)).toEqual([]);
    expect((await onlyGrant(ctx)).properties.status).toBe("revoked");
    expect(
      await authorizeOutcome(ctx, clientId, cookie, "core.note:read"),
    ).toBe("consent_screen");
  });
});
