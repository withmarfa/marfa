/**
 * The owner door. Every instance boots without an owner, the operator key
 * creates the one account, and the account is real: it signs in at the
 * sign-in surface the door exists to put a person behind.
 */
import { afterEach, describe, expect, it } from "vitest";
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
    expect(((await operator.json()) as Envelope).error.code).toBe(
      "owner_not_found",
    );
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
    // Neither refusal created anything.
    const none = await request(ctx.app, "GET", "/owner", {
      key: ctx.operatorKey,
    });
    expect(none.status).toBe(404);
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
});
