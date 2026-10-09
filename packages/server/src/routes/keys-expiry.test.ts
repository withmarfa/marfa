/**
 * A key minted with an expiry, and an expiry changed afterwards.
 *
 * The expiry is a lifetime bound, so every door that lengthens a life is held
 * to the same ceiling a mint is: a key that expires cannot make itself, or a
 * copy of itself, last longer. **Every refusal is paired with the request
 * that must still succeed**, or a route that refused every expiry would pass.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  createTestContext,
  request,
  TEST_API_KEY_SALT,
} from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { hashApiKey } from "../middleware/auth.js";

const SOON = "2999-01-01T00:00:00.000Z";
const LATER = "2999-06-01T00:00:00.000Z";
const LATEST = "2999-12-01T00:00:00.000Z";

let ctx: TestContext;

interface KeyBody {
  id: string;
  key?: string;
  expires_at: string | null;
}

interface Refusal {
  error: { code: string; message: string; details?: Record<string, unknown> };
}

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.cleanup();
});

function suffix(): string {
  return Math.random().toString(36).slice(2, 12);
}

/** A key that may mint and edit, stored with the expiry given. */
async function seedMinter(
  expiresAt?: string,
): Promise<{ id: string; raw: string }> {
  const tag = suffix();
  const raw = `marfa_k1_minter_${tag}`;
  const stored = await ctx.storage.keys.create(
    {
      label: "minter",
      source: `expiry-minter-${tag}`,
      permissions: ["keys.mint"],
      type_permissions: { "*": "write" },
      default_tier: "library",
      ...(expiresAt === undefined ? {} : { expires_at: expiresAt }),
    },
    hashApiKey(raw, TEST_API_KEY_SALT),
  );
  return { id: stored.id, raw };
}

async function mint(key: string, expiresAt?: string | null): Promise<Response> {
  const tag = suffix();
  return request(ctx.app, "POST", "/keys", {
    key,
    body: {
      label: `minted-${tag}`,
      source: `minted-${tag}`,
      type_permissions: { "core.note": "read" },
      ...(expiresAt === undefined ? {} : { expires_at: expiresAt }),
    },
  });
}

async function madeKey(
  key: string,
  expiresAt?: string,
): Promise<{ id: string; raw: string }> {
  const res = await mint(key, expiresAt);
  expect(res.status).toBe(201);
  const body = (await res.json()) as KeyBody;
  return { id: body.id, raw: body.key ?? "" };
}

function patch(
  key: string,
  id: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return request(ctx.app, "PATCH", `/keys/${id}`, { key, body });
}

async function stampExpiry(id: string, at: string): Promise<void> {
  const s = ctx.storage as unknown as {
    __sqliteRun?: (query: string, params: unknown[]) => Promise<unknown>;
  };
  if (!s.__sqliteRun) throw new Error("test storage exposes no __sqliteRun");
  await s.__sqliteRun("UPDATE api_keys SET expires_at = ? WHERE id = ?", [
    at,
    id,
  ]);
}

async function expiryOf(id: string): Promise<string | null | undefined> {
  const res = await request(ctx.app, "GET", "/keys", {
    key: ctx.managementKey,
  });
  const listed = (await res.json()) as { data: KeyBody[] };
  return listed.data.find((key) => key.id === id)?.expires_at;
}

