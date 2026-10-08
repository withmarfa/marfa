/**
 * A device sign-in widens a client's stored scope ceiling only once a signed-in
 * person approves it.
 *
 * `POST /auth/device/code` is made before anybody can sign in, so it is open
 * to anyone who knows a client's public id, and a write there would let a
 * stranger widen what the client's later consent screens offer. The code is
 * issued for what the client could ask, the registration stays as it was, and
 * the person's approval writes the scopes they ticked.
 *
 * **Every assertion reads the stored row**, through the same read the plugin
 * makes, because the initiation answers 200 whether or not the row moved.
 */
import { DEVICE_CODE_GRANT_TYPE } from "@better-auth/oauth-provider";
import { expandBundlesToScopes } from "@withmarfa/shared";
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PERMISSION_BUNDLES } from "../config.js";
import type { TestContext } from "../test-utils.js";
import { createTestContext, request } from "../test-utils.js";

vi.setConfig({ testTimeout: 45_000 });

let ctx: TestContext | undefined;

afterEach(async () => {
  await ctx?.cleanup();
  ctx = undefined;
});

const ORIGIN = "http://localhost:0";
const HELD = "core.note:read";

/** Two scopes the bundles publish to every client and the seeded ceiling lacks. */
function publishedBeyondCeiling(): [string, string] {
  const rest = [...expandBundlesToScopes(DEFAULT_PERMISSION_BUNDLES)].filter(
    (scope) => scope !== HELD,
  );
  const [first, second] = rest;
  if (!first || !second) throw new Error("the bundles publish too few scopes");
  return [first, second];
}

/** A device client whose registration has aged: it holds one scope only. */
async function seedStaleClient(c: TestContext): Promise<string> {
  const clientId = `device-${randomBytes(5).toString("hex")}`;
  const oauth = c.storage.oauthProvider;
  if (!oauth) throw new Error("storage.oauthProvider missing");
  await oauth.createClient({
    clientId,
    name: "Stale Device Client",
    isPublic: true,
    grantTypes: [DEVICE_CODE_GRANT_TYPE],
    responseTypes: [],
    tokenEndpointAuthMethod: "none",
    scopes: [HELD],
    redirectUris: [`${ORIGIN}/callback`],
    postLogoutRedirectUris: [ORIGIN + "/"],
  });
  return clientId;
}

async function storedCeiling(
  c: TestContext,
  clientId: string,
): Promise<readonly string[] | null> {
  const client = await c.storage.oauthProvider?.getClient(clientId);
  return client?.scopes ?? null;
}

async function widenings(c: TestContext, clientId: string) {
  const rows = await c.storage.audit.list({
    action: "auth.client.scopes_widened",
    limit: 50,
  });
  return rows.data.filter((row) => row.resource_id === clientId);
}

async function signIn(c: TestContext): Promise<string> {
  const { email, password } = c.owner;
  const res = await request(c.app, "POST", "/auth/sign-in/email", {
    body: { email, password },
    headers: { origin: ORIGIN },
  });
  const match = /(?:^|,\s*)([\w.-]*session_token=[^;]+)/.exec(
    res.headers.get("set-cookie") ?? "",
  );
  if (res.status !== 200 || !match?.[1]) throw new Error("sign-in failed");
  return match[1];
}

/** Initiation with nobody signed in: no cookie, only the client's public id. */
async function initiate(c: TestContext, clientId: string, scope: string) {
  return request(c.app, "POST", "/auth/device/code", {
    form: { client_id: clientId, scope },
    headers: { origin: ORIGIN },
  });
}

interface DeviceInit {
  device_code: string;
  user_code: string;
}

async function openConsent(c: TestContext, userCode: string, cookie: string) {
  const res = await request(
    c.app,
    "GET",
    `/auth/device/consent?user_code=${encodeURIComponent(userCode)}`,
    { headers: { cookie } },
  );
  expect(res.status).toBe(200);
  return res.text();
}

async function decide(
  c: TestContext,
  userCode: string,
  cookie: string,
  decision: "approve" | "deny",
  scopes: string[],
) {
  return request(c.app, "POST", "/auth/device/consent", {
    form: { user_code: userCode, decision, scopes },
    headers: { origin: ORIGIN, cookie },
  });
}

async function redeem(c: TestContext, deviceCode: string, clientId: string) {
  const schema = await import("../storage/sqlite/schema.js");
  const { eq } = await import("drizzle-orm");
  const db = c.storage.betterAuthDb as {
    update: (t: unknown) => {
      set: (v: Record<string, unknown>) => {
        where: (w: unknown) => Promise<unknown>;
      };
    };
  };
  await db
    .update(schema.auth_oauth_device_code)
    .set({ lastPolledAt: null })
    .where(eq(schema.auth_oauth_device_code.deviceCode, deviceCode));
  const res = await request(c.app, "POST", "/auth/oauth2/token", {
    form: {
      grant_type: DEVICE_CODE_GRANT_TYPE,
      device_code: deviceCode,
      client_id: clientId,
    },
    headers: { origin: ORIGIN },
  });
  return {
    status: res.status,
    body: (await res.json()) as { scope?: string; error?: string },
  };
}

