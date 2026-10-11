import { afterEach, describe, expect, it, vi } from "vitest";
import type { TestContext } from "../test-utils.js";
import { createTestContext, request, seedOauthBearer } from "../test-utils.js";
import {
  DEVICE_CODE_ADDRESS_LIMIT,
  DEVICE_CODE_INSTANCE_LIMIT,
} from "./auth-pages.js";

/**
 * Every door that looks a device code up (the entry form, `POST
 * /auth/device`, and the consent screen and its decision, `GET` and `POST
 * /auth/device/consent`) counts the lookup in its lane, per anonymous address
 * or verified owner and across that lane, whatever codes they are.
 *
 * Marfa's own rate limiter is off in the test context, so a redirect
 * carrying `error=too_many_attempts` is this limit firing.
 */

let ctx: TestContext | undefined;

afterEach(async () => {
  await ctx?.cleanup();
  ctx = undefined;
});

const ORIGIN = "http://localhost:0";

/** A well-formed code nobody issued, distinct for each `n`. */
function codeFor(n: number): string {
  return `AB${n.toString(36).toUpperCase().padStart(6, "2")}`;
}

async function submit(
  c: TestContext,
  userCode: string,
  peer: string,
  headers: Record<string, string> = {},
): Promise<string> {
  const res = await request(c.app, "POST", "/auth/device", {
    form: { user_code: userCode },
    headers: { origin: ORIGIN, ...headers },
    peer,
  });
  expect(res.status).toBe(302);
  return res.headers.get("location") ?? "";
}

