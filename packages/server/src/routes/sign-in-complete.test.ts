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
