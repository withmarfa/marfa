import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { issuerOrigin } from "../../utils/signed-in.js";
import { testAuthenticator } from "../../utils/passkey-authenticator.js";
import { TEST_OWNER } from "../../utils/target.js";

/**
 * Confirming a stale sign-in in place: `POST /auth/confirm` replaces the
 * owner's browser session with a new one, created now, when the password or a
 * passkey shows the owner is there. A session's age is the server's clock
 * moved forward, and the clock only goes forward. Each case that needs a
 * sign-in from an address of its own takes the next one, so the per-address
 * sign-in limit never holds another case back.
 */
let server: FreshServer;
let origin: string;

const CLIENT_HEADER = "x-conformance-client";
const MINUTE = 60 * 1000;
let addresses = 0;

beforeAll(async () => {
  server = await bootFreshServer("confirm-sign-in", {
    TRUSTED_PROXY_HEADER: CLIENT_HEADER,
  });
  origin = await issuerOrigin(server);
}, 2 * FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  await server.stop();
}, 2 * FRESH_SERVER_TIMEOUT_MS);

function nextAddress(): string {
  addresses += 1;
  return `198.51.100.${String(addresses)}`;
}

const sessionCookie = (response: Response): string | undefined =>
  /(?:^|,\s*)([\w.-]*session_token=[^;]+)/.exec(
    response.headers.get("set-cookie") ?? "",
  )?.[1];

/** Signs in with the owner's password from `address`. */
async function signIn(address = nextAddress()): Promise<string> {
  const response = await fetch(`${server.apiUrl}/auth/sign-in/email`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin,
      [CLIENT_HEADER]: address,
    },
    body: JSON.stringify(TEST_OWNER),
  });
  expect(response.status).toBe(200);
  const cookie = sessionCookie(response);
  expect(cookie, "sign-in set no session cookie").toBeTruthy();
  return cookie!;
}