describe("minting a key with an expiry", () => {
  it("answers the instant in UTC, reads it back on every door, and refuses the key once it has passed", async () => {
    const res = await mint(ctx.workingKey, "2999-01-01T02:00:00+02:00");
    expect(res.status).toBe(201);
    const made = (await res.json()) as KeyBody;
    expect(made.expires_at).toBe(SOON);

    const current = await request(ctx.app, "GET", "/keys/current", {
      key: made.key,
    });
    expect(current.status).toBe(200);
    expect(((await current.json()) as KeyBody).expires_at).toBe(SOON);
    expect(await expiryOf(made.id)).toBe(SOON);

    await stampExpiry(made.id, "2001-01-01T00:00:00.000Z");
    const refused = await request(ctx.app, "GET", "/keys/current", {
      key: made.key,
    });
    expect(refused.status).toBe(401);
    expect(((await refused.json()) as Refusal).error.code).toBe("unauthorized");
  });

  it("reads a time with no zone as UTC", async () => {
    const res = await mint(ctx.workingKey, "2999-01-01T00:00:00");
    expect(res.status).toBe(201);
    expect(((await res.json()) as KeyBody).expires_at).toBe(SOON);
  });

  it("answers null for a key minted with none", async () => {
    const res = await mint(ctx.workingKey);
    expect(res.status).toBe(201);
    expect(((await res.json()) as KeyBody).expires_at).toBeNull();
  });

  it.each([
    ["a word", "tomorrow"],
    ["a date with no time", "2999-01-01"],
    ["an instant that has passed", "2001-01-01T00:00:00.000Z"],
    ["a time whose UTC year is 10000", "9999-12-31T23:59:59-01:00"],
    ["null", null],
    ["a number", 1_900_000_000],
  ])("refuses %s, naming the field, and mints nothing", async (_name, bad) => {
    const tag = suffix();
    const res = await request(ctx.app, "POST", "/keys", {
      key: ctx.workingKey,
      body: {
        label: `refused-${tag}`,
        source: `refused-${tag}`,
        type_permissions: { "core.note": "read" },
        expires_at: bad,
      },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as Refusal;
    expect(body.error.code).toBe("validation_error");
    // The witness: the same mint without the bad expiry is taken, so the
    // refusal was the expiry's and the source was free.
    const again = await request(ctx.app, "POST", "/keys", {
      key: ctx.workingKey,
      body: {
        label: `refused-${tag}`,
        source: `refused-${tag}`,
        type_permissions: { "core.note": "read" },
      },
    });
    expect(again.status).toBe(201);
  });

  it("names expires_at in the refusal of a time that has passed", async () => {
    const res = await mint(ctx.workingKey, "2001-01-01T00:00:00.000Z");
    expect(res.status).toBe(400);
    const body = (await res.json()) as Refusal;
    expect(body.error.details?.field).toBe("expires_at");
  });
});

describe("changing a key's expiry", () => {
  it("sets, replaces and clears it, and leaves it alone when the body does not name it", async () => {
    const { id } = await madeKey(ctx.workingKey);
    expect(await expiryOf(id)).toBeNull();

    const set = await patch(ctx.workingKey, id, { expires_at: SOON });
    expect(set.status).toBe(200);
    expect(((await set.json()) as KeyBody).expires_at).toBe(SOON);

    const renamed = await patch(ctx.workingKey, id, { label: "renamed" });
    expect(renamed.status).toBe(200);
    expect(((await renamed.json()) as KeyBody).expires_at).toBe(SOON);

    const replaced = await patch(ctx.workingKey, id, { expires_at: LATER });
    expect(((await replaced.json()) as KeyBody).expires_at).toBe(LATER);

    const cleared = await patch(ctx.workingKey, id, { expires_at: null });
    expect(cleared.status).toBe(200);
    expect(((await cleared.json()) as KeyBody).expires_at).toBeNull();
    expect(await expiryOf(id)).toBeNull();
  });

  it("refuses a time that has passed or is no time, and leaves the expiry as it was", async () => {
    const { id } = await madeKey(ctx.workingKey, SOON);
    for (const bad of ["2001-01-01T00:00:00.000Z", "soon", 7]) {
      const res = await patch(ctx.workingKey, id, { expires_at: bad });
      expect(res.status, String(bad)).toBe(400);
      expect(((await res.json()) as Refusal).error.code).toBe(
        "validation_error",
      );
    }
    expect(await expiryOf(id)).toBe(SOON);
  });

  it("does not bring back a key that has already expired", async () => {
    const { id } = await madeKey(ctx.workingKey, SOON);
    await stampExpiry(id, "2001-01-01T00:00:00.000Z");
    const res = await patch(ctx.workingKey, id, { expires_at: null });
    expect(res.status).toBe(404);
    expect(((await res.json()) as Refusal).error.code).toBe(
      "api_key_not_found",
    );
    expect(await expiryOf(id)).toBeUndefined();
  });
});

describe("a key whose time has passed", () => {
  it("gives up its own source to the next mint, and holds it until then", async () => {
    const tag = suffix();
    const source = `expiry-source-${tag}`;
    const lapsing = await ctx.storage.keys.create(
      {
        label: "lapsing",
        source,
        permissions: [],
        type_permissions: { "core.note": "read" },
        default_tier: "library",
        expires_at: SOON,
      },
      hashApiKey(`marfa_k1_lapsing_${tag}`, TEST_API_KEY_SALT),
    );
    const take = (): Promise<Response> =>
      request(ctx.app, "POST", "/keys", {
        key: ctx.workingKey,
        body: {
          label: "next",
          source,
          type_permissions: { "core.note": "read" },
        },
      });

    // The witness: while the key stands, the source is its own.
    const held = await take();
    expect(held.status).toBe(409);
    expect(((await held.json()) as Refusal).error.code).toBe("conflict");

    await stampExpiry(lapsing.id, "2001-01-01T00:00:00.000Z");
    const next = await take();
    expect(next.status).toBe(201);
    expect(await expiryOf(((await next.json()) as KeyBody).id)).toBeNull();

    // Taking the source retired the lapsed key: it is revoked, not merely
    // expired, so the source is the new key's alone.
    const rows = await (
      ctx.storage as unknown as {
        __sqliteAll: (
          query: string,
        ) => Promise<{ revoked_at: string | null }[]>;
      }
    ).__sqliteAll(`SELECT revoked_at FROM api_keys WHERE id = '${lapsing.id}'`);
    expect(rows[0]?.revoked_at).not.toBeNull();
    const audited = await (
      ctx.storage as unknown as {
        __sqliteAll: (
          query: string,
        ) => Promise<{ action: string; details: string }[]>;
      }
    ).__sqliteAll(
      `SELECT action, details FROM audit_log WHERE resource_id = '${lapsing.id}'`,
    );
    expect(audited.map((row) => row.action)).toEqual(["key.revoke"]);
    expect(JSON.parse(audited[0]?.details ?? "{}")).toMatchObject({
      reason: "expired",
      source,
    });
    const again = await take();
    expect(again.status).toBe(409);
  });
});

describe("a key that expires", () => {
  it("mints a key that expires when its own does, where the body names none", async () => {
    const minter = await seedMinter(SOON);
    const res = await mint(minter.raw);
    expect(res.status).toBe(201);
    expect(((await res.json()) as KeyBody).expires_at).toBe(SOON);
  });

  it("mints a key that expires no later than its own, and refuses a later one", async () => {
    const minter = await seedMinter(LATER);
    const earlier = await mint(minter.raw, SOON);
    expect(earlier.status).toBe(201);
    expect(((await earlier.json()) as KeyBody).expires_at).toBe(SOON);
    const same = await mint(minter.raw, LATER);
    expect(same.status).toBe(201);

    const refused = await mint(minter.raw, LATEST);
    expect(refused.status).toBe(403);
    const body = (await refused.json()) as Refusal;
    expect(body.error.code).toBe("forbidden");
    expect(body.error.details?.expires_at).toBe(LATER);
  });

  it("changes another key's expiry no later than its own, and neither lengthens nor clears it", async () => {
    const minter = await seedMinter(LATER);
    const { id } = await madeKey(minter.raw, SOON);

    const shorter = await patch(minter.raw, id, {
      expires_at: "2999-03-01T00:00:00.000Z",
    });
    expect(shorter.status).toBe(200);

    for (const bad of [LATEST, null]) {
      const refused = await patch(minter.raw, id, { expires_at: bad });
      expect(refused.status, String(bad)).toBe(403);
      expect(((await refused.json()) as Refusal).error.code).toBe("forbidden");
    }
    expect(await expiryOf(id)).toBe("2999-03-01T00:00:00.000Z");
  });

  it("cannot lengthen or clear its own", async () => {
    const minter = await seedMinter(SOON);
    for (const bad of [LATER, null]) {
      const refused = await patch(minter.raw, minter.id, { expires_at: bad });
      expect(refused.status, String(bad)).toBe(403);
    }
    expect(await expiryOf(minter.id)).toBe(SOON);
    const shorter = await patch(minter.raw, minter.id, {
      expires_at: "2998-01-01T00:00:00.000Z",
    });
    expect(shorter.status).toBe(200);
  });

  it("holds the owner to nothing", async () => {
    const { id } = await madeKey(ctx.workingKey, SOON);
    const res = await ctx.ownerRequest(`/keys/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expires_at: null }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as KeyBody).expires_at).toBeNull();
  });
});

describe("a key changed through keys.manage", () => {
  it("is shortened, or given an expiry when it has none, and never lengthened or cleared", async () => {
    const open = await madeKey(ctx.workingKey);
    const given = await patch(ctx.managementKey, open.id, {
      expires_at: LATER,
    });
    expect(given.status).toBe(200);

    const shorter = await patch(ctx.managementKey, open.id, {
      expires_at: SOON,
    });
    expect(shorter.status).toBe(200);

    for (const bad of [LATER, null]) {
      const refused = await patch(ctx.managementKey, open.id, {
        expires_at: bad,
      });
      expect(refused.status, String(bad)).toBe(403);
      expect(((await refused.json()) as Refusal).error.message).toContain(
        "may only be narrowed",
      );
    }
    expect(await expiryOf(open.id)).toBe(SOON);
  });
});

describe("a key an app made", () => {
  it("is shortened, and never lengthened or cleared, whoever the caller is", async () => {
    const tag = suffix();
    const stored = await ctx.storage.keys.create(
      {
        label: "app-made",
        source: `expiry-app-${tag}`,
        permissions: [],
        type_permissions: { "core.note": "read" },
        default_tier: "library",
        oauth_client_id: "client-notes",
        expires_at: SOON,
      },
      hashApiKey(`marfa_k1_app_${tag}`, TEST_API_KEY_SALT),
    );
    const ownerPatch = (body: Record<string, unknown>): Promise<Response> =>
      ctx.ownerRequest(`/keys/${stored.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

    for (const bad of [LATER, null]) {
      const refused = await ownerPatch({ expires_at: bad });
      expect(refused.status, String(bad)).toBe(403);
    }
    expect(await expiryOf(stored.id)).toBe(SOON);

    const shorter = await ownerPatch({
      expires_at: "2998-01-01T00:00:00.000Z",
    });
    expect(shorter.status).toBe(200);
  });
});
