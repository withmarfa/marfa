import { TEST_OWNER as OWNER } from "../../utils/target.js";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import { controlRequest } from "../../utils/control-request.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { withInstanceDatabase } from "../../utils/instance-database.js";
import { HeldLock } from "../../utils/held-lock.js";
import {
  connect,
  issuerOrigin,
  itemsStatus,
  registerApp,
  token,
  type App,
} from "../../utils/signed-in.js";
import { expectMatchesSchema } from "../../utils/openapi.js";

/**
 * The owner's sign-ins: every browser session, app and key, listed, renamed
 * and ended at `/owner/sign-ins`, and a browser session ended by a week
 * unused. A session's age is arranged in the server's own
 * database where a clock would take a week to reach it, and then asked about
 * over HTTP, so what is asserted is what the server answers. Each sign-in
 * comes from an address of its own, so the per-address sign-in limit never
 * holds this file back, and the address is what the listing shows.
 */
let server: FreshServer;
let origin: string;

const CLIENT_HEADER = "x-conformance-client";
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
let addresses = 0;

beforeAll(async () => {
  server = await bootFreshServer("owner-sign-ins", {
    TRUSTED_PROXY_HEADER: CLIENT_HEADER,
    // How long a write waits for the lock before it gives up, kept short for
    // the case that holds the lock from outside.
    SQLITE_BUSY_BUDGET_MS: "1000",
  });
  origin = await issuerOrigin(server);
}, 2 * FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  await server.stop();
}, 2 * FRESH_SERVER_TIMEOUT_MS);

interface Browser {
  cookie: string;
  address: string;
  userAgent: string;
  /** The `Max-Age` the sign-in gave the cookie. */
  maxAge: number;
}

interface SignIn {
  id: string;
  kind: string;
  name: string;
  current: boolean;
  created_at: string;
  last_used_at: string;
  expires_at: string;
  ip_address: string | null;
  user_agent: string | null;
}

async function signIn(
  userAgent = `owner-sign-ins browser ${String(addresses + 1)}`,
): Promise<Browser> {
  addresses += 1;
  const address = `198.51.100.${String(addresses)}`;
  const response = await fetch(`${server.apiUrl}/auth/sign-in/email`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin,
      "user-agent": userAgent,
      [CLIENT_HEADER]: address,
    },
    body: JSON.stringify({ email: OWNER.email, password: OWNER.password }),
  });
  expect(response.status).toBe(200);
  const cookie = /(?:^|,\s*)([\w.-]*session_token=[^;]+)/.exec(
    response.headers.get("set-cookie") ?? "",
  )?.[1];
  expect(cookie, "sign-in set no session cookie").toBeTruthy();
  return {
    cookie: cookie!,
    address,
    userAgent,
    maxAge: cookieMaxAge(response, cookie!) ?? Number.NaN,
  };
}

/** The `Max-Age` of the session cookie `response` sets, if it sets it. */
function cookieMaxAge(response: Response, cookie: string): number | undefined {
  const line = response.headers
    .getSetCookie()
    .find((value) => value.startsWith(`${cookie};`));
  return line === undefined
    ? undefined
    : Number(/max-age=(\d+)/i.exec(line)?.[1]);
}

const COOKIE_SECONDS = 400 * 24 * 3600;

function list(browser: Browser): Promise<Response> {
  return fetch(`${server.apiUrl}/owner/sign-ins`, {
    headers: { cookie: browser.cookie },
  });
}

async function signIns(browser: Browser): Promise<SignIn[]> {
  const response = await list(browser);
  expect(response.status).toBe(200);
  const body = (await response.json()) as { data: SignIn[] };
  await expectMatchesSchema("GET", "/owner/sign-ins", 200, body);
  return body.data;
}

async function idOf(browser: Browser): Promise<string> {
  const own = (await signIns(browser)).find((row) => row.current);
  expect(own, "the listing marked no session current").toBeDefined();
  return own!.id;
}

