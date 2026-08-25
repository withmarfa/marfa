import { describe, it, expect, afterEach } from "vitest";
import {
  createTestContext,
  markEmailVerified,
  request,
} from "../test-utils.js";
import type { TestContext } from "../test-utils.js";

/**
 * The return leg of a sign-in link.
 *
 * A magic link on the OAuth path has to carry the signed authorize query back
 * to `/auth/authorize` intact. It used to travel as the `callbackURL` handed
 * to Better Auth, and did not survive: the verify endpoint decodes that value
 * a second time, after better-call has already decoded it once, so a `%2B` in
 * the query arrived as a literal `+` and the next parser read it as a space.
 * The signature then failed to match and the user was told their request had
 * expired, on roughly half of all attempts, because roughly half of base64
 * signatures contain a `+`.
 *
 * These tests pin the property that fixes it: what Better Auth is handed
 * contains nothing a decode can change, and the destination comes back
 * byte-for-byte.
 */

let ctx: TestContext | undefined;

afterEach(async () => {
  await ctx?.cleanup();
  ctx = undefined;
});

const ORIGIN = "http://localhost:0";

/** A return path shaped like the real one: a signed authorize query whose
 *  base64 signature contains the `+` that used to break the round trip. */
const SIGNED_RETURN_TO =
  "/auth/authorize?response_type=code&client_id=marfa-tickets" +
  "&exp=9999999999&sig=BET18rqMuNKqxb8v32Q0S7bXVAd2SyMDGWh9wAqp%2B%2BA%3D";

const encodeNext = (value: string): string =>
  Buffer.from(value, "utf8").toString("base64url");

/** The emailed link, or a failure that names what was missing rather than a
 *  null-dereference three lines later. */
function emailedMagicLink(body: string): string {
  const match = /https?:\/\/\S*magic-link\/verify\S*?(?=["\s<])/.exec(body);
  if (!match) throw new Error("no magic link was emailed");
  return match[0];
}

function queryParam(url: string, name: string): string {
  const value = new URL(url).searchParams.get(name);
  if (value === null) throw new Error(`${name} is missing from ${url}`);
  return value;
}

async function postSignIn(
  context: TestContext,
  body: Record<string, string>,
): Promise<Response> {
  return context.app.fetch(
    new Request(`${ORIGIN}/auth/sign-in`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: ORIGIN,
      },
      body: new URLSearchParams(body).toString(),
    }),
  );
}

describe("the emailed sign-in link", () => {
  it("carries the destination in an alphabet a second decode cannot change", async () => {
    const sent: string[] = [];
    ctx = await createTestContext({ authAllowSignup: true }, {
      send: (message: { text?: string; html?: string }) => {
        sent.push(`${message.text ?? ""}${message.html ?? ""}`);
        return Promise.resolve({ ok: true as const });
      },
    } as never);

    await request(ctx.app, "POST", "/auth/sign-up/email", {
      body: {
        email: "jonah@example.com",
        password: "correct horse",
        name: "Jonah",
      },
      headers: { origin: ORIGIN },
    });
    await markEmailVerified(ctx.storage, "jonah@example.com");

    const res = await postSignIn(ctx, {
      mode: "magic",
      email: "jonah@example.com",
      return_to: SIGNED_RETURN_TO,
    });
    expect(res.status).toBe(302);

    const link = emailedMagicLink(sent.join("\n"));
    const callbackURL = queryParam(link, "callbackURL");

    // The whole defect in one assertion. Whatever we hand over is decoded
    // twice on the way back, so it must survive being decoded twice.
    expect(decodeURIComponent(callbackURL)).toBe(callbackURL);

    const next = queryParam(callbackURL, "next");
    expect(Buffer.from(next, "base64url").toString("utf8")).toBe(
      SIGNED_RETURN_TO,
    );
  });
});

