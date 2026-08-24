/**
 * The rule that decides who may act on a space-admin HTML surface.
 *
 * These routes accept either a bearer token or a browser session, and the
 * two branches were not held to the same standard. The bearer branch
 * required space-admin authority; the session branch required only that
 * somebody was signed in, and then handed back whatever space resolved —
 * including none. Downstream, `spaceId: undefined` is not "no space", it
 * is "no space filter", so an unresolved session reached across spaces.
 *
 * Driven against the resolver directly. The route-level suites cover the
 * happy paths; what was missing is the refusals, which is the half a
 * gate exists for.
 */
import { describe, it, expect } from "vitest";
import type { Context } from "hono";
import type { ApiKey, User } from "@withmarfa/shared";
import { MarfaError, ErrorCode } from "@withmarfa/shared";
import { resolveSpaceAdminCaller } from "./_space-caller.js";
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
    role: "member",
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
  return resolveSpaceAdminCaller(
    sessionContext(),
    storageWith(user),
    auth,
    "Space admin authority required",
  );
}

describe("resolveSpaceAdminCaller — the session branch", () => {
  it("refuses a signed-in member, as the bearer branch already does", async () => {
    // Being signed in is not authority. A member holds an account in the
    // space; installing an integration or rewriting its configuration is
    // a space-admin act, and the bearer branch has always said so.
    await expect(resolve(fakeUser({ role: "member" }))).rejects.toThrow(
      MarfaError,
    );
    await expect(resolve(fakeUser({ role: "member" }))).rejects.toMatchObject({
      code: ErrorCode.FORBIDDEN,
    });
  });

  it("refuses a role outside the union instead of admitting it", async () => {
    // The fail-open direction, and the one worth a test of its own. This
    // gate compares ranks rather than literals, so an unrecognized role
    // makes the lookup `undefined`, and `undefined < 2` is false, the
    // comparison admits precisely what it means to refuse. Every account
    // holder on both deployments carried such a value for a full rename
    // cycle.
    //
    // The store narrows on read, so a real caller cannot arrive in this
    // shape any more. This asserts the gate does not depend on that: the
    // fake here builds a `User` directly, exactly as a future caller
    // assembled some other way would.
    const stale = fakeUser({ role: "tenant_admin" as "space_admin" });
    await expect(resolve(stale)).rejects.toMatchObject({
      code: ErrorCode.FORBIDDEN,
    });
  });

  it("admits a space admin", async () => {
    const caller = await resolve(fakeUser({ role: "space_admin" }));
    expect(caller).toMatchObject({
      apiKeyId: "auth_user:auth-1",
      spaceId: "space-1",
    });
  });

  it("admits a platform admin", async () => {
    const caller = await resolve(fakeUser({ role: "admin" }));
    expect(caller).toMatchObject({ spaceId: "space-1" });
  });

  it("refuses when no space resolves, rather than returning an unscoped caller", async () => {
    // The dangerous shape. `spaceId: undefined` reads downstream as "do
    // not filter by space", so returning it for a session whose space
    // could not be resolved hands a browser caller the platform tier.
    await expect(resolve(null)).rejects.toMatchObject({
      code: ErrorCode.FORBIDDEN,
    });
  });

  it("refuses a session whose user row carries no space", async () => {
    await expect(
      resolve(fakeUser({ role: "space_admin", space_id: "" })),
    ).rejects.toMatchObject({ code: ErrorCode.FORBIDDEN });
  });

  it("admits the account holder of a keys-mode self-host, which has no users store", async () => {
    // The distinction that makes the refusals above safe. Keys mode has
    // no per-user space model and no role to read, and its space-less
    // caller is the only space the instance has rather than authority
    // over every space. Collapsing the two would either break every
    // self-host browser flow or leave the hosted hole open.
    const caller = await resolveSpaceAdminCaller(
      sessionContext(),
      {} as unknown as Storage,
      auth,
      "Space admin authority required",
    );
    expect(caller).toMatchObject({
      apiKeyId: "auth_user:auth-1",
      spaceId: undefined,
    });
  });
});

describe("resolveSpaceAdminCaller — the bearer branch is unchanged", () => {
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
      role: "space_admin",
      default_tier: "library",
      is_platform: false,
      type_permissions: {},
      extension_permissions: {},
      edge_permissions: {},
      metadata_permissions: {},
      created_at: "2026-01-01T00:00:00.000Z",
      last_used_at: null,
      ...over,
    };
  }

  it("admits a space_admin key", async () => {
    const caller = await resolveSpaceAdminCaller(
      bearerContext(fakeKey({ role: "space_admin" })),
      storageWith(null),
      auth,
      "nope",
    );
    expect(caller).toMatchObject({ apiKeyId: "k1", spaceId: "space-1" });
  });

  it("refuses a member key", async () => {
    await expect(
      resolveSpaceAdminCaller(
        bearerContext(fakeKey({ role: "member" })),
        storageWith(null),
        auth,
        "nope",
      ),
    ).rejects.toMatchObject({ code: ErrorCode.FORBIDDEN });
  });
});
