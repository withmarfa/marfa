/**
 * The owner door. Every instance boots without an owner, the operator key
 * creates the one account, and the account is real: it signs in at the
 * sign-in surface the door exists to put a person behind.
 */
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { ensureInstanceId } from "../storage/instance-id.js";
import { createBlobLayer } from "../storage/blob-layer.js";
import { Housekeeping } from "../housekeeping/scheduler.js";
import { createSqliteStorage } from "../storage/sqlite/index.js";
import { auth_account, auth_user } from "../storage/sqlite/schema.js";
import type { DrizzleDb } from "../storage/sqlite/connection.js";
import {
  createTestAccount,
  createTestContext,
  request,
} from "../test-utils.js";
import type { TestContext } from "../test-utils.js";

/** What `createTestContext` hands the auth surface as its base URL. */
const ORIGIN = "http://localhost:0";
const PASSWORD = "correct horse battery";

const contexts: TestContext[] = [];

async function newContext(): Promise<TestContext> {
  const ctx = await createTestContext();
  contexts.push(ctx);
  return ctx;
}

afterEach(async () => {
  while (contexts.length > 0) {
    const ctx = contexts.pop();
    if (ctx) await ctx.cleanup();
  }
});

interface Envelope {
  error: {
    code: string;
    message: string;
    details?: { errors?: { path: string; message: string }[] };
  };
}

interface Owner {
  id: string;
  email: string;
  name: string;
  created_at: string;
}

async function create(
  ctx: TestContext,
  body: unknown,
  key = ctx.operatorKey,
): Promise<Response> {
  return request(ctx.app, "POST", "/owner", { key, body });
}

async function signIn(
  ctx: TestContext,
  email: string,
  password: string,
): Promise<Response> {
  return request(ctx.app, "POST", "/auth/sign-in/email", {
    body: { email, password },
    headers: { origin: ORIGIN },
  });
}

describe("GET /owner", () => {
  it("refuses no credential and a working key, and answers the operator", async () => {
    const ctx = await newContext();
    const bare = await request(ctx.app, "GET", "/owner");
    expect(bare.status).toBe(401);
    const working = await request(ctx.app, "GET", "/owner", {
      key: ctx.workingKey,
    });
    expect(working.status).toBe(403);
    expect(((await working.json()) as Envelope).error.code).toBe("forbidden");

    // A fresh instance has nobody behind its sign-in surface.
    const operator = await request(ctx.app, "GET", "/owner", {
      key: ctx.operatorKey,
    });
    expect(operator.status).toBe(404);
    const refusal = ((await operator.json()) as Envelope).error;
    expect(refusal.code).toBe("owner_not_found");
    expect(refusal.message).toContain("marfa owner create");
  });

  it("answers an account written around the door, because the first account is the owner", async () => {
    const ctx = await newContext();
    const seeded = await createTestAccount(
      ctx,
      "seeded@example.com",
      PASSWORD,
      "Seeded",
    );
    const res = await request(ctx.app, "GET", "/owner", {
      key: ctx.operatorKey,
    });
    expect(res.status).toBe(200);
    const owner = (await res.json()) as Owner;
    expect(owner).toMatchObject({
      id: seeded.authUserId,
      email: "seeded@example.com",
      name: "Seeded",
    });
    expect(Number.isNaN(Date.parse(owner.created_at))).toBe(false);

    const again = await create(ctx, {
      email: "second@example.com",
      password: PASSWORD,
    });
    expect(again.status).toBe(409);
    expect(((await again.json()) as Envelope).error.code).toBe("owner_exists");
  });

  it("answers the account created first when the harness has written two", async () => {
    const ctx = await newContext();
    const first = await createTestAccount(ctx, "first@example.com", PASSWORD);
    // A second later, so the two do not share a creation second and the
    // order is the stamp's rather than the id's.
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await createTestAccount(ctx, "second@example.com", PASSWORD);
    const res = await request(ctx.app, "GET", "/owner", {
      key: ctx.operatorKey,
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as Owner).id).toBe(first.authUserId);
  });
});

