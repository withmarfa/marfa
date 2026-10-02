/**
 * The sign-in surface keys its limits on the address Marfa resolved, and one
 * visitor cannot use them to lock the owner out.
 *
 * Better Auth runs a limiter of its own on `/auth/sign-in/email` and keys it
 * on the address it reads off the request. Marfa resolves that address once,
 * behind whatever proxy trust the instance configured, and hands it to Better
 * Auth on every request, the ones its sign-in form dispatches in-process
 * included. The address Better Auth used is the one it records on the session
 * it creates, which is what these cases read.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  createTestContext,
  createTestAccount,
  request,
} from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { auth_session } from "../storage/sqlite/schema.js";
import {
  SIGN_IN_ACCOUNT_LIMIT,
  SIGN_IN_ADDRESS_LIMIT,
} from "../auth/sign-in-throttle.js";

vi.setConfig({ testTimeout: 60_000 });

let ctx: TestContext | undefined;

afterEach(async () => {
  await ctx?.cleanup();
  ctx = undefined;
});

const ORIGIN = "http://localhost:0";
const EMAIL = "owner@example.com";
const PASSWORD = "correct horse battery";

function sessionToken(res: Response): string | undefined {
  return /(?:^|,\s*)[\w.-]*session_token=([^;.]+)/.exec(
    res.headers.get("set-cookie") ?? "",
  )?.[1];
}

async function sessionAddress(
  c: TestContext,
  res: Response,
): Promise<string | null> {
  const token = sessionToken(res);
  if (token === undefined) throw new Error("the sign-in set no session");
  const db = c.storage.betterAuthDb as {
    select: () => {
      from: (t: unknown) => {
        where: (w: unknown) => Promise<{ ipAddress: string | null }[]>;
      };
    };
  };
  const rows = await db
    .select()
    .from(auth_session)
    .where(eq(auth_session.token, decodeURIComponent(token)));
  return rows[0]?.ipAddress ?? null;
}

/** Headers a client can set to claim any address it likes. */
const SPOOFED = {
  "x-forwarded-for": "198.51.100.9",
  "x-real-ip": "198.51.100.10",
  "x-marfa-client-address": "198.51.100.11",
};

function signInDirect(
  c: TestContext,
  password: string,
  peer: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  return request(c.app, "POST", "/auth/sign-in/email", {
    body: { email: EMAIL, password },
    headers: { origin: ORIGIN, ...headers },
    peer,
  });
}

function signInForm(
  c: TestContext,
  password: string,
  peer: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  return request(c.app, "POST", "/auth/sign-in", {
    form: { email: EMAIL, password, return_to: "/" },
    headers: { origin: ORIGIN, ...headers },
    peer,
  });
}

describe("the address Better Auth sees", () => {
  it("is the connection's, whatever forwarding headers the client sent", async () => {
    ctx = await createTestContext();
    await createTestAccount(ctx, EMAIL, PASSWORD);

    const direct = await signInDirect(ctx, PASSWORD, "203.0.113.7", SPOOFED);
    expect(direct.status).toBe(200);
    expect(await sessionAddress(ctx, direct)).toBe("203.0.113.7");

    const form = await signInForm(ctx, PASSWORD, "203.0.113.8", SPOOFED);
    expect(form.status).toBe(302);
    expect(await sessionAddress(ctx, form)).toBe("203.0.113.8");
  });

  it("is the one the instance's trusted proxy header names, when it names one", async () => {
    ctx = await createTestContext({ trustedProxyHeader: "x-real-ip" });
    await createTestAccount(ctx, EMAIL, PASSWORD);

    const direct = await signInDirect(ctx, PASSWORD, "10.0.0.1", {
      "x-real-ip": "192.0.2.5",
      "x-forwarded-for": "198.51.100.9",
    });
    expect(direct.status).toBe(200);
    expect(await sessionAddress(ctx, direct)).toBe("192.0.2.5");

    const form = await signInForm(ctx, PASSWORD, "10.0.0.1", {
      "x-real-ip": "192.0.2.6",
    });
    expect(form.status).toBe(302);
    expect(await sessionAddress(ctx, form)).toBe("192.0.2.6");
  });
});

