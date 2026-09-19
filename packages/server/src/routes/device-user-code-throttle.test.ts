import { describe, it, expect, afterEach } from "vitest";
import { createTestContext } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";

/**
 * Per-`user_code` failed-attempt throttle on the device-flow
 * verification form (`POST /auth/device` user-code submission).
 *
 * The per-IP rate limit (`middleware/rate-limit.ts`) bounds one client
 * guessing codes, but a distributed guesser rotating IPs would slip
 * under it. This throttle keys on the submitted `user_code` itself, so a
 * brute-force sweep against the short user-code range is capped per code
 * regardless of source IP. Only failed submissions increment; a valid
 * code that advances to consent never touches the counter.
 *
 * Rate-limit middleware is off in the test context, so a 302 redirect
 * carrying `error=too_many_attempts` is the throttle firing — not the
 * per-IP cap.
 */

let ctx: TestContext | undefined;

afterEach(async () => {
  await ctx?.cleanup();
  ctx = undefined;
});

const ORIGIN = "http://localhost:0";

/** Submit a `user_code` to the verification form. Returns the redirect
 *  Location (302) so the test can read the surfaced error code. */
async function submitUserCode(
  c: TestContext,
  userCode: string,
): Promise<{ status: number; location: string }> {
  const res = await c.app.fetch(
    new Request(`${ORIGIN}/auth/device`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: ORIGIN,
      },
      body: new URLSearchParams({ user_code: userCode }).toString(),
      redirect: "manual",
    }),
  );
  return { status: res.status, location: res.headers.get("location") ?? "" };
}

describe("device-flow per-user_code attempt throttle", () => {
  it("denies after repeated failed user_code submissions", async () => {
    ctx = await createTestContext({});

    // A well-formed but non-existent code. The default cap is 5 failed
    // attempts; submissions 1–5 surface `invalid_code`, submission 6
    // crosses the cap and surfaces `too_many_attempts`.
    const bogus = "ABCD-2345";

    for (let i = 0; i < 5; i++) {
      const { status, location } = await submitUserCode(ctx, bogus);
      expect(status).toBe(302);
      expect(location).toContain("error=invalid_code");
    }

    const overflow = await submitUserCode(ctx, bogus);
    expect(overflow.status).toBe(302);
    expect(overflow.location).toContain("error=too_many_attempts");

    // Still throttled on subsequent attempts within the window.
    const stillBlocked = await submitUserCode(ctx, bogus);
    expect(stillBlocked.location).toContain("error=too_many_attempts");
  });

  it("throttles per code — a different code is unaffected", async () => {
    ctx = await createTestContext({});

    // Poison one code to its cap.
    const poisoned = "BCDE-3456";
    for (let i = 0; i < 6; i++) {
      await submitUserCode(ctx, poisoned);
    }
    const blocked = await submitUserCode(ctx, poisoned);
    expect(blocked.location).toContain("error=too_many_attempts");

    // A different (also non-existent) code starts fresh — the throttle
    // is keyed per code, not globally.
    const other = await submitUserCode(ctx, "CDEF-4567");
    expect(other.location).toContain("error=invalid_code");
    expect(other.location).not.toContain("too_many_attempts");
  });
});
