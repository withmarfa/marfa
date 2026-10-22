import * as clock from "../clock.js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { png } from "../test-pictures.js";
import {
  createTestContext,
  request,
  seedOauthBearer,
  type TestContext,
} from "../test-utils.js";
let ctx: TestContext;
beforeEach(async () => {
  ctx = await createTestContext();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await ctx.cleanup();
});
const origin = () => new URL(ctx.config.authBaseUrl).origin;
const pictureAddress = () => `${origin()}/owner/picture`;
function upload(file: Uint8Array) {
  return ctx.app.request("/owner/picture", {
    method: "PUT",
    headers: { cookie: ctx.owner.cookie, origin: origin() },
    body: new Uint8Array(file),
  });
}
function owner(body: unknown) {
  return request(ctx.app, "PATCH", "/owner", {
    body,
    headers: {
      cookie: ctx.owner.cookie,
      origin: new URL(ctx.config.authBaseUrl).origin,
    },
  });
}
it("updates the existing owner and keeps password sign-in working at the new email", async () => {
  const previous = await ctx.storage.owner!.find();
  const response = await owner({
    email: "NEW@example.com",
    name: "  New name  ",
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    id: previous!.id,
    email: "new@example.com",
    name: "New name",
  });
  expect((await ctx.storage.owner!.find())!.id).toBe(previous!.id);
});
it("refuses empty, unknown and invalid owner fields", async () => {
  for (const body of [
    {},
    { avatar: "file:///tmp/picture" },
    { avatar: "https://example.com/portrait.png" },
    { name: " " },
    { name: "\tName" },
    { name: "\u200fName" },
    { name: "a".repeat(201) },
    { email: "bad" },
    { email: null },
  ]) {
    expect((await owner(body)).status, JSON.stringify(body)).toBe(400);
  }
  expect((await owner({ name: "😀".repeat(200) })).status).toBe(200);
});
it("sets and clears the owner's picture without changing their other details", async () => {
  const before = await ctx.storage.owner!.find();
  expect(before!.hasPicture).toBe(false);
  const set = await upload(png());
  expect(set.status).toBe(200);
  expect(await set.json()).toMatchObject({ avatar: pictureAddress() });
  expect(await ctx.storage.owner!.find()).toMatchObject({
    id: before!.id,
    email: before!.email,
    name: before!.name,
    hasPicture: true,
  });
  const cleared = await owner({ avatar: null });
  expect(cleared.status).toBe(200);
  expect(await cleared.json()).toMatchObject({ avatar: null });
  expect(await ctx.storage.owner!.find()).toMatchObject({
    email: before!.email,
    name: before!.name,
    hasPicture: false,
  });
});
it("refuses profile fields without credential write authority and never accepts email", async () => {
  expect(
    (
      await request(ctx.app, "PATCH", "/profile", {
        key: ctx.workingKey,
        body: { name: "Allowed" },
      })
    ).status,
  ).toBe(200);
  for (const body of [
    {},
    { email: "other@example.com" },
    { name: "No", email: "other@example.com" },
    { avatar: "file:///tmp/picture" },
    { avatar: "https://example.com/portrait.png" },
  ]) {
    expect(
      (
        await request(ctx.app, "PATCH", "/profile", {
          key: ctx.workingKey,
          body,
        })
      ).status,
      JSON.stringify(body),
    ).toBe(400);
  }
  expect(
    (
      await request(ctx.app, "PATCH", "/profile", {
        key: ctx.workingKey,
        body: { avatar: null },
      })
    ).status,
  ).toBe(200);
});
it("refuses explicit email-write and unknown profile key grants at both doors", async () => {
  for (const profile_permissions of [{ email: "write" }, { unknown: "read" }]) {
    expect(
      (
        await request(ctx.app, "POST", "/keys", {
          headers: {
            cookie: ctx.owner.cookie,
            origin: new URL(ctx.config.authBaseUrl).origin,
          },
          body: { label: "bad", source: "profile-test", profile_permissions },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await request(
          ctx.app,
          "PATCH",
          `/keys/${(await ctx.storage.keys.list())[0]!.id}`,
          {
            headers: {
              cookie: ctx.owner.cookie,
              origin: new URL(ctx.config.authBaseUrl).origin,
            },
            body: { profile_permissions },
          },
        )
      ).status,
    ).toBe(400);
  }
});

it("keeps credentials, sessions, and grants intact and signs in only at the new email", async () => {
  const raw = ctx.storage as typeof ctx.storage & {
    __sqliteAll(query: string): Promise<unknown[]>;
  };
  const before = await raw.__sqliteAll(
    "SELECT id, user_id, account_id, provider_id, password FROM auth_account",
  );
  await (
    ctx.storage as typeof ctx.storage & {
      __sqliteRun(query: string, args: unknown[]): Promise<unknown>;
    }
  ).__sqliteRun(
    "INSERT INTO auth_passkey(id,name,public_key,user_id,credential_id,counter,device_type,backed_up) VALUES (?,?,?,?,?,?,?,?)",
    [
      "preserved-passkey",
      "Owner key",
      "public-material",
      ctx.owner.id,
      "credential-material",
      7,
      "singleDevice",
      0,
    ],
  );
  const passkeys = await raw.__sqliteAll("SELECT * FROM auth_passkey");
  expect(passkeys).toHaveLength(1);

  await ctx.storage.runInTransaction(() =>
    ctx.storage.owner!.update({ name: "Before" }),
  );
  expect((await owner({ email: "changed@example.com" })).status).toBe(200);
  const headers = { origin: new URL(ctx.config.authBaseUrl).origin };
  expect(
    (
      await request(ctx.app, "POST", "/auth/sign-in/email", {
        headers,
        body: { email: ctx.owner.email, password: ctx.owner.password },
      })
    ).status,
  ).toBe(401);
  expect(
    (
      await request(ctx.app, "POST", "/auth/sign-in/email", {
        headers,
        body: { email: "changed@example.com", password: ctx.owner.password },
      })
    ).status,
  ).toBe(200);
  expect(
    await raw.__sqliteAll(
      "SELECT id, user_id, account_id, provider_id, password FROM auth_account",
    ),
  ).toEqual(before);
  expect(await raw.__sqliteAll("SELECT * FROM auth_passkey")).toEqual(passkeys);
  expect((await ctx.ownerRequest("/owner")).status).toBe(200);
  expect(
    (await request(ctx.app, "GET", "/keys/current", { key: ctx.workingKey }))
      .status,
  ).toBe(200);
});
it("does not let bearer plus owner cookie or a forged local header update owner", async () => {
  expect(
    (
      await request(ctx.app, "PATCH", "/owner", {
        key: ctx.workingKey,
        headers: {
          cookie: ctx.owner.cookie,
          origin: new URL(ctx.config.authBaseUrl).origin,
        },
        body: { name: "No" },
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await request(ctx.app, "PATCH", "/owner", {
        headers: { "x-marfa-local-authority": "true" },
        body: { name: "No" },
      })
    ).status,
  ).toBe(401);
});
it("rolls back owner and delegated updates when their audit fails", async () => {
  const raw = ctx.storage as typeof ctx.storage & {
    __sqliteRun(query: string, args: unknown[]): Promise<unknown>;
  };
  const before = await ctx.storage.owner!.find();
  for (const action of ["owner.update", "profile.update"]) {
    await raw.__sqliteRun(
      `CREATE TRIGGER reject_profile_audit BEFORE INSERT ON audit_log WHEN NEW.action = '${action}' BEGIN SELECT RAISE(ABORT, 'audit fault'); END`,
      [],
    );
    const result =
      action === "owner.update"
        ? await owner({ name: "Rejected", email: "rejected@example.com" })
        : await request(ctx.app, "PATCH", "/profile", {
            key: ctx.workingKey,
            body: { name: "Rejected", avatar: null },
          });
    expect(result.status).toBe(500);
    expect(await ctx.storage.owner!.find()).toEqual(before);
    await raw.__sqliteRun("DROP TRIGGER reject_profile_audit", []);
  }
  expect((await owner({ name: "Accepted" })).status).toBe(200);
  expect(
    (
      await request(ctx.app, "PATCH", "/profile", {
        key: ctx.workingKey,
        body: { name: "Delegated" },
      })
    ).status,
  ).toBe(200);
});
it("refuses a multi-field update atomically when any submitted field is not writable", async () => {
  const made = await ctx.ownerRequest("/keys", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      label: "name only",
      source: "name-only",
      profile_permissions: { name: "write" },
    }),
  });
  expect(made.status).toBe(201);
  const { key } = (await made.json()) as { key: string };
  const before = await ctx.storage.owner!.find();
  expect(
    (
      await request(ctx.app, "PATCH", "/profile", {
        key,
        body: { name: "Not committed", avatar: null },
      })
    ).status,
  ).toBe(403);
  expect(await ctx.storage.owner!.find()).toEqual(before);
  expect(
    (
      await request(ctx.app, "PATCH", "/profile", {
        key,
        body: { name: "Committed" },
      })
    ).status,
  ).toBe(200);
});
it("refreshes a key narrowed while its profile write waits for writer admission", async () => {
  const before = await ctx.storage.owner!.find();
  const key = (await ctx.storage.keys.list()).find(
    (k) => k.profile_permissions["*"] === "write",
  )!;
  const original = ctx.storage.runInTransaction.bind(ctx.storage);
  let arrive!: () => void, release!: () => void;
  const arrived = new Promise<void>((resolve) => {
    arrive = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let first = true;
  ctx.storage.runInTransaction = async (fn, options) => {
    if (first) {
      first = false;
      arrive();
      await gate;
    }
    return original(fn, options);
  };
  const pending = request(ctx.app, "PATCH", "/profile", {
    key: ctx.workingKey,
    body: { name: "Not committed", avatar: null },
  });
  try {
    await arrived;
    await original(() =>
      ctx.storage.keys.update(key.id, {
        profile_permissions: { name: "write" },
      }),
    );
  } finally {
    release();
  }
  expect((await pending).status).toBe(403);
  expect(await ctx.storage.owner!.find()).toEqual(before);
});

it("requires owner authentication at most five minutes old, and a live session", async () => {
  const raw = ctx.storage as typeof ctx.storage & {
    __sqliteAll(query: string): Promise<{ created_at: number }[]>;
    __sqliteRun(query: string, args: unknown[]): Promise<unknown>;
  };
  const session = (
    await raw.__sqliteAll("SELECT created_at FROM auth_session")
  )[0]!;
  vi.spyOn(clock, "nowMs").mockReturnValue(session.created_at * 1000 + 300_000);
  expect((await owner({ name: "Boundary" })).status).toBe(200);
  vi.mocked(clock.nowMs).mockReturnValue(session.created_at * 1000 + 300_001);
  expect((await owner({ name: "Late" })).status).toBe(403);
  vi.restoreAllMocks();
  await raw.__sqliteRun("DELETE FROM auth_session", []);
  expect((await owner({ name: "Gone" })).status).toBe(401);
  expect((await ctx.storage.owner!.find())!.name).toBe("Boundary");
});

it("serves changed profile values through real OAuth userinfo and keeps wildcard reads", async () => {
  const oauth = await seedOauthBearer(ctx, [
    "openid",
    "profile:write",
    "offline_access",
  ]);
  expect((await upload(png())).status).toBe(200);
  expect(
    (
      await request(ctx.app, "PATCH", "/profile", {
        key: oauth.token,
        body: { name: "OAuth name" },
      })
    ).status,
  ).toBe(200);
  const info = await request(ctx.app, "GET", "/auth/oauth2/userinfo", {
    key: oauth.token,
  });
  expect(info.status).toBe(200);
  expect(await info.json()).toMatchObject({
    sub: ctx.owner.id,
    name: "OAuth name",
    picture: pictureAddress(),
    email: ctx.owner.email,
  });
  expect((await owner({ email: ctx.owner.email.toUpperCase() })).status).toBe(
    200,
  );
  const sameEmail = await request(ctx.app, "GET", "/auth/oauth2/userinfo", {
    key: oauth.token,
  });
  expect(await sameEmail.json()).toMatchObject({
    email: ctx.owner.email,
    email_verified: true,
  });
  expect((await owner({ email: "new@example.com" })).status).toBe(200);
  const changed = await request(ctx.app, "GET", "/auth/oauth2/userinfo", {
    key: oauth.token,
  });
  expect(await changed.json()).toMatchObject({
    sub: ctx.owner.id,
    email: "new@example.com",
    email_verified: false,
  });
  const refreshed = await request(ctx.app, "POST", "/auth/oauth2/token", {
    form: {
      client_id: oauth.clientId,
      grant_type: "refresh_token",
      refresh_token: oauth.refreshToken!,
    },
  });
  expect(refreshed.status).toBe(200);
  const tokens = (await refreshed.json()) as { id_token: string };
  const claims = JSON.parse(
    Buffer.from(tokens.id_token.split(".")[1]!, "base64url").toString(),
  ) as Record<string, unknown>;
  expect(claims).toMatchObject({
    sub: ctx.owner.id,
    email: "new@example.com",
    email_verified: false,
    name: "OAuth name",
    picture: pictureAddress(),
  });
});
it("refuses an app disconnected while awaiting the profile writer", async () => {
  const oauth = await seedOauthBearer(ctx, ["openid", "profile:write"]);
  const before = await ctx.storage.owner!.find();
  const original = ctx.storage.runInTransaction.bind(ctx.storage);
  let arrive!: () => void, release!: () => void;
  const arrived = new Promise<void>((resolve) => {
    arrive = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let first = true;
  ctx.storage.runInTransaction = async (fn, options) => {
    if (first) {
      first = false;
      arrive();
      await gate;
    }
    return original(fn, options);
  };
  const pending = request(ctx.app, "PATCH", "/profile", {
    key: oauth.token,
    body: { name: "No", avatar: null },
  });
  try {
    await arrived;
    expect(
      (
        await ctx.ownerRequest(`/auth/grants/${oauth.grantId}`, {
          method: "DELETE",
        })
      ).status,
    ).toBe(204);
  } finally {
    release();
  }
  expect((await pending).status).toBe(401);
  expect(await ctx.storage.owner!.find()).toEqual(before);
});

it("refuses an expired owner session before changing the owner", async () => {
  expect((await owner({ name: "Live" })).status).toBe(200);
  const raw = ctx.storage as typeof ctx.storage & {
    __sqliteRun(query: string, args: unknown[]): Promise<unknown>;
  };
  await raw.__sqliteRun("UPDATE auth_session SET expires_at = 0", []);
  expect((await owner({ name: "Expired" })).status).toBe(401);
  expect((await ctx.storage.owner!.find())!.name).toBe("Live");
});

it("keeps an old app token through an identical approval with explicit email read", async () => {
  const scopes = ["openid", "profile:write", "profile.email:read"];
  const app = await seedOauthBearer(ctx, scopes);
  const change = () =>
    request(ctx.app, "PATCH", "/profile", {
      key: app.token,
      body: { name: "Still approved" },
    });
  expect((await change()).status).toBe(200);
  await seedOauthBearer(ctx, scopes, { clientId: app.clientId });
  expect((await change()).status).toBe(200);
  await seedOauthBearer(ctx, ["openid", "profile:write"], {
    clientId: app.clientId,
  });
  expect((await change()).status).toBe(200);
});
