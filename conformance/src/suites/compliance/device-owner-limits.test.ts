import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { withInstanceDatabase } from "../../utils/instance-database.js";
import { MINUTE_MS, movedClock } from "../../utils/moved-clock.js";
import { issuerOrigin } from "../../utils/signed-in.js";
import { TEST_OWNER } from "../../utils/target.js";

let server: FreshServer;
let clock: ReturnType<typeof movedClock>;
let origin: string;
const CLIENT_HEADER = "x-conformance-client";

beforeEach(async () => {
  server = await bootFreshServer("device-owner-limits", {
    TRUSTED_PROXY_HEADER: CLIENT_HEADER,
  });
  clock = movedClock(server);
  origin = await issuerOrigin(server);
}, 2 * FRESH_SERVER_TIMEOUT_MS);

afterEach(async () => {
  await server?.stop();
}, 2 * FRESH_SERVER_TIMEOUT_MS);

function codeFor(n: number): string {
  return `ZZ${String(100000 + n)}`;
}

function post(
  path: string,
  form: Record<string, string>,
  cookie?: string,
  address = "192.0.2.1",
  authorization?: string,
): Promise<Response> {
  return fetch(`${server.apiUrl}${path}`, {
    method: "POST",
    redirect: "manual",
    headers: {
      origin,
      "content-type": "application/x-www-form-urlencoded",
      [CLIENT_HEADER]: address,
      ...(cookie ? { cookie } : {}),
      ...(authorization ? { authorization } : {}),
    },
    body: new URLSearchParams(form),
  });
}

function enter(
  code: string,
  cookie?: string,
  address?: string,
  authorization?: string,
) {
  return post(
    "/auth/device",
    { user_code: code },
    cookie,
    address,
    authorization,
  );
}

function screen(code: string, cookie: string, address = "192.0.2.1") {
  return fetch(`${server.apiUrl}/auth/device/consent?user_code=${code}`, {
    headers: { cookie, [CLIENT_HEADER]: address },
    redirect: "manual",
  });
}

async function signIn(): Promise<string> {
  const response = await fetch(`${server.apiUrl}/auth/sign-in/email`, {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify(TEST_OWNER),
  });
  expect(response.status).toBe(200);
  const cookie = /(?:^|,\s*)([\w.-]*session_token=[^;]+)/.exec(
    response.headers.get("set-cookie") ?? "",
  )?.[1];
  if (!cookie) throw new Error("Sign-in set no session cookie");
  return cookie;
}

async function location(response: Response): Promise<string> {
  expect(response.status).toBe(302);
  await response.body?.cancel();
  return response.headers.get("location") ?? "";
}

