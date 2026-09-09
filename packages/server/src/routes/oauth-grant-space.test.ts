/**
 * Which space a sign-in's grant lands in, driven through the code flow.
 *
 * A grant is two records that have to name the same space: the token's
 * `reference_id` and the `system.connection { kind: "app" }` projection. Both
 * come from one resolver, and it answers nothing in two situations -- a
 * self-hosted server holding more than one space, and an account with no
 * space of its own. Before this suite the code flow carried on regardless: it
 * wrote a space-less projection, the plugin minted a code, and the token that
 * followed was refused by the bearer middleware on every request, with
 * nothing on any surface naming the cause. The device flow refused up front,
 * so one of the two paths told the person and the other did not.
 *
 * The happy case is here for the same reason the refusals are: a guard that
 * refuses everything passes every refusal test. So keys mode runs end to
 * end -- consent, token, data call -- and the token has to reach the one
 * space's data rather than merely mint.
 */

import { createHash, randomBytes } from "node:crypto";
import { describe, it, expect, afterEach, vi } from "vitest";
import {
  createTestContext,
  markEmailVerified,
  request,
} from "../test-utils.js";
import type { TestContext } from "../test-utils.js";

// Each case signs a person up and in and drives a grant before it asserts
// anything. An overrun reports as a timeout, which says nothing about the
// property under test.
vi.setConfig({ testTimeout: 45_000 });

let ctx: TestContext | undefined;

afterEach(async () => {
  await ctx?.cleanup();
  ctx = undefined;
});

const ORIGIN = "http://localhost:0";
const CALLBACK = "http://localhost:0/callback";
const SCOPE = "core.note:read";

async function signInUser(c: TestContext, email: string): Promise<string> {
  const password = "correct horse battery";
  const signUp = await request(c.app, "POST", "/auth/sign-up/email", {
    body: { email, password, name: "Grant Space User" },
    headers: { origin: ORIGIN },
  });
  if (signUp.status !== 200) {
    throw new Error(`sign-up failed (${String(signUp.status)})`);
  }
  await markEmailVerified(c.storage, email);
  const signIn = await request(c.app, "POST", "/auth/sign-in/email", {
    body: { email, password },
    headers: { origin: ORIGIN },
  });
  if (signIn.status !== 200) {
    throw new Error(`sign-in failed (${String(signIn.status)})`);
  }
  const setCookie = signIn.headers.get("set-cookie");
  if (!setCookie) throw new Error("sign-in: no Set-Cookie header");
  for (const part of setCookie.split(/,\s*(?=[a-zA-Z0-9_-]+=)/)) {
    const head = part.split(";")[0];
    if (head?.includes("session_token")) return head;
  }
  throw new Error("sign-in: session_token cookie not found");
}

async function registerClient(c: TestContext, cookie: string): Promise<string> {
  const res = await request(c.app, "POST", "/auth/oauth2/register", {
    body: {
      redirect_uris: [CALLBACK],
      grant_types: ["authorization_code"],
      response_types: ["code"],
      client_name: "Grant Space Test",
      scope: SCOPE,
    },
    headers: { cookie, origin: ORIGIN },
  });
  if (res.status !== 201) {
    throw new Error(`registration failed (${String(res.status)})`);
  }
  return ((await res.json()) as { client_id: string }).client_id;
}

interface AuthorizeAttempt {
  /** The `/auth/authorize` response, which is where a refusal lands first. */
  consent: Response;
  /** Present only when the consent screen was reached. */
  signedQuery?: string;
  verifier: string;
}

async function authorize(
  c: TestContext,
  clientId: string,
  cookie: string,
): Promise<AuthorizeAttempt> {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: CALLBACK,
    state: "grant-space-state",
    scope: SCOPE,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  const started = await request(
    c.app,
    "GET",
    `/auth/oauth2/authorize?${params.toString()}`,
    { headers: { cookie } },
  );
  expect(started.status).toBe(302);
  const location = started.headers.get("location") ?? "";
  if (!location.includes("/auth/authorize?")) {
    throw new Error(`authorize did not reach consent: ${location}`);
  }
  const query = location.slice(location.indexOf("?") + 1);
  const consent = await request(c.app, "GET", `/auth/authorize?${query}`, {
    headers: { cookie },
  });
  return { consent, signedQuery: query, verifier };
}

