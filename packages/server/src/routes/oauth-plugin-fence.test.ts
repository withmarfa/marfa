import { describe, it, expect, afterEach, vi } from "vitest";
import { oauthProvider } from "@better-auth/oauth-provider";
import {
  createTestContext,
  markEmailVerified,
  request,
} from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import {
  FENCED_PLUGIN_ENDPOINTS,
  REACHABLE_PLUGIN_ENDPOINTS,
} from "./oauth-plugin-fence.js";

/**
 * The OAuth Provider plugin's management endpoints are refused before the
 * catch-all can serve them, and the list of what is refused is held to what
 * the plugin actually registers.
 *
 * Two properties, and neither implies the other. The enumeration case says
 * the two lists between them name every `/oauth2/*` and `/admin/oauth2/*`
 * path the vendored plugin registers and nothing it does not, so a plugin
 * upgrade that adds a door, or a fence entry that has gone stale, both
 * redden. The driven cases say the fence is actually mounted ahead of the
 * catch-all: a signed-in session reaching a fenced path gets the Marfa 404
 * and the row it aimed at is unchanged, while the protocol endpoints beside
 * it still answer as themselves.
 */

vi.setConfig({ testTimeout: 45_000 });

let ctx: TestContext | undefined;

afterEach(async () => {
  await ctx?.cleanup();
  ctx = undefined;
});

const ORIGIN = "http://localhost:0";

/** Every `/oauth2/*` or `/admin/oauth2/*` path the plugin registers, read
 *  off the plugin's own endpoint record rather than from a list somebody
 *  typed. Options are the minimum the factory accepts; endpoint
 *  registration does not depend on them. */
function pluginOauthPaths(): string[] {
  const plugin = oauthProvider({
    loginPage: "/auth/sign-in",
    consentPage: "/auth/authorize",
  });
  const endpoints = (
    plugin as unknown as { endpoints: Record<string, { path: string }> }
  ).endpoints;
  const paths = new Set<string>();
  for (const endpoint of Object.values(endpoints)) {
    const path = endpoint.path;
    if (path.startsWith("/oauth2/") || path.startsWith("/admin/oauth2/")) {
      paths.add(path);
    }
  }
  return [...paths].sort();
}

/** Sign up + verify + sign in; returns the session cookie (`name=value`). */
async function signInUser(c: TestContext, email: string): Promise<string> {
  const password = "correct horse battery";
  const signUpRes = await request(c.app, "POST", "/auth/sign-up/email", {
    body: { email, password, name: "Fence Test User" },
    headers: { origin: ORIGIN },
  });
  if (signUpRes.status !== 200) {
    throw new Error(`sign-up failed (${String(signUpRes.status)})`);
  }
  await markEmailVerified(c.storage, email);
  const signInRes = await request(c.app, "POST", "/auth/sign-in/email", {
    body: { email, password },
    headers: { origin: ORIGIN },
  });
  if (signInRes.status !== 200) {
    throw new Error(`sign-in failed (${String(signInRes.status)})`);
  }
  const setCookie = signInRes.headers.get("set-cookie");
  if (!setCookie) throw new Error("sign-in: no Set-Cookie header");
  for (const part of setCookie.split(/,\s*(?=[a-zA-Z0-9_-]+=)/)) {
    const head = part.split(";")[0];
    if (head?.includes("session_token")) return head;
  }
  throw new Error("sign-in: session_token cookie not found");
}

/** Substitute concrete segments for the Hono parameters a fenced path
 *  carries, so a request can actually be sent to it. */
function concrete(path: string): string {
  return path
    .replace(":identifier", "https%3A%2F%2Fapi.example.com")
    .replace(":client_id", "some-client");
}

async function countClients(c: TestContext): Promise<number> {
  const schema =
    c.storage.betterAuthDialect === "pg"
      ? await import("../storage/pg/schema.js")
      : await import("../storage/sqlite/schema.js");
  const db = c.storage.betterAuthDb as {
    select: () => { from: (table: unknown) => Promise<unknown[]> };
  };
  const rows = await db.select().from(schema.auth_oauth_client);
  return rows.length;
}

describe("the plugin's management endpoints are fenced", () => {
  it("the reachable and fenced lists between them name every /oauth2 path the plugin registers, and nothing else", () => {
    const registered = pluginOauthPaths();
    const reachable = new Set(REACHABLE_PLUGIN_ENDPOINTS);
    const fenced = new Set(FENCED_PLUGIN_ENDPOINTS);

    // A path in both lists is a contradiction: the fence would win at
    // runtime and the reachable list would be lying about it.
    for (const path of reachable) expect(fenced.has(path)).toBe(false);

    // Every registered path is decided one way or the other. A plugin
    // upgrade that registers something new lands here first.
    const undecided = registered.filter(
      (path) => !reachable.has(path) && !fenced.has(path),
    );
    expect(undecided).toEqual([]);

    // And both lists describe paths that exist, so a stale entry — a path
    // the plugin stopped registering — reddens rather than reading as a
    // protection.
    const known = new Set(registered);
    for (const path of [...reachable, ...fenced]) {
      expect(known.has(path), `${path} is not a plugin endpoint`).toBe(true);
    }
  });

  it("a signed-in session gets the Marfa 404 on every fenced path and changes nothing", async () => {
    ctx = await createTestContext({ authAllowSignup: true });
    const cookie = await signInUser(ctx, "fence@example.com");
    const clientsBefore = await countClients(ctx);

    for (const path of FENCED_PLUGIN_ENDPOINTS) {
      for (const method of ["GET", "POST"]) {
        const res = await request(ctx.app, method, `/auth${concrete(path)}`, {
          headers: { cookie, origin: ORIGIN },
          // A body a real caller would send, so the fence is shown to win
          // before any handler could read it.
          ...(method === "POST" && {
            body: {
              id: "x",
              client_id: "some-client",
              client_name: "Fenced",
              redirect_uris: ["https://example.com/cb"],
              update: { scopes: ["core.note:read"] },
            },
          }),
        });
        expect(res.status, `${method} ${path}`).toBe(404);
        expect(res.headers.get("x-error-code"), `${method} ${path}`).toBe(
          "not_found",
        );
        const body = (await res.json()) as { error?: { code?: string } };
        expect(body.error?.code, `${method} ${path}`).toBe("not_found");
      }
    }

    // `POST /oauth2/create-client` would have written a row for this
    // session's own space; the count is what says it never ran.
    expect(await countClients(ctx)).toBe(clientsBefore);
  });

  it("the protocol endpoints beside the fence still answer as themselves", async () => {
    ctx = await createTestContext({ authAllowSignup: true });

    // The plugin's own refusal, not a 404: a token request with no grant.
    const token = await request(ctx.app, "POST", "/auth/oauth2/token", {
      form: { grant_type: "refresh_token" },
      headers: { origin: ORIGIN },
    });
    expect(token.status).not.toBe(404);
    expect(token.status).toBeGreaterThanOrEqual(400);
    expect(token.status).toBeLessThan(500);

    // Userinfo with no bearer is the plugin's 401.
    const userinfo = await request(ctx.app, "GET", "/auth/oauth2/userinfo");
    expect(userinfo.status).toBe(401);

    // Registration is Marfa's own handler, mounted ahead of the fence and
    // the catch-all alike; its content-type refusal proves it still runs.
    const register = await request(ctx.app, "POST", "/auth/oauth2/register", {
      form: { client_name: "x" },
    });
    expect(register.status).toBe(400);
    const body = (await register.json()) as { error?: string };
    expect(body.error).toBe("invalid_client_metadata");
  });
});
