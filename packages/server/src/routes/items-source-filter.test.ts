/**
 * The `source_filter` enforcement lever on list reads.
 *
 * `source_filter` narrows reads of the listed types to items written from an
 * approved source. It is keyed off the `?type=` query parameter, which means
 * the lever and the SQL predicate must agree on what that parameter names: a
 * bare identifier and its subtree wildcard select the same rows, so they have
 * to attract the same lever. Anything less makes the control optional from
 * the caller's side.
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
let tenantId: string;
let trustedKey: string;
let untrustedKey: string;

/**
 * Credentials stamp `source` onto every item they write, so "an item from an
 * untrusted source" means "an item written by a second credential".
 */
async function mintTenantKey(source: string): Promise<string> {
  const suffix = Math.random().toString(36).slice(2, 12);
  const raw = `marfa_k1_src_${suffix}`;
  await ctx.storage.keys.create(
    {
      label: `source-filter-${source}`,
      source,
      role: "admin",
      type_permissions: {},
      default_tier: "library",
    },
    hashApiKey(raw, TEST_API_KEY_SALT),
    tenantId,
  );
  return raw;
}

beforeAll(async () => {
  ctx = await createTestContext({ authMode: "hosted" });
  const tenant = await ctx.storage.tenants!.create("source-filter");
  tenantId = tenant.id;
  trustedKey = await mintTenantKey("trusted");
  untrustedKey = await mintTenantKey("untrusted");

  for (const key of [trustedKey, untrustedKey]) {
    const created = await request(ctx.app, "POST", "/items", {
      key,
      body: { type: "core.note", properties: { body: "note" } },
    });
    expect(created.status).toBe(201);
  }

  await ctx.storage.tenants!.updateConfig(tenantId, {
    enforcement: {
      source_filter: { types: ["core.note"], sources: ["trusted"] },
    },
  });
});

afterAll(async () => {
  await ctx.cleanup();
});

async function listSources(query: string): Promise<string[]> {
  const res = await request(ctx.app, "GET", query, { key: trustedKey });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { data: { source: string }[] };
  return [...new Set(body.data.map((item) => item.source))].sort();
}

describe("source_filter applies to every spelling of the same type filter", () => {
  it("narrows a bare identifier to the approved sources", async () => {
    expect(await listSources("/items?type=core.note")).toEqual(["trusted"]);
  });

  it("narrows the equivalent subtree wildcard to the approved sources", async () => {
    expect(await listSources("/items?type=core.note.*")).toEqual(["trusted"]);
  });
});