describe("a device sign-in widens a client's ceiling only when a person approves", () => {
  it("leaves the ceiling as it was when nobody signed in asks for a published scope", async () => {
    ctx = await createTestContext({});
    const clientId = await seedStaleClient(ctx);
    const [wanted] = publishedBeyondCeiling();

    const res = await initiate(ctx, clientId, `${HELD} ${wanted}`);

    // The code is issued: a stale registration is still a device the person
    // can approve, which is what the later cases finish.
    expect(res.status).toBe(200);
    expect(await storedCeiling(ctx, clientId)).toEqual([HELD]);
    expect(await widenings(ctx, clientId)).toEqual([]);
  });

  it("widens the ceiling by the scopes the person ticked, and the device then redeems them", async () => {
    ctx = await createTestContext({});
    const c = ctx;
    const clientId = await seedStaleClient(c);
    const [ticked, unticked] = publishedBeyondCeiling();
    const init = (await (
      await initiate(c, clientId, `${HELD} ${ticked} ${unticked}`)
    ).json()) as DeviceInit;
    const cookie = await signIn(c);

    const screen = await openConsent(c, init.user_code, cookie);
    // The screen offers what the device asked for, beyond the ceiling.
    expect(screen).toContain(ticked);
    expect(screen).toContain(unticked);
    expect(await storedCeiling(c, clientId)).toEqual([HELD]);

    const approved = await decide(c, init.user_code, cookie, "approve", [
      HELD,
      ticked,
    ]);
    expect(approved.status).toBe(200);

    expect(await storedCeiling(c, clientId)).toEqual([HELD, ticked]);
    const rows = await widenings(c, clientId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.details.surface).toBe("device");
    expect(rows[0]!.details.added_scopes).toEqual([ticked]);

    const minted = await redeem(c, init.device_code, clientId);
    expect(minted.status).toBe(200);
    expect(minted.body.scope?.split(" ").sort()).toEqual([HELD, ticked].sort());
  });

  it("answers a poll of a code nobody has decided with authorization_pending, whatever scopes it names", async () => {
    ctx = await createTestContext({});
    const c = ctx;
    const clientId = await seedStaleClient(c);
    const [beyond] = publishedBeyondCeiling();
    const within = (await (
      await initiate(c, clientId, HELD)
    ).json()) as DeviceInit;
    const offered = (await (
      await initiate(c, clientId, `${HELD} ${beyond}`)
    ).json()) as DeviceInit;

    // The witness: a pending code the ceiling covers is answered as pending.
    const covered = await redeem(c, within.device_code, clientId);
    expect(covered.body.error).toBe("authorization_pending");

    const pending = await redeem(c, offered.device_code, clientId);
    expect(pending.status).toBe(400);
    expect(pending.body.error).toBe("authorization_pending");
    expect(await storedCeiling(c, clientId)).toEqual([HELD]);
  });

  it("does not widen the ceiling when the person denies, or ticks nothing", async () => {
    ctx = await createTestContext({});
    const c = ctx;
    const clientId = await seedStaleClient(c);
    const [wanted] = publishedBeyondCeiling();
    const cookie = await signIn(c);

    const denied = (await (
      await initiate(c, clientId, `${HELD} ${wanted}`)
    ).json()) as DeviceInit;
    await openConsent(c, denied.user_code, cookie);
    expect((await decide(c, denied.user_code, cookie, "deny", [])).status).toBe(
      200,
    );

    const empty = (await (
      await initiate(c, clientId, `${HELD} ${wanted}`)
    ).json()) as DeviceInit;
    await openConsent(c, empty.user_code, cookie);
    expect(
      (await decide(c, empty.user_code, cookie, "approve", [])).status,
    ).toBe(200);

    expect(await storedCeiling(c, clientId)).toEqual([HELD]);
    expect(await widenings(c, clientId)).toEqual([]);
  });

  it("does not widen the ceiling for a scope the person did not tick when they approve another", async () => {
    ctx = await createTestContext({});
    const c = ctx;
    const clientId = await seedStaleClient(c);
    const [, unticked] = publishedBeyondCeiling();
    const init = (await (
      await initiate(c, clientId, `${HELD} ${unticked}`)
    ).json()) as DeviceInit;
    const cookie = await signIn(c);
    await openConsent(c, init.user_code, cookie);

    expect(
      (await decide(c, init.user_code, cookie, "approve", [HELD])).status,
    ).toBe(200);

    expect(await storedCeiling(c, clientId)).toEqual([HELD]);
    expect(await widenings(c, clientId)).toEqual([]);
  });

  it("still refuses a scope the instance does not publish to every client", async () => {
    ctx = await createTestContext({});
    const c = ctx;
    const clientId = await seedStaleClient(c);
    // Valid in the grammar, in no bundle: a client has to be registered for it.
    const res = await initiate(c, clientId, `${HELD} core.note:delete`);

    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe(
      "invalid_scope",
    );
    expect(await storedCeiling(c, clientId)).toEqual([HELD]);
  });
});
