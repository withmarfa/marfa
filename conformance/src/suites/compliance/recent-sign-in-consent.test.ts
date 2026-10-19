import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MarfaClient } from "../../client/api.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import {
  authorize,
  authorizeQuery,
  CALLBACK,
  codeFor,
  issuerOrigin,
  itemsStatus,
  pkce,
  registerApp,
  sentTo,
  token,
  type App,
} from "../../utils/signed-in.js";
import { TEST_OWNER } from "../../utils/target.js";

/**
 * What a browser session that signed in more than five minutes ago may and
 * may not do to an app: approve it on either consent screen, revoke a key,
 * and revoke an app's grant. A session's age is the server's clock moved
 * forward, and the clock only goes forward, so each case signs the stale
 * session in first, lets six minutes pass, and signs the fresh one in after.
 * Each sign-in comes from an address of its own, so the per-address sign-in
 * limit never holds this file back.
 */
let server: FreshServer;
let origin: string;
let management: MarfaClient;

const CLIENT_HEADER = "x-conformance-client";
const MINUTE = 60 * 1000;
let addresses = 0;
let keysMinted = 0;

beforeAll(async () => {
  server = await bootFreshServer("recent-sign-in-consent", {
    TRUSTED_PROXY_HEADER: CLIENT_HEADER,
  });
  origin = await issuerOrigin(server);
  management = new MarfaClient({
    baseUrl: server.apiUrl,
    apiKey: server.managementKey,
  });
}, 2 * FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  await server.stop();
}, 2 * FRESH_SERVER_TIMEOUT_MS);

function nextAddress(): string {
  addresses += 1;
  return `198.51.100.${String(addresses)}`;
}

async function signIn(): Promise<string> {
  const response = await fetch(`${server.apiUrl}/auth/sign-in/email`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin,
      [CLIENT_HEADER]: nextAddress(),
    },
    body: JSON.stringify(TEST_OWNER),
  });
  expect(response.status).toBe(200);
  const cookie = /(?:^|,\s*)([\w.-]*session_token=[^;]+)/.exec(
    response.headers.get("set-cookie") ?? "",
  )?.[1];
  expect(cookie, "sign-in set no session cookie").toBeTruthy();
  return cookie!;
}

async function pass(ms: number): Promise<void> {
  await server.advanceClock(ms);
}

/**
 * A browser session more than five minutes old, and one made just now. The
 * time passed is longer than the fifteen minutes the device code lookups of
 * one owner are counted over, so a case never spends the lookups of the one
 * before it.
 */
async function staleAndFresh(): Promise<{ stale: string; fresh: string }> {
  const stale = await signIn();
  await pass(16 * MINUTE);
  return { stale, fresh: await signIn() };
}

function ownerPost(
  path: string,
  cookie: string,
  form: URLSearchParams,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${server.apiUrl}${path}`, {
    method: "POST",
    redirect: "manual",
    headers: {
      ...headers,
      cookie,
      origin,
      "content-type": "application/x-www-form-urlencoded",
      [CLIENT_HEADER]: nextAddress(),
    },
    body: form,
  });
}

function ownerGet(path: string, cookie: string): Promise<Response> {
  return fetch(`${server.apiUrl}${path}`, {
    redirect: "manual",
    headers: { cookie, [CLIENT_HEADER]: nextAddress() },
  });
}

async function refused(response: Response): Promise<void> {
  expect(response.status).toBe(403);
  expect(response.headers.get("x-error-code")).toBe("forbidden");
  await response.body?.cancel();
}

/** What a browser sends with a form it submits. */
const BROWSER = {
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
};

/** Signs in through the sign-in form the way a redirect to it asks. */
async function signInThrough(
  cookie: string,
  location: string,
): Promise<{ cookie: string; returnTo: string }> {
  const returnTo = new URL(location, server.apiUrl).searchParams.get(
    "return_to",
  )!;
  const submitted = await ownerPost(
    "/auth/sign-in",
    cookie,
    new URLSearchParams({
      email: TEST_OWNER.email,
      password: TEST_OWNER.password,
      return_to: returnTo,
    }),
  );
  expect(submitted.status).toBe(302);
  expect(submitted.headers.get("location")).toBe(returnTo);
  const fresh = /(?:^|,\s*)([\w.-]*session_token=[^;]+)/.exec(
    submitted.headers.get("set-cookie") ?? "",
  )?.[1];
  expect(fresh).toBeTruthy();
  return { cookie: fresh!, returnTo };
}

const SIGN_IN_PREFIX = "/auth/sign-in?prompt=login&return_to=";

// ---------------------------------------------------------------------------
// The device screen
// ---------------------------------------------------------------------------

interface Device {
  clientId: string;
  userCode: string;
  deviceCode: string;
}

async function registerDeviceClient(): Promise<string> {
  const response = await fetch(`${server.apiUrl}/auth/oauth2/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "recent-sign-in device",
      application_type: "native",
      grant_types: [
        "urn:ietf:params:oauth:grant-type:device_code",
        "refresh_token",
      ],
      response_types: [],
      token_endpoint_auth_method: "none",
    }),
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as { client_id: string }).client_id;
}

