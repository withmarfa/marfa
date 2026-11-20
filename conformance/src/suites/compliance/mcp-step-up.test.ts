import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { offeredValues } from "../../utils/approval-form.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import {
  callTool,
  connectMcp,
  toolError,
  toolResult,
  type ToolAnswer,
} from "../../utils/mcp.js";
import {
  authorize,
  authorizeQuery,
  CALLBACK,
  decide,
  issuerOrigin,
  pkce,
  registerApp,
  sentTo,
  token,
  type App,
} from "../../utils/signed-in.js";
import { TEST_OWNER } from "../../utils/target.js";
import { tempFolder } from "../../utils/temp-folder.js";

let server: FreshServer;
let origin: string;
const backups = tempFolder("marfa-mcp-step-up-");
const elsewhere = tempFolder("marfa-mcp-step-up-elsewhere-");
const CLIENT_HEADER = "x-conformance-client";
const MINUTE = 60 * 1000;
/** The recent sign-in window an act that needs one allows, as the API names it in `max_age`. */
const RECENT_SIGN_IN_SECONDS = 900;
/** Long enough that a sign-in made before it is no longer recent. */
const PAST_RECENT = RECENT_SIGN_IN_SECONDS * 1000 + MINUTE;
const SCOPE = "config.manage offline_access";
const SWITCH = "allow_private_addresses";
let addresses = 0;

beforeAll(async () => {
  server = await bootFreshServer("mcp-step-up", {
    MARFA_ALLOW_PRIVATE_ADDRESSES: "false",
    MARFA_BACKUP_PATH: backups,
    MARFA_BACKUP_INTERVAL_SECONDS: "0",
    MARFA_TRUSTED_PROXY_HEADER: CLIENT_HEADER,
    MARFA_TRUSTED_PROXY_CIDRS: "127.0.0.0/8",
  });
  origin = await issuerOrigin(server);
}, FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  await server.stop();
}, FRESH_SERVER_TIMEOUT_MS);

// The owner may look up ten device codes and sign in a limited number of
// times in a window, so each test starts past the last one's.
beforeEach(async () => {
  await server.advanceClock(PAST_RECENT);
});

interface Answer {
  status: number;
  body: Record<string, any>;
}

