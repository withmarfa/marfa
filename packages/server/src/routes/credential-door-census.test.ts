/**
 * Every route the app serves either takes a credential or does not, and the
 * route's own `security` declaration is what decides.
 *
 * `createOpenAPIRouter` hangs `requireDeclaredCredential` off each route
 * that declares one, so the guarded set is read back out of Hono's route
 * table by handler identity rather than kept beside it as a second list of
 * protected paths. Plain handlers may register a schema while retaining
 * their own credential check. Those are named below and exercised with a
 * bare request, so documentation alone cannot count as a runtime gate.
 * The walk fails on a route classified in neither place.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { requireDeclaredCredential } from "../middleware/auth.js";
import {
  finalizeOpenAPISpec,
  OPENAPI_DOCUMENT_INFO,
} from "../openapi-finalize.js";
import { createTestContext, createUnclaimedTestApp } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.cleanup();
});

/** Well-formed, so a door reaches its row lookup rather than refusing the id. */
const UNKNOWN_ID = "019537a0-7b80-7000-8000-000000000000";

function servedDoors(): Set<string> {
  return new Set(ctx.app.routes.map((r) => `${r.method} ${r.path}`));
}

function guardedDoors(): Set<string> {
  return new Set(
    ctx.app.routes
      .filter((r) => r.handler === requireDeclaredCredential)
      .map((r) => `${r.method} ${r.path}`),
  );
}

const HTTP_METHODS = ["get", "post", "put", "patch", "delete"];

function operationDoors(paths: Record<string, unknown>): Set<string> {
  const out = new Set<string>();
  for (const [path, item] of Object.entries(paths)) {
    for (const method of Object.keys(item as Record<string, unknown>)) {
      if (!HTTP_METHODS.includes(method)) continue;
      out.add(`${method.toUpperCase()} ${path.replace(/\{([^}]+)\}/g, ":$1")}`);
    }
  }
  return out;
}

/**
 * Every operation the registry carries and every one the served document
 * publishes, secured or not, as the router paths.
 *
 * `declaredDoors` and `guardedDoors` are both derived from `security`, so a
 * route that loses the declaration leaves both sets at once and their
 * equality still holds. This is the set that does not move when it does.
 *
 * Both the registry and the served document are checked, so document
 * shaping cannot remove a door from the census.
 */
function documentedDoors(): Set<string> {
  const registry = ctx.app.getOpenAPI31Document({
    openapi: "3.1.0",
    info: { title: "census", version: "0" },
  });
  const published = finalizeOpenAPISpec(
    ctx.app.getOpenAPI31Document({
      openapi: "3.1.0",
      info: OPENAPI_DOCUMENT_INFO,
    }),
  );
  return new Set([
    ...operationDoors(registry.paths ?? {}),
    ...operationDoors(published.paths ?? {}),
  ]);
}

/**
 * The documented operations, in the registry or the published document,
 * that take no credential, each with why.
 *
 * A caller cannot be asked for a credential in order to learn how to obtain
 * one, or which instance it is about to sign in to, so registration and the
 * root are open by construction.
 */
const OPEN_OPERATIONS: Record<string, string> = {
  "POST /owner":
    "claims the owner with setup proof carried in the body or setup session",
  "GET /":
    "the instance's description, where a caller with no credential yet reads which instance answers and which contract it speaks",
  "POST /auth/oauth2/register":
    "dynamic client registration, which is how a client comes to hold anything",
};

function declaredDoors(): Set<string> {
  const doc = ctx.app.getOpenAPI31Document({
    openapi: "3.1.0",
    info: { title: "census", version: "0" },
  });
  const out = new Set<string>();
  for (const [path, item] of Object.entries(doc.paths ?? {})) {
    for (const [method, operation] of Object.entries(
      item as Record<string, unknown>,
    )) {
      if (!HTTP_METHODS.includes(method)) continue;
      const security = (operation as { security?: unknown[] }).security;
      if (security === undefined || security.length === 0) continue;
      out.add(`${method.toUpperCase()} ${path.replace(/\{([^}]+)\}/g, ":$1")}`);
    }
  }
  return out;
}

/**
 * Doors with no declaration to read, each with what it is.
 *
 * Open on purpose, all of them: a credential cannot be a precondition for
 * learning how to present one, for signing in, or for the pages a browser
 * lands on before it holds anything.
 */