function confirm(
  body: unknown,
  cookie: string | undefined,
  address = nextAddress(),
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${server.apiUrl}/auth/confirm`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin,
      [CLIENT_HEADER]: address,
      ...(cookie ? { cookie } : {}),
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

function get(path: string, cookie: string): Promise<Response> {
  return fetch(`${server.apiUrl}${path}`, {
    headers: { cookie, origin, [CLIENT_HEADER]: nextAddress() },
  });
}

/** A change that needs a sign-in from the last five minutes. */
function changeName(cookie: string): Promise<Response> {
  return fetch(`${server.apiUrl}/owner`, {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
      cookie,
      origin,
      [CLIENT_HEADER]: nextAddress(),
    },
    body: JSON.stringify({ name: "Confirmed Owner" }),
  });
}

/**
 * A refusal may still renew the session that sent the request, as any use of
 * a session does once a minute has passed, so it may send that session's own
 * cookie again. What it never does is send another session.
 */
function sendsNoOtherSession(response: Response, cookie: string): boolean {
  const sent = sessionCookie(response);
  return sent === undefined || sent === cookie;
}

async function code(response: Response): Promise<string> {
  const body = (await response.json()) as { error: { code: string } };
  return body.error.code;
}

describe("confirming with the password", () => {
  it("replaces a stale session with a new one, so the change that was refused runs", async () => {
    const stale = await signIn();
    await server.advanceClock(6 * MINUTE);
    const refused = await changeName(stale);
    expect(refused.status).toBe(403);
    const refusal = (await refused.json()) as {
      error: { code: string; message: string };
    };
    expect(refusal.error.code).toBe("forbidden");
    expect(refusal.error.message).toBe(
      "Sign in again to perform this operation",
    );

    const confirmed = await confirm({ password: TEST_OWNER.password }, stale);
    expect(confirmed.status).toBe(200);
    expect(await confirmed.json()).toEqual({ ok: true });
    const renewed = sessionCookie(confirmed);
    expect(renewed).toBeTruthy();
    expect(renewed).not.toBe(stale);

    expect((await changeName(renewed!)).status).toBe(200);
    // The old session ended in the same step.
    expect((await get("/owner/sign-ins", stale)).status).toBe(401);
    expect((await get("/owner/sign-ins", renewed!)).status).toBe(200);
  });

  it("dates the new session from the confirmation, so it goes stale five minutes after it", async () => {
    const stale = await signIn();
    await server.advanceClock(6 * MINUTE);
    const renewed = sessionCookie(
      await confirm({ password: TEST_OWNER.password }, stale),
    )!;
    await server.advanceClock(4 * MINUTE);
    expect((await changeName(renewed)).status).toBe(200);
    await server.advanceClock(2 * MINUTE);
    const again = await changeName(renewed);
    expect(again.status).toBe(403);
    expect(await code(again)).toBe("forbidden");
  });

  it("answers a wrong password 401 and leaves the session as it was", async () => {
    const stale = await signIn();
    await server.advanceClock(6 * MINUTE);
    const wrong = await confirm({ password: "not the password" }, stale);
    expect(wrong.status).toBe(401);
    expect(await code(wrong)).toBe("unauthorized");
    expect(sendsNoOtherSession(wrong, stale)).toBe(true);
    // The session lives, is still stale, and a right password renews it.
    expect((await get("/owner/sign-ins", stale)).status).toBe(200);
    expect((await changeName(stale)).status).toBe(403);
    expect(
      (await confirm({ password: TEST_OWNER.password }, stale)).status,
    ).toBe(200);
  });

  it("counts a confirmation in the lane a password sign-in counts in, and answers the lockout with the wait", async () => {
    const stale = await signIn();
    await server.advanceClock(6 * MINUTE);
    const address = nextAddress();
    // Ten attempts from one address spend the window, whichever door they came by.
    for (let attempt = 0; attempt < 5; attempt++) {
      expect(
        (await confirm({ password: "wrong one" }, stale, address)).status,
      ).toBe(401);
      const direct = await fetch(`${server.apiUrl}/auth/sign-in/email`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin,
          [CLIENT_HEADER]: address,
        },
        body: JSON.stringify({ ...TEST_OWNER, password: "wrong two" }),
      });
      expect(direct.status).toBe(401);
    }
    const askedAt = Date.now();
    const locked = await confirm(
      { password: TEST_OWNER.password },
      stale,
      address,
    );
    expect(locked.status).toBe(429);
    expect(await code(locked)).toBe("rate_limited");
    const wait = Number(locked.headers.get("retry-after"));
    expect(wait).toBeGreaterThan(0);

    // The sign-in page is held by the same lane, with the same wait.
    const form = await fetch(`${server.apiUrl}/auth/sign-in`, {
      method: "POST",
      redirect: "manual",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin,
        [CLIENT_HEADER]: address,
      },
      body: new URLSearchParams({
        email: TEST_OWNER.email,
        password: TEST_OWNER.password,
      }),
    });
    expect(form.status).toBe(302);
    expect(form.headers.get("location")).toContain("too_many_attempts");
    // The wait is the whole seconds left in the same lockout, rounded up, so
    // it falls as the clock runs: the page's answer comes later than the
    // confirmation's and may be shorter by the whole seconds in between.
    const elapsed = Math.ceil((Date.now() - askedAt) / 1000);
    const formWait = Number(
      new URL(form.headers.get("location") ?? "", origin).searchParams.get(
        "retry_after",
      ),
    );
    expect(Number.isInteger(formWait)).toBe(true);
    expect(formWait).toBeLessThanOrEqual(wait);
    expect(formWait).toBeGreaterThanOrEqual(wait - elapsed);

    // The refused confirmation left the session as it was: live, and still stale.
    expect(sendsNoOtherSession(locked, stale)).toBe(true);
    expect((await get("/owner/sign-ins", stale)).status).toBe(200);
    expect((await changeName(stale)).status).toBe(403);
    // Another address is not held by it.
    expect(
      (await confirm({ password: TEST_OWNER.password }, stale)).status,
    ).toBe(200);
  });
});

describe("a confirmation names no account", () => {
  it("refuses a body that names an email, both proofs, or neither, and replaces nothing", async () => {
    const stale = await signIn();
    // A minute or more since the session was last used, so its use is recorded.
    await server.advanceClock(6 * MINUTE);
    for (const body of [
      { email: "someone@example.test", password: TEST_OWNER.password },
      { password: TEST_OWNER.password, passkey: {} },
      {},
    ]) {
      const refused = await confirm(body, stale);
      expect(refused.status, JSON.stringify(Object.keys(body))).toBe(400);
      expect(sendsNoOtherSession(refused, stale)).toBe(true);
    }
    expect((await get("/owner/sign-ins", stale)).status).toBe(200);
    expect((await changeName(stale)).status).toBe(403);
  });

  it("refuses a passkey that is not registered to the signed-in owner, and leaves the session as it was", async () => {
    const owner = await signIn();
    const rpID = new URL(origin).hostname;
    const registered = testAuthenticator();
    const stranger = testAuthenticator();
    const options = await get("/auth/passkey/generate-register-options", owner);
    expect(options.status).toBe(200);
    const challenge = ((await options.json()) as { challenge: string })
      .challenge;
    const added = await fetch(
      `${server.apiUrl}/auth/passkey/verify-registration`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin,
          cookie: [owner, cookiesOf(options)].join("; "),
          [CLIENT_HEADER]: nextAddress(),
        },
        body: JSON.stringify({
          name: "Confirm key",
          response: registered.registration(challenge, origin, rpID),
        }),
      },
    );
    expect(added.status).toBe(200);

    await server.advanceClock(6 * MINUTE);
    const asked = await get(
      "/auth/passkey/generate-authenticate-options",
      owner,
    );
    const heard = ((await asked.json()) as { challenge: string }).challenge;
    const cookie = [owner, cookiesOf(asked)].join("; ");
    const refused = await confirm(
      { passkey: stranger.authentication(heard, origin, 1, rpID) },
      cookie,
    );
    expect(refused.status).toBe(401);
    expect(sendsNoOtherSession(refused, owner)).toBe(true);
    expect((await get("/owner/sign-ins", owner)).status).toBe(200);
    expect((await changeName(owner)).status).toBe(403);
  });
});

describe("confirming with a passkey", () => {
  it("replaces a stale session when the owner's passkey signs", async () => {
    const stale = await signIn();
    const rpID = new URL(origin).hostname;
    const device = testAuthenticator();
    const options = await get("/auth/passkey/generate-register-options", stale);
    const challenge = ((await options.json()) as { challenge: string })
      .challenge;
    const added = await fetch(
      `${server.apiUrl}/auth/passkey/verify-registration`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin,
          cookie: [stale, cookiesOf(options)].join("; "),
          [CLIENT_HEADER]: nextAddress(),
        },
        body: JSON.stringify({
          name: "Confirm key",
          response: device.registration(challenge, origin, rpID),
        }),
      },
    );
    expect(added.status).toBe(200);

    await server.advanceClock(6 * MINUTE);
    expect((await changeName(stale)).status).toBe(403);
    const asked = await get(
      "/auth/passkey/generate-authenticate-options",
      stale,
    );
    const heard = ((await asked.json()) as { challenge: string }).challenge;
    const confirmed = await confirm(
      { passkey: device.authentication(heard, origin, 1, rpID) },
      [stale, cookiesOf(asked)].join("; "),
    );
    expect(confirmed.status).toBe(200);
    const renewed = sessionCookie(confirmed);
    expect(renewed).toBeTruthy();
    expect((await changeName(renewed!)).status).toBe(200);
    expect((await get("/owner/sign-ins", stale)).status).toBe(401);
  });
});

describe("a stale session signing out", () => {
  it("lets a stale browser session sign itself out in one request, and ends another only with a recent one", async () => {
    const stale = await signIn();
    await server.advanceClock(6 * MINUTE);
    const fresh = await signIn();
    const listed = (await (await get("/owner/sign-ins", stale)).json()) as {
      data: { id: string; kind: string; current?: boolean }[];
    };
    const browsers = listed.data.filter((row) => row.kind === "browser");
    const own = browsers.find((row) => row.current)!;
    const other = browsers.find((row) => !row.current)!;
    const end = (id: string, cookie: string) =>
      fetch(`${server.apiUrl}/owner/sign-ins/${id}`, {
        method: "DELETE",
        headers: { cookie, origin, [CLIENT_HEADER]: nextAddress() },
      });

    expect((await end(other.id, stale)).status).toBe(403);
    expect((await get("/owner/sign-ins", fresh)).status).toBe(200);
    expect((await end(own.id, stale)).status).toBe(200);
    expect((await get("/owner/sign-ins", stale)).status).toBe(401);
    expect((await get("/owner/sign-ins", fresh)).status).toBe(200);
  });
});

describe("signing out the other browsers", () => {
  /** `POST /auth/revoke-other-sessions` from the browser session `cookie`. */
  const endOthers = (cookie: string) =>
    fetch(`${server.apiUrl}/auth/revoke-other-sessions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie,
        origin,
        [CLIENT_HEADER]: nextAddress(),
      },
      body: "{}",
    });

  it("ends every other browser session of the owner and keeps the one that sent it", async () => {
    const sender = await signIn();
    const others = [await signIn(), await signIn()];
    // The witness: the other sessions are live until the sender ends them.
    for (const other of others)
      expect((await get("/owner/sign-ins", other)).status).toBe(200);
    const ended = await endOthers(sender);
    expect(ended.status).toBe(200);
    for (const other of others)
      expect((await get("/owner/sign-ins", other)).status).toBe(401);
    expect((await get("/owner/sign-ins", sender)).status).toBe(200);
  });

  it("refuses a session created more than five minutes ago and ends none, until the owner confirms", async () => {
    const stale = await signIn();
    const other = await signIn();
    await server.advanceClock(6 * MINUTE);
    const refused = await endOthers(stale);
    expect(refused.status).toBe(403);
    const refusal = (await refused.json()) as {
      error: { code: string; message: string };
    };
    expect(refusal.error.code).toBe("forbidden");
    expect(refusal.error.message).toBe(
      "Sign in again to perform this operation",
    );
    expect((await get("/owner/sign-ins", other)).status).toBe(200);

    const renewed = sessionCookie(
      await confirm({ password: TEST_OWNER.password }, stale),
    )!;
    expect((await endOthers(renewed)).status).toBe(200);
    expect((await get("/owner/sign-ins", other)).status).toBe(401);
    expect((await get("/owner/sign-ins", renewed)).status).toBe(200);
  });
});

