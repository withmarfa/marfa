import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import * as clock from "../clock.js";
import {
  isRecentOwnerAuthentication,
  type AppEnv,
  type DirectAuthority,
} from "../middleware/auth.js";
import { signInAgainBeforeConsent, signInAgainPath } from "./sign-in-again.js";

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

function ask(
  authority: DirectAuthority | undefined,
  requested: string[],
  held?: string[],
): Promise<Response> {
  const app = new Hono<AppEnv>();
  app.use(async (c, next) => {
    c.set("authority", authority);
    await next();
  });
  app.get(
    "/screen",
    (c) =>
      signInAgainBeforeConsent(c, requested, held, "/screen?a=1&b=2") ??
      c.text("shown"),
  );
  return Promise.resolve(app.request("/screen"));
}

describe("isRecentOwnerAuthentication", () => {
  async function recent(
    authority: DirectAuthority | undefined,
  ): Promise<string> {
    const app = new Hono<AppEnv>();
    app.use(async (c, next) => {
      c.set("authority", authority);
      await next();
    });
    app.get("/", (c) => c.text(String(isRecentOwnerAuthentication(c))));
    return (await app.request("/")).text();
  }

  it("holds for an owner session of five minutes and not for one of six", async () => {
    expect(await recent(owner(MINUTE))).toBe("true");
    expect(await recent(owner(5 * MINUTE - 1000))).toBe("true");
    expect(await recent(owner(6 * MINUTE))).toBe("false");
  });

  it("does not hold for a session that signed in in the future", async () => {
    expect(await recent(owner(-MINUTE))).toBe("false");
  });

  it("holds for the local command and not for a request with no direct authority", async () => {
    expect(await recent({ kind: "local_process" })).toBe("true");
    expect(await recent(undefined)).toBe("false");
  });
});

describe("signInAgainPath", () => {
  it("asks for the password again and carries the page back as one encoded value", () => {
    expect(signInAgainPath("/auth/authorize?a=1&b=2")).toBe(
      "/auth/sign-in?prompt=login&return_to=%2Fauth%2Fauthorize%3Fa%3D1%26b%3D2",
    );
  });
});

describe("signInAgainBeforeConsent", () => {
  it("sends a session of six minutes to sign in again for a write or a permission", async () => {
    for (const scope of ["core.note:write", "keys.manage", "*:write"]) {
      const response = await ask(owner(6 * MINUTE), ["core.note:read", scope]);
      expect(response.status, scope).toBe(302);
      expect(response.headers.get("location"), scope).toBe(
        signInAgainPath("/screen?a=1&b=2"),
      );
    }
  });

  it("shows the screen to a session of six minutes for a request that only reads", async () => {
    const response = await ask(owner(6 * MINUTE), [
      "core.note:read",
      "openid",
      "offline_access",
    ]);
    expect(response.status).toBe(200);
  });

  it("shows the screen to a session of one minute for the same request that sent the older one away", async () => {
    const scopes = ["core.note:read", "core.note:write", "keys.manage"];
    expect((await ask(owner(6 * MINUTE), scopes)).status).toBe(302);
    expect((await ask(owner(MINUTE), scopes)).status).toBe(200);
  });

  it("shows the screen to a session of six minutes when the app already holds what it asks for", async () => {
    const response = await ask(
      owner(6 * MINUTE),
      ["core.note:write", "keys.manage"],
      ["core.*:write", "keys.manage"],
    );
    expect(response.status).toBe(200);
  });

  it("shows the screen to the local command", async () => {
    const response = await ask({ kind: "local_process" }, ["keys.manage"]);
    expect(response.status).toBe(200);
  });

  it("sends a request with no direct authority to sign in again", async () => {
    const response = await ask(undefined, ["keys.manage"]);
    expect(response.status).toBe(302);
  });
});