async function call(
  credential: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<Answer> {
  const response = await fetch(`${server.apiUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${credential}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: (text === "" ? {} : JSON.parse(text)) as Record<string, any>,
  };
}

/** A new browser session, by password, from an address of its own. */
async function signIn(): Promise<string> {
  addresses += 1;
  const response = await fetch(`${server.apiUrl}/auth/sign-in`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin,
      [CLIENT_HEADER]: `198.51.100.${String(addresses)}`,
    },
    body: JSON.stringify(TEST_OWNER),
  });
  expect(response.status).toBe(200);
  const cookie = /(?:^|,\s*)([\w.-]*marfa_session=[^;]+)/.exec(
    response.headers.get("set-cookie") ?? "",
  )?.[1];
  expect(cookie, "sign-in set no session cookie").toBeTruthy();
  return cookie!;
}

interface Tokens {
  access: string;
  refresh: string;
}

async function exchangeTokens(
  app: App,
  code: string,
  verifier: string,
): Promise<Tokens> {
  const answer = await token(server, {
    grant_type: "authorization_code",
    code,
    redirect_uri: CALLBACK,
    code_verifier: verifier,
    client_id: app.clientId,
  });
  expect(answer.status, JSON.stringify(answer.body)).toBe(200);
  return {
    access: answer.body.access_token!,
    refresh: answer.body.refresh_token!,
  };
}

async function exchange(app: App, code: string, verifier: string) {
  return (await exchangeTokens(app, code, verifier)).access;
}

function refresh(app: App, refreshToken: string) {
  return token(server, {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: app.clientId,
  });
}

/** Where an authorization for `app` from the browser `cookie` sends it first. */
async function authorizing(
  app: App,
  cookie: string,
  resource = `${origin}/mcp/admin`,
): Promise<{ landed: URL | undefined; verifier: string }> {
  const proof = pkce();
  const landed = await sentTo(
    server,
    await authorize(
      server,
      authorizeQuery(app.clientId, SCOPE, proof, { resource }),
      cookie,
    ),
  );
  return { landed, verifier: proof.verifier };
}

/** Tokens for `app` from the browser `cookie`, through consent if none covers it. */
async function connectTokens(app: App, cookie: string): Promise<Tokens> {
  let { landed, verifier } = await authorizing(app, cookie);
  if (landed !== undefined && !landed.href.startsWith(CALLBACK)) {
    landed = await decide(
      server,
      origin,
      cookie,
      landed,
      true,
      SCOPE.split(" "),
    );
  }
  const code = landed?.searchParams.get("code");
  expect(code, `no code on ${String(landed)}`).toBeTruthy();
  return exchangeTokens(app, code!, verifier);
}

async function connect(app: App, cookie: string): Promise<string> {
  return (await connectTokens(app, cookie)).access;
}

/** The consent page an authorization of `app` from `cookie` opens, asking for consent again. */
async function consentPage(
  app: App,
  cookie: string,
): Promise<{ page: URL; verifier: string }> {
  const proof = pkce();
  const landed = await sentTo(
    server,
    await authorize(
      server,
      authorizeQuery(app.clientId, SCOPE, proof, {
        resource: `${origin}/mcp/admin`,
        prompt: "consent",
      }),
      cookie,
    ),
  );
  expect(landed?.pathname, String(landed)).toBe("/auth/consent");
  return { page: landed!, verifier: proof.verifier };
}

const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

interface DeviceCode {
  device_code: string;
  user_code: string;
  interval: number;
}

async function registerDeviceApp(): Promise<string> {
  const registered = await fetch(`${server.apiUrl}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "mcp step-up device",
      application_type: "native",
      grant_types: [DEVICE_GRANT, "refresh_token"],
      response_types: [],
      token_endpoint_auth_method: "none",
      scope: SCOPE,
    }),
  });
  expect(registered.status).toBe(201);
  return ((await registered.json()) as { client_id: string }).client_id;
}

async function askDevice(clientId: string): Promise<DeviceCode> {
  const response = await fetch(`${server.apiUrl}/oauth/device-authorization`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, scope: SCOPE }),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as DeviceCode;
}

function devicePage(userCode: string, cookie: string): Promise<Response> {
  return fetch(
    `${server.apiUrl}/auth/device/consent?user_code=${encodeURIComponent(userCode)}`,
    { redirect: "manual", headers: { cookie } },
  );
}

