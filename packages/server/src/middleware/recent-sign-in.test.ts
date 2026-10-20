import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import * as clock from "../clock.js";
import {
  isRecentOwnerAuthentication,
  signedInRecently,
  type AppEnv,
  type DirectAuthority,
} from "./auth.js";

const MINUTE = 60_000;

function owner(signedInAgo: number): DirectAuthority {
  return {
    kind: "owner",
    userId: "user",
    sessionId: "session",
    userAgent: null,
    authenticatedAt: clock.nowMs() - signedInAgo,
  };
}

describe("signedInRecently", () => {
  it("holds for five minutes from the session's creation, to the millisecond", () => {
    const at = 10_000_000;
    expect(signedInRecently(at, at)).toBe(true);
    expect(signedInRecently(at - 5 * MINUTE, at)).toBe(true);
    expect(signedInRecently(at - 5 * MINUTE - 1, at)).toBe(false);
  });

  it("does not hold for a session from the future or one with no time", () => {
    expect(signedInRecently(10_001, 10_000)).toBe(false);
    expect(signedInRecently(Number.NaN, 10_000)).toBe(false);
  });
});

describe("isRecentOwnerAuthentication", () => {
  async function recent(
    authority: DirectAuthority | undefined,
    at?: number,
  ): Promise<string> {
    const app = new Hono<AppEnv>();
    app.use(async (c, next) => {
      c.set("authority", authority);
      await next();
    });
    app.get("/", (c) => c.text(String(isRecentOwnerAuthentication(c, at))));
    return (await app.request("/")).text();
  }

  it("holds for an owner session of five minutes and not for one of six", async () => {
    expect(await recent(owner(MINUTE))).toBe("true");
    expect(await recent(owner(5 * MINUTE - 1000))).toBe("true");
    expect(await recent(owner(6 * MINUTE))).toBe("false");
  });

  it("judges a session at the moment it is given, not at the current time", async () => {
    const session = owner(4 * MINUTE);
    const started = clock.nowMs();
    clock.advanceClock(2 * MINUTE);
    expect(await recent(session)).toBe("false");
    expect(await recent(session, started)).toBe("true");
    expect(await recent(session, started + 2 * MINUTE)).toBe("false");
  });

  it("does not hold for a session that signed in in the future", async () => {
    expect(await recent(owner(-MINUTE))).toBe("false");
  });

  it("holds for the local command and not for a request with no direct authority", async () => {
    expect(await recent({ kind: "local_process" })).toBe("true");
    expect(await recent(undefined)).toBe("false");
  });
});
