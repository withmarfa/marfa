/**
 * Which space a machine client's token belongs to.
 *
 * `grant_type=client_credentials` has no user and no consent, so neither of
 * the plugin's `consentReferenceId` call sites runs and the token it mints
 * carries a NULL `reference_id`. While a space-less bearer was admitted, that
 * token read and wrote every space on the instance; once it was refused, the
 * grant minted a credential that could reach nothing.
 *
 * A machine client is a credential a person created. Its token belongs to
 * that person's space and is bounded by what that person holds, and a client
 * nobody registered belongs to no space and gets no token.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHash } from "node:crypto";
import {
  createTestContext,
  markEmailVerified,
  request,
} from "../test-utils.js";
import type { TestContext } from "../test-utils.js";

let ctx: TestContext;

beforeAll(async () => {
  // Hosted: an account, and therefore a person to inherit a space from, only
  // exists there.
  ctx = await createTestContext({ authMode: "hosted", authAllowSignup: true });
});

afterAll(async () => {
  await ctx.cleanup();
});

const ORIGIN = "http://localhost:0";

/** Sign up, verify and sign in; hand back the session cookie and the space
 *  the new account was provisioned into. The first person in a space holds
 *  everything in it, which is the ceiling a machine client registered from
 *  this session is clamped to. */
async function signUpAccount(): Promise<{ cookie: string; spaceId: string }> {
  const email = `machine-${Math.random().toString(36).slice(2, 10)}@marfa.so`;
  const password = "correct horse battery";
  const signUp = await request(ctx.app, "POST", "/auth/sign-up/email", {
    body: { email, password, name: "Machine Owner" },
    headers: { origin: ORIGIN },
  });
  expect(signUp.status).toBeLessThan(400);
  await markEmailVerified(ctx.storage, email);
  const signIn = await request(ctx.app, "POST", "/auth/sign-in/email", {
    body: { email, password },
    headers: { origin: ORIGIN },
  });
  expect(signIn.status).toBe(200);
  const cookie = (signIn.headers.get("set-cookie") ?? "")
    .split(/,\s*(?=[a-zA-Z0-9_-]+=)/)
    .map((chunk) => chunk.split(";")[0])
    .find((head) => head?.includes("session_token"));
  expect(cookie).toBeTruthy();

  const signedIn = (await signIn.json()) as { user: { id: string } };
  const userRow = await ctx.storage.users?.getByAuthUserId(signedIn.user.id);
  expect(userRow?.space_id).toBeTruthy();
  return { cookie: cookie ?? "", spaceId: userRow?.space_id ?? "" };
}

/** Register a machine client through an authenticated session, the way the
 *  product mints one. */
async function registerMachineClient(
  cookie: string,
  scope: string,
): Promise<{
  clientId: string;
  clientSecret: string;
  body: Record<string, unknown>;
}> {
  const res = await request(ctx.app, "POST", "/auth/oauth2/register", {
    body: {
      grant_types: ["client_credentials"],
      client_name: "Machine Client",
      scope,
    },
    headers: { origin: ORIGIN, cookie },
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as Record<string, unknown>;
  return {
    clientId: body.client_id as string,
    clientSecret: body.client_secret as string,
    body,
  };
}

async function machineToken(
  clientId: string,
  clientSecret: string,
  scope?: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const params = new URLSearchParams({ grant_type: "client_credentials" });
  if (scope !== undefined) params.set("scope", scope);
  const res = await ctx.app.fetch(
    new Request(`${ORIGIN}/auth/oauth2/token`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: `Basic ${basic}`,
        origin: ORIGIN,
      },
      body: params.toString(),
    }),
  );
  return {
    status: res.status,
    body: (await res.json()) as Record<string, unknown>,
  };
}

/** A confidential machine client inserted straight into storage, with no
 *  registering user — the shape registration now refuses, kept reachable so
 *  the token endpoint's own refusal is asserted rather than assumed. */
async function seedUnownedClient(secret: string): Promise<string> {
  const clientId = `client_${Math.random().toString(36).slice(2, 10)}`;
  const clientPk = `pk_${Math.random().toString(36).slice(2, 10)}`;
  if (!ctx.storage.betterAuthDb) {
    throw new Error("seedUnownedClient: storage.betterAuthDb missing");
  }
  const schemaModule =
    ctx.storage.betterAuthDialect === "pg"
      ? await import("../storage/pg/schema.js")
      : await import("../storage/sqlite/schema.js");
  const db = ctx.storage.betterAuthDb as unknown as {
    insert: (table: unknown) => {
      values: (v: Record<string, unknown>) => {
        run?: () => Promise<unknown>;
        execute?: () => Promise<unknown>;
      };
    };
  };
  const now = new Date();
  const asArray = (values: string[]): unknown =>
    ctx.storage.betterAuthDialect === "pg" ? values : JSON.stringify(values);
  const op = db.insert(schemaModule.auth_oauth_client).values({
    id: clientPk,
    clientId,
    clientSecret: createHash("sha256").update(secret).digest("base64url"),
    name: "Unowned Machine Client",
    redirectUris: asArray([]),
    grantTypes: asArray(["client_credentials"]),
    tokenEndpointAuthMethod: "client_secret_basic",
    clientCredentialsScopes: asArray(["core.note:read"]),
    public: false,
    disabled: false,
    createdAt: now,
    updatedAt: now,
  });
  await (op.execute?.() ?? op.run?.() ?? Promise.resolve());
  return clientId;
}