const OPEN_DOORS: Record<string, string> = {
  "POST /owner": "one-time owner claim authenticated by setup proof",
  "GET /setup": "the setup page, before any owner exists",
  "POST /setup/exchange":
    "exchanges machine-issued proof for a setup-only cookie",
  "POST /setup/claim": "claims using setup proof or a setup-only cookie",
  "GET /setup/:step":
    "the owner's setup steps, authenticated by the owner session cookie, which send a browser without one to sign in",
  "POST /setup/name":
    "saves the instance name, authenticated by the owner session cookie and origin",
  "GET /auth/owner/manage":
    "management page authenticated by direct owner session",
  "GET /auth/owner/restore":
    "restore form authenticated by direct owner session",
  "GET /auth/owner/passkeys":
    "passkey management authenticated by the owner session cookie",
  "GET /auth/owner/password":
    "owner password form authenticated by the owner session cookie",
  "POST /auth/owner/password":
    "owner password change authenticated by session, current password and origin",

  "GET /":
    "names the instance, its build, its contract version and the surfaces it serves",
  "GET /health": "liveness, read before any credential exists",
  "GET /openapi.json":
    "the document a client reads to learn how to authenticate",
  "GET /.well-known/oauth-authorization-server/auth":
    "RFC 8414 discovery, read by a client that holds nothing yet",
  "GET /.well-known/openid-configuration/auth": "OIDC discovery, same",
  "GET /auth/.well-known/oauth-authorization-server":
    "the issuer-suffixed spelling of the same document",
  "GET /auth/.well-known/openid-configuration": "and of the OIDC one",
  "GET /.well-known/oauth-protected-resource":
    "RFC 9728 resource metadata, which a bearer challenge points at",
  "GET /auth/sign-in": "the sign-in page",
  "POST /auth/sign-in": "its form post, which is how a credential is got",
  "GET /auth/forgot-password":
    "the page that says how to recover a forgotten password, which needs no credential",
  "GET /auth/authorize": "the consent screen, gated on a session cookie",
  "POST /auth/authorize/decision": "the consent decision, gated the same way",
  "GET /auth/device": "the device-code entry page",
  "POST /auth/device": "its form post",
  "GET /auth/device/consent": "the device consent screen",
  "POST /auth/device/consent": "its decision",
  "GET /auth/error": "the OAuth failure page a redirect lands on",
  "GET /auth/oauth2/end-session": "the RP-initiated logout page",
  "GET /auth/static/auth.css": "the stylesheet those pages load",
  "GET /auth/static/pages.css": "the stylesheet those pages load",
  "GET /auth/static/pages.js": "a script those pages load",
  "GET /auth/static/passkeys.js": "a script those pages load",
  "GET /auth/*":
    "the Better Auth catch-all — sign-in, session and the OAuth protocol endpoints, each gating itself; every other path answers 404",
  "POST /auth/*": "the same catch-all",
  "GET /blobs/:hash/fetch":
    "the target of an instance-served blob link, gated by the signature in its query rather than a bearer",
  "POST /inbound/:token":
    "where a sender posts an inbound webhook delivery, gated by the unguessable address rather than a bearer",
};

/**
 * Doors whose plain handlers check the credential themselves, whether or
 * not they register a schema. Each refuses before validating request input,
 * which the sweep below holds them to.
 */
const CREDENTIAL_IN_HANDLER: Record<string, string> = {
  "GET /events":
    "the event stream registers a schema but retains its credential and type-read checks in the plain handler",
  "GET /auth/grants": "lists the apps the owner authorized",
  "DELETE /auth/grants/:id": "revokes one",
};

function concrete(path: string): string {
  return path.replace(/:[^/]+/g, UNKNOWN_ID);
}

/**
 * A bare request carrying everything a door might be tempted to answer
 * ahead of the credential: an unparseable body, an unknown query key, and
 * a path naming rows nothing carries.
 */
async function bare(
  door: string,
): Promise<{ status: number; code: unknown; body: string }> {
  const [method, path] = door.split(" ");
  const url = `${concrete(path ?? "")}?definitely-not-a-filter=1`;
  const res = await ctx.app.request(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: method === "GET" || method === "DELETE" ? undefined : "{ not json",
  });
  const body = await res.text();
  let code: unknown;
  try {
    code = (JSON.parse(body) as { error?: { code?: unknown } }).error?.code;
  } catch {
    code = undefined;
  }
  return { status: res.status, code, body };
}

