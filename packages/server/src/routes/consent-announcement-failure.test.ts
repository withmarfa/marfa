/** A failed grant event refuses the consent unit, including its provider code. */
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
  it("returns no code and leaves neither grant half when its event fails", async () => {
    const c = await createTestContext({});
    ctx = c;
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      initEventLog({
        ...c.storage.eventLog,
        append: () => Promise.reject(new Error("the event log is unwritable")),
      });
      const cookie = await signIn(c, "announce@example.com");
      const register = async (clientId: string): Promise<void> => {
        await c.storage.oauthProvider?.createClient({
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
      };
      const clientId = `announce-${randomBytes(5).toString("hex")}`;
      await register(clientId);
      const consent = async (clientId: string): Promise<Response> => {
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
          c.app,
          "GET",
          `/auth/oauth2/authorize?${params.toString()}`,
          { headers: { cookie } },
        );
        const location = authorize.headers.get("location") ?? "";
        expect(location).toContain("/auth/authorize?");
        const signedQuery = location.slice(location.indexOf("?") + 1);
        return request(c.app, "POST", "/auth/authorize/decision", {
          form: {
            accept: "true",
            oauth_query: signedQuery,
            scopes: ["core.note:read"],
          },
          headers: { cookie, origin: ORIGIN },
        });
      };
      const records = async (clientId: string): Promise<unknown[]> =>
        (
          await c.storage.items.list({ type: "system.connection", limit: 100 })
        ).data.filter(
          (row) =>
            (row.properties as { client_id?: string }).client_id === clientId,
        );

      const decision = await consent(clientId);
      expect(decision.status).toBe(500);
      expect(decision.headers.get("location")).toBeNull();

      await settle(100);
      expect(unhandled).toEqual([]);
      // No record the log never heard of.
      expect(await records(clientId)).toEqual([]);

      // The witness: with the log writable again, a consent records its
      // grant.
      initEventLog(c.storage.eventLog);
      const witness = `witness-${randomBytes(5).toString("hex")}`;
      await register(witness);
      expect((await consent(witness)).status).toBe(302);
      expect(await records(witness)).toHaveLength(1);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      initEventLog(c.storage.eventLog);
    }
  });
});
