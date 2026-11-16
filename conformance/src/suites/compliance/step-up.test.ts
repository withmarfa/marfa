import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createServer, type RequestListener, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { offeredValues } from "../../utils/approval-form.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { controlRequest } from "../../utils/control-request.js";
import { expectMatchesSchema } from "../../utils/openapi.js";
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

/**
 * The four acts that ask the owner to have signed in within five minutes:
 * restoring an archive, restoring a backup, moving the sign-in address and
 * changing `allow_private_addresses`. An app's token meets them by the time
 * its owner last signed in, a key never does, and the private socket keeps
 * them. The owner's sessions, the clock and the sign-in address are the
 * subject, so the file boots a server of its own, with a backup folder.
 * Each password sign-in comes from an address of its own, so the
 * per-address sign-in limit never holds the file back.
 */
let server: FreshServer;
let origin: string;
const backups = mkdtempSync(join(tmpdir(), "marfa-step-up-"));
const CLIENT_HEADER = "x-conformance-client";
const MINUTE = 60 * 1000;
const SCOPE = "backups.manage config.manage offline_access";
const SWITCH = "allow_private_addresses";
let addresses = 0;
let archive: Uint8Array;
let backup: { instance_id: string; name: string };

beforeAll(async () => {
  server = await bootFreshServer("step-up", {
    S3_BUCKET: "",
    MARFA_OBJECT_STORE_BUCKET: "",
    MARFA_OBJECT_STORE_ENDPOINT: "",
    MARFA_ALLOW_PRIVATE_ADDRESSES: "false",
    MARFA_BACKUP_PATH: backups,
    MARFA_BACKUP_INTERVAL_SECONDS: "0",
    MARFA_TRUSTED_PROXY_HEADER: CLIENT_HEADER,
    MARFA_TRUSTED_PROXY_CIDRS: "127.0.0.0/8",
  });
  origin = await issuerOrigin(server);
  const exported = await fetch(
    `${server.apiUrl}/export?format=archive&files=false`,
    { headers: { authorization: `Bearer ${server.workingKey}` } },
  );
  expect(exported.status).toBe(200);
  archive = new Uint8Array(await exported.arrayBuffer());
  const ran = await call(server.managementKey, "POST", "/backups");
  expect(ran.status, JSON.stringify(ran.body)).toBe(200);
  backup = ran.body.backup as { instance_id: string; name: string };
}, FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  await server.stop();
  rmSync(backups, { recursive: true, force: true });
}, FRESH_SERVER_TIMEOUT_MS);

interface Answer {
  status: number;
  challenge: string | null;
  body: Record<string, any>;
}

async function call(
  credential: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<Answer> {
  const raw = body instanceof Uint8Array;
  const response = await fetch(`${server.apiUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${credential}`,
      ...(body === undefined
        ? {}
        : {
            "content-type": raw ? "application/x-tar" : "application/json",
          }),
    },
    body:
      body === undefined
        ? undefined
        : raw
          ? new Blob([body as Uint8Array<ArrayBuffer>])
          : JSON.stringify(body),
  });
  const text = await response.text();
  return {
    status: response.status,
    challenge: response.headers.get("www-authenticate"),
    body: (text === "" ? {} : JSON.parse(text)) as Record<string, any>,
  };
}

function local(method: string, path: string, body?: unknown) {
  return controlRequest(server.controlSocket, path, { method, body });
}

function nextAddress(): string {
  addresses += 1;
  return `198.51.100.${String(addresses)}`;
}

