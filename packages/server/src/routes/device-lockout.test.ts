import { afterEach, describe, expect, it } from "vitest";
import { resetClockForTests, advanceClock, now } from "../clock.js";
import { visibleText } from "../pages/reading.js";
import type { TestContext } from "../test-utils.js";
import { createTestContext, request } from "../test-utils.js";
import {
  DEVICE_CODE_ADDRESS_LIMIT,
  DEVICE_CODE_INSTANCE_LIMIT,
} from "./auth-pages.js";

/**
 * The device code page says how long a person refused for too many lookups
 * has to wait, taken from the lane that refused them, and lets them in again
 * when that wait is over.
 */

let ctx: TestContext | undefined;

afterEach(async () => {
  await ctx?.cleanup();
  ctx = undefined;
  resetClockForTests();
});

const ORIGIN = "http://localhost:0";

function codeFor(n: number): string {
  return `AB${n.toString(36).toUpperCase().padStart(6, "2")}`;
}

async function submit(
  c: TestContext,
  code: string,
  peer: string,
  headers: Record<string, string> = {},
) {
  const res = await request(c.app, "POST", "/auth/device", {
    form: { user_code: code },
    headers: { origin: ORIGIN, ...headers },
    peer,
  });
  expect(res.status).toBe(302);
  return new URL(res.headers.get("location") ?? "", ORIGIN);
}

async function pageText(c: TestContext, location: URL): Promise<string> {
  const res = await request(c.app, "GET", location.pathname + location.search);
  expect(res.status).toBe(200);
  return visibleText(await res.text());
}

