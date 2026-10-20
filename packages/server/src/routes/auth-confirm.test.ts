import { afterEach, describe, expect, it, vi } from "vitest";
import { resetClockForTests } from "../clock.js";
import { testAuthenticator } from "../auth/passkey-test-authenticator.js";
import { SIGN_IN_ADDRESS_LIMIT } from "../auth/sign-in-throttle.js";
import { SIGN_IN_AGAIN_MESSAGE } from "../pages/recent-sign-in.js";
import { createTestContext, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";

vi.setConfig({ testTimeout: 60_000 });

let ctx: TestContext | undefined;

afterEach(async () => {
  await ctx?.cleanup();
  ctx = undefined;
  resetClockForTests();
});

const ORIGIN = "http://localhost:0";
const PEER = "198.51.100.7";

interface Sql {
  __sqliteRun: (sql: string, params: unknown[]) => Promise<unknown>;
}

async function fixture(): Promise<TestContext> {
  ctx = await createTestContext();
  return ctx;
}

/** Age the owner's session to `minutes` old, so the next change is refused. */
async function ageSessionTo(c: TestContext, minutes: number): Promise<void> {
  await (c.storage as unknown as Sql).__sqliteRun(
    "UPDATE auth_session SET created_at = ?",
    [Math.floor(Date.now() / 1000) - minutes * 60],
  );
}

function cookiesOf(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((line) => line.split(";")[0])
    .join("; ");
}

function confirm(
  c: TestContext,
  body: unknown,
  cookie: string | undefined = c.owner.cookie,
  peer = PEER,
): Promise<Response> {
  return request(c.app, "POST", "/auth/confirm", {
    body,
    headers: { origin: ORIGIN, ...(cookie ? { cookie } : {}) },
    peer,
  });
}

/** A change that needs a sign-in from the last five minutes. */
function rename(c: TestContext, cookie: string): Promise<Response> {
  return request(c.app, "PATCH", "/owner", {
    body: { name: "Renamed Owner" },
    headers: { origin: ORIGIN, cookie },
  });
}

async function refusalOf(response: Response) {
  return (await response.json()) as {
    error: { code: string; message: string };
  };
}

describe("POST /auth/confirm with the password", () => {
  it("replaces a stale session with a new one, so the change that was refused runs", async () => {
    const c = await fixture();
    const stale = c.owner.cookie;
    await ageSessionTo(c, 6);

    const refused = await rename(c, stale);
    expect(refused.status).toBe(403);
    expect((await refusalOf(refused)).error.message).toBe(
      SIGN_IN_AGAIN_MESSAGE,
    );

    const confirmed = await confirm(c, { password: c.owner.password }, stale);
    expect(confirmed.status).toBe(200);
    expect(await confirmed.json()).toEqual({ ok: true });
    const fresh = cookiesOf(confirmed);
    expect(fresh).toContain("session_token=");
    expect(fresh).not.toBe(stale);

    expect((await rename(c, fresh)).status).toBe(200);
  });

  it("ends the old session in the same step, so its cookie signs nobody in", async () => {
    const c = await fixture();
    const stale = c.owner.cookie;
    await ageSessionTo(c, 6);
    const confirmed = await confirm(c, { password: c.owner.password }, stale);
    expect(confirmed.status).toBe(200);
    expect(
      (
        await (
          c.storage as unknown as {
            __sqliteAll: (sql: string) => Promise<unknown[]>;
          }
        ).__sqliteAll("SELECT id FROM auth_session")
      ).length,
    ).toBe(1);
    const old = await request(c.app, "GET", "/owner/sign-ins", {
      headers: { origin: ORIGIN, cookie: stale },
    });
    expect(old.status).toBe(401);
  });

  it("answers a wrong password in place and leaves the session as it was", async () => {
    const c = await fixture();
    const stale = c.owner.cookie;
    await ageSessionTo(c, 6);
    const wrong = await confirm(c, { password: "not the password" }, stale);
    expect(wrong.status).toBe(401);
    expect(wrong.headers.get("set-cookie")).toBeNull();
    expect((await refusalOf(wrong)).error.code).toBe("unauthorized");

    expect(
      (
        await request(c.app, "GET", "/owner/sign-ins", {
          headers: { origin: ORIGIN, cookie: stale },
        })
      ).status,
    ).toBe(200);
    expect((await rename(c, stale)).status).toBe(403);
    expect(
      (await confirm(c, { password: c.owner.password }, stale)).status,
    ).toBe(200);
  });

  it("counts a confirmation in the lane a sign-in counts in, and answers the lockout with the wait", async () => {
    const c = await fixture();
    const stale = c.owner.cookie;
    const half = SIGN_IN_ADDRESS_LIMIT / 2;
    for (let i = 0; i < half; i++)
      expect((await confirm(c, { password: "wrong one" }, stale)).status).toBe(
        401,
      );
    for (let i = 0; i < half; i++) {
      const direct = await request(c.app, "POST", "/auth/sign-in/email", {
        body: { email: c.owner.email, password: "wrong two" },
        headers: { origin: ORIGIN },
        peer: PEER,
      });
      expect(direct.status).toBe(401);
    }
    const locked = await confirm(c, { password: c.owner.password }, stale);
    expect(locked.status).toBe(429);
    expect((await refusalOf(locked)).error.code).toBe("rate_limited");
    expect(Number(locked.headers.get("retry-after"))).toBeGreaterThan(0);

    // The sign-in page is held by the same lane.
    const signIn = await request(c.app, "POST", "/auth/sign-in/email", {
      body: { email: c.owner.email, password: c.owner.password },
      headers: { origin: ORIGIN },
      peer: PEER,
    });
    expect(signIn.status).toBe(429);
    expect(locked.headers.get("retry-after")).toBe(
      signIn.headers.get("retry-after"),
    );

    // The right password, refused, did not end the session.
    expect(
      (
        await request(c.app, "GET", "/owner/sign-ins", {
          headers: { origin: ORIGIN, cookie: stale },
        })
      ).status,
    ).toBe(200);
  });

  it("holds a lockout reached through the sign-in form against a confirmation", async () => {
    const c = await fixture();
    for (let i = 0; i < SIGN_IN_ADDRESS_LIMIT; i++)
      await request(c.app, "POST", "/auth/sign-in/email", {
        body: { email: c.owner.email, password: "wrong" },
        headers: { origin: ORIGIN },
        peer: PEER,
      });
    const locked = await confirm(c, { password: c.owner.password });
    expect(locked.status).toBe(429);
    expect(locked.headers.get("set-cookie")).toBeNull();
  });

  it("takes no email: a body that names one, or two proofs, or none, is refused", async () => {
    const c = await fixture();
    for (const body of [
      { password: c.owner.password, email: "other@example.com" },
      { email: c.owner.email, password: c.owner.password, passkey: {} },
      { password: c.owner.password, passkey: {} },
      {},
      { password: "" },
    ]) {
      const answered = await confirm(c, body);
      expect(answered.status, JSON.stringify(Object.keys(body))).toBe(400);
      expect(answered.headers.get("set-cookie")).toBeNull();
    }
  });
});

describe("POST /auth/confirm without a signed-in owner", () => {
  it("refuses a request with no session", async () => {
    const c = await fixture();
    const answered = await confirm(c, { password: c.owner.password }, "");
    expect(answered.status).toBe(401);
    expect(answered.headers.get("set-cookie")).toBeNull();
  });

  it("refuses a session that has ended", async () => {
    const c = await fixture();
    const stale = c.owner.cookie;
    const ended = await request(c.app, "POST", "/auth/sign-out", {
      body: {},
      headers: { origin: ORIGIN, cookie: stale },
    });
    expect(ended.status).toBe(200);
    const answered = await confirm(c, { password: c.owner.password }, stale);
    expect(answered.status).toBe(401);
    expect(answered.headers.get("set-cookie")).toBeNull();
  });

  it("refuses a bearer key, which holds no session to renew", async () => {
    const c = await fixture();
    const answered = await request(c.app, "POST", "/auth/confirm", {
      body: { password: c.owner.password },
      headers: { origin: ORIGIN },
      key: c.managementKey,
    });
    expect(answered.status).toBe(401);
  });

  it("refuses a post from another origin", async () => {
    const c = await fixture();
    const answered = await request(c.app, "POST", "/auth/confirm", {
      body: { password: c.owner.password },
      headers: { origin: "https://foreign.example", cookie: c.owner.cookie },
    });
    expect(answered.status).toBe(403);
    expect(answered.headers.get("set-cookie")).toBeNull();
  });
});

describe("POST /auth/confirm with a passkey", () => {
  async function registered(c: TestContext) {
    const device = testAuthenticator();
    const options = await request(
      c.app,
      "GET",
      "/auth/passkey/generate-register-options",
      { headers: { origin: ORIGIN, cookie: c.owner.cookie } },
    );
    expect(options.status).toBe(200);
    const { challenge } = (await options.json()) as { challenge: string };
    const done = await request(
      c.app,
      "POST",
      "/auth/passkey/verify-registration",
      {
        body: {
          response: device.registration(challenge, ORIGIN),
          name: "Test key",
        },
        headers: {
          origin: ORIGIN,
          cookie: [c.owner.cookie, cookiesOf(options)].join("; "),
        },
      },
    );
    expect(done.status).toBe(200);
    return device;
  }

  /** The challenge a browser holds in its cookies before it asks the passkey. */
  async function challenge(c: TestContext, cookie: string) {
    const options = await request(
      c.app,
      "GET",
      "/auth/passkey/generate-authenticate-options",
      { headers: { origin: ORIGIN, cookie } },
    );
    expect(options.status).toBe(200);
    return {
      value: ((await options.json()) as { challenge: string }).challenge,
      cookie: [cookie, cookiesOf(options)].filter(Boolean).join("; "),
    };
  }

  it("replaces a stale session when the owner's passkey signs", async () => {
    const c = await fixture();
    const device = await registered(c);
    const stale = c.owner.cookie;
    await ageSessionTo(c, 6);
    expect((await rename(c, stale)).status).toBe(403);

    const asked = await challenge(c, stale);
    const confirmed = await confirm(
      c,
      { passkey: device.authentication(asked.value, ORIGIN) },
      asked.cookie,
    );
    expect(confirmed.status).toBe(200);
    const fresh = cookiesOf(confirmed);
    expect((await rename(c, fresh)).status).toBe(200);
    expect(
      (
        await request(c.app, "GET", "/owner/sign-ins", {
          headers: { origin: ORIGIN, cookie: stale },
        })
      ).status,
    ).toBe(401);
  });

  it("refuses a passkey the owner never registered, and keeps the session", async () => {
    const c = await fixture();
    await registered(c);
    const stranger = testAuthenticator();
    const stale = c.owner.cookie;
    const asked = await challenge(c, stale);
    const refused = await confirm(
      c,
      { passkey: stranger.authentication(asked.value, ORIGIN) },
      asked.cookie,
    );
    expect(refused.status).toBe(401);
    expect(refused.headers.get("set-cookie")).toBeNull();
    expect(
      (
        await request(c.app, "GET", "/owner/sign-ins", {
          headers: { origin: ORIGIN, cookie: stale },
        })
      ).status,
    ).toBe(200);
  });

  it("refuses a passkey that belongs to another user than the session's, and keeps the session", async () => {
    const c = await fixture();
    const device = await registered(c);
    const owner = c.owner;
    const session = await c.auth.getSession(
      new Headers({ cookie: owner.cookie }),
      { readOnly: true },
    );
    if (!session) throw new Error("the owner is signed in");
    const asked = await challenge(c, owner.cookie);
    const outcome = await c.auth.confirmSession({
      headers: new Headers({ cookie: asked.cookie }),
      clientAddress: PEER,
      current: {
        userId: "another-user",
        sessionId: session.session.id,
        email: owner.email,
      },
      proof: {
        kind: "passkey",
        response: device.authentication(asked.value, ORIGIN),
      },
    });
    expect(outcome).toMatchObject({ ok: false });
    expect(
      (
        await request(c.app, "GET", "/owner/sign-ins", {
          headers: { origin: ORIGIN, cookie: owner.cookie },
        })
      ).status,
    ).toBe(200);
  });
});

describe("a confirmation does not outlast five minutes", () => {
  it("makes a session whose own change is refused again once five minutes pass", async () => {
    const c = await fixture();
    const stale = c.owner.cookie;
    await ageSessionTo(c, 6);
    const confirmed = await confirm(c, { password: c.owner.password }, stale);
    const fresh = cookiesOf(confirmed);
    expect((await rename(c, fresh)).status).toBe(200);
    await ageSessionTo(c, 6);
    const again = await rename(c, fresh);
    expect(again.status).toBe(403);
    expect((await refusalOf(again)).error.message).toBe(SIGN_IN_AGAIN_MESSAGE);
  });
});