describe("device code entry limits", () => {
  it("refuses one address sweeping distinct codes, and not another address", async () => {
    ctx = await createTestContext();

    for (let i = 0; i < DEVICE_CODE_ADDRESS_LIMIT; i++) {
      expect(await submit(ctx, codeFor(i), "203.0.113.1")).toContain(
        "error=invalid_code",
      );
    }
    // A code this address has never tried is refused all the same.
    expect(await submit(ctx, codeFor(1000), "203.0.113.1")).toContain(
      "error=too_many_attempts",
    );
    // Another address is still served.
    expect(await submit(ctx, codeFor(1001), "192.0.2.9")).toContain(
      "error=invalid_code",
    );
  });

  it("counts an IPv6 address by its /64", async () => {
    ctx = await createTestContext();

    for (let i = 0; i < DEVICE_CODE_ADDRESS_LIMIT; i++) {
      expect(
        await submit(ctx, codeFor(i), `2001:db8:5:6::${(i + 1).toString(16)}`),
      ).toContain("error=invalid_code");
    }
    expect(await submit(ctx, codeFor(500), "2001:db8:5:6::abcd")).toContain(
      "error=too_many_attempts",
    );
    expect(await submit(ctx, codeFor(501), "2001:db8:5:7::1")).toContain(
      "error=invalid_code",
    );
  });

  it("refuses a sweep spread across many addresses once the instance has taken its share", async () => {
    ctx = await createTestContext();

    for (let i = 0; i < DEVICE_CODE_INSTANCE_LIMIT; i++) {
      expect(await submit(ctx, codeFor(i), `198.51.${String(i)}.1`)).toContain(
        "error=invalid_code",
      );
    }
    expect(await submit(ctx, codeFor(9999), "192.0.2.77")).toContain(
      "error=too_many_attempts",
    );
  });

  it("does not let one address's refused submissions close the form for everyone", async () => {
    ctx = await createTestContext();

    for (let i = 0; i < DEVICE_CODE_INSTANCE_LIMIT + 5; i++) {
      await submit(ctx, codeFor(i), "203.0.113.2");
    }
    expect(await submit(ctx, codeFor(7777), "192.0.2.8")).toContain(
      "error=invalid_code",
    );
  });

  it("shares one owner budget across sessions, addresses and all three lookup doors", async () => {
    ctx = await createTestContext();
    const c = ctx;
    const secondCookie = await signIn(c);
    const first = await c.auth.getSession(
      new Headers({ cookie: c.owner.cookie }),
      { readOnly: true },
    );
    const second = await c.auth.getSession(
      new Headers({ cookie: secondCookie }),
      { readOnly: true },
    );
    expect(first!.session.id).not.toBe(second!.session.id);
    expect(first!.user.id).toBe(second!.user.id);
    const lookup = vi.spyOn(c.auth, "deviceVerify");
    for (let i = 0; i < 10; i++) {
      const cookie = i % 2 ? secondCookie : c.owner.cookie;
      const res = await ownerLookup(
        c,
        i % 3,
        codeFor(i),
        cookie,
        `192.0.2.${String(i + 1)}`,
      );
      expect(res.status).toBe(i % 3 === 2 ? 404 : 302);
      expect(res.headers.get("location") ?? "").not.toContain(
        "too_many_attempts",
      );
    }
    expect(lookup).toHaveBeenCalledTimes(10);
    for (const door of [0, 1, 2]) {
      const refused = await ownerLookup(
        c,
        door,
        codeFor(100 + door),
        secondCookie,
        "198.51.100.1",
      );
      expect(refused.headers.get("location")).toContain(
        "error=too_many_attempts",
      );
    }
    expect(lookup).toHaveBeenCalledTimes(10);
    expect(await submit(c, codeFor(200), "198.51.100.1")).toContain(
      "error=invalid_code",
    );
  });

  it("approves and exchanges a genuine device after anonymous callers exhaust the owner address and aggregate", async () => {
    ctx = await createTestContext();
    const c = ctx;
    const registered = await request(c.app, "POST", "/auth/oauth2/register", {
      headers: { origin: ORIGIN },
      body: {
        client_name: "Device throttle test",
        application_type: "native",
        grant_types: ["urn:ietf:params:oauth:grant-type:device_code"],
        token_endpoint_auth_method: "none",
        redirect_uris: [`${ORIGIN}/callback`],
        response_types: [],
      },
    });
    expect(registered.status).toBe(201);
    const { client_id } = (await registered.json()) as { client_id: string };
    const issued = await request(c.app, "POST", "/auth/device/code", {
      headers: { origin: ORIGIN },
      form: { client_id, scope: "core.note:read" },
    });
    expect(issued.status).toBe(200);
    const { user_code, device_code } = (await issued.json()) as {
      user_code: string;
      device_code: string;
    };
    for (let i = 0; i < 100; i++) {
      const address = i < 10 ? "2001:db8:5:6::1" : `198.51.100.${String(i)}`;
      expect(await submit(c, codeFor(i), address)).toContain(
        "error=invalid_code",
      );
    }
    expect(await submit(c, user_code, "2001:db8:5:6::abcd")).toContain(
      "error=too_many_attempts",
    );
    expect(await submit(c, user_code, "192.0.2.200")).toContain(
      "error=too_many_attempts",
    );
    expect(
      await submit(c, user_code, "2001:db8:5:6::abcd", {
        cookie: c.owner.cookie,
      }),
    ).toContain("/auth/device/consent?");
    expect(
      (await ownerLookup(c, 1, user_code, c.owner.cookie, "2001:db8:5:6::abcd"))
        .status,
    ).toBe(200);
    const approved = await request(c.app, "POST", "/auth/device/consent", {
      headers: { origin: ORIGIN, cookie: c.owner.cookie },
      peer: "2001:db8:5:6::abcd",
      form: { user_code, decision: "approve", scopes: ["core.note:read"] },
    });
    expect(approved.status).toBe(200);
    const exchanged = await request(c.app, "POST", "/auth/oauth2/token", {
      headers: { origin: ORIGIN },
      form: {
        client_id,
        device_code,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      },
    });
    expect(exchanged.status).toBe(200);
    const { access_token, scope } = (await exchanged.json()) as {
      access_token: string;
      scope: string;
    };
    expect(scope).toBe("core.note:read");
    expect(
      (
        await request(c.app, "GET", "/items?type=core.note", {
          key: access_token,
        })
      ).status,
    ).toBe(200);
  });

  it.each(["forged", "expired", "revoked"] as const)(
    "keeps a %s owner session in the anonymous lane",
    async (state) => {
      ctx = await createTestContext();
      const c = ctx;
      let cookie = c.owner.cookie;
      const session = await c.auth.getSession(new Headers({ cookie }), {
        readOnly: true,
      });
      expect(session!.user.id).toBe(c.owner.id);
      expect(await submit(c, codeFor(900), "192.0.2.1", { cookie })).toContain(
        "error=invalid_code",
      );
      if (state === "forged")
        cookie = cookie.slice(0, -1) + (cookie.endsWith("A") ? "B" : "A");
      else if (state === "expired") {
        const { sql } = await import("drizzle-orm");
        await (
          c.storage.betterAuthDb as { run(query: unknown): Promise<unknown> }
        ).run(
          sql`update auth_session set expires_at = ${Math.floor(Date.now() / 1000) - 60} where id = ${session!.session.id}`,
        );
      } else
        expect(
          await c.auth.endBrowserSession(c.owner.id, session!.session.id, null),
        ).toBe(true);
      for (let i = 0; i < 10; i++)
        expect(await submit(c, codeFor(i), "203.0.113.1")).toContain(
          "error=invalid_code",
        );
      expect(
        await submit(c, codeFor(100), "203.0.113.1", { cookie }),
      ).toContain("error=too_many_attempts");
      expect(
        await c.auth.getSession(new Headers({ cookie }), { readOnly: true }),
      ).toBeNull();
    },
  );

  it("revalidates owner authority before counting when the session ends after middleware admission", async () => {
    ctx = await createTestContext();
    const c = ctx;
    const session = await c.auth.getSession(
      new Headers({ cookie: c.owner.cookie }),
      { readOnly: true },
    );
    const count = vi.spyOn(c.storage.rateLimits, "incrementWindow");
    const lookup = vi.spyOn(c.auth, "deviceVerify");
    expect(
      await submit(c, codeFor(0), "192.0.2.1", { cookie: c.owner.cookie }),
    ).toContain("error=invalid_code");
    expect(count).toHaveBeenCalled();
    expect(lookup).toHaveBeenCalledTimes(1);
    count.mockClear();
    lookup.mockClear();
    const transaction = c.storage.runInTransaction.bind(c.storage);
    vi.spyOn(c.storage, "runInTransaction").mockImplementationOnce(
      async (work, options) => {
        expect(
          await c.auth.endBrowserSession(c.owner.id, session!.session.id, null),
        ).toBe(true);
        return transaction(work, options);
      },
    );
    const refused = await request(c.app, "POST", "/auth/device", {
      headers: { origin: ORIGIN, cookie: c.owner.cookie },
      peer: "192.0.2.1",
      form: { user_code: codeFor(1) },
    });
    expect(refused.status).toBe(401);
    expect(count).not.toHaveBeenCalled();
    expect(lookup).not.toHaveBeenCalled();
  });

  it("keeps ordinary keys and OAuth tokens in the anonymous lane even beside an owner cookie", async () => {
    ctx = await createTestContext();
    const c = ctx;
    const oauth = await seedOauthBearer(c, ["core.note:read"]);
    for (let i = 0; i < 10; i++)
      expect(await submit(c, codeFor(i), "203.0.113.1")).toContain(
        "error=invalid_code",
      );
    for (const token of [c.managementKey, oauth.token]) {
      expect(
        await submit(c, codeFor(100), "203.0.113.1", {
          cookie: c.owner.cookie,
          authorization: `Bearer ${token}`,
        }),
      ).toContain("error=too_many_attempts");
    }
    expect(
      await submit(c, codeFor(101), "203.0.113.1", { cookie: c.owner.cookie }),
    ).toContain("error=invalid_code");
  });

  it("admits exactly ten owner lookups during a concurrent burst", async () => {
    ctx = await createTestContext();
    const c = ctx;
    const lookup = vi.spyOn(c.auth, "deviceVerify");
    const answers = await Promise.all(
      Array.from({ length: 24 }, (_, i) =>
        submit(c, codeFor(i), `192.0.2.${String(i + 1)}`, {
          cookie: c.owner.cookie,
        }),
      ),
    );
    expect(
      answers.filter((location) => location.includes("invalid_code")),
    ).toHaveLength(10);
    expect(
      answers.filter((location) => location.includes("too_many_attempts")),
    ).toHaveLength(14);
    expect(lookup).toHaveBeenCalledTimes(10);
  });

  it("applies the owner lane aggregate cap independently of the anonymous cap", async () => {
    ctx = await createTestContext();
    const c = ctx;
    // A single claimed owner reaches its own cap before the aggregate cap.
    // Seed only the aggregate to witness that the second bound is enforced.
    for (let i = 0; i < 99; i++)
      await c.storage.rateLimits.incrementWindow(
        "device-user-code-owner-instance",
        "all",
        15 * 60_000,
        new Date().toISOString(),
      );
    expect(
      await submit(c, codeFor(1), "192.0.2.1", { cookie: c.owner.cookie }),
    ).toContain("error=invalid_code");
    expect(
      await submit(c, codeFor(2), "192.0.2.1", { cookie: c.owner.cookie }),
    ).toContain("error=too_many_attempts");
    expect(await submit(c, codeFor(3), "192.0.2.1")).toContain(
      "error=invalid_code",
    );
  });
});

async function signIn(c: TestContext): Promise<string> {
  const response = await request(c.app, "POST", "/auth/sign-in/email", {
    headers: { origin: ORIGIN },
    body: { email: c.owner.email, password: c.owner.password },
  });
  expect(response.status).toBe(200);
  const cookie = /(?:^|,\s*)([\w.-]*session_token=[^;]+)/.exec(
    response.headers.get("set-cookie") ?? "",
  )?.[1];
  if (!cookie) throw new Error("Sign-in returned no session cookie");
  return cookie;
}

function ownerLookup(
  c: TestContext,
  door: number,
  code: string,
  cookie: string,
  peer: string,
): Promise<Response> {
  if (door === 1)
    return request(c.app, "GET", `/auth/device/consent?user_code=${code}`, {
      headers: { cookie },
      peer,
    });
  return request(
    c.app,
    "POST",
    door === 0 ? "/auth/device" : "/auth/device/consent",
    {
      headers: { origin: ORIGIN, cookie },
      peer,
      form: { user_code: code, decision: "approve" },
    },
  );
}