describe("the device code page after too many lookups", () => {
  it("names the address lane's wait in whole minutes, rounded up", async () => {
    ctx = await createTestContext();
    for (let i = 0; i < DEVICE_CODE_ADDRESS_LIMIT; i++)
      expect(
        (await submit(ctx, codeFor(i), "203.0.113.1")).searchParams.get(
          "error",
        ),
      ).toBe("invalid_code");

    const refused = await submit(ctx, codeFor(100), "203.0.113.1");
    expect(refused.searchParams.get("error")).toBe("too_many_attempts");
    const wait = Number(refused.searchParams.get("retry_after"));
    expect(wait).toBeGreaterThan(14 * 60);
    expect(wait).toBeLessThanOrEqual(15 * 60);
    expect(await pageText(ctx, refused)).toMatch(
      /Too many codes have been tried\. Try again in (14|15) minutes\./,
    );
  });

  it("names the instance lane's wait when every address together has spent it", async () => {
    ctx = await createTestContext();
    // Ten addresses of ten lookups each fill the instance's hundred.
    for (
      let a = 0;
      a < DEVICE_CODE_INSTANCE_LIMIT / DEVICE_CODE_ADDRESS_LIMIT;
      a++
    )
      for (let i = 0; i < DEVICE_CODE_ADDRESS_LIMIT; i++)
        await submit(ctx, codeFor(a * 100 + i), `198.51.100.${String(a + 1)}`);

    // A new address has its own lookups left, so only the instance lane can
    // be the one that refuses it.
    const refused = await submit(ctx, codeFor(9000), "192.0.2.77");
    expect(refused.searchParams.get("error")).toBe("too_many_attempts");
    expect(Number(refused.searchParams.get("retry_after"))).toBeGreaterThan(
      14 * 60,
    );
    expect(await pageText(ctx, refused)).toMatch(
      /Try again in (14|15) minutes/,
    );
  });

  it("names the later reset when the address lane and the instance lane are both spent", async () => {
    ctx = await createTestContext();
    // The instance lane's window opens first and ends first.
    await submit(ctx, codeFor(1), "198.51.100.1");
    advanceClock(10 * 60_000);
    // This address spends its ten in a window that ends nine minutes after
    // the instance lane's has ended.
    for (let i = 0; i < DEVICE_CODE_ADDRESS_LIMIT; i++)
      await submit(ctx, codeFor(10 + i), "203.0.113.9");
    advanceClock(6 * 60_000);
    // The instance lane's window has ended and opens again, and ten other
    // addresses fill its hundred.
    for (
      let a = 0;
      a < DEVICE_CODE_INSTANCE_LIMIT / DEVICE_CODE_ADDRESS_LIMIT;
      a++
    )
      for (let i = 0; i < DEVICE_CODE_ADDRESS_LIMIT; i++)
        await submit(
          ctx,
          codeFor(a * 100 + i + 100),
          `198.51.100.${String(a + 20)}`,
        );

    // The address lane refuses this address for nine more minutes, but the
    // instance lane would refuse it for fifteen.
    const refused = await submit(ctx, codeFor(5000), "203.0.113.9");
    expect(refused.searchParams.get("error")).toBe("too_many_attempts");
    const wait = Number(refused.searchParams.get("retry_after"));
    expect(wait).toBeGreaterThan(14 * 60);
    expect(wait).toBeLessThanOrEqual(15 * 60);
    expect(await pageText(ctx, refused)).toMatch(
      /Try again in (14|15) minutes/,
    );

    // After that wait the address is let in.
    advanceClock((wait + 1) * 1000);
    expect(
      (await submit(ctx, codeFor(5001), "203.0.113.9")).searchParams.get(
        "error",
      ),
    ).toBe("invalid_code");
  });

  it("names the owner lane instance's wait when only that lane is spent", async () => {
    ctx = await createTestContext();
    // One owner cannot fill the instance lane's hundred before the owner's own
    // ten, so the counter is seeded as the other tests of it do.
    for (let i = 0; i < DEVICE_CODE_INSTANCE_LIMIT; i++)
      await ctx.storage.rateLimits.incrementWindow(
        "device-user-code-owner-instance",
        "all",
        15 * 60_000,
        now().toISOString(),
      );
    const refused = await submit(ctx, codeFor(1), "192.0.2.1", {
      cookie: ctx.owner.cookie,
    });
    expect(refused.searchParams.get("error")).toBe("too_many_attempts");
    const wait = Number(refused.searchParams.get("retry_after"));
    expect(wait).toBeGreaterThan(14 * 60);
    expect(wait).toBeLessThanOrEqual(15 * 60);
    expect(await pageText(ctx, refused)).toMatch(
      /Try again in (14|15) minutes/,
    );
  });

  it("names the later reset when the owner lane and its instance lane are both spent", async () => {
    ctx = await createTestContext();
    const cookie = ctx.owner.cookie;
    // The instance lane's window opens five minutes after the owner's own
    // and so ends five minutes after it. The owner's ten lookups bring its
    // count to the cap.
    for (
      let i = 0;
      i < DEVICE_CODE_INSTANCE_LIMIT - DEVICE_CODE_ADDRESS_LIMIT;
      i++
    )
      await ctx.storage.rateLimits.incrementWindow(
        "device-user-code-owner-instance",
        "all",
        15 * 60_000,
        new Date(now().getTime() + 5 * 60_000).toISOString(),
      );
    for (let i = 0; i < DEVICE_CODE_ADDRESS_LIMIT; i++)
      expect(
        (
          await submit(ctx, codeFor(i), "192.0.2.1", { cookie })
        ).searchParams.get("error"),
      ).toBe("invalid_code");

    const refused = await submit(ctx, codeFor(99), "192.0.2.1", { cookie });
    expect(refused.searchParams.get("error")).toBe("too_many_attempts");
    const wait = Number(refused.searchParams.get("retry_after"));
    expect(wait).toBeGreaterThan(19 * 60);
    expect(wait).toBeLessThanOrEqual(20 * 60);
  });

  it("takes entries again once the wait is over", async () => {
    ctx = await createTestContext();
    for (let i = 0; i < DEVICE_CODE_ADDRESS_LIMIT; i++)
      await submit(ctx, codeFor(i), "203.0.113.2");
    const refused = await submit(ctx, codeFor(200), "203.0.113.2");
    const wait = Number(refused.searchParams.get("retry_after"));

    advanceClock((wait - 5) * 1000);
    expect(
      (await submit(ctx, codeFor(201), "203.0.113.2")).searchParams.get(
        "error",
      ),
    ).toBe("too_many_attempts");
    advanceClock(10 * 1000);
    expect(
      (await submit(ctx, codeFor(202), "203.0.113.2")).searchParams.get(
        "error",
      ),
    ).toBe("invalid_code");
  });

  it("promises no number of minutes when the address names none, or names nonsense", async () => {
    ctx = await createTestContext();
    for (const query of [
      "error=too_many_attempts",
      "error=too_many_attempts&retry_after=0",
      "error=too_many_attempts&retry_after=-5",
      "error=too_many_attempts&retry_after=soon",
      "error=too_many_attempts&retry_after=99999999",
      "error=too_many_attempts&retry_after=1.5",
    ]) {
      const text = await pageText(
        ctx,
        new URL(`/auth/device?${query}`, ORIGIN),
      );
      expect(text, query).toContain("Too many codes have been tried");
      expect(text, query).not.toMatch(/\d+ minutes?/);
    }
    // Witness: a wait the server could have named is shown.
    expect(
      await pageText(
        ctx,
        new URL("/auth/device?error=too_many_attempts&retry_after=300", ORIGIN),
      ),
    ).toContain("Try again in 5 minutes");
  });
});