describe("GET /auth/sign-in/complete", () => {
  it("returns the signed query byte-for-byte, plus signs intact", async () => {
    ctx = await createTestContext();
    const res = await ctx.app.fetch(
      new Request(
        `${ORIGIN}/auth/sign-in/complete?next=${encodeNext(SIGNED_RETURN_TO)}`,
        { headers: { origin: ORIGIN } },
      ),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(SIGNED_RETURN_TO);

    // Spelled out because this is the exact byte that used to be lost: the
    // escape must still be an escape, not the `+` it decodes to.
    expect(res.headers.get("location")).toContain("%2B%2B");
    expect(res.headers.get("location")).not.toContain("++");
  });

  it("renders the dead-link page when the verify bounced", async () => {
    ctx = await createTestContext();
    const res = await ctx.app.fetch(
      new Request(
        `${ORIGIN}/auth/sign-in/complete?error=INVALID_TOKEN&next=${encodeNext("/")}`,
        { headers: { origin: ORIGIN } },
      ),
    );
    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).toContain("That sign-in link didn&#39;t work");
    // Names both causes rather than picking one: the verify step reports a
    // spent token and a timed-out one identically.
    expect(body).toContain("already been used");
    expect(body).toContain("Send another link");
  });

  /**
   * The closed-signup bounce is the one error code where the dead-link
   * copy would be a loop rather than a fix: another link resolves to the
   * same absent account and bounces identically. The page has to stop
   * offering one.
   */
  it("does not invite a retry when the bounce was a closed sign-up", async () => {
    ctx = await createTestContext();
    const res = await ctx.app.fetch(
      new Request(
        `${ORIGIN}/auth/sign-in/complete?error=new_user_signup_disabled&next=${encodeNext("/")}`,
        { headers: { origin: ORIGIN } },
      ),
    );
    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).toContain("isn&#39;t open for new accounts");
    expect(body).not.toContain("Send another link");
    expect(body).not.toContain("already been used");
  });

  /**
   * The renderer's own tests prove it names a host it is given. This one
   * proves the route gives it one, from the instance's resolved config
   * rather than from the request — a distinction that matters because the
   * request's host is whatever the client sent and this string is rendered
   * straight back to them. The call site had no coverage at all until this
   * test; both halves were tested and the wire between them was not.
   */
  it("names the server the refusal came from, taken from config", async () => {
    ctx = await createTestContext({ authBaseUrl: "https://staging.marfa.so" });
    const res = await ctx.app.fetch(
      new Request(
        `${ORIGIN}/auth/sign-in/complete?error=new_user_signup_disabled&next=${encodeNext("/")}`,
        { headers: { origin: ORIGIN } },
      ),
    );
    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).toContain("Sign-in links on staging.marfa.so");
    expect(body).toContain("only work for accounts that already exist here");
  });

  /**
   * A host in the request cannot reach the page. Someone following a link
   * to a Marfa instance must not be shown a hostname an attacker chose.
   */
  it("ignores a host supplied by the request", async () => {
    // `Host` and `X-Forwarded-Host` both, because the second is the usual
    // vector for this class of bug and the handler reads neither. Node's
    // Request does not strip a manually-set Host, so these genuinely reach
    // the handler rather than being dropped before it.
    for (const headers of [
      { origin: ORIGIN, host: "evil.example.com" },
      { origin: ORIGIN, "x-forwarded-host": "evil.example.com" },
    ]) {
      ctx = await createTestContext({
        authBaseUrl: "https://staging.marfa.so",
      });
      const res = await ctx.app.fetch(
        new Request(
          `${ORIGIN}/auth/sign-in/complete?error=new_user_signup_disabled&next=${encodeNext("/")}`,
          { headers },
        ),
      );
      expect(res.status).toBe(400);
      const body = await res.text();
      expect(body).toContain("staging.marfa.so");
      expect(body).not.toContain("evil.example.com");
      await ctx.cleanup();
      ctx = undefined;
    }
  });

  /**
   * The deployment that has not configured its public identity.
   *
   * `config.authBaseUrl` falls back to a localhost URL when
   * `MARFA_AUTH_BASE_URL` is unset, and naming that to somebody who
   * reached this page at a real domain is worse than naming nothing. The
   * renderer's own tests cover the rule; this covers that the route is
   * subject to it rather than routing around it.
   */
  it("names no host when the instance has only the localhost fallback", async () => {
    ctx = await createTestContext({ authBaseUrl: "http://localhost:8600" });
    const res = await ctx.app.fetch(
      new Request(
        `${ORIGIN}/auth/sign-in/complete?error=new_user_signup_disabled&next=${encodeNext("/")}`,
        { headers: { origin: ORIGIN } },
      ),
    );
    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).toContain("isn&#39;t open for new accounts");
    // Scoped to the message rather than the whole document. Asserting no
    // "localhost" anywhere would also fail the day the layout emits an
    // absolute asset URL derived from the same config value, and would
    // read as a regression in this page rather than in the layout.
    const message = /<p class="sub"[^>]*>([\s\S]*?)<\/p>/.exec(body)?.[1] ?? "";
    expect(message).not.toContain("Sign-in links on ");
    expect(message).not.toContain("localhost");
  });

  it("refuses to forward somewhere off-origin", async () => {
    ctx = await createTestContext();
    for (const hostile of [
      "https://evil.example.com/steal",
      "//evil.example.com/steal",
      "/\\evil.example.com",
    ]) {
      const res = await ctx.app.fetch(
        new Request(
          `${ORIGIN}/auth/sign-in/complete?next=${encodeNext(hostile)}`,
          { headers: { origin: ORIGIN } },
        ),
      );
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe("/");
    }
  });

  it("falls back to the root when next is missing or unreadable", async () => {
    ctx = await createTestContext();
    for (const query of ["", "?next="]) {
      const res = await ctx.app.fetch(
        new Request(`${ORIGIN}/auth/sign-in/complete${query}`, {
          headers: { origin: ORIGIN },
        }),
      );
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe("/");
    }
  });
});

describe("resending a sign-in link", () => {
  it("says sent every time but only sends once a minute", async () => {
    const sent: string[] = [];
    ctx = await createTestContext({ authAllowSignup: true }, {
      send: (message: { text?: string; html?: string }) => {
        sent.push(`${message.text ?? ""}${message.html ?? ""}`);
        return Promise.resolve({ ok: true as const });
      },
    } as never);

    await request(ctx.app, "POST", "/auth/sign-up/email", {
      body: {
        email: "resend@example.com",
        password: "correct horse",
        name: "Resend",
      },
      headers: { origin: ORIGIN },
    });
    await markEmailVerified(ctx.storage, "resend@example.com");

    const first = await postSignIn(ctx, {
      mode: "magic",
      email: "resend@example.com",
      return_to: SIGNED_RETURN_TO,
    });
    const second = await postSignIn(ctx, {
      mode: "magic",
      email: "resend@example.com",
      return_to: SIGNED_RETURN_TO,
    });

    // Indistinguishable to the caller, deliberately. A different answer for
    // the throttled attempt would be the one response on this surface that
    // varies with something other than what the user typed.
    for (const res of [first, second]) {
      expect(res.status).toBe(302);
      const location = res.headers.get("location") ?? "";
      expect(location).toContain("sent=1");
      // Carried back so the confirmation screen can resend without asking
      // for the address again.
      expect(location).toContain("email=resend%40example.com");
    }

    // Only the sign-in links count. Signing up sent a verification email
    // through the same transport, and counting that would have made the
    // throttle look like it worked when it had not.
    const links = sent.filter((body) => body.includes("magic-link/verify"));
    expect(links).toHaveLength(1);
  });
});