async function decide(
  c: TestContext,
  cookie: string,
  signedQuery: string,
): Promise<Response> {
  return await request(c.app, "POST", "/auth/authorize/decision", {
    form: {
      accept: "true",
      oauth_query: signedQuery,
      scopes: [SCOPE],
    },
    headers: { cookie, origin: ORIGIN },
  });
}

describe("a keys-mode sign-in grants in the instance's one space", () => {
  it("consents, mints a token bound to that space, and reads its data", async () => {
    // The whole path, on the deployment shape this change is about: no user
    // store, one space, and a grant that has to land in it. A refusal test
    // alone would pass against a guard that refused everything.
    const context = await createTestContext({ authAllowSignup: true });
    ctx = context;
    expect(context.storage.users).toBeUndefined();
    const spaces = context.storage.spaces;
    if (!spaces) throw new Error("space store expected");
    const [sole] = await spaces.list();
    if (!sole) throw new Error("keys mode provisions one space");

    // Written through the space key, which is the credential a keys-mode
    // instance hands its operator. The bearer has to reach the same rows.
    const seeded = await request(context.app, "POST", "/items", {
      key: context.spaceKey,
      body: {
        type: "core.note",
        properties: { title: "in the one space", body: "reachable" },
        source: "test/grant-space",
      },
    });
    expect(seeded.status).toBe(201);

    const cookie = await signInUser(context, "keys-grant@marfa.so");
    const clientId = await registerClient(context, cookie);
    const attempt = await authorize(context, clientId, cookie);
    expect(attempt.consent.status).toBe(200);

    const decision = await decide(context, cookie, attempt.signedQuery!);
    expect(decision.status).toBe(302);
    const code = new URL(
      decision.headers.get("location") ?? "",
      ORIGIN,
    ).searchParams.get("code");
    expect(code).toBeTruthy();

    const tokenRes = await request(context.app, "POST", "/auth/oauth2/token", {
      form: {
        grant_type: "authorization_code",
        code: code!,
        redirect_uri: CALLBACK,
        client_id: clientId,
        code_verifier: attempt.verifier,
      },
      headers: { origin: ORIGIN },
    });
    expect(tokenRes.status).toBe(200);
    const accessToken = ((await tokenRes.json()) as { access_token: string })
      .access_token;
    expect(accessToken.startsWith("marfa_at_")).toBe(true);

    // Admitted, and bound: a token carrying no space is refused outright, so
    // a 200 here is already the binding. Reading the row back is what says
    // which space it is bound to.
    const read = await request(context.app, "GET", "/items", {
      key: accessToken,
    });
    expect(read.status).toBe(200);
    const body = (await read.json()) as {
      data: { space_id?: string | null; properties: { title: string } }[];
    };
    const note = body.data.find(
      (i) => i.properties.title === "in the one space",
    );
    expect(note).toBeDefined();

    // The projection went into the same space, which is what keeps the
    // security page and the revoke door pointed at the grant that exists.
    const projections = await context.storage.items.list({
      type: "system.connection",
      state: "active",
      spaceId: sole.id,
    });
    expect(
      projections.data.some(
        (i) =>
          i.properties.kind === "app" && i.properties.client_id === clientId,
      ),
    ).toBe(true);
  });
});