describe("the per-account sign-in throttle", () => {
  it("stops one address guessing one account, and leaves the owner's own address signing in", async () => {
    ctx = await createTestContext();
    await createTestAccount(ctx, EMAIL, PASSWORD);

    for (let i = 0; i < SIGN_IN_ADDRESS_LIMIT; i++) {
      const res = await signInDirect(ctx, "wrong password", "203.0.113.50");
      expect(res.status).toBe(401);
    }
    // Past the cap the door answers that it is throttled, before it asks
    // whether the password is right: the right one is refused too.
    expect((await signInDirect(ctx, "wrong", "203.0.113.50")).status).toBe(429);
    expect((await signInDirect(ctx, PASSWORD, "203.0.113.50")).status).toBe(
      429,
    );
    // Spoofing a forwarding header does not buy the guesser a new bucket.
    expect(
      (await signInDirect(ctx, "wrong", "203.0.113.50", SPOOFED)).status,
    ).toBe(429);

    // The owner, somewhere else, is not locked out.
    expect((await signInDirect(ctx, PASSWORD, "192.0.2.1")).status).toBe(200);
  });

  it("keys an IPv6 address by its /64, so a host cannot rotate within its own prefix", async () => {
    ctx = await createTestContext();
    await createTestAccount(ctx, EMAIL, PASSWORD);

    for (let i = 0; i < SIGN_IN_ADDRESS_LIMIT; i++) {
      const res = await signInDirect(
        ctx,
        "wrong",
        `2001:db8:1:2::${(i + 1).toString(16)}`,
      );
      expect(res.status).toBe(401);
    }
    expect(
      (await signInDirect(ctx, "wrong", "2001:db8:1:2::ffff")).status,
    ).toBe(429);
    expect((await signInDirect(ctx, PASSWORD, "2001:db8:1:3::1")).status).toBe(
      200,
    );
  });

  it("bounds the guesses at one account across every address", async () => {
    ctx = await createTestContext();
    await createTestAccount(ctx, EMAIL, PASSWORD);

    for (let i = 0; i < SIGN_IN_ACCOUNT_LIMIT; i++) {
      const res = await signInDirect(ctx, "wrong", `203.0.${String(i)}.1`);
      expect(res.status).toBe(401);
    }
    expect((await signInDirect(ctx, "wrong", "192.0.2.200")).status).toBe(429);
    // Another account is its own count.
    await createTestAccount(ctx, "other@example.com", PASSWORD);
    const other = await request(ctx.app, "POST", "/auth/sign-in/email", {
      body: { email: "other@example.com", password: PASSWORD },
      headers: { origin: ORIGIN },
      peer: "192.0.2.200",
    });
    expect(other.status).toBe(200);
  });

  it("tells the form's visitor the sign-in is throttled, not that the password is wrong", async () => {
    ctx = await createTestContext();
    await createTestAccount(ctx, EMAIL, PASSWORD);

    for (let i = 0; i < SIGN_IN_ADDRESS_LIMIT; i++) {
      const res = await signInForm(ctx, "wrong", "203.0.113.60");
      expect(res.headers.get("location")).toContain(
        "error=invalid_credentials",
      );
    }
    const throttled = await signInForm(ctx, PASSWORD, "203.0.113.60");
    expect(throttled.status).toBe(302);
    const location = throttled.headers.get("location") ?? "";
    expect(location).toContain("error=too_many_attempts");
    expect(throttled.headers.get("set-cookie")).toBeNull();

    const page = await request(ctx.app, "GET", location);
    const html = await page.text();
    expect(html).toContain("Too many sign-in attempts");
    expect(html).not.toContain("That email or password is wrong");
  });
});