describe("a stale session adding a passkey", () => {
  it("refuses a passkey registration from a stale session", async () => {
    const stale = await signIn();
    expect(
      (await get("/auth/passkey/generate-register-options", stale)).status,
    ).toBe(200);
    await server.advanceClock(6 * MINUTE);
    const refused = await get("/auth/passkey/generate-register-options", stale);
    expect(refused.status).toBe(403);
    expect(await code(refused)).toBe("forbidden");
  });
});

describe("a confirmation without a signed-in owner session", () => {
  it("is refused with no cookie, with an ended session, and with a key", async () => {
    const none = await confirm({ password: TEST_OWNER.password }, undefined);
    expect(none.status).toBe(401);
    expect(none.headers.get("set-cookie")).toBeNull();

    const ended = await signIn();
    const out = await fetch(`${server.apiUrl}/auth/sign-out`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin,
        cookie: ended,
        [CLIENT_HEADER]: nextAddress(),
      },
      body: "{}",
    });
    expect(out.status).toBe(200);
    const afterEnd = await confirm({ password: TEST_OWNER.password }, ended);
    expect(afterEnd.status).toBe(401);
    expect(afterEnd.headers.get("set-cookie")).toBeNull();

    const withKey = await confirm(
      { password: TEST_OWNER.password },
      undefined,
      nextAddress(),
      {
        authorization: `Bearer ${server.managementKey}`,
      },
    );
    expect(withKey.status).toBe(401);
  });

  it("is refused from another origin, and sets no session", async () => {
    const stale = await signIn();
    const foreign = await confirm(
      { password: TEST_OWNER.password },
      stale,
      nextAddress(),
      { origin: "https://foreign.example" },
    );
    expect(foreign.status).toBe(403);
    expect(foreign.headers.get("set-cookie")).toBeNull();
  });
});

function cookiesOf(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((line) => line.split(";")[0])
    .join("; ");
}