describe("a machine client's token belongs to its registering person's space", () => {
  it("reads its own space's rows and none of another space's", async () => {
    const owner = await signUpAccount();
    const stranger = await signUpAccount();
    expect(owner.spaceId).not.toBe(stranger.spaceId);

    const ownNote = await ctx.storage.items.create(
      {
        type: "core.note",
        tier: "library",
        state: "active",
        properties: { title: "own note", body: "the machine's own space" },
        source: "test/machine-client-space",
      },
      owner.spaceId,
    );
    const strangerNote = await ctx.storage.items.create(
      {
        type: "core.note",
        tier: "library",
        state: "active",
        properties: { title: "stranger note", body: "another space entirely" },
        source: "test/machine-client-space",
      },
      stranger.spaceId,
    );

    const client = await registerMachineClient(owner.cookie, "core.note:read");
    const token = await machineToken(client.clientId, client.clientSecret);
    expect(token.status).toBe(200);
    const accessToken = token.body.access_token as string;
    // Opaque, so the bearer middleware can resolve it to its row: a JWT here
    // is a token that verifies nowhere.
    expect(accessToken.startsWith("marfa_at_")).toBe(true);

    const listed = await request(ctx.app, "GET", "/items", {
      key: accessToken,
    });
    expect(listed.status).toBe(200);
    const ids = new Set(
      ((await listed.json()) as { data: { id: string }[] }).data.map(
        (item) => item.id,
      ),
    );
    expect(ids.has(ownNote.id)).toBe(true);
    expect(ids.has(strangerNote.id)).toBe(false);

    // A listing that filters is one assertion; a direct read by id is the
    // other, and it is the one a missing space predicate would answer.
    const direct = await request(ctx.app, "GET", `/items/${strangerNote.id}`, {
      key: accessToken,
    });
    expect(direct.status).toBe(404);
  });

  it("refuses a client with no registering user, and mints nothing", async () => {
    const secret = `s3cret-${Math.random().toString(36).slice(2)}`;
    const clientId = await seedUnownedClient(secret);

    const token = await machineToken(clientId, secret, "core.note:read");
    expect(token.status).toBe(400);
    expect(token.body.error).toBe("unauthorized_client");
    expect(token.body.access_token).toBeUndefined();
  });
});

describe("registering a machine client", () => {
  it("refuses an unauthenticated registration", async () => {
    const res = await request(ctx.app, "POST", "/auth/oauth2/register", {
      body: {
        grant_types: ["client_credentials"],
        client_name: "nobody's machine",
        scope: "core.note:read",
      },
      headers: { origin: ORIGIN },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_client_metadata");
  });

  it("clamps the machine allowlist to what the registering person holds", async () => {
    const owner = await signUpAccount();
    // `openid` is inside the person's own grant — every consent screen offers
    // it — and outside what a machine client can ever spend, because the
    // grant has no session to carry. The clamp is what keeps it off the
    // allowlist, and the difference between the two columns is what shows
    // the clamp ran rather than the request being echoed back.
    const client = await registerMachineClient(
      owner.cookie,
      "core.note:read openid",
    );
    expect(client.body.client_credentials_scopes).toEqual(["core.note:read"]);
    expect((client.body.scope as string).split(" ")).toContain("openid");

    // And the ceiling is enforced when spent, not only when written.
    const overAsk = await machineToken(
      client.clientId,
      client.clientSecret,
      "core.note:write",
    );
    expect(overAsk.status).toBe(400);
    expect(overAsk.body.error).toBe("invalid_scope");

    const atCeiling = await machineToken(
      client.clientId,
      client.clientSecret,
      "core.note:read",
    );
    expect(atCeiling.status).toBe(200);
  });

  it("refuses a machine registration that names no scope it could hold", async () => {
    const owner = await signUpAccount();
    const res = await request(ctx.app, "POST", "/auth/oauth2/register", {
      body: {
        grant_types: ["client_credentials"],
        client_name: "scopeless machine",
        scope: "openid",
      },
      headers: { origin: ORIGIN, cookie: owner.cookie },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_scope");
  });
});