describe("a grant with no space to land in is refused before a code exists", () => {
  it("refuses on a self-hosted server holding more than one space", async () => {
    // Two spaces is the state the resolver declines to answer, because
    // choosing between them binds somebody's grant to whichever row came
    // back first. Before this the flow carried on and wrote the grant into
    // no space at all.
    const context = await createTestContext({ authAllowSignup: true });
    ctx = context;
    const spaces = context.storage.spaces;
    if (!spaces) throw new Error("space store expected");
    const cookie = await signInUser(context, "two-spaces@marfa.so");
    const clientId = await registerClient(context, cookie);
    await spaces.create("a-second-space");
    expect((await spaces.list()).length).toBe(2);

    const attempt = await authorize(context, clientId, cookie);
    expect(attempt.consent.status).toBe(403);
    const page = await attempt.consent.text();
    // The cause, not "complete onboarding": on this server there is nothing
    // for the reader to complete, and the sentence has to say so.
    expect(page).toContain("no space to grant access in");
    expect(page).toContain("holds exactly one");
    expect(page).not.toContain("onboarding");

    // And the decision handler refuses on its own, because a form POST is an
    // ordinary request and nothing guarantees the screen in front of it came
    // from the check above.
    const decision = await decide(context, cookie, attempt.signedQuery!);
    expect(decision.status).toBe(403);

    // Nothing was written anywhere, which is the half a status code cannot
    // show. Listed with no space so the space-less bucket is included: that
    // is exactly where the projection used to land, and a per-space listing
    // would report it clean.
    const projections = await context.storage.items.list({
      type: "system.connection",
    });
    expect(projections.data.some((i) => i.properties.kind === "app")).toBe(
      false,
    );
  });

  it("refuses an account that has no space of its own", async () => {
    // The hosted half. Sign-up provisions a space, and the provisioning is
    // best-effort behind a catch, so an account without one is what a failure
    // there leaves behind. Reproduced by removing the row rather than by
    // breaking the hook, because the state is what the flow has to answer
    // for however it arose.
    const context = await createTestContext({
      authMode: "hosted",
      authAllowSignup: true,
    });
    ctx = context;
    const cookie = await signInUser(context, "no-space@marfa.so");
    const clientId = await registerClient(context, cookie);
    await detachAccountFromItsSpace(context, "no-space@marfa.so");

    const attempt = await authorize(context, clientId, cookie);
    expect(attempt.consent.status).toBe(403);
    const page = await attempt.consent.text();
    expect(page).toContain("no space to grant access in");

    const decision = await decide(context, cookie, attempt.signedQuery!);
    expect(decision.status).toBe(403);
  });
});

/**
 * Leave the account signed in and holding no space, by deleting its `users`
 * row. That row is the only thing binding a Better Auth identity to a space
 * in hosted mode, and its absence is exactly what a failed sign-up
 * provisioning leaves. Better Auth's own session is untouched, so the person
 * is still signed in, which is the situation being tested.
 */
async function detachAccountFromItsSpace(
  c: TestContext,
  email: string,
): Promise<void> {
  const users = c.storage.users;
  if (!users) throw new Error("hosted-mode storage missing user store");
  const authUserId = await authUserIdFor(c, email);
  const row = await users.getByAuthUserId(authUserId);
  expect(row).not.toBeNull();
  const schema =
    c.storage.betterAuthDialect === "pg"
      ? await import("../storage/pg/schema.js")
      : await import("../storage/sqlite/schema.js");
  const db = c.storage.betterAuthDb as {
    delete: (table: unknown) => {
      where: (clause: unknown) => {
        run?: () => Promise<unknown>;
        execute?: () => Promise<unknown>;
      };
    };
  };
  const { eq } = await import("drizzle-orm");
  const op = db.delete(schema.users).where(eq(schema.users.id, row!.id));
  await (op.execute?.() ?? op.run?.() ?? Promise.resolve());
  expect(await users.getByAuthUserId(authUserId)).toBeNull();
}

/** The Better Auth user id behind an email, read the way the bridge reads it. */
async function authUserIdFor(c: TestContext, email: string): Promise<string> {
  const schema =
    c.storage.betterAuthDialect === "pg"
      ? await import("../storage/pg/schema.js")
      : await import("../storage/sqlite/schema.js");
  const db = c.storage.betterAuthDb as {
    select: (cols: unknown) => {
      from: (table: unknown) => {
        where: (clause: unknown) => Promise<{ id: string }[]> & {
          all?: () => Promise<{ id: string }[]>;
        };
      };
    };
  };
  const { eq } = await import("drizzle-orm");
  const query = db
    .select({ id: schema.auth_user.id })
    .from(schema.auth_user)
    .where(eq(schema.auth_user.email, email));
  const rows = await (query.all?.() ?? query);
  const id = rows[0]?.id;
  if (!id) throw new Error(`no auth_user for ${email}`);
  return id;
}
