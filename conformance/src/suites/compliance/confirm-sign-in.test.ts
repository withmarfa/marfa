import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { issuerOrigin } from "../../utils/signed-in.js";
import { testAuthenticator } from "../../utils/passkey-authenticator.js";
import { TEST_OWNER } from "../../utils/target.js";
import { sessionCookieOf as sessionCookie } from "../../client/owner-session.js";

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
    MARFA_TRUSTED_PROXY_HEADER: CLIENT_HEADER,
    MARFA_TRUSTED_PROXY_CIDRS: "127.0.0.0/8",
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

/** Signs in with the owner's password from `address`. */
async function signIn(address = nextAddress()): Promise<string> {
  const response = await fetch(`${server.apiUrl}/auth/sign-in`, {
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

/**
 * A step that needs a sign-in from the last five minutes: removing a passkey.
 * No passkey has this ID, so a session recent enough is answered 404.
 */
function removeAbsent(cookie: string): Promise<Response> {
  return fetch(`${server.apiUrl}/owner/passkeys/absent`, {
    method: "DELETE",
    headers: { cookie, origin, [CLIENT_HEADER]: nextAddress() },
  });
}

/** The challenge for a passkey registration or sign-in, with its cookie added to `cookie`. */
async function passkeyOptions(
  ceremony: "registration" | "sign-in",
  cookie: string,
): Promise<{ status: number; challenge: string; cookie: string }> {
  const response = await fetch(
    `${server.apiUrl}/auth/passkeys/${ceremony}/options`,
    {
      method: "POST",
      headers: { cookie, origin, [CLIENT_HEADER]: nextAddress() },
    },
  );
  const body = (await response.json()) as { challenge?: string };
  return {
    status: response.status,
    challenge: body.challenge ?? "",
    cookie: [cookie, cookiesOf(response)].filter(Boolean).join("; "),
  };
}

/** Registers `device` as a passkey named `name` from the session in `cookie`. */
async function registerPasskey(
  cookie: string,
  device: ReturnType<typeof testAuthenticator>,
  name: string,
): Promise<Response> {
  const options = await passkeyOptions("registration", cookie);
  expect(options.status).toBe(200);
  return fetch(`${server.apiUrl}/auth/passkeys/registration`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin,
      cookie: options.cookie,
      [CLIENT_HEADER]: nextAddress(),
    },
    body: JSON.stringify({
      name,
      response: device.registration(
        options.challenge,
        origin,
        new URL(origin).hostname,
      ),
    }),
  });
}

/** Whether `response` got past the five-minute check. */
async function wasRecent(response: Response): Promise<boolean> {
  expect([403, 404], await response.clone().text()).toContain(response.status);
  return response.status === 404;
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
    const refused = await removeAbsent(stale);
    expect(refused.status).toBe(403);
    const refusal = (await refused.json()) as {
      error: { code: string; details?: { needs?: string } };
    };
    expect(refusal.error.code).toBe("forbidden");
    expect(refusal.error.details?.needs).toBe("recent_sign_in");

    const confirmed = await confirm({ password: TEST_OWNER.password }, stale);
    expect(confirmed.status).toBe(200);
    expect(await confirmed.json()).toEqual({ ok: true });
    const renewed = sessionCookie(confirmed);
    expect(renewed).toBeTruthy();
    expect(renewed).not.toBe(stale);

    expect(await wasRecent(await removeAbsent(renewed!))).toBe(true);
    // The old session ended in the same step.
    expect((await get("/owner/passkeys", stale)).status).toBe(401);
    expect((await get("/owner/passkeys", renewed!)).status).toBe(200);
  });

  it("dates the new session from the confirmation, so it goes stale five minutes after it", async () => {
    const stale = await signIn();
    await server.advanceClock(6 * MINUTE);
    const renewed = sessionCookie(
      await confirm({ password: TEST_OWNER.password }, stale),
    )!;
    await server.advanceClock(4 * MINUTE);
    expect(await wasRecent(await removeAbsent(renewed))).toBe(true);
    await server.advanceClock(2 * MINUTE);
    const again = await removeAbsent(renewed);
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
    expect((await get("/owner/passkeys", stale)).status).toBe(200);
    expect((await removeAbsent(stale)).status).toBe(403);
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
      const direct = await fetch(`${server.apiUrl}/auth/sign-in`, {
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
    expect((await get("/owner/passkeys", stale)).status).toBe(200);
    expect((await removeAbsent(stale)).status).toBe(403);
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
    expect((await get("/owner/passkeys", stale)).status).toBe(200);
    expect((await removeAbsent(stale)).status).toBe(403);
  });

  it("refuses a passkey that is not registered to the signed-in owner, and leaves the session as it was", async () => {
    const owner = await signIn();
    const rpID = new URL(origin).hostname;
    const registered = testAuthenticator();
    const stranger = testAuthenticator();
    const added = await registerPasskey(owner, registered, "Confirm key");
    expect(added.status).toBe(201);

    await server.advanceClock(6 * MINUTE);
    const asked = await passkeyOptions("sign-in", owner);
    const refused = await confirm(
      { passkey: stranger.authentication(asked.challenge, origin, 1, rpID) },
      asked.cookie,
    );
    expect(refused.status).toBe(401);
    expect(sendsNoOtherSession(refused, owner)).toBe(true);
    expect((await get("/owner/passkeys", owner)).status).toBe(200);
    expect((await removeAbsent(owner)).status).toBe(403);
  });
});

