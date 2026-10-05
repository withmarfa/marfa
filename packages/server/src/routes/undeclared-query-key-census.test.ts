/**
 * Every door the app serves refuses a query key it does not declare, or is
 * named below with why it does not.
 *
 * A misspelled filter that is dropped answers the whole set, so the rule
 * holds on a door nobody has looked at yet: `createOpenAPIRouter` installs it
 * on every route, and this walk is what notices a door that was registered
 * some other way. It reads the app's own route table, so a door added
 * without the refusal has to be classified here before this file goes green.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestContext } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
  const registered = await ctx.app.request("/types", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ctx.workingKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      id: OWN_TYPE,
      fields: { title: { type: "string" } },
    }),
  });
  expect(registered.status).toBe(201);
});

afterAll(async () => {
  await ctx.cleanup();
});

const UNKNOWN_ID = "019537a0-7b80-7000-8000-000000000000";

/**
 * A type the working key registered, for the door that checks its path
 * names a writable type before the rest of the request is read.
 */
const OWN_TYPE = "census.door";
const BY_PATH: Record<string, string> = { "PUT /types/:id": OWN_TYPE };
const STRAY = "definitely-not-a-filter";

/**
 * Doors that take a query this rule cannot read, each with why.
 *
 * Every one is a page or a protocol endpoint whose query belongs to another
 * party: a sender, a browser following a redirect, or the Better Auth
 * library. None of them answers a set a dropped filter could widen.
 */
const OTHER_PARTIES_QUERY: Record<string, string> = {
  "POST /inbound/:token":
    "a sender's delivery, whose query string is recorded as it arrived",
  "GET /.well-known/oauth-authorization-server/auth":
    "RFC 8414 discovery, fetched by third-party OAuth clients",
  "GET /.well-known/openid-configuration/auth": "OIDC discovery, same",
  "GET /auth/.well-known/oauth-authorization-server":
    "the issuer-suffixed spelling of the same document",
  "GET /auth/.well-known/openid-configuration": "and of the OIDC one",
  "GET /.well-known/oauth-protected-resource":
    "RFC 9728 resource metadata, which a bearer challenge points at",
  "GET /auth/sign-in": "a page a redirect lands on, carrying the OAuth flow",
  "POST /auth/sign-in": "its form post",
  "GET /auth/authorize": "the consent screen, reached with the OAuth request",
  "POST /auth/authorize/decision": "its decision",
  "GET /auth/device": "the device-code entry page",
  "POST /auth/device": "its form post",
  "GET /auth/device/consent": "the device consent screen",
  "POST /auth/device/consent": "its decision",
  "GET /auth/error": "the OAuth failure page a redirect lands on",
  "GET /auth/oauth2/end-session":
    "the logout page, reached with the OAuth request",
  "GET /auth/static/auth.css": "a stylesheet those pages load",
  "GET /auth/static/password-toggle.js": "a script those pages load",
  "GET /auth/static/submit-state.js": "a script those pages load",
  "GET /auth/grants": "the page listing the apps the owner authorized",
  "DELETE /auth/grants/:id": "its revoke",
  "GET /auth/*": "the Better Auth catch-all, which answers its own protocol",
  "POST /auth/*": "the same catch-all",
};

function servedDoors(): string[] {
  const doors = new Set(ctx.app.routes.map((r) => `${r.method} ${r.path}`));
  doors.delete("ALL /*");
  return [...doors].filter(
    (door) => !door.startsWith("ALL ") && !(door in OTHER_PARTIES_QUERY),
  );
}

async function answer(
  door: string,
  key: string,
): Promise<{ status: number; unknown: unknown }> {
  const [method, path] = door.split(" ");
  const concrete = (path ?? "").replace(/:[^/]+/g, BY_PATH[door] ?? UNKNOWN_ID);
  const res = await ctx.app.request(`${concrete}?${STRAY}=1`, {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: method === "GET" || method === "DELETE" ? undefined : "{}",
  });
  let unknown: unknown;
  try {
    unknown = (
      (await res.json()) as {
        error?: { details?: { unknown_parameters?: unknown } };
      }
    ).error?.details?.unknown_parameters;
  } catch {
    unknown = undefined;
  }
  return { status: res.status, unknown };
}

describe("a query key no door declares", () => {
  it("is refused on every door the app serves but the ones whose query is another party's", async () => {
    const doors = servedDoors();
    // The positive control: the walk is over a table that has to have filled.
    expect(doors.length).toBeGreaterThan(100);
    const unrefused: string[] = [];
    for (const door of doors) {
      // Each door is tried as the credential that may use it. The working key
      // holds every permission; the operator key holds the instance routes
      // the working key does not.
      let refused = false;
      for (const key of [ctx.workingKey, ctx.operatorKey]) {
        const { status, unknown } = await answer(door, key);
        if (
          status === 400 &&
          Array.isArray(unknown) &&
          unknown.includes(STRAY)
        ) {
          refused = true;
          break;
        }
      }
      if (!refused) unrefused.push(door);
    }
    expect(unrefused.sort()).toEqual([]);
  });

  it("holds every exemption to a route that still exists", () => {
    const served = new Set(ctx.app.routes.map((r) => `${r.method} ${r.path}`));
    const stale = Object.keys(OTHER_PARTIES_QUERY).filter(
      (door) => !served.has(door),
    );
    expect(stale.sort()).toEqual([]);
  });

  it("answers a copy stream request the way every door does: 401, then the standing rule, then the query", async () => {
    const ask = (key?: string) =>
      ctx.app.request("/events?copy=1&edges=all&x=1", {
        headers: key === undefined ? {} : { Authorization: `Bearer ${key}` },
      });
    expect((await ask()).status).toBe(401);
    // The operator key reads no type, so the door turns it away whatever the query holds.
    expect((await ask(ctx.operatorKey)).status).toBe(403);
    // A key that may use the door meets the copy stream's own refusal of the key.
    expect((await ask(ctx.workingKey)).status).toBe(400);
  });
});
