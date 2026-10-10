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
import {
  connect,
  issuerOrigin,
  itemsStatus,
  registerApp,
  token,
} from "../../utils/signed-in.js";
import { expectMatchesSchema } from "../../utils/openapi.js";

/**
 * The owner's browser sessions: listed and ended at `/owner/sign-ins`, and
 * ended by a week unused. A session's age is arranged in the server's own
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
  current: boolean;
  created_at: string;
  last_used_at: string;
  expires_at: string;
  ip_address: string | null;
  user_agent: string | null;
}

async function signIn(): Promise<Browser> {
  addresses += 1;
  const address = `198.51.100.${String(addresses)}`;
  const userAgent = `owner-sign-ins browser ${String(addresses)}`;
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

  it("refuses a key, an app's token and the local command 403, and no credential 401", async () => {
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
        ["DELETE", `/owner/sign-ins/${id}`],
      ] as const) {
        const response = await fetch(`${server.apiUrl}${path}`, {
          method,
          // The owner's cookie beside a bearer adds nothing to it.
          headers: {
            authorization: `Bearer ${bearer}`,
            cookie: browser.cookie,
            origin,
          },
        });
        expect(response.status, `${method} ${path}`).toBe(403);
        expect(response.headers.get("x-error-code")).toBe("forbidden");
      }
    }
    for (const [method, path] of [
      ["GET", "/owner/sign-ins"],
      ["DELETE", `/owner/sign-ins/${id}`],
    ] as const) {
      const local = await controlRequest(server.controlSocket, path, {
        method,
      });
      expect(local.status, `local ${method} ${path}`).toBe(403);
      const none = await fetch(`${server.apiUrl}${path}`, { method });
      expect(none.status, `no credential ${method} ${path}`).toBe(401);
    }
    // Nothing above ended the session.
    expect(await session(browser)).not.toBeNull();
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
    withInstanceDatabase(server.sqlitePath, (db) =>
      db.exec(
        "CREATE TRIGGER refuse_session_use BEFORE UPDATE ON auth_session BEGIN SELECT RAISE(ABORT, 'session use refused'); END",
      ),
    );
    try {
      const admitted = await list(browser);
      expect(admitted.status).toBe(200);
      expect(cookieMaxAge(admitted, browser.cookie)).toBeUndefined();
      expect(stored(id).updated_at).toBe(Math.floor(recorded / 1000));
    } finally {
      withInstanceDatabase(server.sqlitePath, (db) =>
        db.exec("DROP TRIGGER refuse_session_use"),
      );
    }
    const next = await list(browser);
    expect(next.status).toBe(200);
    expect(cookieMaxAge(next, browser.cookie)).toBe(COOKIE_SECONDS);
    expect(stored(id).updated_at).toBeGreaterThan(Math.floor(recorded / 1000));
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
  it("keeps an ended and an expired session refused, and a live session's last use and expiry", async () => {
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

    await server.restart();

    expect(await session(ended)).toBeNull();
    expect(await session(expired)).toBeNull();
    expect(stored(liveId)).toEqual(before);
    const listed = (await signIns(live)).find((row) => row.id === liveId)!;
    // That listing was itself a use, recorded after the restart.
    expect(Date.parse(listed.last_used_at)).toBeGreaterThan(recorded);
    expect(
      (Date.parse(listed.expires_at) - Date.parse(listed.last_used_at)) / 1000,
    ).toBe(7 * 24 * 3600 + 60);
  });
});
