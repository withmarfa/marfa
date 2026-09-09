/**
 * The rule that decides who may act on an HTML surface a space permission
 * gates.
 *
 * These routes accept either a bearer token or a browser session, and the two
 * branches answer different questions. A bearer is held to the space
 * permission the surface names. A session is not: these pages are part of the
 * consent surface rather than something reached through it, so there is no
 * grant behind them for a space permission to have been ticked on, and what
 * the session has to resolve to is a space. That is the refusal worth
 * pinning — downstream, `spaceId: undefined` is not "no space", it is "no
 * space filter", so an unresolved session would reach across spaces.
 *
 * Driven against the resolver directly. The route-level suites cover the
 * happy paths; what was missing is the refusals, which is the half a
 * gate exists for.
 */
import { describe, it, expect } from "vitest";
import type { Context } from "hono";
import type { ApiKey, User } from "@withmarfa/shared";
import { ErrorCode } from "@withmarfa/shared";
import { resolveSpaceCaller } from "./_space-caller.js";
import type { AppEnv } from "../middleware/auth.js";
import type { Storage } from "../storage/interface.js";
import type { MarfaAuth } from "../auth/instance.js";

function fakeUser(over: Partial<User>): User {
  return {
    id: "u1",
    name: null,
    first_name: null,
    last_name: null,
    bio: null,
    avatar_blob_hash: null,
    provider: "credential",
    timezone: null,
    provider_id: "p1",
    space_id: "space-1",
    handle: "someone",
    auth_user_id: "auth-1",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

/** A context carrying a session but no bearer — the browser navigation case. */
function sessionContext(): Context<AppEnv> {
  return {
    get: () => undefined,
    req: {
      raw: { headers: new Headers() },
      header: () => undefined,
      url: "https://marfa.test/integrations/x/install",
    },
    redirect: () => new Response(null, { status: 302 }),
  } as unknown as Context<AppEnv>;
}

function storageWith(user: User | null): Storage {
  return {
    users: {
      getByAuthUserId: () => Promise.resolve(user),
    },
  } as unknown as Storage;
}

const auth = {
  getSession: () => Promise.resolve({ user: { id: "auth-1" } }),
} as unknown as MarfaAuth;

async function resolve(user: User | null) {
  return resolveSpaceCaller(
    sessionContext(),
    storageWith(user),
    auth,
    "Your account is not attached to a space",
    "space.connections",
  );
}

describe("resolveSpaceCaller — the session branch", () => {
  it("admits a signed-in person whose account resolves to a space", async () => {
    const caller = await resolve(fakeUser({}));
    expect(caller).toMatchObject({
      apiKeyId: "auth_user:auth-1",
      spaceId: "space-1",
    });
  });

  it("refuses when no space resolves, rather than returning an unscoped caller", async () => {
    // The dangerous shape. `spaceId: undefined` reads downstream as "do
    // not filter by space", so returning it for a session whose space
    // could not be resolved hands a browser caller the operator tier.
    await expect(resolve(null)).rejects.toMatchObject({
      code: ErrorCode.FORBIDDEN,
    });
  });

  it("refuses a session whose user row carries no space", async () => {
    await expect(resolve(fakeUser({ space_id: "" }))).rejects.toMatchObject({
      code: ErrorCode.FORBIDDEN,
    });
  });

  it("admits the account holder of a keys-mode self-host, in the instance's one space", async () => {
    // **Keys mode has no per-user space model and does have a space.** The
    // answer here used to be `undefined`, on the reasoning that a space-less
    // caller on such an instance is the only space it has rather than
    // authority over every space. That was true while nothing there had a
    // space; bootstrap now provisions one and mints the working credential
    // into it, and `undefined` reads downstream as "do not filter by space",
    // which is a different thing — a connection installed through one of these
    // pages would be written where the instance's own credential cannot see
    // it, and could never mint a runtime credential at all.
    const caller = await resolveSpaceCaller(
      sessionContext(),
      {
        spaces: { list: () => Promise.resolve([{ id: "only-space" }]) },
      } as unknown as Storage,
      auth,
      "Your account is not attached to a space",
      "space.connections",
    );
    expect(caller).toMatchObject({
      apiKeyId: "auth_user:auth-1",
      spaceId: "only-space",
    });
  });

  it("refuses a keys-mode session when there is not exactly one space", async () => {
    // Nothing here can pick between two, and there is nothing to act in when
    // there are none. Guessing would write into whichever the store happened
    // to return first, which is the failure the `undefined` answer used to be.
    for (const spaces of [[], [{ id: "a" }, { id: "b" }]]) {
      await expect(
        resolveSpaceCaller(
          sessionContext(),
          {
            spaces: { list: () => Promise.resolve(spaces) },
          } as unknown as Storage,
          auth,
          "Your account is not attached to a space",
          "space.connections",
        ),
      ).rejects.toMatchObject({ code: ErrorCode.FORBIDDEN });
    }
  });
});

describe("resolveSpaceCaller — the bearer branch asks the space permission", () => {
  function bearerContext(key: ApiKey): Context<AppEnv> {
    return {
      get: (name: string) => (name === "apiKey" ? key : undefined),
      req: {
        raw: { headers: new Headers() },
        header: () => "Bearer x",
        url: "https://marfa.test/integrations/x/install",
      },
    } as unknown as Context<AppEnv>;
  }

  function fakeKey(over: Partial<ApiKey>): ApiKey {
    return {
      id: "k1",
      space_id: "space-1",
      label: "t",
      source: "t",
      space_permissions: ["space.connections"],
      default_tier: "library",
      is_operator: false,
      type_permissions: {},
      extension_permissions: {},
      edge_permissions: {},
      metadata_permissions: {},
      created_at: "2026-01-01T00:00:00.000Z",
      last_used_at: null,
      ...over,
    };
  }

  it("admits a key holding the space permission the surface names", async () => {
    const caller = await resolveSpaceCaller(
      bearerContext(fakeKey({})),
      storageWith(null),
      auth,
      "nope",
      "space.connections",
    );
    expect(caller).toMatchObject({ apiKeyId: "k1", spaceId: "space-1" });
  });

  /** A bearer context that reports itself as OAuth, with a granted scope set. */
  function oauthContext(key: ApiKey, scopes: string[]): Context<AppEnv> {
    return {
      get: (name: string) =>
        name === "apiKey"
          ? key
          : name === "authType"
            ? "oauth"
            : name === "oauthGrant"
              ? { scopes, clientId: "c1", authUserId: "u1" }
              : undefined,
      req: {
        raw: { headers: new Headers() },
        header: () => "Bearer x",
        url: "https://marfa.test/integrations/x/install",
      },
    } as unknown as Context<AppEnv>;
  }

  it("refuses a signed-in app that was not granted the space permission", async () => {
    // The case the resolver exists to answer. The key this app signed in
    // through holds `space.connections` on its row; the grant does not, and
    // the grant is what an OAuth caller is held to. Without this, the
    // surfaces behind the resolver were reachable by any app at all — which
    // is how the `GET` half of a door stayed open while its `POST` twin was
    // closed.
    await expect(
      resolveSpaceCaller(
        oauthContext(fakeKey({}), ["openid"]),
        storageWith(null),
        auth,
        "nope",
        "space.connections",
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("admits a signed-in app that holds it", async () => {
    const caller = await resolveSpaceCaller(
      oauthContext(fakeKey({}), ["openid", "space.connections"]),
      storageWith(null),
      auth,
      "nope",
      "space.connections",
    );
    expect(caller).toMatchObject({ apiKeyId: "k1", spaceId: "space-1" });
  });

  it("asks for the space permission it was handed, not a fixed one", async () => {
    // The parameter is what makes a new surface behind this resolver have to
    // answer the question. A hard-coded literal would let one be added under
    // the wrong authority and still look gated.
    await expect(
      resolveSpaceCaller(
        oauthContext(fakeKey({}), ["openid", "space.connections"]),
        storageWith(null),
        auth,
        "nope",
        "space.credentials",
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("refuses a key that holds nothing", async () => {
    await expect(
      resolveSpaceCaller(
        bearerContext(fakeKey({ space_permissions: [] })),
        storageWith(null),
        auth,
        "nope",
        "space.connections",
      ),
    ).rejects.toMatchObject({ code: ErrorCode.FORBIDDEN });
  });
});