async function approveDevice(userCode: string, cookie: string): Promise<void> {
  const shown = await devicePage(userCode, cookie);
  expect(shown.status, shown.headers.get("location") ?? "").toBe(200);
  const form = new URLSearchParams({
    user_code: userCode,
    decision: "approve",
  });
  for (const scope of offeredValues(await shown.text(), "scopes")) {
    form.append("scopes", scope);
  }
  const decided = await fetch(`${server.apiUrl}/auth/device/consent`, {
    method: "POST",
    redirect: "manual",
    headers: {
      cookie,
      origin,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: form,
  });
  await decided.body?.cancel();
  expect(decided.status).toBe(200);
}

async function deviceToken(
  clientId: string,
  asked: DeviceCode,
): Promise<string> {
  await server.advanceClock(asked.interval * 1000 + 1000);
  const answer = await token(server, {
    grant_type: DEVICE_GRANT,
    device_code: asked.device_code,
    client_id: clientId,
  });
  expect(answer.status, JSON.stringify(answer.body)).toBe(200);
  return answer.body.access_token!;
}

async function settingsCall(
  access: string,
  settings: Record<string, unknown>,
): Promise<ToolAnswer> {
  const connection = await connectMcp(
    server.apiUrl,
    access,
    "2026-07-28",
    "/mcp/admin",
  );
  try {
    return await callTool(connection, "marfa_change_settings", { settings });
  } finally {
    await connection.close();
  }
}

async function stored(): Promise<Record<string, unknown>> {
  const read = await call(server.managementKey, "GET", "/config");
  expect(read.status).toBe(200);
  return read.body;
}

function expectSignInAsked(landed: URL | undefined, name: string): string {
  expect(landed?.pathname, `${name}: ${String(landed)}`).toBe("/auth/sign-in");
  const back = landed!.searchParams.get("return_to");
  expect(back, `${name}: ${String(landed)}`).toBeTruthy();
  return back!;
}

function expectCodeAtOnce(landed: URL | undefined, name: string): string {
  expect(landed?.href.startsWith(CALLBACK), `${name}: ${String(landed)}`).toBe(
    true,
  );
  return landed!.searchParams.get("code")!;
}

/** The tool's refusal of an app whose owner signed in too long ago. */
function expectRenewalAsked(answer: ToolAnswer): void {
  const refused = toolError(answer);
  expect(refused.code, JSON.stringify(refused)).toBe(
    "insufficient_user_authentication",
  );
  expect(refused.details).toEqual({ max_age: RECENT_SIGN_IN_SECONDS });
}

describe("the settings that need a recent sign-in, through the settings tool", () => {
  it("changes allow_private_addresses and backup_path for an app whose owner signed in within the recent sign-in window", async () => {
    const access = await connect(
      await registerApp(server, SCOPE),
      await signIn(),
    );
    const on = toolResult(await settingsCall(access, { [SWITCH]: true }));
    expect(on, JSON.stringify(on)).toBeTruthy();
    expect((await stored())[SWITCH]).toBe(true);
    toolResult(await settingsCall(access, { backup_path: elsewhere }));
    expect((await stored()).backup_path).toBe(elsewhere);
    toolResult(
      await settingsCall(access, { [SWITCH]: false, backup_path: backups }),
    );
    const after = await stored();
    expect(after[SWITCH]).toBe(false);
    expect(after.backup_path).toBe(backups);
  });

  it("refuses an app whose owner signed in longer ago than the recent sign-in window with insufficient_user_authentication and max_age, as the API does, and changes nothing", async () => {
    const access = await connect(
      await registerApp(server, SCOPE),
      await signIn(),
    );
    // The witness: within the window the same token changes the setting.
    toolResult(await settingsCall(access, { [SWITCH]: true }));
    toolResult(await settingsCall(access, { [SWITCH]: false }));
    await server.advanceClock(PAST_RECENT);
    const before = await stored();
    for (const settings of [{ [SWITCH]: true }, { backup_path: elsewhere }]) {
      expectRenewalAsked(await settingsCall(access, settings));
    }
    expect(await stored()).toEqual(before);
    const api = await call(access, "PATCH", "/config", { [SWITCH]: true });
    expect(api.status).toBe(401);
    expect(api.body.error.code).toBe("insufficient_user_authentication");
    expect(api.body.error.details).toEqual({ max_age: RECENT_SIGN_IN_SECONDS });
  });

  it("refuses sign_in_address to an app whose owner signed in just now with not_offered_over_mcp and the command that moves it, and changes nothing", async () => {
    const access = await connect(
      await registerApp(server, SCOPE),
      await signIn(),
    );
    const before = await stored();
    const refused = toolError(
      await settingsCall(access, {
        sign_in_address: "https://elsewhere.example",
        [SWITCH]: true,
      }),
    );
    expect(refused.code).toBe("not_offered_over_mcp");
    expect(String(refused.message)).toContain(
      "marfa config set sign_in_address",
    );
    expect(await stored()).toEqual(before);
    // The witness: the same token changes a setting that needs a recent sign-in.
    toolResult(await settingsCall(access, { [SWITCH]: true }));
    toolResult(await settingsCall(access, { [SWITCH]: false }));
  });
});

describe("renewing the sign-in the settings tool asked for", () => {
  it("sends the browser to sign in again when the refused app reconnects, and the token it then gets changes the setting", async () => {
    const app = await registerApp(server, SCOPE);
    const other = await registerApp(server, SCOPE);
    const stale = await signIn();
    const access = await connect(app, stale);
    await connect(other, stale);
    await server.advanceClock(PAST_RECENT);
    // The witness: before the refusal, the older browser gets a code at once.
    expectCodeAtOnce((await authorizing(app, stale)).landed, "before");

    expectRenewalAsked(await settingsCall(access, { [SWITCH]: true }));

    // At either endpoint, and again, the older browser is asked to sign in.
    expectSignInAsked(
      (await authorizing(app, stale, `${origin}/mcp`)).landed,
      "at /mcp",
    );
    const { landed, verifier } = await authorizing(app, stale);
    const back = expectSignInAsked(landed, "at /mcp/admin");
    // Only the refused app's own consent asks.
    expectCodeAtOnce((await authorizing(other, stale)).landed, "another app");

    const fresh = await signIn();
    const signedIn = await sentTo(
      server,
      await fetch(new URL(back, server.apiUrl), {
        redirect: "manual",
        headers: { cookie: fresh },
      }),
    );
    const renewed = await exchange(
      app,
      expectCodeAtOnce(signedIn, "after the sign-in"),
      verifier,
    );
    toolResult(await settingsCall(renewed, { [SWITCH]: true }));
    expect((await stored())[SWITCH]).toBe(true);
    toolResult(await settingsCall(renewed, { [SWITCH]: false }));
    // Nothing needs clearing: the new browser connects at once at either endpoint.
    expectCodeAtOnce(
      (await authorizing(app, fresh, `${origin}/mcp`)).landed,
      "the new browser at /mcp",
    );
    expectCodeAtOnce((await authorizing(app, fresh)).landed, "the new browser");
  });

  it("sends the browser to sign in again before it approves a device code for the refused app, and the token the code then issues changes the setting", async () => {
    const clientId = await registerDeviceApp();
    const ask = () => askDevice(clientId);
    const page = devicePage;
    const approve = approveDevice;
    const issued = (asked: DeviceCode) => deviceToken(clientId, asked);

    const stale = await signIn();
    const first = await ask();
    await approve(first.user_code, stale);
    const access = await issued(first);
    await server.advanceClock(PAST_RECENT);
    // The witness: before the refusal, the older browser approves a code at once.
    const before = await ask();
    await approve(before.user_code, stale);
    await issued(before);

    expectRenewalAsked(await settingsCall(access, { [SWITCH]: true }));

    const asked = await ask();
    const sent = await page(asked.user_code, stale);
    expect(sent.status).toBe(302);
    const to = new URL(sent.headers.get("location")!, server.apiUrl);
    expect(to.pathname, String(to)).toBe("/auth/sign-in");
    expect(to.searchParams.get("prompt"), String(to)).toBe("login");

    await approve(asked.user_code, await signIn());
    const renewed = await issued(asked);
    toolResult(await settingsCall(renewed, { [SWITCH]: true }));
    expect((await stored())[SWITCH]).toBe(true);
    toolResult(await settingsCall(renewed, { [SWITCH]: false }));
  });

  it("refuses with invalid_grant a refresh of a sign-in older than the refusal, and refreshes a token from a new sign-in", async () => {
    const app = await registerApp(server, SCOPE);
    const first = await connectTokens(app, await signIn());
    // The witness: before the refusal, the older sign-in's token refreshes.
    const before = await refresh(app, first.refresh);
    expect(before.status, JSON.stringify(before.body)).toBe(200);
    await server.advanceClock(PAST_RECENT);

    expectRenewalAsked(
      await settingsCall(before.body.access_token!, { [SWITCH]: true }),
    );

    const refused = await refresh(app, before.body.refresh_token!);
    expect(refused.status, JSON.stringify(refused.body)).toBe(400);
    expect(refused.body.error).toBe("invalid_grant");

    const renewed = await connectTokens(app, await signIn());
    const again = await refresh(app, renewed.refresh);
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    toolResult(
      await settingsCall(again.body.access_token!, { [SWITCH]: true }),
    );
    expect((await stored())[SWITCH]).toBe(true);
    toolResult(
      await settingsCall(again.body.access_token!, { [SWITCH]: false }),
    );
  });

  it("forgets the renewal when the person removes the app, so the app approved again from the older browser refreshes", async () => {
    const app = await registerApp(server, SCOPE);
    const first = await connectTokens(app, await signIn());
    await server.advanceClock(PAST_RECENT);
    // Recent enough to approve the app, but begun before the refusal.
    const older = await signIn();
    await server.advanceClock(1000);
    expectRenewalAsked(await settingsCall(first.access, { [SWITCH]: true }));
    // The witness: while the app stays, the older browser is asked to sign in.
    expectSignInAsked((await authorizing(app, older)).landed, "before removal");

    const listed = await call(server.managementKey, "GET", "/grants");
    expect(listed.status).toBe(200);
    const grant = (
      listed.body.data as { id: string; client_id: string }[]
    ).find((each) => each.client_id === app.clientId);
    expect(grant, JSON.stringify(listed.body)).toBeTruthy();
    const removed = await call(
      server.managementKey,
      "DELETE",
      `/grants/${grant!.id}`,
    );
    expect(removed.status, JSON.stringify(removed.body)).toBe(200);

    const again = await connectTokens(app, older);
    const refreshed = await refresh(app, again.refresh);
    expect(refreshed.status, JSON.stringify(refreshed.body)).toBe(200);
    expect(refreshed.body.refresh_token).toBeTruthy();
  });

  it("keeps the renewal where it was when a token from the older sign-in is refused again after the person signed in again", async () => {
    const clientId = await registerDeviceApp();
    const stale = await signIn();
    const first = await askDevice(clientId);
    await approveDevice(first.user_code, stale);
    const old = await deviceToken(clientId, first);
    await server.advanceClock(PAST_RECENT);

    expectRenewalAsked(await settingsCall(old, { [SWITCH]: true }));

    const fresh = await signIn();
    const second = await askDevice(clientId);
    await approveDevice(second.user_code, fresh);
    const renewed = await deviceToken(clientId, second);
    // The older token's retry comes after the new sign-in.
    await server.advanceClock(1000);
    expectRenewalAsked(await settingsCall(old, { [SWITCH]: true }));
    toolResult(await settingsCall(renewed, { [SWITCH]: true }));
    expect((await stored())[SWITCH]).toBe(true);
    toolResult(await settingsCall(renewed, { [SWITCH]: false }));

    const third = await askDevice(clientId);
    // The witness: the device consent still sends the older browser to sign in.
    const older = await devicePage(third.user_code, stale);
    await older.body?.cancel();
    expect(older.status).toBe(302);
    const shown = await devicePage(third.user_code, fresh);
    await shown.body?.cancel();
    expect(shown.status, shown.headers.get("location") ?? "").toBe(200);
  });

  it("sends the browser to sign in again when a consent page opened before the refusal is approved, and issues the code after a new sign-in", async () => {
    const app = await registerApp(server, SCOPE);
    const stale = await signIn();
    const access = await connect(app, stale);
    await server.advanceClock(PAST_RECENT);
    // The witness: before the refusal, approving an open consent page gives a code.
    const before = await consentPage(app, stale);
    expectCodeAtOnce(
      await decide(server, origin, stale, before.page, true, SCOPE.split(" ")),
      "before",
    );
    const open = await consentPage(app, stale);

    expectRenewalAsked(await settingsCall(access, { [SWITCH]: true }));

    const back = expectSignInAsked(
      await decide(server, origin, stale, open.page, true, SCOPE.split(" ")),
      "the page opened before the refusal",
    );
    expect(back.startsWith("/auth/consent?"), back).toBe(true);
    const renewed = await exchange(
      app,
      expectCodeAtOnce(
        await decide(
          server,
          origin,
          await signIn(),
          open.page,
          true,
          SCOPE.split(" "),
        ),
        "after the sign-in",
      ),
      open.verifier,
    );
    toolResult(await settingsCall(renewed, { [SWITCH]: true }));
    expect((await stored())[SWITCH]).toBe(true);
    toolResult(await settingsCall(renewed, { [SWITCH]: false }));
  });
});