describe("confirming with a passkey", () => {
  it("replaces a stale session when the owner's passkey signs", async () => {
    const stale = await signIn();
    const rpID = new URL(origin).hostname;
    const device = testAuthenticator();
    const added = await registerPasskey(stale, device, "Confirm key");
    expect(added.status).toBe(201);

    await server.advanceClock(6 * MINUTE);
    expect((await removeAbsent(stale)).status).toBe(403);
    const asked = await passkeyOptions("sign-in", stale);
    const confirmed = await confirm(
      { passkey: device.authentication(asked.challenge, origin, 1, rpID) },
      asked.cookie,
    );
    expect(confirmed.status).toBe(200);
    const renewed = sessionCookie(confirmed);
    expect(renewed).toBeTruthy();
    expect(await wasRecent(await removeAbsent(renewed!))).toBe(true);
    expect((await get("/owner/passkeys", stale)).status).toBe(401);
  });
});

interface AuditEntry {
  actor: { kind: string; id: string; name: string } | null;
  resource_type: string;
  resource_id: string | null;
  details: Record<string, unknown> | null;
}

/** The audit log's entries of one action, newest first. */
async function audited(action: string): Promise<AuditEntry[]> {
  const response = await fetch(
    `${server.apiUrl}/audit?${new URLSearchParams({ action, limit: "200" })}`,
    { headers: { authorization: `Bearer ${server.managementKey}` } },
  );
  expect(response.status).toBe(200);
  return ((await response.json()) as { data: AuditEntry[] }).data;
}

/**
 * Confirms `cookie` with the right password, and answers the ID of the
 * session it replaced, which the confirmation's own entry names.
 */
async function confirmedSessionId(cookie: string): Promise<string> {
  const confirmed = await confirm({ password: TEST_OWNER.password }, cookie);
  expect(confirmed.status).toBe(200);
  const [entry] = await audited("auth.sign_in.success");
  const id = entry?.details?.confirmed_session;
  expect(id).toBeTypeOf("string");
  return id as string;
}