describe("POST /owner", () => {
  it("refuses no credential ahead of the body, and a working key", async () => {
    const ctx = await newContext();
    const bare = await request(ctx.app, "POST", "/owner", {
      headers: { "content-type": "application/json" },
      body: "{ not json",
    });
    expect(bare.status).toBe(401);
    const working = await create(
      ctx,
      { email: "owner@example.com", password: PASSWORD },
      ctx.workingKey,
    );
    expect(working.status).toBe(403);
    // Neither refusal created anything, and the same body under the
    // operator key does.
    const none = await request(ctx.app, "GET", "/owner", {
      key: ctx.operatorKey,
    });
    expect(none.status).toBe(404);
    const created = await create(ctx, {
      email: "owner@example.com",
      password: PASSWORD,
    });
    expect(created.status).toBe(201);
  });

  it("refuses a malformed body and a password outside the sign-in surface's rule", async () => {
    const ctx = await newContext();

    const noPassword = await create(ctx, { email: "owner@example.com" });
    expect(noPassword.status).toBe(400);
    expect(((await noPassword.json()) as Envelope).error.code).toBe(
      "missing_required_field",
    );

    const badAddress = await create(ctx, {
      email: "not an address",
      password: PASSWORD,
    });
    expect(badAddress.status).toBe(400);
    const badAddressBody = (await badAddress.json()) as Envelope;
    expect(badAddressBody.error.code).toBe("validation_error");
    expect(badAddressBody.error.details?.errors?.[0]?.path).toBe("email");

    const short = await create(ctx, {
      email: "owner@example.com",
      password: "short",
    });
    expect(short.status).toBe(400);
    const shortBody = (await short.json()) as Envelope;
    expect(shortBody.error.code).toBe("validation_error");
    expect(shortBody.error.details?.errors).toEqual([
      {
        path: "password",
        message: expect.stringMatching(/^must be at least \d+ characters$/),
      },
    ]);

    const long = await create(ctx, {
      email: "owner@example.com",
      password: "x".repeat(1000),
    });
    expect(long.status).toBe(400);
    const longBody = (await long.json()) as Envelope;
    expect(longBody.error.details?.errors).toEqual([
      {
        path: "password",
        message: expect.stringMatching(/^must be at most \d+ characters$/),
      },
    ]);

    // None of those created anything, and the same address with a password
    // inside the rule does: the refusals were about the body.
    const none = await request(ctx.app, "GET", "/owner", {
      key: ctx.operatorKey,
    });
    expect(none.status).toBe(404);
    const good = await create(ctx, {
      email: "owner@example.com",
      password: PASSWORD,
    });
    expect(good.status).toBe(201);
  });

  it("creates the owner, who can then sign in, and refuses a second", async () => {
    const ctx = await newContext();
    const before = await signIn(ctx, "owner@example.com", PASSWORD);
    expect(before.status, "nobody can sign in before the owner exists").toBe(
      401,
    );

    const created = await create(ctx, {
      email: "Owner@Example.com",
      password: PASSWORD,
    });
    expect(created.status).toBe(201);
    const owner = (await created.json()) as Owner;
    // The address is stored lowercased, and a name that was not given is
    // the address's local part.
    expect(owner.email).toBe("owner@example.com");
    expect(owner.name).toBe("owner");
    expect(owner.id).not.toBe("");
    expect(Number.isNaN(Date.parse(owner.created_at))).toBe(false);

    const read = await request(ctx.app, "GET", "/owner", {
      key: ctx.operatorKey,
    });
    expect(read.status).toBe(200);
    expect(await read.json()).toEqual(owner);

    // The account is real: it passes the sign-in surface, and only with
    // its password.
    const signedIn = await signIn(ctx, "owner@example.com", PASSWORD);
    expect(signedIn.status).toBe(200);
    expect(signedIn.headers.get("set-cookie")).toMatch(/session_token=/);
    const wrong = await signIn(ctx, "owner@example.com", "not the password");
    expect(wrong.status).toBe(401);

    const second = await create(ctx, {
      email: "second@example.com",
      password: PASSWORD,
    });
    expect(second.status).toBe(409);
    expect(((await second.json()) as Envelope).error.code).toBe("owner_exists");
    const sameAddress = await create(ctx, {
      email: "owner@example.com",
      password: PASSWORD,
    });
    expect(sameAddress.status).toBe(409);
    const still = await request(ctx.app, "GET", "/owner", {
      key: ctx.operatorKey,
    });
    expect(await still.json()).toEqual(owner);
  });

  it("keeps the name it was given, trimmed", async () => {
    const ctx = await newContext();
    const created = await create(ctx, {
      email: "owner@example.com",
      password: PASSWORD,
      name: "  The Owner  ",
    });
    expect(created.status).toBe(201);
    expect(((await created.json()) as Owner).name).toBe("The Owner");
  });

  it("audits the creation against the operator key that asked", async () => {
    const ctx = await newContext();
    const created = await create(ctx, {
      email: "owner@example.com",
      password: PASSWORD,
    });
    expect(created.status).toBe(201);
    const owner = (await created.json()) as Owner;
    const rows = await ctx.storage.audit.list({ action: "owner.created" });
    expect(rows.data).toHaveLength(1);
    expect(rows.data[0]).toMatchObject({
      action: "owner.created",
      resource_type: "owner",
      resource_id: owner.id,
      details: { email: "owner@example.com" },
    });
    expect(rows.data[0]?.key_id).not.toBeNull();
    const keys = await ctx.storage.keys.list();
    const operator = keys.find((k) => k.id === rows.data[0]?.key_id);
    expect(operator?.is_operator).toBe(true);
  });

  it("creates exactly one owner when two asks arrive together", async () => {
    const ctx = await newContext();
    const [a, b] = await Promise.all([
      create(ctx, { email: "first@example.com", password: PASSWORD }),
      create(ctx, { email: "second@example.com", password: PASSWORD }),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([201, 409]);
    const won = a.status === 201 ? a : b;
    const owner = (await won.json()) as Owner;
    const read = await request(ctx.app, "GET", "/owner", {
      key: ctx.operatorKey,
    });
    expect(await read.json()).toEqual(owner);
    const rows = await ctx.storage.audit.list({ action: "owner.created" });
    expect(rows.data).toHaveLength(1);
  });

  it("creates exactly one owner across two processes on one file", async () => {
    // A second server over the same database, which is what two processes
    // are to SQLite; it holds the same keys, because the keys are rows.
    const ctx = await newContext();
    const storage = await createSqliteStorage(join(ctx.tmpDir, "test.db"));
    try {
      const other = createApp(
        storage,
        await createBlobLayer(storage, ctx.config),
        new Housekeeping(storage.housekeeping, { pollIntervalMs: 1_000 }),
        ctx.config,
        await ensureInstanceId(storage.settings),
      );
      const [a, b] = await Promise.all([
        create(ctx, { email: "first@example.com", password: PASSWORD }),
        request(other, "POST", "/owner", {
          key: ctx.operatorKey,
          body: { email: "second@example.com", password: PASSWORD },
        }),
      ]);
      expect([a.status, b.status].sort()).toEqual([201, 409]);
      const rows = await ctx.storage.audit.list({ action: "owner.created" });
      expect(rows.data).toHaveLength(1);
    } finally {
      await storage.close();
    }
  });

  it("opens again once the account is gone, because the row is the record", async () => {
    const ctx = await newContext();
    const created = await create(ctx, {
      email: "owner@example.com",
      password: PASSWORD,
    });
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as Owner;
    const db = ctx.storage.betterAuthDb as DrizzleDb;
    await db.delete(auth_account).where(eq(auth_account.userId, id));
    await db.delete(auth_user).where(eq(auth_user.id, id));

    const none = await request(ctx.app, "GET", "/owner", {
      key: ctx.operatorKey,
    });
    expect(none.status).toBe(404);
    const again = await create(ctx, {
      email: "owner@example.com",
      password: PASSWORD,
    });
    expect(again.status).toBe(201);
  });

  it("gives the claim back when the write throws, so the next ask creates", async () => {
    const ctx = await newContext();
    const real = ctx.auth.createEmailAccount;
    ctx.auth.createEmailAccount = () => {
      ctx.auth.createEmailAccount = real;
      return Promise.reject(new Error("the database went away"));
    };
    const failed = await create(ctx, {
      email: "owner@example.com",
      password: PASSWORD,
    });
    expect(failed.status).toBe(500);
    const created = await create(ctx, {
      email: "owner@example.com",
      password: PASSWORD,
    });
    expect(created.status).toBe(201);
  });

  it("honors a live claim and takes over one a dead process left", async () => {
    const ctx = await newContext();
    expect(await ctx.storage.settings.claim("owner", String(Date.now()))).toBe(
      true,
    );
    const held = await create(ctx, {
      email: "owner@example.com",
      password: PASSWORD,
    });
    expect(held.status).toBe(409);
    expect(((await held.json()) as Envelope).error.code).toBe("owner_exists");
    await ctx.storage.settings.release("owner");

    expect(
      await ctx.storage.settings.claim(
        "owner",
        String(Date.now() - 10 * 60_000),
      ),
    ).toBe(true);
    const created = await create(ctx, {
      email: "owner@example.com",
      password: PASSWORD,
    });
    expect(created.status).toBe(201);
    // And given back, like every claim this door takes.
    expect(await ctx.storage.settings.get("owner")).toBeNull();
  });

  it("asks again under the claim, so an account that lands after the first check is seen", async () => {
    const ctx = await newContext();
    // The account lands in the gap between the check and the claim: the
    // claim itself is wrapped so the first one taken finds the row there.
    const settings = ctx.storage.settings;
    const claim = settings.claim.bind(settings);
    settings.claim = async (key, value) => {
      settings.claim = claim;
      await createTestAccount(ctx, "landed@example.com", PASSWORD);
      return claim(key, value);
    };
    const res = await create(ctx, {
      email: "owner@example.com",
      password: PASSWORD,
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as Envelope).error.code).toBe("owner_exists");
    const db = ctx.storage.betterAuthDb as DrizzleDb;
    expect(await db.select({ id: auth_user.id }).from(auth_user)).toHaveLength(
      1,
    );
    expect(await settings.get("owner")).toBeNull();
  });

  it("answers the creation even when the claim cannot be given back", async () => {
    const ctx = await newContext();
    const settings = ctx.storage.settings;
    const release = settings.release.bind(settings);
    settings.release = () => {
      settings.release = release;
      return Promise.reject(new Error("the settings table is gone"));
    };
    const created = await create(ctx, {
      email: "owner@example.com",
      password: PASSWORD,
    });
    expect(created.status).toBe(201);
    // The claim is left behind for the lease to repair, and the owner is
    // there for everyone to see.
    expect(await settings.get("owner")).not.toBeNull();
    const read = await request(ctx.app, "GET", "/owner", {
      key: ctx.operatorKey,
    });
    expect(read.status).toBe(200);
  });

  it("answers owner_exists when an account with the address lands around the door", async () => {
    const ctx = await newContext();
    const real = ctx.auth.createEmailAccount;
    ctx.auth.createEmailAccount = () => {
      ctx.auth.createEmailAccount = real;
      return Promise.resolve({ ok: false, reason: "email_exists" });
    };
    const res = await create(ctx, {
      email: "owner@example.com",
      password: PASSWORD,
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as Envelope).error.code).toBe("owner_exists");
  });

  it("fails the request when the audit row cannot be written", async () => {
    const ctx = await newContext();
    const real = ctx.storage.audit.log.bind(ctx.storage.audit);
    ctx.storage.audit.log = () => {
      ctx.storage.audit.log = real;
      return Promise.reject(new Error("the audit table is gone"));
    };
    const res = await create(ctx, {
      email: "owner@example.com",
      password: PASSWORD,
    });
    expect(res.status).toBe(500);
  });
});