describe("the credential gate", () => {
  it("uses the shared gate for every declared credential door without its own gate", () => {
    const declared = declaredDoors();
    // The positive control. An empty declaration set would satisfy the
    // comparison below while proving the gate is attached to nothing.
    expect(declared.size).toBeGreaterThan(60);
    expect([...guardedDoors()].sort()).toEqual(
      [...declared].filter((door) => !(door in CREDENTIAL_IN_HANDLER)).sort(),
    );
  });

  it("leaves no published operation ungated except the ones named open", () => {
    // The check the equality above cannot make. Both sets there read the same
    // `security` declaration, so a route that drops it leaves both together
    // and the comparison stays green one door smaller. An operation exists in
    // the registry whether or not it declares anything, so an ungated one
    // that nobody named is visible here and nowhere else.
    //
    // The two records are the only way through: an operation the document
    // carries is either gated, open by construction, or one of the plain
    // Hono handlers that takes its credential itself and is swept below.
    const guarded = guardedDoors();
    const ungated = [...documentedDoors()]
      .filter((door) => !guarded.has(door))
      .filter((door) => !(door in OPEN_OPERATIONS))
      .filter((door) => !(door in CREDENTIAL_IN_HANDLER));
    expect(ungated.sort()).toEqual([]);
  });

  it("refuses a bare request before the body check and the row lookup", async () => {
    const guarded = [...guardedDoors()];
    expect(guarded.length).toBeGreaterThan(60);
    const wrong: string[] = [];
    for (const door of guarded) {
      const { status, code, body } = await bare(door);
      if (status !== 401 || code !== "unauthorized") {
        wrong.push(`${door} answered ${String(status)} ${body.slice(0, 120)}`);
      }
    }
    expect(wrong.sort()).toEqual([]);
  });

  it("refuses a bare request on every door that checks its own credential", async () => {
    const doors = Object.keys(CREDENTIAL_IN_HANDLER);
    expect(doors.length).toBeGreaterThan(0);
    const wrong: string[] = [];
    for (const door of doors) {
      const { status, code, body } = await bare(door);
      if (status !== 401 || code !== "unauthorized") {
        wrong.push(`${door} answered ${String(status)} ${body.slice(0, 120)}`);
      }
    }
    expect(wrong.sort()).toEqual([]);
  });

  it("refuses credential-less key minting before an owner claims the instance", async () => {
    const fresh = await createUnclaimedTestApp();
    try {
      const res = await fresh.app.request("/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: "first", source: "first" }),
      });
      expect(res.status).toBe(401);
      expect((await fresh.storage.keys.list()).length).toBe(0);
      const ownerMint = await ctx.ownerRequest("/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          label: "owner-witness",
          source: "owner-witness",
        }),
      });
      expect(ownerMint.status).toBe(201);
    } finally {
      await fresh.cleanup();
    }
  });

  it("accounts for every route the app serves", () => {
    const served = servedDoors();
    // Positive control: the walk is over a table that has to have filled.
    expect(served.size).toBeGreaterThan(100);
    const guarded = guardedDoors();
    const unclassified: string[] = [];
    for (const door of served) {
      // The global middleware mounts, which are not doors: nothing is
      // served at `/*` and every request passes through them on its way to
      // whatever is.
      if (
        [
          "ALL /*",
          "ALL /setup/*",
          "ALL /owner/*",
          "ALL /auth/owner/*",
        ].includes(door)
      )
        continue;
      if (guarded.has(door)) continue;
      if (door in OPEN_DOORS) continue;
      if (door in CREDENTIAL_IN_HANDLER) continue;
      unclassified.push(door);
    }
    expect(unclassified.sort()).toEqual([]);
  });

  it("holds every classification to a route that still exists", () => {
    const served = servedDoors();
    const stale = [
      ...Object.keys(OPEN_DOORS),
      ...Object.keys(CREDENTIAL_IN_HANDLER),
    ].filter((door) => !served.has(door));
    expect(stale.sort()).toEqual([]);
  });
});

it("declares owner browser authority only on the two item summary and export reads", async () => {
  const doc = ctx.app.getOpenAPI31Document({
    openapi: "3.1.0",
    info: { title: "owner read census", version: "0" },
  });
  for (const [path, operations] of Object.entries(doc.paths ?? {})) {
    if (!["/items/stats", "/export"].includes(path)) continue;
    const operation = (operations as { get?: { security?: unknown[] } }).get;
    expect(operation?.security).toEqual([
      { bearerAuth: [] },
      { ownerSession: [] },
    ]);
    const owner = await ctx.ownerRequest(path);
    expect(owner.status).toBe(200);
    await owner.body?.cancel();
    expect((await ctx.app.request(path)).status).toBe(401);
  }
});
