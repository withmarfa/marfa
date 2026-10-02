/**
 * A grant's event that cannot be written does not end the process, and does
 * not take the person's consent with it.
 *
 * The consent door announces a new grant without waiting on it, after the
 * grant is written. The announcement used to be started with no handler, so
 * a failed event-log append was an unhandled rejection, and with nothing
 * listening for those the server ended.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import {
  createTestAccount,
  createTestContext,
  request,
  settle,
} from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { initEventLog } from "../pubsub.js";
import * as logger from "../middleware/logger.js";

vi.setConfig({ testTimeout: 45_000 });

const ORIGIN = "http://localhost:0";
const CALLBACK = "http://localhost:0/callback";

let ctx: TestContext | undefined;

afterEach(async () => {
  vi.restoreAllMocks();
  await ctx?.cleanup();
  ctx = undefined;
});

async function signIn(c: TestContext, email: string): Promise<string> {
  const password = "correct horse battery";
  await createTestAccount(c, email, password, "Test User");
  const res = await request(c.app, "POST", "/auth/sign-in/email", {
    body: { email, password },
    headers: { origin: ORIGIN },
  });
  const setCookie = res.headers.get("set-cookie") ?? "";
  for (const part of setCookie.split(/,\s*(?=[a-zA-Z0-9_-]+=)/)) {
    const head = part.split(";")[0];
    if (head?.includes("session_token")) return head;
  }
  throw new Error("session_token cookie not found");
}

describe("a consent whose event cannot be written", () => {
  it("still sends the person back with a code, and the failure is reported rather than left unhandled", async () => {
    ctx = await createTestContext({});
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    const logged = vi.spyOn(logger, "log");
    try {
      initEventLog({
        ...ctx.storage.eventLog,
        append: () => Promise.reject(new Error("the event log is unwritable")),
      });
      const cookie = await signIn(ctx, "announce@example.com");
      const clientId = `announce-${randomBytes(5).toString("hex")}`;
      await ctx.storage.oauthProvider?.createClient({
        clientId,
        name: "Announcing App",
        isPublic: true,
        grantTypes: ["authorization_code", "refresh_token"],
        responseTypes: ["code"],
        tokenEndpointAuthMethod: "none",
        scopes: ["core.note:read"],
        redirectUris: [CALLBACK],
        postLogoutRedirectUris: [ORIGIN + "/"],
      });
      const challenge = createHash("sha256")
        .update(randomBytes(32).toString("base64url"))
        .digest("base64url");
      const params = new URLSearchParams({
        response_type: "code",
        client_id: clientId,
        redirect_uri: CALLBACK,
        scope: "core.note:read",
        state: "announce",
        code_challenge: challenge,
        code_challenge_method: "S256",
      });
      const authorize = await request(
        ctx.app,
        "GET",
        `/auth/oauth2/authorize?${params.toString()}`,
        { headers: { cookie } },
      );
      const location = authorize.headers.get("location") ?? "";
      expect(location).toContain("/auth/authorize?");
      const signedQuery = location.slice(location.indexOf("?") + 1);

      const decision = await request(
        ctx.app,
        "POST",
        "/auth/authorize/decision",
        {
          form: {
            accept: "true",
            oauth_query: signedQuery,
            scopes: ["core.note:read"],
          },
          headers: { cookie, origin: ORIGIN },
        },
      );
      expect(decision.status).toBe(302);
      const back = new URL(decision.headers.get("location") ?? "", ORIGIN);
      expect(back.searchParams.get("code")).toBeTruthy();

      await settle(100);
      expect(unhandled).toEqual([]);
      expect(
        logged.mock.calls.some(
          ([level, message]) =>
            level === "error" &&
            message === "consent: the grant's event could not be written",
        ),
      ).toBe(true);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      initEventLog(ctx.storage.eventLog);
    }
  });
});
