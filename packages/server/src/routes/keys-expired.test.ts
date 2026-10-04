/**
 * The key doors agree that a key past its `expires_at` does not exist, as the
 * listing and the bearer gate already treat it: it cannot be changed or
 * revoked by id, and it answers `404 api_key_not_found` there.
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import {
  createTestContext,
  request,
  TEST_API_KEY_SALT,
} from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { hashApiKey } from "../middleware/auth.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.cleanup();
});

async function storeKey(): Promise<string> {
  const suffix = Math.random().toString(36).slice(2, 12);
  const stored = await ctx.storage.keys.create(
    {
      label: `expiring-${suffix}`,
      source: `expiring-${suffix}`,
      type_permissions: { "core.note": "read" },
      default_tier: "library",
      is_operator: false,
    },
    hashApiKey(`marfa_k1_expiring_${suffix}`, TEST_API_KEY_SALT),
  );
  return stored.id;
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

async function listed(id: string): Promise<boolean> {
  const res = await request(ctx.app, "GET", "/keys", { key: ctx.operatorKey });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { data: { id: string }[] };
  return body.data.some((k) => k.id === id);
}

const PAST = "2000-01-01T00:00:00.000Z";
const FUTURE = "2999-01-01T00:00:00.000Z";

describe("a key past its expiry", () => {
  it("is listed, changed and revoked while it stands, and by none of the doors once it has passed", async () => {
    const live = await storeKey();
    await stampExpiry(live, FUTURE);
    expect(await listed(live)).toBe(true);
    const renamed = await request(ctx.app, "PATCH", `/keys/${live}`, {
      key: ctx.operatorKey,
      body: { label: "still here" },
    });
    expect(renamed.status).toBe(200);

    const gone = await storeKey();
    await stampExpiry(gone, PAST);
    expect(await listed(gone)).toBe(false);
    for (const [method, body] of [
      ["PATCH", { label: "too late" }],
      ["DELETE", undefined],
    ] as const) {
      const res = await request(ctx.app, method, `/keys/${gone}`, {
        key: ctx.operatorKey,
        body,
      });
      expect(res.status, method).toBe(404);
      expect(
        ((await res.json()) as { error: { code: string } }).error.code,
      ).toBe("api_key_not_found");
    }

    const revoked = await request(ctx.app, "DELETE", `/keys/${live}`, {
      key: ctx.operatorKey,
    });
    expect(revoked.status).toBe(200);
  });
});