function end(browser: Browser, id: string): Promise<Response> {
  return fetch(`${server.apiUrl}/owner/sign-ins/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: { cookie: browser.cookie, origin },
  });
}

function rename(
  browser: Browser,
  id: string,
  body: unknown,
): Promise<Response> {
  return fetch(`${server.apiUrl}/owner/sign-ins/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: {
      cookie: browser.cookie,
      origin,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

/** The private local command's request, which carries no credential. */
function local(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return controlRequest(server.controlSocket, path, { method, body });
}

const APP_SCOPE = "core.note:read core.note:write offline_access";

interface SignedInApp {
  clientId: string;
  accessToken: string;
  refreshToken: string;
  app: App;
}

/** An app registered under `name` and approved by `browser`. */
async function approveApp(
  browser: Browser,
  name: string,
): Promise<SignedInApp> {
  const app = await registerApp(server, APP_SCOPE, { client_name: name });
  const tokens = await connect(server, origin, browser.cookie, app, APP_SCOPE);
  expect(tokens.access_token).toBeTruthy();
  expect(tokens.refresh_token).toBeTruthy();
  return {
    clientId: app.clientId,
    accessToken: tokens.access_token!,
    refreshToken: tokens.refresh_token!,
    app,
  };
}

/** A key the local command mints, which can read and write notes. */
async function mintKey(label: string): Promise<{ id: string; key: string }> {
  const minted = await local("POST", "/keys", {
    label,
    source: `owner-sign-ins-${label.replace(/\W+/g, "-")}`,
    type_permissions: { "core.note": "write" },
  });
  expect(minted.status, JSON.stringify(minted.body)).toBe(201);
  return minted.body as { id: string; key: string };
}

/** Writes a note with `bearer`, and changes it so it has a version, and
 *  answers its id. */
async function writeNote(bearer: string): Promise<string> {
  const headers = {
    authorization: `Bearer ${bearer}`,
    "content-type": "application/json",
  };
  const created = await fetch(`${server.apiUrl}/items`, {
    method: "POST",
    headers,
    body: JSON.stringify({ type: "core.note", properties: { body: "first" } }),
  });
  expect(created.status, await created.clone().text()).toBe(201);
  const id = ((await created.json()) as { item: { id: string } }).item.id;
  const changed = await fetch(`${server.apiUrl}/items/${id}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ version: 1, properties: { body: "second" } }),
  });
  expect(changed.status, await changed.clone().text()).toBe(200);
  return id;
}

/** An item's versions, as the working key reads them. */
async function versionsOf(id: string): Promise<unknown> {
  const response = await fetch(`${server.apiUrl}/items/${id}/versions`, {
    headers: { authorization: `Bearer ${server.workingKey}` },
  });
  expect(response.status).toBe(200);
  return response.json();
}

/** The app's refresh, answered status and error. */
async function refresh(
  signedIn: SignedInApp,
): Promise<{ status: number; error?: string; access?: string }> {
  const answer = await token(
    server,
    {
      grant_type: "refresh_token",
      refresh_token: signedIn.refreshToken,
      client_id: signedIn.clientId,
    },
    signedIn.app,
  );
  return {
    status: answer.status,
    error: answer.body.error,
    access: answer.body.access_token,
  };
}

/** Waits for the listing to show `id` with a last use, which is written
 *  after the request that made it answers. */
async function listedWithUse(browser: Browser, id: string): Promise<SignIn> {
  const deadline = Date.now() + 10 * SECOND;
  for (;;) {
    const row = (await signIns(browser)).find((r) => r.id === id);
    if (row?.last_used_at || Date.now() > deadline) {
      expect(row, `${id} is not listed`).toBeDefined();
      return row!;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
}

/** What the sign-in library says of the browser's session: `null` for none. */
async function session(
  browser: Browser,
): Promise<{ session: Record<string, unknown> } | null> {
  const response = await fetch(`${server.apiUrl}/auth/get-session`, {
    headers: { cookie: browser.cookie },
  });
  expect(response.status).toBe(200);
  return (await response.json()) as { session: Record<string, unknown> } | null;
}

/** Sets a session's stored times, in the whole seconds the table keeps. */
function arrange(
  id: string,
  times: { createdAt?: number; updatedAt?: number; expiresAt?: number },
): void {
  withInstanceDatabase(server.sqlitePath, (db) => {
    for (const [column, at] of [
      ["created_at", times.createdAt],
      ["updated_at", times.updatedAt],
      ["expires_at", times.expiresAt],
    ] as const) {
      if (at === undefined) continue;
      db.prepare(`UPDATE auth_session SET ${column} = ? WHERE id = ?`).run(
        Math.floor(at / 1000),
        id,
      );
    }
  });
}

function stored(id: string): { updated_at: number; expires_at: number } {
  return withInstanceDatabase(
    server.sqlitePath,
    (db) =>
      db
        .prepare("SELECT updated_at, expires_at FROM auth_session WHERE id = ?")
        .get(id) as { updated_at: number; expires_at: number },
  );
}

describe("the owner's sign-ins", () => {
  it("lists every live browser session of the owner, marking the one that asks", async () => {
    const first = await signIn();
    const second = await signIn();
    const rows = await signIns(first);
    const firstId = await idOf(first);
    const secondId = await idOf(second);
    const mine = rows.find((row) => row.id === firstId);
    const other = rows.find((row) => row.id === secondId);
    expect(mine).toMatchObject({
      kind: "browser",
      current: true,
      ip_address: first.address,
      user_agent: first.userAgent,
    });
    expect(other).toMatchObject({
      kind: "browser",
      current: false,
      ip_address: second.address,
      user_agent: second.userAgent,
    });
    for (const row of [mine!, other!]) {
      expect(Object.keys(row).sort()).toEqual([
        "created_at",
        "current",
        "expires_at",
        "id",
        "ip_address",
        "kind",
        "last_used_at",
        "name",
        "user_agent",
      ]);
      for (const at of [row.created_at, row.last_used_at, row.expires_at])
        expect(Number.isNaN(Date.parse(at))).toBe(false);
    }
    expect(rows.filter((row) => row.current)).toHaveLength(1);
  });

  it("carries no session's token, which the sign-in library's own answer does", async () => {
    const browser = await signIn();
    // The witness: the token is there to leak, in the library's answer.
    const own = await session(browser);
    const sessionToken = own?.session.token;
    expect(typeof sessionToken).toBe("string");
    const text = await (await list(browser)).text();
    expect(text).not.toContain(sessionToken as string);
    expect(text).not.toContain(
      decodeURIComponent(browser.cookie.slice(browser.cookie.indexOf("=") + 1)),
    );
  });

  it("lists and ends no session of anyone but the owner", async () => {
    const browser = await signIn();
    const now = Math.floor(Date.now() / 1000);
    withInstanceDatabase(server.sqlitePath, (db) => {
      db.prepare(
        "INSERT INTO auth_user (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)",
      ).run("someone-else", "Someone Else", "someone@example.test", now, now);
      db.prepare(
        "INSERT INTO auth_session (id, token, user_id, created_at, updated_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(
        "someone-elses-session",
        "someone-elses-token",
        "someone-else",
        now,
        now,
        now + 7 * 24 * 3600,
      );
    });
    // The witness: the owner's own session is listed beside where it would be.
    expect((await signIns(browser)).some((row) => row.current)).toBe(true);
    expect((await signIns(browser)).map((row) => row.id)).not.toContain(
      "someone-elses-session",
    );
    const refused = await end(browser, "someone-elses-session");
    expect(refused.status).toBe(404);
    expect(refused.headers.get("x-error-code")).toBe("sign_in_not_found");
    expect(
      withInstanceDatabase(server.sqlitePath, (db) =>
        db
          .prepare("SELECT id FROM auth_session WHERE id = ?")
          .get("someone-elses-session"),
      ),
    ).toBeDefined();
  });

  it("refuses a key and an app's token 403, and no credential 401", async () => {
    const browser = await signIn();
    const id = await idOf(browser);
    const app = await registerApp(server, "core.note:read");
    const appToken = (
      await connect(server, origin, browser.cookie, app, "core.note:read")
    ).access_token!;
    // The witness: the app's token works where it is meant to.
    expect(await itemsStatus(server, appToken)).toBe(200);

    for (const bearer of [server.managementKey, server.workingKey, appToken]) {
      for (const [method, path] of [
        ["GET", "/owner/sign-ins"],
        ["PATCH", `/owner/sign-ins/${id}`],
        ["DELETE", `/owner/sign-ins/${id}`],
      ] as const) {
        const response = await fetch(`${server.apiUrl}${path}`, {
          method,
          // The owner's cookie beside a bearer adds nothing to it.
          headers: {
            authorization: `Bearer ${bearer}`,
            cookie: browser.cookie,
            origin,
            "content-type": "application/json",
          },
          ...(method === "PATCH"
            ? { body: JSON.stringify({ name: "taken over" }) }
            : {}),
        });
        expect(response.status, `${method} ${path}`).toBe(403);
        expect(response.headers.get("x-error-code")).toBe("forbidden");
      }
    }
    for (const [method, path] of [
      ["GET", "/owner/sign-ins"],
      ["PATCH", `/owner/sign-ins/${id}`],
      ["DELETE", `/owner/sign-ins/${id}`],
    ] as const) {
      const none = await fetch(`${server.apiUrl}${path}`, {
        method,
        headers: { "content-type": "application/json" },
        ...(method === "PATCH" ? { body: JSON.stringify({ name: "x" }) } : {}),
      });
      expect(none.status, `no credential ${method} ${path}`).toBe(401);
    }
    // Nothing above ended the session.
    expect(await session(browser)).not.toBeNull();
  });

  it("answers the private local command every browser session, marking none current, and ends one for it", async () => {
    const browser = await signIn();
    const id = await idOf(browser);
    const listed = await controlRequest(
      server.controlSocket,
      "/owner/sign-ins",
    );
    expect(listed.status).toBe(200);
    const rows = (listed.body as { data: SignIn[] }).data;
    expect(rows.map((row) => row.id)).toContain(id);
    expect(rows.every((row) => !row.current)).toBe(true);
    const ended = await controlRequest(
      server.controlSocket,
      `/owner/sign-ins/${id}`,
      { method: "DELETE" },
    );
    expect(ended.status).toBe(200);
    expect(await session(browser)).toBeNull();
  });

  it("names a browser from the browser it reports", async () => {
    const safari = await signIn(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
    );
    const own = (await signIns(safari)).find((row) => row.current)!;
    expect(own.name).toBe("Safari on macOS");
  });
});

describe("every sign-in", () => {
  it("lists every app and key beside the browsers, each with a name, a kind and its last use", async () => {
    const browser = await signIn();
    const signedIn = await approveApp(browser, "Marfa app on the test machine");
    const minted = await mintKey("listed key");
    expect(await itemsStatus(server, signedIn.accessToken)).toBe(200);
    expect(await itemsStatus(server, minted.key)).toBe(200);

    const rows = await signIns(browser);
    const appRow = rows.find(
      (row) =>
        row.kind === "app" && row.name === "Marfa app on the test machine",
    );
    expect(appRow, "the app is not listed").toBeDefined();
    const keyRow = rows.find((row) => row.id === minted.id);
    expect(keyRow).toMatchObject({
      kind: "key",
      name: "listed key",
      current: false,
      ip_address: null,
      user_agent: null,
      expires_at: null,
    });
    expect(appRow).toMatchObject({
      current: false,
      ip_address: null,
      user_agent: null,
      expires_at: null,
    });
    expect(rows.some((row) => row.kind === "browser" && row.current)).toBe(
      true,
    );
    for (const id of [appRow!.id, minted.id]) {
      const used = await listedWithUse(browser, id);
      expect(Number.isNaN(Date.parse(used.last_used_at))).toBe(false);
    }
    // Oldest first, across every kind.
    const made = rows.map((row) => Date.parse(row.created_at));
    expect(made).toEqual([...made].sort((a, b) => a - b));
  });

  it("carries no key and no app token, which the app and the key hold", async () => {
    const browser = await signIn();
    const signedIn = await approveApp(browser, "app that holds tokens");
    const minted = await mintKey("key that holds itself");
    // The witness: each credential is real and works.
    expect(await itemsStatus(server, signedIn.accessToken)).toBe(200);
    expect(await itemsStatus(server, minted.key)).toBe(200);
    const text = await (await list(browser)).text();
    expect(text).toContain(minted.id);
    for (const secret of [
      minted.key,
      signedIn.accessToken,
      signedIn.refreshToken,
    ])
      expect(text).not.toContain(secret);
  });

  it("lists no key past its expires_at", async () => {
    const browser = await signIn();
    const minted = await local("POST", "/keys", {
      label: "short-lived key",
      source: "owner-sign-ins-short-lived",
      expires_at: new Date(Date.now() + 2 * SECOND).toISOString(),
    });
    expect(minted.status, JSON.stringify(minted.body)).toBe(201);
    const id = minted.body.id as string;
    // The witness: the key is listed while it lives.
    expect((await signIns(browser)).map((row) => row.id)).toContain(id);
    await new Promise((resolveWait) => setTimeout(resolveWait, 2500));
    expect((await signIns(browser)).map((row) => row.id)).not.toContain(id);
    const ended = await end(browser, id);
    expect(ended.status).toBe(404);
    expect(ended.headers.get("x-error-code")).toBe("sign_in_not_found");
  });

  it("lists no revoked key", async () => {
    const browser = await signIn();
    const minted = await mintKey("revoked key");
    // The witness: the key is listed while it lives.
    expect((await signIns(browser)).map((row) => row.id)).toContain(minted.id);
    const revoked = await fetch(`${server.apiUrl}/keys/${minted.id}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${server.managementKey}` },
    });
    expect(revoked.status).toBe(200);
    expect((await signIns(browser)).map((row) => row.id)).not.toContain(
      minted.id,
    );
  });

  it("lists, renames and ends a sign-in through the local command", async () => {
    const browser = await signIn();
    const minted = await mintKey("local key");
    const listed = await local("GET", "/owner/sign-ins");
    expect(listed.status).toBe(200);
    await expectMatchesSchema("GET", "/owner/sign-ins", 200, listed.body);
    const rows = listed.body.data as SignIn[];
    expect(rows.map((row) => row.id)).toContain(minted.id);
    expect(rows.map((row) => row.id)).toContain(await idOf(browser));
    // The local command is no browser, so no sign-in sent its request.
    expect(rows.filter((row) => row.current)).toEqual([]);

    const renamed = await local("PATCH", `/owner/sign-ins/${minted.id}`, {
      name: "renamed locally",
    });
    expect(renamed.status).toBe(200);
    expect(renamed.body).toMatchObject({
      id: minted.id,
      name: "renamed locally",
    });

    const ended = await local("DELETE", `/owner/sign-ins/${minted.id}`);
    expect(ended.status).toBe(200);
    expect(ended.body).toEqual({ ok: true });
    expect(await itemsStatus(server, minted.key)).toBe(401);
  });
});

describe("renaming a sign-in", () => {
  it("gives an app the owner's own name, which the listing shows", async () => {
    const browser = await signIn();
    const signedIn = await approveApp(browser, "marfa");
    const id = (await signIns(browser)).find(
      (row) => row.kind === "app" && row.name === "marfa",
    )!.id;
    const response = await rename(browser, id, {
      name: "  Marfa app on the studio laptop  ",
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as SignIn;
    await expectMatchesSchema("PATCH", "/owner/sign-ins/{id}", 200, body);
    expect(body).toMatchObject({
      id,
      kind: "app",
      name: "Marfa app on the studio laptop",
      current: false,
    });
    expect((await signIns(browser)).find((row) => row.id === id)?.name).toBe(
      "Marfa app on the studio laptop",
    );
    // A name is not access: the app is still signed in.
    expect(await itemsStatus(server, signedIn.accessToken)).toBe(200);
  });

  it("gives a key a new label", async () => {
    const browser = await signIn();
    const minted = await mintKey("old label");
    const response = await rename(browser, minted.id, { name: "new label" });
    expect(response.status).toBe(200);
    const keys = await fetch(`${server.apiUrl}/keys`, {
      headers: { authorization: `Bearer ${server.managementKey}` },
    });
    const listed = (await keys.json()) as {
      data: { id: string; label: string }[];
    };
    expect(listed.data.find((key) => key.id === minted.id)?.label).toBe(
      "new label",
    );
  });

  it("refuses to rename a browser 400 validation_error", async () => {
    const browser = await signIn();
    const response = await rename(browser, await idOf(browser), {
      name: "my browser",
    });
    expect(response.status).toBe(400);
    expect(response.headers.get("x-error-code")).toBe("validation_error");
  });

  it("refuses an empty, overlong or missing name and another field 400", async () => {
    const browser = await signIn();
    const minted = await mintKey("kept label");
    for (const [body, code] of [
      [{ name: "   " }, "validation_error"],
      [{ name: "x".repeat(201) }, "validation_error"],
      [{ name: "ok", label: "no" }, "validation_error"],
      [{}, "missing_required_field"],
    ] as const) {
      const response = await rename(browser, minted.id, body);
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect(response.headers.get("x-error-code")).toBe(code);
    }
    // The witness: a name the door takes renames it.
    expect(
      (await rename(browser, minted.id, { name: "x".repeat(200) })).status,
    ).toBe(200);
  });

  it("answers 404 sign_in_not_found for an ended sign-in and an id no sign-in has", async () => {
    const browser = await signIn();
    const minted = await mintKey("ended before rename");
    expect((await end(browser, minted.id)).status).toBe(200);
    for (const id of [minted.id, "no-such-sign-in"]) {
      const response = await rename(browser, id, { name: "anything" });
      expect(response.status, id).toBe(404);
      expect(response.headers.get("x-error-code")).toBe("sign_in_not_found");
    }
  });

  it("refuses a browser that signed in more than five minutes ago 403, and renames nothing", async () => {
    const stale = await signIn();
    const minted = await mintKey("stale rename");
    arrange(await idOf(stale), { createdAt: Date.now() - 6 * MINUTE });
    const refused = await rename(stale, minted.id, { name: "renamed" });
    expect(refused.status).toBe(403);
    expect(refused.headers.get("x-error-code")).toBe("forbidden");
    expect(
      (await signIns(stale)).find((row) => row.id === minted.id)?.name,
    ).toBe("stale rename");
  });
});

describe("ending a sign-in", () => {
  it("ends that browser's session, whose next request is refused, and leaves the other signed in", async () => {
    const ended = await signIn();
    const kept = await signIn();
    const id = await idOf(ended);
    const response = await end(kept, id);
    expect(response.status).toBe(200);
    const body: unknown = await response.json();
    expect(body).toEqual({ ok: true });
    await expectMatchesSchema("DELETE", "/owner/sign-ins/{id}", 200, body);

    expect(await session(ended)).toBeNull();
    const refused = await list(ended);
    expect(refused.status).toBe(401);
    expect(await session(kept)).not.toBeNull();
    expect((await signIns(kept)).map((row) => row.id)).not.toContain(id);
  });

  it("answers 404 sign_in_not_found for a session already ended and an id no session has", async () => {
    const ended = await signIn();
    const kept = await signIn();
    const id = await idOf(ended);
    expect((await end(kept, id)).status).toBe(200);
    for (const unknown of [id, "no-such-session"]) {
      const again = await end(kept, unknown);
      expect(again.status, unknown).toBe(404);
      expect(again.headers.get("x-error-code")).toBe("sign_in_not_found");
    }
  });

  it("clears the cookie of the session that ends itself", async () => {
    const browser = await signIn();
    const response = await end(browser, await idOf(browser));
    expect(response.status).toBe(200);
    const name = browser.cookie.slice(0, browser.cookie.indexOf("="));
    expect(
      response.headers
        .getSetCookie()
        .some(
          (line) => line.startsWith(`${name}=;`) && /max-age=0/i.test(line),
        ),
    ).toBe(true);
    // The cookie is cleared, not also sent again for the session it ended.
    expect(cookieMaxAge(response, browser.cookie)).toBeUndefined();
    expect(await session(browser)).toBeNull();
  });

  it("refuses a browser that signed in more than five minutes ago 403, and ends nothing", async () => {
    const stale = await signIn();
    const target = await signIn();
    const staleId = await idOf(stale);
    const targetId = await idOf(target);
    arrange(staleId, { createdAt: Date.now() - 6 * MINUTE });
    const refused = await end(stale, targetId);
    expect(refused.status).toBe(403);
    expect(refused.headers.get("x-error-code")).toBe("forbidden");
    expect(await session(target)).not.toBeNull();
    // The witness: a browser that signed in just now ends it.
    expect((await end(target, targetId)).status).toBe(200);
  });

  it("is in the audit log when it answers", async () => {
    const ended = await signIn();
    const kept = await signIn();
    const id = await idOf(ended);
    expect((await end(kept, id)).status).toBe(200);
    const page = await new MarfaClient({
      baseUrl: server.apiUrl,
      apiKey: server.managementKey,
    }).listAudit({ action: "auth.session.delete", limit: 200 });
    expect(page.status, JSON.stringify(page.error)).toBe(200);
    expect(page.data.data.map((row) => row.resource_id)).toContain(id);
  });
});

describe("ending an app or a key", () => {
  it("ends an app at once: its next request is refused and its refresh token is dead, and nothing else is", async () => {
    const browser = await signIn();
    const ended = await approveApp(browser, "app to end");
    const kept = await approveApp(browser, "app to keep");
    const key = await mintKey("key beside the ended app");
    const id = (await signIns(browser)).find(
      (row) => row.kind === "app" && row.name === "app to end",
    )!.id;
    // The witness: the app's access and refresh both work before it ends.
    expect(await itemsStatus(server, ended.accessToken)).toBe(200);

    const response = await end(browser, id);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });

    expect(await itemsStatus(server, ended.accessToken)).toBe(401);
    const renewed = await refresh(ended);
    expect(renewed.status).toBe(400);
    expect(renewed.error).toBe("invalid_grant");
    expect((await signIns(browser)).map((row) => row.id)).not.toContain(id);

    expect(await itemsStatus(server, kept.accessToken)).toBe(200);
    const keptRenewed = await refresh(kept);
    expect(keptRenewed.status).toBe(200);
    expect(await itemsStatus(server, key.key)).toBe(200);
    expect(await session(browser)).not.toBeNull();
  });

  it("ends a key at once, and leaves every other sign-in", async () => {
    const browser = await signIn();
    const ended = await mintKey("key to end");
    const kept = await mintKey("key to keep");
    const app = await approveApp(browser, "app beside the ended key");
    expect(await itemsStatus(server, ended.key)).toBe(200);
    expect((await end(browser, ended.id)).status).toBe(200);
    expect(await itemsStatus(server, ended.key)).toBe(401);
    expect(await itemsStatus(server, kept.key)).toBe(200);
    expect(await itemsStatus(server, app.accessToken)).toBe(200);
    expect(await session(browser)).not.toBeNull();
  });

  it("answers 404 sign_in_not_found to the second end of an app and of a key", async () => {
    const browser = await signIn();
    await approveApp(browser, "app ended twice");
    const minted = await mintKey("key ended twice");
    const appId = (await signIns(browser)).find(
      (row) => row.kind === "app" && row.name === "app ended twice",
    )!.id;
    for (const id of [appId, minted.id]) {
      expect((await end(browser, id)).status, id).toBe(200);
      const again = await end(browser, id);
      expect(again.status, id).toBe(404);
      expect(again.headers.get("x-error-code")).toBe("sign_in_not_found");
    }
  });

  it("refuses a browser that signed in more than five minutes ago 403, and ends no app or key", async () => {
    const stale = await signIn();
    const signedIn = await approveApp(stale, "app a stale browser asks about");
    const minted = await mintKey("key a stale browser asks about");
    const appId = (await signIns(stale)).find(
      (row) =>
        row.kind === "app" && row.name === "app a stale browser asks about",
    )!.id;
    arrange(await idOf(stale), { createdAt: Date.now() - 6 * MINUTE });
    for (const id of [appId, minted.id]) {
      const refused = await end(stale, id);
      expect(refused.status, id).toBe(403);
      expect(refused.headers.get("x-error-code")).toBe("forbidden");
    }
    expect(await itemsStatus(server, signedIn.accessToken)).toBe(200);
    expect(await itemsStatus(server, minted.key)).toBe(200);
  });

  it("leaves every version the app and the key wrote as it was", async () => {
    const browser = await signIn();
    const signedIn = await approveApp(browser, "app that wrote");
    const minted = await mintKey("key that wrote");
    const byApp = await writeNote(signedIn.accessToken);
    const byKey = await writeNote(minted.key);
    const before = [await versionsOf(byApp), await versionsOf(byKey)];
    // The witness: each wrote a version there is to keep.
    for (const page of before)
      expect((page as { data: unknown[] }).data.length).toBeGreaterThan(0);
    const appId = (await signIns(browser)).find(
      (row) => row.kind === "app" && row.name === "app that wrote",
    )!.id;
    expect((await end(browser, appId)).status).toBe(200);
    expect((await end(browser, minted.id)).status).toBe(200);
    expect([await versionsOf(byApp), await versionsOf(byKey)]).toEqual(before);
  });

  it("is in the audit log when it ends an app or a key", async () => {
    const browser = await signIn();
    const signedIn = await approveApp(browser, "app the audit names");
    const minted = await mintKey("key the audit names");
    const appId = (await signIns(browser)).find(
      (row) => row.kind === "app" && row.name === "app the audit names",
    )!.id;
    expect((await end(browser, appId)).status).toBe(200);
    expect((await end(browser, minted.id)).status).toBe(200);
    const audit = new MarfaClient({
      baseUrl: server.apiUrl,
      apiKey: server.managementKey,
    });
    const grants = await audit.listAudit({
      action: "auth.grant.revoked",
      limit: 200,
    });
    expect(grants.status, JSON.stringify(grants.error)).toBe(200);
    expect(grants.data.data.map((row) => row.resource_id)).toContain(
      signedIn.clientId,
    );
    const keys = await audit.listAudit({ action: "key.revoke", limit: 200 });
    expect(keys.status, JSON.stringify(keys.error)).toBe(200);
    expect(keys.data.data.map((row) => row.resource_id)).toContain(minted.id);
  });
});

describe("a browser session's idle week", () => {
  it("records a request as the last use and moves the expiry to a week and a minute after it, where a renewal a day old would not", async () => {
    const browser = await signIn();
    const id = await idOf(browser);
    // As the sign-in library would leave a session it renewed 23 hours ago:
    // its own refresh waits a day, so this request would leave it alone.
    const renewedAt = Date.now() - 23 * HOUR;
    arrange(id, {
      createdAt: renewedAt,
      updatedAt: renewedAt,
      expiresAt: renewedAt + WEEK,
    });
    const before = Math.floor(Date.now() / 1000);
    const response = await list(browser);
    expect(response.status).toBe(200);
    const after = Math.ceil(Date.now() / 1000);
    const row = stored(id);
    expect(row.updated_at).toBeGreaterThanOrEqual(before);
    expect(row.updated_at).toBeLessThanOrEqual(after);
    expect(row.expires_at - row.updated_at).toBe(7 * 24 * 3600 + 60);
    const listed = (await signIns(browser)).find((r) => r.id === id)!;
    expect(Date.parse(listed.last_used_at) / 1000).toBe(row.updated_at);
    expect(Date.parse(listed.expires_at) / 1000).toBe(row.expires_at);
  });

  it("gives a new session a week and a minute, and its cookie 400 days", async () => {
    const browser = await signIn();
    expect(browser.maxAge).toBe(COOKIE_SECONDS);
    const own = (await signIns(browser)).find((row) => row.current)!;
    expect(
      (Date.parse(own.expires_at) - Date.parse(own.created_at)) / 1000,
    ).toBe(7 * 24 * 3600 + 60);
  });

  it("sends the cookie again for 400 days when it records a use, in a refusal too", async () => {
    const browser = await signIn();
    const id = await idOf(browser);
    arrange(id, { updatedAt: Date.now() - 2 * MINUTE });
    const missing = await fetch(
      `${server.apiUrl}/items/019537a0-7b80-7000-8000-000000000000`,
      { headers: { cookie: browser.cookie } },
    );
    expect(missing.status).toBe(404);
    expect(cookieMaxAge(missing, browser.cookie)).toBe(COOKIE_SECONDS);
    expect(stored(id).updated_at).toBeGreaterThan(
      Math.floor((Date.now() - MINUTE) / 1000),
    );
    arrange(id, { updatedAt: Date.now() - 2 * MINUTE });
    const listed = await list(browser);
    expect(listed.status).toBe(200);
    expect(cookieMaxAge(listed, browser.cookie)).toBe(COOKIE_SECONDS);
  });

  it("admits a request whose use cannot be recorded, and records the next once it can", async () => {
    const browser = await signIn();
    const id = await idOf(browser);
    const recorded = Date.now() - 2 * MINUTE;
    arrange(id, { updatedAt: recorded });
    // The write lock held from outside: the use waits for it, then gives up.
    const lock = await HeldLock.take(server.sqlitePath);
    try {
      const admitted = await list(browser);
      expect(admitted.status).toBe(200);
      expect(cookieMaxAge(admitted, browser.cookie)).toBeUndefined();
      expect(stored(id).updated_at).toBe(Math.floor(recorded / 1000));
    } finally {
      await lock.release();
    }
    const next = await list(browser);
    expect(next.status).toBe(200);
    expect(cookieMaxAge(next, browser.cookie)).toBe(COOKIE_SECONDS);
    expect(stored(id).updated_at).toBeGreaterThan(Math.floor(recorded / 1000));
  }, 30_000);

  it("keeps a sign-in not to be remembered on a cookie with no Max-Age, and its idle week on the server", async () => {
    addresses += 1;
    const response = await fetch(`${server.apiUrl}/auth/sign-in/email`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin,
        [CLIENT_HEADER]: `198.51.100.${String(addresses)}`,
      },
      body: JSON.stringify({ ...OWNER, rememberMe: false }),
    });
    expect(response.status).toBe(200);
    const line = response.headers
      .getSetCookie()
      .find((value) => /session_token=/.test(value));
    expect(line, "sign-in set no session cookie").toBeDefined();
    expect(line).not.toMatch(/max-age/i);
    const browser: Browser = {
      cookie: response.headers
        .getSetCookie()
        .map((value) => value.split(";")[0])
        .join("; "),
      address: "",
      userAgent: "",
      maxAge: Number.NaN,
    };
    const session = line!.split(";")[0]!;
    const id = await idOf(browser);
    const created = (await signIns(browser)).find((row) => row.id === id)!;
    expect(
      (Date.parse(created.expires_at) - Date.parse(created.created_at)) / 1000,
    ).toBe(7 * 24 * 3600 + 60);

    arrange(id, { updatedAt: Date.now() - 2 * MINUTE });
    const before = Math.floor(Date.now() / 1000);
    const used = await list(browser);
    expect(used.status).toBe(200);
    expect(cookieMaxAge(used, session)).toBeUndefined();
    expect(
      used.headers.getSetCookie().some((value) => /session_token=/.test(value)),
    ).toBe(false);
    const row = stored(id);
    expect(row.updated_at).toBeGreaterThanOrEqual(before);
    expect(row.expires_at - row.updated_at).toBe(7 * 24 * 3600 + 60);
  });

  it("does not record a use within a minute of the last one", async () => {
    const browser = await signIn();
    const id = await idOf(browser);
    const recorded = Date.now() - 30 * SECOND;
    arrange(id, { updatedAt: recorded, expiresAt: recorded + WEEK + MINUTE });
    const response = await list(browser);
    expect(response.status).toBe(200);
    expect(stored(id).updated_at).toBe(Math.floor(recorded / 1000));
    expect(response.headers.getSetCookie()).toEqual([]);
  });

  it("admits a session last used just under a week ago", async () => {
    const browser = await signIn();
    const id = await idOf(browser);
    const used = Date.now() - WEEK + 2 * MINUTE;
    arrange(id, { updatedAt: used, expiresAt: used + WEEK + MINUTE });
    expect(await session(browser)).not.toBeNull();
    expect((await list(browser)).status).toBe(200);
  });

  it("refuses a session unused for a week and a minute", async () => {
    const browser = await signIn();
    const kept = await signIn();
    const id = await idOf(browser);
    const used = Date.now() - WEEK - MINUTE - 5 * SECOND;
    arrange(id, { updatedAt: used, expiresAt: used + WEEK + MINUTE });
    expect(await session(browser)).toBeNull();
    expect((await list(browser)).status).toBe(401);
    expect((await signIns(kept)).map((row) => row.id)).not.toContain(id);
  });

  it("through going unused for a week leaves every app connected", async () => {
    const browser = await signIn();
    const id = await idOf(browser);
    const scope = "core.note:read offline_access";
    const app = await registerApp(server, scope);
    const tokens = await connect(server, origin, browser.cookie, app, scope);
    expect(tokens.refresh_token).toBeTruthy();
    const used = Date.now() - WEEK - 2 * MINUTE;
    arrange(id, { updatedAt: used, expiresAt: used + WEEK + MINUTE });
    expect(await session(browser)).toBeNull();

    expect(await itemsStatus(server, tokens.access_token!)).toBe(200);
    const renewed = await token(
      server,
      {
        grant_type: "refresh_token",
        refresh_token: tokens.refresh_token!,
        client_id: app.clientId,
      },
      app,
    );
    expect(renewed.status).toBe(200);
    expect(await itemsStatus(server, renewed.body.access_token!)).toBe(200);
  });
});

describe("a restart", () => {
  it("keeps an ended and an expired session, an ended app and an ended key refused, and a live session's last use and expiry", async () => {
    const live = await signIn();
    const ended = await signIn();
    const expired = await signIn();
    const liveId = await idOf(live);
    const endedId = await idOf(ended);
    const expiredId = await idOf(expired);
    expect((await end(live, endedId)).status).toBe(200);
    const used = Date.now() - WEEK - 2 * MINUTE;
    arrange(expiredId, { updatedAt: used, expiresAt: used + WEEK + MINUTE });
    const recorded = Date.now() - 3 * HOUR;
    arrange(liveId, {
      updatedAt: recorded,
      expiresAt: recorded + WEEK + MINUTE,
    });
    const before = stored(liveId);
    const endedApp = await approveApp(live, "app ended before a restart");
    const endedKey = await mintKey("key ended before a restart");
    const appId = (await signIns(live)).find(
      (row) => row.kind === "app" && row.name === "app ended before a restart",
    )!.id;
    expect((await end(live, appId)).status).toBe(200);
    expect((await end(live, endedKey.id)).status).toBe(200);
    // That was the live session's own use, so its times are read again.
    arrange(liveId, {
      updatedAt: recorded,
      expiresAt: recorded + WEEK + MINUTE,
    });

    await server.restart();

    expect(await session(ended)).toBeNull();
    expect(await session(expired)).toBeNull();
    expect(await itemsStatus(server, endedApp.accessToken)).toBe(401);
    expect((await refresh(endedApp)).status).toBe(400);
    expect(await itemsStatus(server, endedKey.key)).toBe(401);
    expect(stored(liveId)).toEqual(before);
    const listed = (await signIns(live)).find((row) => row.id === liveId)!;
    // That listing was itself a use, recorded after the restart.
    expect(Date.parse(listed.last_used_at)).toBeGreaterThan(recorded);
    expect(
      (Date.parse(listed.expires_at) - Date.parse(listed.last_used_at)) / 1000,
    ).toBe(7 * 24 * 3600 + 60);
  });
});
