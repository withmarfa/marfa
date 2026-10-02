import { describe, it, expect, afterEach } from "vitest";
import { createTestContext, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import {
  DEVICE_CODE_ADDRESS_LIMIT,
  DEVICE_CODE_INSTANCE_LIMIT,
} from "./auth-pages.js";

/**
 * The device code entry form (`POST /auth/device`) limits how many codes
 * are tried, per caller address and across the instance, whatever codes they
 * are. A sweep tries each code once, so only a count that ignores which code
 * was submitted can stop one.
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
): Promise<string> {
  const res = await request(c.app, "POST", "/auth/device", {
    form: { user_code: userCode },
    headers: { origin: ORIGIN },
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
});
