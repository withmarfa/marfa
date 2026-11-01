import { afterEach, expect, it } from "vitest";
import { createClaimTestApp } from "./claim-test-app.js";
import { SIGN_IN_AGAIN_MESSAGE } from "../pages/recent-sign-in.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
const origin = "http://localhost:8600";
const owner = { email: "owner@example.com", password: "correct horse battery" };
it("offers an owner-bound passkey registration ceremony", async () => {
  const ctx = await createClaimTestApp(origin);
  cleanups.push(ctx.cleanup);
  await ctx.app.request("/owner", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...owner, code: ctx.setupCode }),
  });
  const signedIn = await ctx.app.request(origin + "/auth/sign-in/email", {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify(owner),
  });
  expect(signedIn.status).toBe(200);
  const cookie = signedIn.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  const response = await ctx.app.request(
    origin + "/auth/passkey/generate-register-options",
    { headers: { origin, cookie } },
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    rp: { id: "localhost", name: "Marfa" },
    authenticatorSelection: {
      userVerification: "required",
      residentKey: "required",
    },
  });
});

import { testAuthenticator } from "./passkey-test-authenticator.js";

async function signedOwner() {
  const ctx = await createClaimTestApp(origin);
  cleanups.push(ctx.cleanup);
  const post = (path: string, body: unknown, cookie = "") =>
    ctx.app.request(origin + path, {
      method: "POST",
      headers: { origin, cookie, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  // A claim from the instance's own origin signs the owner in, so the one
  // browser session these tests count is the claim's own.
  const claimed = await post("/owner", { ...owner, code: ctx.setupCode });
  expect(claimed.status).toBe(201);
  const ownerCookie = cookies(claimed);
  const options = async (
    kind: "register" | "authenticate",
    cookie = kind === "register" ? ownerCookie : "",
  ) => {
    const response = await ctx.app.request(
      origin + `/auth/passkey/generate-${kind}-options`,
      { headers: { origin, cookie } },
    );
    expect(response.status).toBe(200);
    return {
      body: (await response.json()) as { challenge: string },
      cookie: [cookie, cookies(response)].filter(Boolean).join("; "),
    };
  };
  const register = async (
    device: ReturnType<typeof testAuthenticator>,
    name: string,
  ) => {
    const challenge = await options("register");
    const response = await post(
      "/auth/passkey/verify-registration",
      { response: device.registration(challenge.body.challenge, origin), name },
      challenge.cookie,
    );
    expect(response.status).toBe(200);
    return (await response.json()) as { id: string };
  };
  const remove = (id: string) =>
    ctx.app.request(origin + "/owner/passkeys/" + id, {
      method: "DELETE",
      headers: { origin, cookie: ownerCookie },
    });
  return { ...ctx, post, ownerCookie, options, register, remove };
}
function cookies(response: Response) {
  return response.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
}

it("signs with cryptographic credentials, consumes challenges, and removes only one passkey", async () => {
  const ctx = await signedOwner();
  const first = testAuthenticator(),
    second = testAuthenticator();
  const registered = await ctx.register(first, "First");
  await ctx.register(second, "Second");
  const challenge = await ctx.options("authenticate");
  const body = {
    response: first.authentication(challenge.body.challenge, origin),
  };
  const login = await ctx.post(
    "/auth/passkey/verify-authentication",
    body,
    challenge.cookie,
  );
  expect(login.status).toBe(200);
  expect(
    (await ctx.app.request("/owner", { headers: { cookie: cookies(login) } }))
      .status,
  ).toBe(200);
  const replay = await ctx.post(
    "/auth/passkey/verify-authentication",
    body,
    challenge.cookie,
  );
  expect(replay.status).toBe(400);
  expect(cookies(replay)).not.toContain("session_token");
  expect((await ctx.remove(registered.id)).status).toBe(200);
  const removedChallenge = await ctx.options("authenticate");
  const removed = await ctx.post(
    "/auth/passkey/verify-authentication",
    {
      response: first.authentication(
        removedChallenge.body.challenge,
        origin,
        2,
      ),
    },
    removedChallenge.cookie,
  );
  expect(removed.status).toBe(401);
  expect(cookies(removed)).not.toContain("session_token");
  const secondChallenge = await ctx.options("authenticate");
  expect(
    (
      await ctx.post(
        "/auth/passkey/verify-authentication",
        {
          response: second.authentication(
            secondChallenge.body.challenge,
            origin,
          ),
        },
        secondChallenge.cookie,
      )
    ).status,
  ).toBe(200);
});

it("records when a passkey last signed in, only for that passkey and only when the sign-in succeeds", async () => {
  const ctx = await signedOwner(),
    used = testAuthenticator(),
    idle = testAuthenticator();
  await ctx.register(used, "Used");
  await ctx.register(idle, "Idle");
  expect(await lastUsed(ctx)).toEqual({ Used: null, Idle: null });

  const refusedChallenge = await ctx.options("authenticate");
  const forged = used.authentication(refusedChallenge.body.challenge, origin);
  forged.response.signature = Buffer.alloc(64).toString("base64url");
  const refused = await ctx.post(
    "/auth/passkey/verify-authentication",
    { response: forged },
    refusedChallenge.cookie,
  );
  expect(refused.status).toBeGreaterThanOrEqual(400);
  expect(await lastUsed(ctx)).toEqual({ Used: null, Idle: null });

  const from = Math.floor(Date.now() / 1000) * 1000;
  const challenge = await ctx.options("authenticate");
  const login = await ctx.post(
    "/auth/passkey/verify-authentication",
    { response: used.authentication(challenge.body.challenge, origin) },
    challenge.cookie,
  );
  expect(login.status).toBe(200);
  const after = await lastUsed(ctx);
  expect(after.Idle).toBeNull();
  const at = Date.parse(String(after.Used));
  expect(at).toBeGreaterThanOrEqual(from);
  expect(at).toBeLessThanOrEqual(Date.now());
});

/** Each passkey's `last_used_at`, by name, as the owner's list returns it. */
async function lastUsed(ctx: Awaited<ReturnType<typeof signedOwner>>) {
  const list = await ctx.app.request(origin + "/owner/passkeys", {
    headers: { origin, cookie: ctx.ownerCookie },
  });
  expect(list.status).toBe(200);
  const { data } = (await list.json()) as {
    data: { name: string; last_used_at: string | null }[];
  };
  return Object.fromEntries(data.map((row) => [row.name, row.last_used_at]));
}

it("refuses wrong signatures and missing user verification without producing a session", async () => {
  const ctx = await signedOwner(),
    device = testAuthenticator();
  await ctx.register(device, "Owner");
  for (const kind of ["signature", "verification", "origin", "rp"] as const) {
    const challenge = await ctx.options("authenticate");
    const response = device.authentication(
      challenge.body.challenge,
      kind === "origin" ? "https://elsewhere.example" : origin,
      1,
      kind === "rp" ? "elsewhere.example" : "localhost",
      kind !== "verification",
    );
    if (kind === "signature")
      response.response.signature = Buffer.alloc(64).toString("base64url");
    const refused = await ctx.post(
      "/auth/passkey/verify-authentication",
      { response },
      challenge.cookie,
    );
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(refused.status).toBeLessThan(500);
    expect(cookies(refused)).not.toContain("session_token");
    const replay = await ctx.post(
      "/auth/passkey/verify-authentication",
      { response: device.authentication(challenge.body.challenge, origin) },
      challenge.cookie,
    );
    expect(replay.status).toBe(400);
  }
  const challenge = await ctx.options("authenticate");
  expect(
    (
      await ctx.post(
        "/auth/passkey/verify-authentication",
        { response: device.authentication(challenge.body.challenge, origin) },
        challenge.cookie,
      )
    ).status,
  ).toBe(200);
});

it("keeps passkey sign-in independent of the password lock", async () => {
  const ctx = await signedOwner(),
    device = testAuthenticator();
  await ctx.register(device, "Owner");
  for (let attempt = 0; attempt < 11; attempt++)
    await ctx.post("/auth/sign-in/email", {
      ...owner,
      password: "wrong password",
    });
  expect((await ctx.post("/auth/sign-in/email", owner)).status).toBe(429);
  const challenge = await ctx.options("authenticate");
  const login = await ctx.post(
    "/auth/passkey/verify-authentication",
    { response: device.authentication(challenge.body.challenge, origin) },
    challenge.cookie,
  );
  expect(login.status).toBe(200);
  expect((await ctx.post("/auth/sign-in/email", owner)).status).toBe(429);
});

it("requires the owner's recent browser session and same origin at every management door", async () => {
  const ctx = await signedOwner(),
    device = testAuthenticator();
  const registered = await ctx.register(device, "Owner");
  for (const path of ["generate-register-options", "verify-registration"]) {
    const method =
      path.startsWith("generate") || path.startsWith("list") ? "GET" : "POST";
    const body =
      method === "POST"
        ? JSON.stringify({ id: registered.id, response: {} })
        : undefined;
    for (const headers of [
      { origin },
      { origin: "https://elsewhere.example", cookie: ctx.ownerCookie },
      { origin, cookie: ctx.ownerCookie, authorization: "Bearer anything" },
    ]) {
      const response = await ctx.auth
        .handler(
          new Request(origin + "/auth/passkey/" + path, {
            method,
            headers: { "content-type": "application/json", ...headers },
            body,
          }),
          "127.0.0.1",
        )
        .catch((error: unknown) => error);
      expect(response).toBeInstanceOf(Error);
    }
  }
  const session = await ctx.auth.getSession(
    new Headers({ cookie: ctx.ownerCookie }),
  );
  expect(session).not.toBeNull();
  const db = ctx.storage.betterAuthDb as {
    run(query: unknown): Promise<unknown>;
  };
  await db.run(
    sql`update auth_session set created_at = ${Math.floor(Date.now() / 1000) - 3600} where id = ${session!.session.id}`,
  );
  for (const path of ["generate-register-options", "verify-registration"]) {
    const method = path.startsWith("generate") ? "GET" : "POST";
    const response = await ctx.app.request(origin + "/auth/passkey/" + path, {
      method,
      headers: {
        origin,
        cookie: ctx.ownerCookie,
        "content-type": "application/json",
      },
      ...(method === "POST"
        ? { body: JSON.stringify({ id: registered.id, response: {} }) }
        : {}),
    });
    expect(response.status).toBe(403);
    expect(
      ((await response.json()) as { error: { message: string } }).error.message,
    ).toBe(SIGN_IN_AGAIN_MESSAGE);
  }
  const list = await ctx.app.request(origin + "/owner/passkeys", {
    headers: { origin, cookie: ctx.ownerCookie },
  });
  expect(list.status).toBe(200);
  expect(((await list.json()) as { data: unknown[] }).data).toHaveLength(1);
});

it("rolls back the session and counter when its audit cannot commit", async () => {
  const ctx = await signedOwner(),
    device = testAuthenticator();
  await ctx.register(device, "Owner");
  const challenge = await ctx.options("authenticate");
  const response = device.authentication(challenge.body.challenge, origin);
  const session = await ctx.auth.getSession(
    new Headers({ cookie: ctx.ownerCookie }),
  );
  if (!session) throw new Error("Missing owner session");
  expect(await ctx.auth.listBrowserSessions(session.user.id)).toHaveLength(1);
  const original = ctx.storage.audit.log.bind(ctx.storage.audit);
  const spy = vi
    .spyOn(ctx.storage.audit, "log")
    .mockImplementation(async (entry, id) => {
      if (entry.action === "auth.sign_in.success")
        throw new Error("audit storage unavailable");
      return original(entry, id);
    });
  const failed = await ctx.post(
    "/auth/passkey/verify-authentication",
    { response },
    challenge.cookie,
  );
  expect(failed.status).toBe(500);
  expect(cookies(failed)).not.toContain("session_token");
  spy.mockRestore();
  expect(await ctx.auth.listBrowserSessions(session.user.id)).toHaveLength(1);
  expect(await lastUsed(ctx)).toEqual({ Owner: null });
  const retry = await ctx.post(
    "/auth/passkey/verify-authentication",
    { response },
    challenge.cookie,
  );
  expect(retry.status).toBe(200);
  expect(await ctx.auth.listBrowserSessions(session.user.id)).toHaveLength(2);
  expect((await lastUsed(ctx)).Owner).toEqual(expect.any(String));
});

import { sql } from "drizzle-orm";
import { vi } from "vitest";

it("refuses duplicate registration so removal cannot leave the same credential usable", async () => {
  const ctx = await signedOwner(),
    device = testAuthenticator();
  const registered = await ctx.register(device, "First name");
  const challenge = await ctx.options("register");
  const duplicate = await ctx.post(
    "/auth/passkey/verify-registration",
    {
      name: "Second name",
      response: device.registration(challenge.body.challenge, origin),
    },
    challenge.cookie,
  );
  expect(duplicate.status).toBe(409);
  expect((await ctx.remove(registered.id)).status).toBe(200);
  const authentication = await ctx.options("authenticate");
  expect(
    (
      await ctx.post(
        "/auth/passkey/verify-authentication",
        {
          response: device.authentication(
            authentication.body.challenge,
            origin,
          ),
        },
        authentication.cookie,
      )
    ).status,
  ).toBe(401);
});

it("requires user verification during enrollment and consumes its refused challenge", async () => {
  const ctx = await signedOwner(),
    device = testAuthenticator();
  const challenge = await ctx.options("register");
  const refused = await ctx.post(
    "/auth/passkey/verify-registration",
    {
      response: device.registration(
        challenge.body.challenge,
        origin,
        "localhost",
        false,
      ),
    },
    challenge.cookie,
  );
  expect(refused.status).toBe(401);
  const retry = await ctx.post(
    "/auth/passkey/verify-registration",
    { response: device.registration(challenge.body.challenge, origin) },
    challenge.cookie,
  );
  expect(retry.status).toBe(400);
  await ctx.register(device, "Verified");
});

it("refuses provider calls that bypass the guarded browser facade", async () => {
  const ctx = await signedOwner();
  const api = ctx.auth.api as Record<
    string,
    (input: { headers: Headers; body?: unknown }) => Promise<unknown>
  >;
  for (const name of [
    "generatePasskeyRegistrationOptions",
    "generatePasskeyAuthenticationOptions",
    "listPasskeys",
    "deletePasskey",
    "verifyPasskeyRegistration",
    "verifyPasskeyAuthentication",
  ]) {
    const endpoint = api[name];
    if (!endpoint) throw new Error("Missing passkey endpoint");
    await expect(
      endpoint({
        headers: new Headers({ origin, cookie: ctx.ownerCookie }),
        body: { id: "unknown", response: {} },
      }),
    ).rejects.toMatchObject({ status: "FORBIDDEN" });
  }
});

it("rechecks a browser revoked between admission and the registration write", async () => {
  const ctx = await signedOwner(),
    device = testAuthenticator();
  const challenge = await ctx.options("register");
  const session = await ctx.auth.getSession(
    new Headers({ cookie: ctx.ownerCookie }),
  );
  if (!session) throw new Error("Missing owner session");
  const original = ctx.storage.runInTransaction.bind(ctx.storage);
  let revoke = true;
  const spy = vi
    .spyOn(ctx.storage, "runInTransaction")
    .mockImplementation(async (work, options) => {
      if (revoke) {
        revoke = false;
        const db = ctx.storage.betterAuthDb as {
          run(query: unknown): Promise<unknown>;
        };
        await db.run(
          sql`delete from auth_session where id = ${session.session.id}`,
        );
      }
      return original(work, options);
    });
  const refused = await ctx.post(
    "/auth/passkey/verify-registration",
    { response: device.registration(challenge.body.challenge, origin) },
    challenge.cookie,
  );
  spy.mockRestore();
  expect(refused.status).toBe(401);
  expect(await ctx.auth.listBrowserSessions(session.user.id)).toHaveLength(0);
  const login = await ctx.post("/auth/sign-in/email", owner);
  const list = await ctx.app.request(origin + "/owner/passkeys", {
    headers: { origin, cookie: cookies(login) },
  });
  expect(list.status).toBe(200);
  expect(await list.json()).toEqual({ data: [], next_cursor: null });
});

it("uses the verified registration identity and keeps removal effective", async () => {
  const ctx = await signedOwner(),
    device = testAuthenticator();
  const registered = await ctx.register(device, "First");
  const challenge = await ctx.options("register");
  const response = device.registration(challenge.body.challenge, origin);
  response.id = response.rawId = Buffer.from(
    "alternate outer identity",
  ).toString("base64url");
  const duplicate = await ctx.post(
    "/auth/passkey/verify-registration",
    { name: "Second", response },
    challenge.cookie,
  );
  expect.soft(duplicate.status).toBe(409);
  expect((await ctx.remove(registered.id)).status).toBe(200);
  const authentication = await ctx.options("authenticate");
  const login = await ctx.post(
    "/auth/passkey/verify-authentication",
    { response: device.authentication(authentication.body.challenge, origin) },
    authentication.cookie,
  );
  expect(login.status).toBe(401);
});

it("includes every credential in the inventory and both ceremony options", async () => {
  const ctx = await signedOwner();
  const devices = Array.from({ length: 101 }, () => testAuthenticator());
  const rows = [];
  for (const [index, device] of devices.entries())
    rows.push(await ctx.register(device, `Passkey ${String(index)}`));
  const list = await ctx.app.request(origin + "/owner/passkeys", {
    headers: { origin, cookie: ctx.ownerCookie },
  });
  expect(list.status).toBe(200);
  const { data: listed } = (await list.json()) as { data: { id: string }[] };
  expect
    .soft(listed.map((row) => row.id).sort())
    .toEqual(rows.map((row) => row.id).sort());
  for (const [kind, field] of [
    ["register", "excludeCredentials"],
    ["authenticate", "allowCredentials"],
  ] as const) {
    const response = await ctx.app.request(
      origin + `/auth/passkey/generate-${kind}-options`,
      { headers: { origin, cookie: ctx.ownerCookie } },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, { id: string }[]>;
    expect
      .soft(body[field]?.map((row) => row.id).sort())
      .toEqual(devices.map((device) => device.id).sort());
  }
  const last = devices.at(-1),
    lastRow = rows.at(-1);
  if (!last || !lastRow) throw new Error("Missing final credential");
  const challenge = await ctx.options("authenticate");
  expect(
    (
      await ctx.post(
        "/auth/passkey/verify-authentication",
        { response: last.authentication(challenge.body.challenge, origin) },
        challenge.cookie,
      )
    ).status,
  ).toBe(200);
  expect((await ctx.remove(lastRow.id)).status).toBe(200);
  const removed = await ctx.options("authenticate");
  expect(
    (
      await ctx.post(
        "/auth/passkey/verify-authentication",
        { response: last.authentication(removed.body.challenge, origin, 2) },
        removed.cookie,
      )
    ).status,
  ).toBe(401);
});

it("orders verification and removal at the credential writer in either order", async () => {
  for (const first of ["verify", "remove"] as const) {
    const ctx = await signedOwner();
    const device = testAuthenticator();
    const registered = await ctx.register(device, "Racing");
    const challenge = await ctx.options("authenticate");
    let entered!: () => void, release!: () => void;
    const held = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const resume = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = ctx.storage.audit.log.bind(ctx.storage.audit);
    let once = true;
    const spy = vi
      .spyOn(ctx.storage.audit, "log")
      .mockImplementation(async (entry, id) => {
        if (
          once &&
          entry.action ===
            (first === "verify" ? "auth.passkey.update" : "auth.passkey.delete")
        ) {
          once = false;
          entered();
          await resume;
        }
        return original(entry, id);
      });
    const verify = () =>
      ctx.post(
        "/auth/passkey/verify-authentication",
        { response: device.authentication(challenge.body.challenge, origin) },
        challenge.cookie,
      );
    const initial = first === "verify" ? verify() : ctx.remove(registered.id);
    await held;
    const later = first === "verify" ? ctx.remove(registered.id) : verify();
    release();
    const [initialResponse, laterResponse] = await Promise.all([
      initial,
      later,
    ]);
    spy.mockRestore();
    expect(initialResponse.status).toBe(200);
    expect(laterResponse.status).toBe(first === "verify" ? 200 : 401);
    if (first === "verify")
      expect(cookies(initialResponse)).toContain("session_token");
    else expect(cookies(laterResponse)).not.toContain("session_token");
    const removed = await ctx.options("authenticate");
    expect(
      (
        await ctx.post(
          "/auth/passkey/verify-authentication",
          {
            response: device.authentication(removed.body.challenge, origin, 2),
          },
          removed.cookie,
        )
      ).status,
    ).toBe(401);
  }
});