describe("a refused confirmation in the audit log", () => {
  it("records a refused confirmation in the audit log as a refused password sign-in, with its reason", async () => {
    const stale = await signIn();
    await server.advanceClock(6 * MINUTE);
    const failed = "auth.sign_in.failed";
    const before = (await audited(failed)).length;
    const sent = "a wrong confirmation password";
    const wrong = await confirm({ password: sent }, stale);
    expect(wrong.status).toBe(401);
    const refused = await audited(failed);
    expect(refused).toHaveLength(before + 1);
    expect(refused[0]?.resource_type).toBe("owner");
    expect(refused[0]?.details).toMatchObject({
      method: "password",
      reason: "invalid_credentials",
    });

    const address = nextAddress();
    for (let attempt = 0; attempt < 10; attempt++) {
      const spent = await confirm({ password: sent }, stale, address);
      expect(spent.status).toBe(401);
    }
    const locked = await confirm(
      { password: TEST_OWNER.password },
      stale,
      address,
    );
    expect(locked.status).toBe(429);
    const held = await audited(failed);
    expect(held).toHaveLength(before + 12);
    expect(held[0]?.resource_type).toBe("owner");
    expect(held[0]?.details).toMatchObject({
      method: "password",
      reason: "too_many_attempts",
    });

    const recorded = held.slice(0, 12);
    expect(JSON.stringify(recorded)).not.toContain(sent);
    expect(JSON.stringify(recorded)).not.toContain(TEST_OWNER.password);
    const session = await confirmedSessionId(stale);
    expect(await audited(failed)).toHaveLength(before + 12);
    for (const entry of recorded) {
      expect(entry.actor).toMatchObject({ kind: "browser", id: session });
    }
  });

  it("records a refused passkey confirmation in the audit log as a refused passkey sign-in", async () => {
    const stale = await signIn();
    const rpID = new URL(origin).hostname;
    const device = testAuthenticator();
    const added = await registerPasskey(stale, device, "Audited key");
    expect(added.status).toBe(201);
    const passkeyId = ((await added.json()) as { id: string }).id;

    await server.advanceClock(6 * MINUTE);
    const failed = "auth.sign_in.failed";
    const before = (await audited(failed)).length;
    const asked = await passkeyOptions("sign-in", stale);
    const signed = device.authentication(asked.challenge, origin, 1, rpID);
    // A signature over another challenge does not verify this assertion.
    const other = device.authentication("b3RoZXI", origin, 1, rpID);
    signed.response.signature = other.response.signature;
    const refused = await confirm({ passkey: signed }, asked.cookie);
    expect(refused.status).toBe(401);

    const held = await audited(failed);
    expect(held).toHaveLength(before + 1);
    expect(held[0]?.resource_type).toBe("passkey");
    expect(held[0]?.resource_id).toBe(passkeyId);
    expect(held[0]?.details).toMatchObject({ method: "passkey" });
    const session = await confirmedSessionId(stale);
    expect(await audited(failed)).toHaveLength(before + 1);
    expect(held[0]?.actor).toMatchObject({ kind: "browser", id: session });
  });
});

describe("a stale session changing a passkey", () => {
  it("refuses a rename and a removal from a session created more than five minutes ago, and a recent session makes both", async () => {
    const holder = await signIn();
    const added = await registerPasskey(
      holder,
      testAuthenticator(),
      "Kept by age",
    );
    expect(added.status).toBe(201);

    await server.advanceClock(6 * MINUTE);
    const fresh = await signIn();
    const listed = await get("/owner/passkeys", fresh);
    expect(listed.status).toBe(200);
    const id = (
      (await listed.json()) as { data: { id: string; name: string }[] }
    ).data.find((row) => row.name === "Kept by age")!.id;
    const change = (method: string, cookie: string) =>
      fetch(`${server.apiUrl}/owner/passkeys/${id}`, {
        method,
        headers: {
          "content-type": "application/json",
          cookie,
          origin,
          [CLIENT_HEADER]: nextAddress(),
        },
        ...(method === "PATCH"
          ? { body: JSON.stringify({ name: "Renamed by age" }) }
          : {}),
      });
    for (const method of ["PATCH", "DELETE"]) {
      const refused = await change(method, holder);
      expect(refused.status, method).toBe(403);
      expect(await code(refused)).toBe("forbidden");
    }
    const kept = (await (await get("/owner/passkeys", fresh)).json()) as {
      data: { id: string; name: string }[];
    };
    expect(kept.data.find((row) => row.id === id)?.name).toBe("Kept by age");

    const renamed = await change("PATCH", fresh);
    expect(renamed.status).toBe(200);
    expect(((await renamed.json()) as { name: string }).name).toBe(
      "Renamed by age",
    );
    expect((await change("DELETE", fresh)).status).toBe(200);
  });
});

describe("a stale session adding a passkey", () => {
  it("refuses a passkey registration from a stale session", async () => {
    const stale = await signIn();
    const options = () =>
      fetch(`${server.apiUrl}/auth/passkeys/registration/options`, {
        method: "POST",
        headers: { cookie: stale, origin, [CLIENT_HEADER]: nextAddress() },
      });
    expect((await options()).status).toBe(200);
    await server.advanceClock(6 * MINUTE);
    const refused = await options();
    expect(refused.status).toBe(403);
    const refusal = (await refused.json()) as {
      error: { code: string; details?: { needs?: string } };
    };
    expect(refusal.error.code).toBe("forbidden");
    expect(refusal.error.details?.needs).toBe("recent_sign_in");
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