async function sessionId(cookie: string): Promise<string> {
  const response = await fetch(`${server.apiUrl}/auth/get-session`, {
    headers: { cookie },
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as { session: { id: string } }).session.id;
}

describe("the owner device lookup lane", () => {
  it("admits owner entry and consent and exchanges the grant after anonymous address and aggregate exhaustion", async () => {
    const registration = await fetch(`${server.apiUrl}/auth/oauth2/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "Device limit fixture",
        application_type: "native",
        grant_types: ["urn:ietf:params:oauth:grant-type:device_code"],
        response_types: [],
        token_endpoint_auth_method: "none",
      }),
    });
    expect(registration.status).toBe(201);
    const { client_id } = (await registration.json()) as { client_id: string };
    const issued = await post("/auth/device/code", {
      client_id,
      scope: "core.note:read",
    });
    expect(issued.status).toBe(200);
    const { user_code, device_code } = (await issued.json()) as {
      user_code: string;
      device_code: string;
    };
    for (let i = 0; i < 100; i++) {
      expect(
        await location(
          await enter(
            codeFor(i),
            undefined,
            i < 10 ? "2001:db8:5:6::1" : `198.51.100.${String(i)}`,
          ),
        ),
      ).toContain("error=invalid_code");
    }
    expect(
      await location(await enter(user_code, undefined, "2001:db8:5:6::abcd")),
    ).toContain("error=too_many_attempts");
    expect(
      await location(await enter(user_code, undefined, "192.0.2.200")),
    ).toContain("error=too_many_attempts");
    const cookie = server.ownerCookie;
    expect(
      await location(await enter(user_code, cookie, "2001:db8:5:6::abcd")),
    ).toContain("/auth/device/consent?");
    const consent = await screen(user_code, cookie, "2001:db8:5:6::abcd");
    expect(consent.status).toBe(200);
    await consent.body?.cancel();
    const approved = await post(
      "/auth/device/consent",
      {
        user_code,
        decision: "approve",
        scopes: "core.note:read",
      },
      cookie,
      "2001:db8:5:6::abcd",
    );
    expect(approved.status).toBe(200);
    await approved.body?.cancel();
    const exchanged = await post("/auth/oauth2/token", {
      client_id,
      device_code,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    });
    expect(exchanged.status).toBe(200);
    const token = (await exchanged.json()) as {
      access_token: string;
      scope: string;
    };
    expect(token.scope).toBe("core.note:read");
    const read = await fetch(`${server.apiUrl}/items?type=core.note`, {
      headers: { authorization: `Bearer ${token.access_token}` },
    });
    expect(read.status).toBe(200);
    await read.body?.cancel();
    expect(
      await location(
        await enter(
          codeFor(999),
          cookie,
          "2001:db8:5:6::abcd",
          `Bearer ${server.managementKey}`,
        ),
      ),
    ).toContain("error=too_many_attempts");
    expect(
      await location(
        await enter(
          codeFor(998),
          cookie,
          "2001:db8:5:6::abcd",
          `Bearer ${token.access_token}`,
        ),
      ),
    ).toContain("error=too_many_attempts");
  });

  it("shares ten lookups across owner sessions, addresses and routes, and keeps the budget after restart", async () => {
    const first = server.ownerCookie;
    const second = await signIn();
    expect(await sessionId(first)).not.toBe(await sessionId(second));
    for (let i = 0; i < 8; i++) {
      const cookie = i % 2 ? first : second;
      const address = `192.0.2.${String(i + 1)}`;
      const response =
        i % 3 === 0
          ? await enter(codeFor(i), cookie, address)
          : i % 3 === 1
            ? await screen(codeFor(i), cookie, address)
            : await post(
                "/auth/device/consent",
                { user_code: codeFor(i), decision: "approve" },
                cookie,
                address,
              );
      expect(response.status).toBe(i % 3 === 2 ? 404 : 302);
      expect(response.headers.get("location") ?? "").not.toContain(
        "too_many_attempts",
      );
      await response.body?.cancel();
    }
    // Concurrent distinct addresses and sessions cannot each see attempts left.
    const burst = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        enter(
          codeFor(20 + i),
          i % 2 ? first : second,
          `198.51.100.${String(i + 1)}`,
        ),
      ),
    );
    const redirects = await Promise.all(burst.map(location));
    expect(
      redirects.filter((value) => value.includes("invalid_code")),
    ).toHaveLength(2);
    expect(
      redirects.filter((value) => value.includes("too_many_attempts")),
    ).toHaveLength(6);
    await server.restart();
    origin = await issuerOrigin(server);
    expect(
      await location(await enter(codeFor(100), second, "203.0.113.1")),
    ).toContain("error=too_many_attempts");
    expect(
      await location(await screen(codeFor(101), second, "203.0.113.2")),
    ).toContain("error=too_many_attempts");
    expect(
      await location(
        await post(
          "/auth/device/consent",
          { user_code: codeFor(102), decision: "approve" },
          first,
          "203.0.113.3",
        ),
      ),
    ).toContain("error=too_many_attempts");
    expect(
      await location(await enter(codeFor(103), undefined, "203.0.113.1")),
    ).toContain("error=invalid_code");
    await clock.advance(16 * MINUTE_MS);
    expect(await location(await enter(codeFor(104), second))).toContain(
      "error=invalid_code",
    );
  });

  it.each(["forged", "expired", "revoked"] as const)(
    "keeps a %s cookie in the anonymous lane",
    async (state) => {
      let cookie = server.ownerCookie;
      const id = await sessionId(cookie);
      expect(await location(await enter(codeFor(900), cookie))).toContain(
        "error=invalid_code",
      );
      if (state === "forged")
        cookie = cookie.slice(0, -1) + (cookie.endsWith("A") ? "B" : "A");
      else if (state === "expired")
        withInstanceDatabase(server.sqlitePath, (db) => {
          db.prepare("UPDATE auth_session SET expires_at = ? WHERE id = ?").run(
            Math.floor(Date.now() / 1000) - 60,
            id,
          );
        });
      else {
        const ended = await fetch(`${server.apiUrl}/owner/sign-ins/${id}`, {
          method: "DELETE",
          headers: { cookie, origin },
        });
        expect(ended.status).toBe(200);
        await ended.body?.cancel();
      }
      for (let i = 0; i < 10; i++)
        expect(
          await location(await enter(codeFor(i), undefined, "203.0.113.1")),
        ).toContain("error=invalid_code");
      expect(
        await location(await enter(codeFor(100), cookie, "203.0.113.1")),
      ).toContain("error=too_many_attempts");
      const consent = await screen(codeFor(101), cookie);
      expect(consent.status).toBe(302);
      expect(consent.headers.get("location")).toContain("/auth/sign-in?");
    },
  );

  it("holds the owner lane aggregate to one hundred and resets its fifteen-minute window", async () => {
    // One owner reaches its own ten-attempt cap before the aggregate. Arrange
    // only that otherwise unreachable aggregate state, then assert over HTTP.
    withInstanceDatabase(server.sqlitePath, (db) => {
      db.prepare(
        "INSERT INTO rate_limit_windows (family, window_key, count, expires_at) VALUES (?, ?, ?, ?)",
      ).run(
        "device-user-code-owner-instance",
        "all",
        99,
        new Date(clock.now() + 15 * MINUTE_MS).toISOString(),
      );
    });
    expect(
      await location(await enter(codeFor(1), server.ownerCookie)),
    ).toContain("error=invalid_code");
    expect(
      await location(await enter(codeFor(2), server.ownerCookie)),
    ).toContain("error=too_many_attempts");
    expect(await location(await enter(codeFor(3)))).toContain(
      "error=invalid_code",
    );
    await server.restart();
    origin = await issuerOrigin(server);
    expect(
      await location(await enter(codeFor(4), server.ownerCookie)),
    ).toContain("error=too_many_attempts");
    await clock.advance(16 * MINUTE_MS);
    expect(
      await location(await enter(codeFor(5), server.ownerCookie)),
    ).toContain("error=invalid_code");
  });
});