/** A new browser session, by password, at the sign-in address `at`. */
async function signIn(at = origin): Promise<string> {
  const response = await fetch(`${server.apiUrl}/auth/sign-in`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: at,
      [CLIENT_HEADER]: nextAddress(),
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

async function exchange(app: App, code: string, verifier: string) {
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

/** Tokens for `app` from the browser `cookie`, through consent if none covers the scope. */
async function connect(
  app: App,
  cookie: string,
  at = origin,
  extra: Record<string, string> = {},
): Promise<Tokens> {
  const proof = pkce();
  let landed = await sentTo(
    server,
    await authorize(
      server,
      authorizeQuery(app.clientId, SCOPE, proof, extra),
      cookie,
    ),
  );
  if (landed !== undefined && !landed.href.startsWith(CALLBACK)) {
    landed = await decide(server, at, cookie, landed, true, SCOPE.split(" "));
  }
  const code = landed?.searchParams.get("code");
  expect(code, `no code on ${String(landed)}`).toBeTruthy();
  return exchange(app, code!, proof.verifier);
}

async function refreshed(app: App, refresh: string): Promise<Tokens> {
  const answer = await token(server, {
    grant_type: "refresh_token",
    refresh_token: refresh,
    client_id: app.clientId,
  });
  expect(answer.status, JSON.stringify(answer.body)).toBe(200);
  return {
    access: answer.body.access_token!,
    refresh: answer.body.refresh_token!,
  };
}

async function mint(permissions: string[]): Promise<string> {
  const answer = await local("POST", "/keys", {
    label: "step-up key",
    source: `step-up-${randomUUID()}`,
    permissions,
  });
  expect(answer.status, JSON.stringify(answer.body)).toBe(201);
  return answer.body.key as string;
}

async function switchState(): Promise<unknown> {
  const read = await call(server.managementKey, "GET", "/config");
  expect(read.status).toBe(200);
  return read.body[SWITCH];
}

/** A note the working key writes, which the archive and the backup taken after it hold. */
async function note(): Promise<string> {
  const written = await call(server.workingKey, "POST", "/items", {
    type: "core.note",
    properties: { title: `step-up ${randomUUID()}` },
  });
  expect(written.status, JSON.stringify(written.body)).toBe(201);
  return written.body.item.id as string;
}

async function purge(id: string): Promise<void> {
  expect((await call(server.workingKey, "DELETE", `/items/${id}`)).status).toBe(
    200,
  );
  const purged = await call(server.workingKey, "POST", `/items/${id}/purge`);
  expect(purged.status, JSON.stringify(purged.body)).toBe(200);
}

async function itemStatus(id: string): Promise<number> {
  return (await call(server.workingKey, "GET", `/items/${id}`)).status;
}

const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

async function deviceClient(): Promise<string> {
  const response = await fetch(`${server.apiUrl}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "step-up device",
      application_type: "native",
      grant_types: [DEVICE_GRANT, "refresh_token"],
      response_types: [],
      token_endpoint_auth_method: "none",
      scope: SCOPE,
    }),
  });
  const body = (await response.json()) as { client_id: string };
  expect(response.status, JSON.stringify(body)).toBe(201);
  return body.client_id;
}

async function deviceCode(
  clientId: string,
  extra: Record<string, string> = {},
): Promise<{ status: number; body: Record<string, any> }> {
  const response = await fetch(`${server.apiUrl}/oauth/device-authorization`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, scope: SCOPE, ...extra }),
  });
  return {
    status: response.status,
    body: (await response.json()) as Record<string, any>,
  };
}

function devicePage(userCode: string, cookie: string): Promise<Response> {
  return fetch(
    `${server.apiUrl}/auth/device/consent?user_code=${encodeURIComponent(userCode)}`,
    { redirect: "manual", headers: { cookie } },
  );
}

function deviceDecision(
  userCode: string,
  cookie: string,
  scopes: readonly string[],
): Promise<Response> {
  const form = new URLSearchParams({
    user_code: userCode,
    decision: "approve",
  });
  for (const scope of scopes) form.append("scopes", scope);
  return fetch(`${server.apiUrl}/auth/device/consent`, {
    method: "POST",
    redirect: "manual",
    headers: {
      cookie,
      origin,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: form,
  });
}

/** The owner approves, from the browser `cookie`, everything the device page offers. */
async function approveDevice(userCode: string, cookie: string): Promise<void> {
  const page = await devicePage(userCode, cookie);
  expect(page.status, page.headers.get("location") ?? "").toBe(200);
  const offered = offeredValues(await page.text(), "scopes");
  const approved = await deviceDecision(userCode, cookie, offered);
  await approved.body?.cancel();
  expect(approved.status).toBe(200);
}

function devicePoll(clientId: string, code: string) {
  return token(server, {
    grant_type: DEVICE_GRANT,
    device_code: code,
    client_id: clientId,
  });
}

/** Where a device page sends a browser it asks to sign in again. */
function expectSignInAgain(answer: Response, userCode: string): void {
  expect(answer.status).toBe(302);
  const to = new URL(answer.headers.get("location")!, server.apiUrl);
  expect(to.pathname, String(to)).toBe("/auth/sign-in");
  expect(to.searchParams.get("prompt"), String(to)).toBe("login");
  expect(to.searchParams.get("return_to"), String(to)).toBe(
    `/auth/device/consent?user_code=${encodeURIComponent(userCode)}`,
  );
}

/** A listener on loopback that answers each request with `listener`. */
async function stand(
  listener: RequestListener,
): Promise<{ origin: string; server: Server }> {
  const standing = createServer(listener);
  await new Promise<void>((resolve) => {
    standing.listen(0, "127.0.0.1", resolve);
  });
  const { port } = standing.address() as AddressInfo;
  return { origin: `http://127.0.0.1:${String(port)}`, server: standing };
}

async function fold(standing: Server): Promise<void> {
  standing.closeAllConnections();
  await new Promise<void>((resolve) => standing.close(() => resolve()));
}

/** Addresses that do not answer as this instance, by why. */
async function strangers(): Promise<{
  other: string;
  redirect: string;
  closed: string;
  silent: string;
  fold(): Promise<void>;
}> {
  const other = await stand((_, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ name: "Other", instance_id: randomUUID() }));
  });
  const redirect = await stand((_, response) => {
    response.writeHead(302, { location: `${server.apiUrl}/` });
    response.end();
  });
  const silent = await stand(() => {});
  const gone = await stand(() => {});
  await fold(gone.server);
  return {
    other: other.origin,
    redirect: redirect.origin,
    closed: gone.origin,
    silent: silent.origin,
    async fold() {
      await Promise.all(
        [other, redirect, silent].map((one) => fold(one.server)),
      );
    },
  };
}

/** The instance's own address under its other loopback name. */
function otherName(at: string): string {
  const url = new URL(at);
  url.hostname = url.hostname === "localhost" ? "127.0.0.1" : "localhost";
  return url.origin;
}

/** Each act, as a request that reaches it and changes nothing a later act depends on. */
function acts(): readonly {
  name: string;
  send(credential: string): Promise<Answer>;
}[] {
  return [
    {
      name: "POST /restore",
      send: (credential) => call(credential, "POST", "/restore", archive),
    },
    {
      name: "POST /backups/{instance_id}/{name}/restore",
      send: (credential) =>
        call(
          credential,
          "POST",
          `/backups/${backup.instance_id}/${backup.name}/restore`,
        ),
    },
    {
      name: "PATCH /config sign_in_address",
      send: (credential) =>
        call(credential, "PATCH", "/config", {
          sign_in_address: "https://unmoved.example",
          confirm_sign_in_address_change: true,
        }),
    },
    {
      name: "PATCH /config allow_private_addresses",
      send: (credential) =>
        call(credential, "PATCH", "/config", { [SWITCH]: true }),
    },
  ];
}

const CHALLENGE =
  'Bearer error="insufficient_user_authentication", max_age="300"';

function expectChallenged(answer: Answer, name: string): void {
  expect(answer.status, `${name} ${JSON.stringify(answer.body)}`).toBe(401);
  expect(answer.challenge, name).toBe(CHALLENGE);
  expect(answer.body.error.code, name).toBe("insufficient_user_authentication");
  expect(answer.body.error.details, name).toEqual({ max_age: 300 });
}

describe("an app's token", () => {
  it("is challenged at each of the four acts with 401 insufficient_user_authentication and max_age once its owner signed in more than five minutes ago, and changes nothing", async () => {
    const app = await registerApp(server, SCOPE);
    const { access } = await connect(app, await signIn());
    // The witness: the same token holds the permissions the acts take.
    const read = await call(access, "GET", "/backups");
    expect(read.status, JSON.stringify(read.body)).toBe(200);
    await server.advanceClock(6 * MINUTE);
    const before = await call(server.managementKey, "GET", "/config");
    for (const act of acts()) {
      const answer = await act.send(access);
      expectChallenged(answer, act.name);
      await expectMatchesSchema("PATCH", "/config", 401, answer.body);
    }
    expect((await call(server.managementKey, "GET", "/config")).body).toEqual(
      before.body,
    );
    // A token whose owner signed in just now holds no more than this one, and
    // its sign-in is what the acts ask for.
    const fresh = await connect(app, await signIn());
    const turned = await call(fresh.access, "PATCH", "/config", {
      [SWITCH]: true,
    });
    expect(turned.status, JSON.stringify(turned.body)).toBe(200);
    expect(
      (await call(fresh.access, "PATCH", "/config", { [SWITCH]: false }))
        .status,
    ).toBe(200);
  });

  it("writes no item at a challenged archive restore or a challenged backup restore, though the same restores by a token whose owner signed in just now write it", async () => {
    const id = await note();
    const exported = await fetch(
      `${server.apiUrl}/export?format=archive&files=false`,
      { headers: { authorization: `Bearer ${server.workingKey}` } },
    );
    expect(exported.status).toBe(200);
    const holding = new Uint8Array(await exported.arrayBuffer());
    const ran = await call(server.managementKey, "POST", "/backups");
    expect(ran.status, JSON.stringify(ran.body)).toBe(200);
    const kept = ran.body.backup as { instance_id: string; name: string };
    const fromBackup = `/backups/${kept.instance_id}/${kept.name}/restore`;
    await purge(id);
    expect(await itemStatus(id)).toBe(404);

    const app = await registerApp(server, SCOPE);
    const stale = await connect(app, await signIn());
    await server.advanceClock(6 * MINUTE);
    expectChallenged(
      await call(stale.access, "POST", "/restore", holding),
      "archive",
    );
    expect(await itemStatus(id)).toBe(404);
    expectChallenged(await call(stale.access, "POST", fromBackup), "backup");
    expect(await itemStatus(id)).toBe(404);

    // The witness: each restore writes the note back for a token whose owner
    // signed in just now.
    const fresh = await connect(app, await signIn());
    const restored = await call(fresh.access, "POST", "/restore", holding);
    expect(restored.status, JSON.stringify(restored.body)).toBe(200);
    expect(await itemStatus(id)).toBe(200);
    await purge(id);
    const again = await call(fresh.access, "POST", fromBackup);
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(await itemStatus(id)).toBe(200);
  });

  it("restores an archive and a backup, and changes allow_private_addresses, when its owner signed in within five minutes", async () => {
    const app = await registerApp(server, SCOPE);
    const { access } = await connect(app, await signIn());
    const restored = await call(access, "POST", "/restore", archive);
    expect(restored.status, JSON.stringify(restored.body)).toBe(200);
    const fromBackup = await call(
      access,
      "POST",
      `/backups/${backup.instance_id}/${backup.name}/restore`,
    );
    expect(fromBackup.status, JSON.stringify(fromBackup.body)).toBe(200);
    const on = await call(access, "PATCH", "/config", { [SWITCH]: true });
    expect(on.status, JSON.stringify(on.body)).toBe(200);
    expect(await switchState()).toBe(true);
    const off = await call(access, "PATCH", "/config", { [SWITCH]: false });
    expect(off.status, JSON.stringify(off.body)).toBe(200);
    expect(await switchState()).toBe(false);
  });

  it("keeps its owner's sign-in time through a refresh, so the refreshed token is challenged five minutes after the sign-in", async () => {
    const app = await registerApp(server, SCOPE);
    const first = await connect(app, await signIn());
    await server.advanceClock(4 * MINUTE);
    const second = await refreshed(app, first.refresh);
    // The witness: within five minutes of the sign-in the refreshed token acts.
    const on = await call(second.access, "PATCH", "/config", {
      [SWITCH]: true,
    });
    expect(on.status, JSON.stringify(on.body)).toBe(200);
    await server.advanceClock(2 * MINUTE);
    const third = await refreshed(app, second.refresh);
    for (const access of [second.access, third.access]) {
      expectChallenged(
        await call(access, "PATCH", "/config", { [SWITCH]: false }),
        "refreshed",
      );
    }
    expect(await switchState()).toBe(true);
    const fresh = await connect(app, await signIn());
    expect(
      (await call(fresh.access, "PATCH", "/config", { [SWITCH]: false }))
        .status,
    ).toBe(200);
  });

  it("is judged by its own sign-in when the same app holds a token from an older sign-in and one from a newer", async () => {
    const app = await registerApp(server, SCOPE);
    const old = await connect(app, await signIn());
    await server.advanceClock(6 * MINUTE);
    const fresh = await connect(app, await signIn());
    expectChallenged(
      await call(old.access, "PATCH", "/config", { [SWITCH]: true }),
      "older",
    );
    const on = await call(fresh.access, "PATCH", "/config", { [SWITCH]: true });
    expect(on.status, JSON.stringify(on.body)).toBe(200);
    expectChallenged(
      await call(old.access, "PATCH", "/config", { [SWITCH]: false }),
      "older, after the newer acted",
    );
    expect(
      (await call(fresh.access, "PATCH", "/config", { [SWITCH]: false }))
        .status,
    ).toBe(200);
  });
});

describe("max_age at the authorization endpoint", () => {
  it("sends a browser that signed in longer ago than max_age to sign in again, and the code it then issues carries the new sign-in", async () => {
    const app = await registerApp(server, SCOPE);
    const stale = await signIn();
    await connect(app, stale);
    await server.advanceClock(6 * MINUTE);
    // The witness: without max_age the standing consent answers at once.
    const plain = await sentTo(
      server,
      await authorize(
        server,
        authorizeQuery(app.clientId, SCOPE, pkce()),
        stale,
      ),
    );
    expect(plain?.href.startsWith(CALLBACK), String(plain)).toBe(true);

    const proof = pkce();
    const asked = await sentTo(
      server,
      await authorize(
        server,
        authorizeQuery(app.clientId, SCOPE, proof, { max_age: "300" }),
        stale,
      ),
    );
    expect(asked?.pathname, String(asked)).toBe("/auth/sign-in");
    const back = asked!.searchParams.get("return_to");
    expect(back, String(asked)).toBeTruthy();

    const fresh = await signIn();
    const landed = await sentTo(
      server,
      await fetch(new URL(back!, server.apiUrl), {
        redirect: "manual",
        headers: { cookie: fresh },
      }),
    );
    // Consent stands, so the new sign-in is the only step.
    expect(landed?.href.startsWith(CALLBACK), String(landed)).toBe(true);
    const code = landed!.searchParams.get("code");
    expect(code).toBeTruthy();
    const { access } = await exchange(app, code!, proof.verifier);
    const on = await call(access, "PATCH", "/config", { [SWITCH]: true });
    expect(on.status, JSON.stringify(on.body)).toBe(200);
    expect(
      (await call(access, "PATCH", "/config", { [SWITCH]: false })).status,
    ).toBe(200);
  });

  it("issues a code at once to a browser that signed in within max_age", async () => {
    const app = await registerApp(server, SCOPE);
    const cookie = await signIn();
    await connect(app, cookie);
    await server.advanceClock(MINUTE);
    const landed = await sentTo(
      server,
      await authorize(
        server,
        authorizeQuery(app.clientId, SCOPE, pkce(), { max_age: "300" }),
        cookie,
      ),
    );
    expect(landed?.href.startsWith(CALLBACK), String(landed)).toBe(true);
  });

  it("sends a browser that signed in this moment to sign in again under max_age=0", async () => {
    const app = await registerApp(server, SCOPE);
    const cookie = await signIn();
    await connect(app, cookie);
    const asked = await sentTo(
      server,
      await authorize(
        server,
        authorizeQuery(app.clientId, SCOPE, pkce(), { max_age: "0" }),
        cookie,
      ),
    );
    expect(asked?.pathname, String(asked)).toBe("/auth/sign-in");
  });

  it("answers login_required under prompt=none to a browser that signed in longer ago than max_age", async () => {
    const app = await registerApp(server, SCOPE);
    const cookie = await signIn();
    await connect(app, cookie);
    await server.advanceClock(6 * MINUTE);
    // The witness: without max_age, prompt=none answers the standing consent with a code.
    const silent = await sentTo(
      server,
      await authorize(
        server,
        authorizeQuery(app.clientId, SCOPE, pkce(), { prompt: "none" }),
        cookie,
      ),
    );
    expect(silent?.searchParams.get("code"), String(silent)).toBeTruthy();
    const landed = await sentTo(
      server,
      await authorize(
        server,
        authorizeQuery(app.clientId, SCOPE, pkce(), {
          prompt: "none",
          max_age: "300",
        }),
        cookie,
      ),
    );
    expect(landed?.href.startsWith(CALLBACK), String(landed)).toBe(true);
    expect(landed!.searchParams.get("error")).toBe("login_required");
    expect(landed!.searchParams.get("code")).toBeNull();
  });

  it("refuses a max_age that is not a whole number of seconds with invalid_request at the redirect URI", async () => {
    const app = await registerApp(server, SCOPE);
    const cookie = await signIn();
    for (const value of ["-1", "5.5", "soon"]) {
      const landed = await sentTo(
        server,
        await authorize(
          server,
          authorizeQuery(app.clientId, SCOPE, pkce(), {
            max_age: value,
            state: "kept",
          }),
          cookie,
        ),
      );
      expect(
        landed?.href.startsWith(CALLBACK),
        `${value}: ${String(landed)}`,
      ).toBe(true);
      expect(landed!.searchParams.get("error"), value).toBe("invalid_request");
      expect(landed!.searchParams.get("state"), value).toBe("kept");
      expect(landed!.searchParams.get("code"), value).toBeNull();
    }
  });

  it("advertises prompt=login in the authorization server metadata", async () => {
    const response = await fetch(
      `${server.apiUrl}/.well-known/oauth-authorization-server`,
    );
    const metadata = (await response.json()) as Record<string, unknown>;
    expect(metadata.prompt_values_supported).toEqual([
      "none",
      "login",
      "consent",
    ]);
  });
});

describe("max_age at the device authorization endpoint", () => {
  // Each test opens the device page up to eight times, and the owner may look
  // up ten codes in fifteen minutes.
  beforeEach(async () => {
    await server.advanceClock(16 * MINUTE);
  });

  it("sends a browser that signed in longer ago than max_age to sign in again before it approves the code, and the token the code then issues passes the step-up check", async () => {
    const clientId = await deviceClient();
    // A grant that holds the scope already, so an older browser may approve
    // the next codes.
    const first = await deviceCode(clientId);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    await approveDevice(first.body.user_code, await signIn());
    const stale = await signIn();
    await server.advanceClock(6 * MINUTE);

    // The witness: without max_age the older browser approves at once, and
    // the token carries its older sign-in.
    const plain = await deviceCode(clientId);
    await approveDevice(plain.body.user_code, stale);
    const plainToken = await devicePoll(clientId, plain.body.device_code);
    expect(plainToken.status, JSON.stringify(plainToken.body)).toBe(200);
    expectChallenged(
      await call(plainToken.body.access_token!, "PATCH", "/config", {
        [SWITCH]: true,
      }),
      "without max_age",
    );

    const asked = await deviceCode(clientId, { max_age: "300" });
    expect(asked.status, JSON.stringify(asked.body)).toBe(200);
    const userCode = asked.body.user_code as string;
    expectSignInAgain(await devicePage(userCode, stale), userCode);
    expectSignInAgain(
      await deviceDecision(userCode, stale, SCOPE.split(" ")),
      userCode,
    );
    const pending = await devicePoll(clientId, asked.body.device_code);
    expect(pending.body.error).toBe("authorization_pending");

    await approveDevice(userCode, await signIn());
    await server.advanceClock((asked.body.interval as number) * 1000 + 1000);
    const issued = await devicePoll(clientId, asked.body.device_code);
    expect(issued.status, JSON.stringify(issued.body)).toBe(200);
    const on = await call(issued.body.access_token!, "PATCH", "/config", {
      [SWITCH]: true,
    });
    expect(on.status, JSON.stringify(on.body)).toBe(200);
    expect(
      (
        await call(issued.body.access_token!, "PATCH", "/config", {
          [SWITCH]: false,
        })
      ).status,
    ).toBe(200);
  });

  it("sends a browser that signed in before the code was asked for to sign in again under max_age=0, and approves from a sign-in made after it", async () => {
    const clientId = await deviceClient();
    const first = await deviceCode(clientId);
    await approveDevice(first.body.user_code, await signIn());
    const before = await signIn();
    await server.advanceClock(1000);
    const asked = await deviceCode(clientId, { max_age: "0" });
    expect(asked.status, JSON.stringify(asked.body)).toBe(200);
    const userCode = asked.body.user_code as string;
    expectSignInAgain(await devicePage(userCode, before), userCode);
    await approveDevice(userCode, await signIn());
    const issued = await devicePoll(clientId, asked.body.device_code);
    expect(issued.status, JSON.stringify(issued.body)).toBe(200);
    const on = await call(issued.body.access_token!, "PATCH", "/config", {
      [SWITCH]: true,
    });
    expect(on.status, JSON.stringify(on.body)).toBe(200);
    expect(
      (
        await call(issued.body.access_token!, "PATCH", "/config", {
          [SWITCH]: false,
        })
      ).status,
    ).toBe(200);
  });

  it("refuses a max_age that is not a whole number of seconds with 400 invalid_request", async () => {
    const clientId = await deviceClient();
    for (const value of ["-1", "5.5", "soon", ""]) {
      const asked = await deviceCode(clientId, { max_age: value });
      expect(asked.status, `${value}: ${JSON.stringify(asked.body)}`).toBe(400);
      expect(asked.body.error, value).toBe("invalid_request");
      expect(asked.body.device_code, value).toBeUndefined();
    }
  });
});

describe("a key and the private socket", () => {
  it("refuses a key, even one holding every permission the acts take, with 403 app_sign_in_required and never a challenge", async () => {
    const key = await mint(["backups.manage", "config.manage"]);
    // The witness: the key holds the permissions the acts take.
    expect((await call(key, "GET", "/backups")).status).toBe(200);
    for (const act of acts()) {
      const answer = await act.send(key);
      expect(answer.status, `${act.name} ${JSON.stringify(answer.body)}`).toBe(
        403,
      );
      expect(answer.challenge, act.name).toBeNull();
      expect(answer.body.error.code, act.name).toBe("app_sign_in_required");
    }
    expect(await switchState()).toBe(false);
  });

  it("refuses an app's token without the permission an act takes, naming it, before any challenge", async () => {
    const app = await registerApp(server, "instance.read");
    const proof = pkce();
    const cookie = await signIn();
    let landed = await sentTo(
      server,
      await authorize(
        server,
        authorizeQuery(app.clientId, "instance.read", proof),
        cookie,
      ),
    );
    if (landed !== undefined && !landed.href.startsWith(CALLBACK)) {
      landed = await decide(server, origin, cookie, landed, true, [
        "instance.read",
      ]);
    }
    const { access } = await exchange(
      app,
      landed!.searchParams.get("code")!,
      proof.verifier,
    );
    await server.advanceClock(6 * MINUTE);
    const answer = await call(access, "POST", "/backups/x/y/restore");
    expect(answer.status, JSON.stringify(answer.body)).toBe(403);
    expect(answer.body.error.details).toEqual({
      required_scope: "backups.manage",
    });
    expect(answer.challenge).toBeNull();
  });

  it("keeps the four acts on the private socket with no challenge", async () => {
    await server.advanceClock(6 * MINUTE);
    const restored = await controlRequest(server.controlSocket, "/restore", {
      method: "POST",
      body: archive,
    });
    expect(restored.status, JSON.stringify(restored.body)).toBe(200);
    const fromBackup = await local(
      "POST",
      `/backups/${backup.instance_id}/${backup.name}/restore`,
    );
    expect(fromBackup.status, JSON.stringify(fromBackup.body)).toBe(200);
    expect((await local("PATCH", "/config", { [SWITCH]: true })).status).toBe(
      200,
    );
    expect((await local("PATCH", "/config", { [SWITCH]: false })).status).toBe(
      200,
    );
  });
});

describe("the check that the new sign-in address answers as this instance", () => {
  it("refuses a move to an address that answers as another instance, redirects, answers nothing or never answers, with 409 sign_in_address_check_failed, and changes nothing", async () => {
    const away = await strangers();
    try {
      const app = await registerApp(server, SCOPE);
      const { access } = await connect(app, await signIn());
      const before = await call(server.managementKey, "GET", "/config");
      for (const to of [away.other, away.redirect, away.closed, away.silent]) {
        const checked = await call(access, "POST", "/config/address-check", {
          sign_in_address: to,
        });
        expect(checked.status, JSON.stringify(checked.body)).toBe(200);
        expect(checked.body.sign_in_address_check, to).toEqual({
          passed: false,
          reason: "not_this_instance",
        });
        const moved = await call(access, "PATCH", "/config", {
          sign_in_address: to,
          confirm_sign_in_address_change: true,
        });
        expect(moved.status, `${to} ${JSON.stringify(moved.body)}`).toBe(409);
        expect(moved.body.error.code, to).toBe("sign_in_address_check_failed");
        expect(moved.body.error.details, to).toEqual({
          reason: "not_this_instance",
        });
        await expectMatchesSchema("PATCH", "/config", 409, moved.body);
      }
      expect((await call(server.managementKey, "GET", "/config")).body).toEqual(
        before.body,
      );
      expect(await issuerOrigin(server)).toBe(origin);
      // Nothing ended: the token that asked still reads.
      expect((await call(access, "GET", "/config")).status).toBe(200);
    } finally {
      await away.fold();
    }
  }, 60_000);

  it("names why an address failed the check while private addresses are allowed: unreachable, timed_out or not_this_instance", async () => {
    const away = await strangers();
    expect((await local("PATCH", "/config", { [SWITCH]: true })).status).toBe(
      200,
    );
    try {
      for (const [to, reason] of [
        [away.closed, "unreachable"],
        [away.silent, "timed_out"],
        [away.other, "not_this_instance"],
        [away.redirect, "not_this_instance"],
      ] as const) {
        const checked = await call(
          server.managementKey,
          "POST",
          "/config/address-check",
          { sign_in_address: to },
        );
        expect(checked.status, JSON.stringify(checked.body)).toBe(200);
        expect(checked.body.sign_in_address_check, to).toEqual({
          passed: false,
          reason,
        });
        await expectMatchesSchema(
          "POST",
          "/config/address-check",
          200,
          checked.body,
        );
      }
      // A move is refused for the same reason the check names.
      const app = await registerApp(server, SCOPE);
      const { access } = await connect(app, await signIn());
      const moved = await call(access, "PATCH", "/config", {
        sign_in_address: away.closed,
        confirm_sign_in_address_change: true,
      });
      expect(moved.status, JSON.stringify(moved.body)).toBe(409);
      expect(moved.body.error).toMatchObject({
        code: "sign_in_address_check_failed",
        details: { reason: "unreachable" },
      });
      expect(await issuerOrigin(server)).toBe(origin);
    } finally {
      expect(
        (await local("PATCH", "/config", { [SWITCH]: false })).status,
      ).toBe(200);
      await away.fold();
    }
  }, 60_000);

  it("is skipped for the private local command when the body sets skip_sign_in_address_check, and that field is refused to an app with 403 forbidden", async () => {
    const away = await strangers();
    try {
      const app = await registerApp(server, SCOPE);
      const { access } = await connect(app, await signIn());
      const asked = {
        sign_in_address: away.closed,
        confirm_sign_in_address_change: true,
        skip_sign_in_address_check: true,
      };
      const refused = await call(access, "PATCH", "/config", asked);
      expect(refused.status, JSON.stringify(refused.body)).toBe(403);
      expect(refused.body.error.code).toBe("forbidden");
      expect(await issuerOrigin(server)).toBe(origin);

      const moved = await local("PATCH", "/config", asked);
      expect(moved.status, JSON.stringify(moved.body)).toBe(200);
      expect(await issuerOrigin(server)).toBe(away.closed);
      // The witness: without the field, the check runs for the private
      // local command too, and the instance's own address passes it.
      const unchecked = await local("PATCH", "/config", {
        sign_in_address: away.other,
        confirm_sign_in_address_change: true,
      });
      expect(unchecked.status, JSON.stringify(unchecked.body)).toBe(409);
      expect((unchecked.body as { error: { code: string } }).error.code).toBe(
        "sign_in_address_check_failed",
      );
      const back = await local("PATCH", "/config", {
        sign_in_address: origin,
        confirm_sign_in_address_change: true,
      });
      expect(back.status, JSON.stringify(back.body)).toBe(200);
      expect(await issuerOrigin(server)).toBe(origin);
    } finally {
      await away.fold();
    }
  });
});

describe("moving the sign-in address", () => {
  it("is checked beforehand as it is done: an app whose owner signed in just now moves it, every browser session and app sign-in ends after the answer, keys keep working, and the answer names the next steps", async () => {
    const from = await issuerOrigin(server);
    const to = otherName(from);
    const app = await registerApp(server, SCOPE);
    const other = await registerApp(server, SCOPE);
    const cookie = await signIn(from);
    const mover = await connect(app, cookie, from);
    const bystander = await connect(other, cookie, from);
    const key = await mint(["config.manage"]);
    for (const access of [mover.access, bystander.access]) {
      expect((await call(access, "GET", "/config")).status).toBe(200);
    }

    const checked = await call(mover.access, "POST", "/config/address-check", {
      sign_in_address: to,
    });
    expect(checked.status, JSON.stringify(checked.body)).toBe(200);
    expect(checked.body.requires_confirmation).toBe(true);
    expect(checked.body.sign_in_address_check).toEqual({ passed: true });
    const codes = (checked.body.consequences as { code: string }[]).map(
      (consequence) => consequence.code,
    );
    expect(codes).toEqual(
      expect.arrayContaining(["browser_sessions_end", "apps_sign_in_again"]),
    );
    expect(checked.body.next_steps).toEqual([
      {
        code: "sign_in",
        sentence: expect.any(String),
        url: `${to}/auth/sign-in`,
      },
      {
        code: "add_passkey",
        sentence: expect.any(String),
        url: `${to}/auth/sign-in?prompt=login&return_to=/auth/owner/passkeys`,
      },
    ]);
    await expectMatchesSchema(
      "POST",
      "/config/address-check",
      200,
      checked.body,
    );

    const moved = await call(mover.access, "PATCH", "/config", {
      sign_in_address: to,
      confirm_sign_in_address_change: true,
    });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    expect(moved.body.sign_in_address).toBe(to);
    await expectMatchesSchema("PATCH", "/config", 200, moved.body);
    expect(moved.body.sign_in_moved).toEqual({
      consequences: checked.body.consequences,
      next_steps: checked.body.next_steps,
    });

    for (const access of [mover.access, bystander.access]) {
      expect((await call(access, "GET", "/config")).status).toBe(401);
    }
    const refreshing = await token(server, {
      grant_type: "refresh_token",
      refresh_token: mover.refresh,
      client_id: app.clientId,
    });
    expect(refreshing.status).toBe(400);
    expect(refreshing.body.error).toBe("invalid_grant");
    const opens = await fetch(`${server.apiUrl}/owner/passkeys`, {
      headers: { cookie },
    });
    await opens.body?.cancel();
    expect(opens.status).toBe(401);
    expect((await call(key, "GET", "/config")).status).toBe(200);
    const link = await call(
      server.managementKey,
      "GET",
      "/owner/passkeys/add-url",
    );
    expect(link.body.url).toBe(checked.body.next_steps[1].url);

    // The app reconnects at the new issuer, and its grant still stands, so
    // the new sign-in is the only step.
    expect(await issuerOrigin(server)).toBe(to);
    const proof = pkce();
    const landed = await sentTo(
      server,
      await authorize(
        server,
        authorizeQuery(app.clientId, SCOPE, proof),
        await signIn(to),
      ),
    );
    expect(landed?.href.startsWith(CALLBACK), String(landed)).toBe(true);
    expect(landed!.searchParams.get("iss")).toBe(to);
    const again = await exchange(
      app,
      landed!.searchParams.get("code")!,
      proof.verifier,
    );
    const read = await call(again.access, "GET", "/config");
    expect(read.status).toBe(200);
    expect(read.body).not.toHaveProperty("sign_in_moved");
  });
});