async function deviceCode(scope: string, clientId?: string): Promise<Device> {
  const id = clientId ?? (await registerDeviceClient());
  const response = await fetch(`${server.apiUrl}/auth/device/code`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: id, scope }),
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    user_code: string;
    device_code: string;
  };
  return {
    clientId: id,
    userCode: body.user_code,
    deviceCode: body.device_code,
  };
}

function deviceScreen(device: Device, cookie: string): Promise<Response> {
  return ownerGet(
    `/auth/device/consent?user_code=${encodeURIComponent(device.userCode)}`,
    cookie,
  );
}

function deviceApproval(
  device: Device,
  cookie: string,
  scopes: readonly string[],
  headers: Record<string, string> = {},
): Promise<Response> {
  return ownerPost(
    "/auth/device/consent",
    cookie,
    new URLSearchParams([
      ["user_code", device.userCode],
      ["decision", "approve"],
      ...scopes.map((scope): [string, string] => ["scopes", scope]),
    ]),
    headers,
  );
}

async function devicePoll(
  device: Device,
): Promise<{ status: number; scope?: string; accessToken?: string }> {
  const response = await fetch(`${server.apiUrl}/auth/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: device.deviceCode,
      client_id: device.clientId,
    }),
  });
  const body = (await response.json()) as {
    scope?: string;
    access_token?: string;
  };
  return {
    status: response.status,
    scope: body.scope,
    accessToken: body.access_token,
  };
}

function scopesOf(scope: string | undefined): string[] {
  return (scope ?? "").split(" ").filter(Boolean).sort();
}

describe("approving a device", () => {
  it("refuses a session that signed in more than five minutes ago 403 for a permission, and a fresh session approves the same code", async () => {
    const { stale, fresh } = await staleAndFresh();
    const device = await deviceCode("core.note:read keys.manage");
    await refused(
      await deviceApproval(device, stale, ["core.note:read", "keys.manage"]),
    );
    // The witness: the refusal left the code pending, so a fresh session
    // approves the very request, and the token carries the permission.
    const approved = await deviceApproval(device, fresh, [
      "core.note:read",
      "keys.manage",
    ]);
    expect(approved.status).toBe(200);
    await approved.body?.cancel();
    const polled = await devicePoll(device);
    expect(polled.status).toBe(200);
    expect(scopesOf(polled.scope)).toEqual(["core.note:read", "keys.manage"]);
  });

  it("refuses a session that signed in more than five minutes ago 403 for a write, and a fresh session approves the same code", async () => {
    const { stale, fresh } = await staleAndFresh();
    for (const write of ["core.note:write", "*:write", "content:write"]) {
      const device = await deviceCode(`core.note:read ${write}`);
      await refused(
        await deviceApproval(device, stale, ["core.note:read", write]),
      );
      const approved = await deviceApproval(device, fresh, [
        "core.note:read",
        write,
      ]);
      expect(approved.status, write).toBe(200);
      await approved.body?.cancel();
      const polled = await devicePoll(device);
      expect(polled.status, write).toBe(200);
      expect(scopesOf(polled.scope), write).toEqual(
        ["core.note:read", write].sort(),
      );
    }
  });

  it("approves from a session that signed in more than five minutes ago the scopes that only read, and not the ones left unticked", async () => {
    const { stale } = await staleAndFresh();
    const device = await deviceCode(
      "core.note:read edge.parent-of:read metadata:read profile.name:read openid keys.manage core.note:write",
    );
    const approved = await deviceApproval(device, stale, [
      "core.note:read",
      "edge.parent-of:read",
      "metadata:read",
      "profile.name:read",
      "openid",
    ]);
    expect(approved.status).toBe(200);
    await approved.body?.cancel();
    const polled = await devicePoll(device);
    expect(polled.status).toBe(200);
    expect(scopesOf(polled.scope)).toEqual(
      [
        "core.note:read",
        "edge.parent-of:read",
        "metadata:read",
        "profile.name:read",
        "openid",
      ].sort(),
    );
  });

  it("approves from a session that signed in more than five minutes ago a permission the app was approved for before", async () => {
    const stale = await signIn();
    const client = await registerDeviceClient();
    const first = await deviceCode("core.note:read keys.manage", client);
    const approvedFirst = await deviceApproval(first, stale, [
      "core.note:read",
      "keys.manage",
    ]);
    expect(approvedFirst.status).toBe(200);
    await approvedFirst.body?.cancel();
    expect((await devicePoll(first)).status).toBe(200);
    await pass(6 * MINUTE);
    const again = await deviceCode("core.note:read keys.manage", client);
    const approved = await deviceApproval(again, stale, [
      "core.note:read",
      "keys.manage",
    ]);
    expect(approved.status).toBe(200);
    await approved.body?.cancel();
    // The permission it held is not the only one: a second one is refused.
    const widened = await deviceCode(
      "core.note:read keys.manage blobs.manage",
      client,
    );
    await refused(
      await deviceApproval(widened, stale, [
        "core.note:read",
        "keys.manage",
        "blobs.manage",
      ]),
    );
  });

  it("sends a browser that approves a device code for a permission or a write on a screen left open past five minutes to sign in again, and back to the code", async () => {
    const { stale } = await staleAndFresh();
    for (const scope of ["keys.manage", "core.note:write"]) {
      const device = await deviceCode(`core.note:read ${scope}`);
      const scopes = ["core.note:read", scope];
      const refusedBrowser = await deviceApproval(
        device,
        stale,
        scopes,
        BROWSER,
      );
      expect(refusedBrowser.status, scope).toBe(303);
      const location = refusedBrowser.headers.get("location")!;
      expect(location, scope).toBe(
        `${SIGN_IN_PREFIX}${encodeURIComponent(
          `/auth/device/consent?user_code=${device.userCode}`,
        )}`,
      );
      await refusedBrowser.body?.cancel();
      const { cookie, returnTo } = await signInThrough(stale, location);
      const landed = await ownerGet(returnTo, cookie);
      expect(landed.status, scope).toBe(200);
      await landed.body?.cancel();
      const approved = await deviceApproval(device, cookie, scopes, BROWSER);
      expect(approved.status, scope).toBe(200);
      await approved.body?.cancel();
      expect(scopesOf((await devicePoll(device)).scope), scope).toEqual(
        [...scopes].sort(),
      );
    }
  });

  it("refuses a caller that does not ask for a page 403, though the browser asking the same is sent to sign in", async () => {
    const { stale, fresh } = await staleAndFresh();
    const device = await deviceCode("core.note:read keys.manage");
    const scopes = ["core.note:read", "keys.manage"];
    await refused(
      await deviceApproval(device, stale, scopes, {
        accept: "application/json",
      }),
    );
    // The witnesses: the browser form is sent on, and a fresh session
    // approves the same code.
    const browser = await deviceApproval(device, stale, scopes, BROWSER);
    expect(browser.status).toBe(303);
    await browser.body?.cancel();
    const approved = await deviceApproval(device, fresh, scopes);
    expect(approved.status).toBe(200);
    await approved.body?.cancel();
  });
});

describe("the device screen", () => {
  it("sends a session that signed in more than five minutes ago to sign in again before it shows a request for a permission or a write", async () => {
    const { stale, fresh } = await staleAndFresh();
    for (const scope of ["core.note:read keys.manage", "core.note:write"]) {
      const device = await deviceCode(scope);
      const screen = await deviceScreen(device, stale);
      expect(screen.status, scope).toBe(302);
      expect(screen.headers.get("location"), scope).toBe(
        `${SIGN_IN_PREFIX}${encodeURIComponent(
          `/auth/device/consent?user_code=${device.userCode}`,
        )}`,
      );
      await screen.body?.cancel();
      // The witnesses: a session that signed in just now is shown the same
      // request, and the stale session is shown a request that only reads.
      const shown = await deviceScreen(device, fresh);
      expect(shown.status, scope).toBe(200);
      expect(await shown.text()).toContain(device.userCode);
    }
    const reading = await deviceCode("core.note:read openid");
    const shown = await deviceScreen(reading, stale);
    expect(shown.status).toBe(200);
    expect(await shown.text()).toContain(reading.userCode);
  });

  it("lands the person back on the screen after they sign in again, where they approve", async () => {
    const { stale } = await staleAndFresh();
    const device = await deviceCode("core.note:read keys.manage");
    const screen = await deviceScreen(device, stale);
    expect(screen.status).toBe(302);
    await screen.body?.cancel();
    const location = screen.headers.get("location")!;
    // The sign-in page asks for the password although a session exists.
    const page = await ownerGet(location, stale);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('type="password"');
    const returnTo = new URL(location, server.apiUrl).searchParams.get(
      "return_to",
    )!;
    const submitted = await ownerPost(
      "/auth/sign-in",
      stale,
      new URLSearchParams({
        email: TEST_OWNER.email,
        password: TEST_OWNER.password,
        return_to: returnTo,
      }),
    );
    expect(submitted.status).toBe(302);
    expect(submitted.headers.get("location")).toBe(returnTo);
    const cookie = /(?:^|,\s*)([\w.-]*session_token=[^;]+)/.exec(
      submitted.headers.get("set-cookie") ?? "",
    )?.[1];
    expect(cookie).toBeTruthy();
    const landed = await ownerGet(returnTo, cookie!);
    expect(landed.status).toBe(200);
    await landed.body?.cancel();
    const approved = await deviceApproval(device, cookie!, [
      "core.note:read",
      "keys.manage",
    ]);
    expect(approved.status).toBe(200);
    await approved.body?.cancel();
  });
});

// ---------------------------------------------------------------------------
// The authorization screen
// ---------------------------------------------------------------------------

/** The consent screen's address for a request, reached as `cookie`. */
async function consentFor(
  app: App,
  scope: string,
  cookie: string,
  extra: Record<string, string> = {},
): Promise<{ url: URL; verifier: string }> {
  const proof = pkce();
  const landed = await sentTo(
    server,
    await authorize(
      server,
      authorizeQuery(app.clientId, scope, proof, extra),
      cookie,
    ),
  );
  expect(landed?.pathname).toBe("/auth/authorize");
  return { url: landed!, verifier: proof.verifier };
}

function decision(
  consent: URL,
  cookie: string,
  scopes: readonly string[],
  headers: Record<string, string> = {},
): Promise<Response> {
  return ownerPost(
    "/auth/authorize/decision",
    cookie,
    new URLSearchParams([
      ["accept", "true"],
      ["oauth_query", consent.search.slice(1)],
      ...scopes.map((scope): [string, string] => ["scopes", scope]),
    ]),
    headers,
  );
}

async function codeOf(response: Response): Promise<string | null | undefined> {
  const landed = await sentTo(server, response);
  expect(landed?.href.startsWith(CALLBACK)).toBe(true);
  return landed?.searchParams.get("code");
}

describe("approving an app", () => {
  it("refuses a session that signed in more than five minutes ago 403 for a permission or a write, and a fresh session approves the same request", async () => {
    const { stale, fresh } = await staleAndFresh();
    for (const gated of ["keys.manage", "core.note:write", "content:write"]) {
      const scope = `core.note:read ${gated}`;
      const app = await registerApp(server, scope);
      const { url } = await consentFor(app, scope, stale);
      await refused(await decision(url, stale, scope.split(" ")));
      const code = await codeOf(await decision(url, fresh, scope.split(" ")));
      expect(code, gated).toBeTruthy();
    }
  });

  it("approves from a session that signed in more than five minutes ago the scopes that only read, and the scopes left unticked", async () => {
    const { stale } = await staleAndFresh();
    const reads = [
      "core.note:read",
      "edge.parent-of:read",
      "metadata:read",
      "profile:read",
      "openid",
      "offline_access",
    ];
    const scope = [...reads, "keys.manage", "core.note:write"].join(" ");
    const app = await registerApp(server, scope);
    const { url, verifier } = await consentFor(app, scope, stale);
    const code = await codeOf(await decision(url, stale, reads));
    expect(code).toBeTruthy();
    const exchanged = await token(
      server,
      {
        grant_type: "authorization_code",
        code: code!,
        redirect_uri: CALLBACK,
        code_verifier: verifier,
        client_id: app.clientId,
      },
      app,
    );
    expect(exchanged.status).toBe(200);
    expect(scopesOf(exchanged.body.scope)).toEqual([...reads].sort());
  });

  it("approves from a session that signed in more than five minutes ago a permission the app was approved for before, and refuses a second one", async () => {
    const first = await signIn();
    const scope = "core.note:read keys.manage";
    const app = await registerApp(server, `${scope} blobs.manage`);
    await codeFor(server, origin, first, app, scope);
    await pass(6 * MINUTE);
    // The witness: the same session is refused a permission the app does not
    // hold, in the same request.
    const wider = `${scope} blobs.manage`;
    const asked = await consentFor(app, wider, first, { prompt: "consent" });
    await refused(await decision(asked.url, first, wider.split(" ")));
    const held = await consentFor(app, scope, first, { prompt: "consent" });
    expect(
      await codeOf(await decision(held.url, first, scope.split(" "))),
    ).toBeTruthy();
  });

  it("sends a browser that approves a request for a permission or a write on a screen left open past five minutes to sign in again, and back to the request", async () => {
    const { stale } = await staleAndFresh();
    for (const gated of ["keys.manage", "core.note:write"]) {
      const scope = `core.note:read ${gated}`;
      const app = await registerApp(server, scope);
      const { url } = await consentFor(app, scope, stale);
      const refusedBrowser = await decision(
        url,
        stale,
        scope.split(" "),
        BROWSER,
      );
      expect(refusedBrowser.status, gated).toBe(303);
      const location = refusedBrowser.headers.get("location")!;
      expect(location, gated).toBe(
        `${SIGN_IN_PREFIX}${encodeURIComponent(`${url.pathname}${url.search}`)}`,
      );
      await refusedBrowser.body?.cancel();
      const { cookie, returnTo } = await signInThrough(stale, location);
      const landed = await ownerGet(returnTo, cookie);
      expect(landed.status, gated).toBe(200);
      await landed.body?.cancel();
      expect(
        await codeOf(await decision(url, cookie, scope.split(" "), BROWSER)),
        gated,
      ).toBeTruthy();
    }
  });

  it("refuses a caller that does not ask for a page 403, though the browser asking the same is sent to sign in", async () => {
    const { stale, fresh } = await staleAndFresh();
    const scope = "core.note:read keys.manage";
    const app = await registerApp(server, scope);
    const { url } = await consentFor(app, scope, stale);
    await refused(
      await decision(url, stale, scope.split(" "), {
        accept: "application/json",
      }),
    );
    // The witnesses: the browser form is sent on, and a fresh session
    // approves the same request.
    const browser = await decision(url, stale, scope.split(" "), BROWSER);
    expect(browser.status).toBe(303);
    await browser.body?.cancel();
    expect(
      await codeOf(await decision(url, fresh, scope.split(" "))),
    ).toBeTruthy();
  });
});

describe("the authorization screen", () => {
  it("sends a session that signed in more than five minutes ago to sign in again before it shows a request for a permission or a write", async () => {
    const { stale, fresh } = await staleAndFresh();
    for (const scope of ["core.note:read keys.manage", "core.note:write"]) {
      const app = await registerApp(server, scope);
      const { url } = await consentFor(app, scope, stale);
      const screen = await ownerGet(`${url.pathname}${url.search}`, stale);
      expect(screen.status, scope).toBe(302);
      expect(screen.headers.get("location"), scope).toBe(
        `${SIGN_IN_PREFIX}${encodeURIComponent(`${url.pathname}${url.search}`)}`,
      );
      await screen.body?.cancel();
      // The witness: a session that signed in just now is shown it.
      const shown = await ownerGet(`${url.pathname}${url.search}`, fresh);
      expect(shown.status, scope).toBe(200);
      await shown.body?.cancel();
    }
  });

  it("shows a session that signed in more than five minutes ago a request that only reads", async () => {
    const { stale } = await staleAndFresh();
    const scope = "core.note:read edge.parent-of:read profile:read openid";
    const app = await registerApp(server, scope);
    const { url } = await consentFor(app, scope, stale);
    const shown = await ownerGet(`${url.pathname}${url.search}`, stale);
    expect(shown.status).toBe(200);
    await shown.body?.cancel();
  });

  it("answers a request a standing consent covers with a code, whatever the age of the session", async () => {
    const first = await signIn();
    const scope = "core.note:read keys.manage";
    const app = await registerApp(server, scope);
    await codeFor(server, origin, first, app, scope);
    await pass(6 * MINUTE);
    const { silent } = await codeFor(server, origin, first, app, scope);
    expect(silent).toBe(true);
  });

  it("lands the person back on the screen after they sign in again, where they approve", async () => {
    const { stale } = await staleAndFresh();
    const scope = "core.note:read keys.manage";
    const app = await registerApp(server, scope);
    const { url } = await consentFor(app, scope, stale);
    const screen = await ownerGet(`${url.pathname}${url.search}`, stale);
    expect(screen.status).toBe(302);
    await screen.body?.cancel();
    const location = screen.headers.get("location")!;
    const page = await ownerGet(location, stale);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('type="password"');
    const returnTo = new URL(location, server.apiUrl).searchParams.get(
      "return_to",
    )!;
    const submitted = await ownerPost(
      "/auth/sign-in",
      stale,
      new URLSearchParams({
        email: TEST_OWNER.email,
        password: TEST_OWNER.password,
        return_to: returnTo,
      }),
    );
    expect(submitted.status).toBe(302);
    expect(submitted.headers.get("location")).toBe(returnTo);
    const cookie = /(?:^|,\s*)([\w.-]*session_token=[^;]+)/.exec(
      submitted.headers.get("set-cookie") ?? "",
    )?.[1];
    expect(cookie).toBeTruthy();
    const landed = await ownerGet(returnTo, cookie!);
    expect(landed.status).toBe(200);
    await landed.body?.cancel();
    expect(
      await codeOf(await decision(url, cookie!, scope.split(" "))),
    ).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Ending a key and an app
// ---------------------------------------------------------------------------

async function mintKey(
  permissions: string[],
): Promise<{ id: string; key: string }> {
  keysMinted += 1;
  const label = `recent-sign-in key ${String(keysMinted)}`;
  const minted = await management.createKey({
    label,
    source: `recent-sign-in-${String(keysMinted)}`,
    permissions: permissions as never,
  });
  expect(minted.status, JSON.stringify(minted.error)).toBe(201);
  return { id: minted.data.id, key: minted.data.key };
}

function bearer(key: string): Record<string, string> {
  return { authorization: `Bearer ${key}` };
}

async function keyStatus(key: string): Promise<number> {
  const response = await fetch(`${server.apiUrl}/keys/current`, {
    headers: bearer(key),
  });
  await response.body?.cancel();
  return response.status;
}

function revokeKey(id: string, headers: Record<string, string>) {
  return fetch(`${server.apiUrl}/keys/${id}`, { method: "DELETE", headers });
}

describe("revoking a key", () => {
  it("refuses a session that signed in more than five minutes ago 403 and leaves the key working, and a fresh session revokes it", async () => {
    const { stale, fresh } = await staleAndFresh();
    const target = await mintKey([]);
    await refused(await revokeKey(target.id, { cookie: stale, origin }));
    expect(await keyStatus(target.key)).toBe(200);
    const revoked = await revokeKey(target.id, { cookie: fresh, origin });
    expect(revoked.status).toBe(200);
    await revoked.body?.cancel();
    expect(await keyStatus(target.key)).toBe(401);
  });

  it("revokes for a key holding keys.manage whatever the age of the owner's sessions", async () => {
    const stale = await signIn();
    await pass(6 * MINUTE);
    expect((await ownerGet("/owner/sign-ins", stale)).status).toBe(200);
    const manager = await mintKey(["keys.manage"]);
    const target = await mintKey([]);
    const revoked = await revokeKey(target.id, bearer(manager.key));
    expect(revoked.status).toBe(200);
    await revoked.body?.cancel();
    expect(await keyStatus(target.key)).toBe(401);
  });
});

describe("revoking an app", () => {
  async function grantOf(app: App, lister: string): Promise<{ id: string }> {
    const response = await fetch(`${server.apiUrl}/auth/grants`, {
      headers: bearer(lister),
    });
    expect(response.status).toBe(200);
    const rows = (
      (await response.json()) as { data: { id: string; client_id: string }[] }
    ).data;
    const found = rows.find((row) => row.client_id === app.clientId);
    expect(found, "the grants listing names the app").toBeDefined();
    return found!;
  }

  function revokeGrant(id: string, headers: Record<string, string>) {
    return fetch(`${server.apiUrl}/auth/grants/${id}`, {
      method: "DELETE",
      headers,
    });
  }

  async function approved(
    cookie: string,
  ): Promise<{ app: App; access: string }> {
    const app = await registerApp(server, "core.note:read");
    const { code, verifier } = await codeFor(
      server,
      origin,
      cookie,
      app,
      "core.note:read",
    );
    const exchanged = await token(
      server,
      {
        grant_type: "authorization_code",
        code,
        redirect_uri: CALLBACK,
        code_verifier: verifier,
        client_id: app.clientId,
      },
      app,
    );
    expect(exchanged.status).toBe(200);
    return { app, access: exchanged.body.access_token! };
  }

  it("refuses a session that signed in more than five minutes ago 403 and leaves the app working, and a fresh session revokes it", async () => {
    const stale = await signIn();
    const { app, access } = await approved(stale);
    const lister = (await mintKey(["grants.manage"])).key;
    const grant = await grantOf(app, lister);
    await pass(6 * MINUTE);
    const fresh = await signIn();
    await refused(await revokeGrant(grant.id, { cookie: stale, origin }));
    expect(await itemsStatus(server, access)).toBe(200);
    expect((await grantOf(app, lister)).id).toBe(grant.id);
    const revoked = await revokeGrant(grant.id, { cookie: fresh, origin });
    expect(revoked.status).toBe(204);
    await revoked.body?.cancel();
    expect(await itemsStatus(server, access)).toBe(401);
  });

  it("revokes for a key holding grants.manage whatever the age of the owner's sessions", async () => {
    const stale = await signIn();
    const { app, access } = await approved(stale);
    const manager = (await mintKey(["grants.manage"])).key;
    const grant = await grantOf(app, manager);
    await pass(6 * MINUTE);
    expect((await ownerGet("/owner/sign-ins", stale)).status).toBe(200);
    const revoked = await revokeGrant(grant.id, bearer(manager));
    expect(revoked.status).toBe(204);
    await revoked.body?.cancel();
    expect(await itemsStatus(server, access)).toBe(401);
  });
});
