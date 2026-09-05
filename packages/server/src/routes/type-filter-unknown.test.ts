/**
 * A concrete `type` filter naming a type the caller's space does not know is
 * refused on every list surface, and the two cases that look like it are
 * not.
 *
 * An empty page is the one answer a client cannot tell from a quiet space:
 * a typo in a type name, a type registered under another handle, and a type
 * deleted since the client last hydrated all read as "no items here", and
 * the client carries on believing a filter it is not applying. So an
 * unknown concrete type is `400 unknown_type` on `GET /items`, `GET /search`
 * and `GET /export`. A wildcard over nothing is still an empty page, because
 * nothing is a correct answer to "everything under this root". A registered
 * type the credential cannot read is still an empty page too: the scope
 * list on the token response is the client's signal for that, and refusing
 * would tell a caller which types exist beyond its grant.
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
let narrowKey: string;

beforeAll(async () => {
  ctx = await createTestContext();
  // A member that reads tasks and nothing else, so `core.note` is a
  // registered type it cannot read.
  const suffix = Math.random().toString(36).slice(2, 12);
  narrowKey = `marfa_k1_narrow_${suffix}`;
  await ctx.storage.keys.create(
    {
      label: `narrow-${suffix}`,
      source: `narrow-${suffix}`,
      role: "member",
      type_permissions: { "core.task": "read" },
      default_tier: "library",
    },
    hashApiKey(narrowKey, TEST_API_KEY_SALT),
  );
});

afterAll(async () => {
  await ctx.cleanup();
});

async function errorCode(res: Response): Promise<string | undefined> {
  const body = (await res.json()) as { error?: { code?: string } };
  return body.error?.code;
}

const SURFACES: { name: string; path: (type: string) => string }[] = [
  { name: "GET /items", path: (t) => `/items?type=${t}` },
  { name: "GET /search", path: (t) => `/search?q=anything&type=${t}` },
  { name: "GET /export", path: (t) => `/export?type=${t}` },
];

describe("an unknown concrete type is refused on every list surface", () => {
  for (const surface of SURFACES) {
    it(`${surface.name} answers 400 unknown_type`, async () => {
      const res = await request(
        ctx.app,
        "GET",
        surface.path("core.nonexistent_filter_type"),
        { key: ctx.adminKey },
      );
      expect(res.status).toBe(400);
      expect(await errorCode(res)).toBe("unknown_type");
      expect(res.headers.get("x-error-code")).toBe("unknown_type");
    });
  }

  it("the grammar refusal comes first and keeps its own code", async () => {
    const res = await request(ctx.app, "GET", "/items?type=not%20a%20type", {
      key: ctx.adminKey,
    });
    expect(res.status).toBe(400);
    expect(await errorCode(res)).toBe("validation_error");
  });
});

describe("the two cases that look like an unknown type are not refused", () => {
  it("a wildcard over a root nothing is registered under answers an empty page", async () => {
    const res = await request(ctx.app, "GET", "/items?type=acme.*", {
      key: ctx.adminKey,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown[]; has_more: boolean };
    expect(body.data).toEqual([]);
    expect(body.has_more).toBe(false);
  });

  it("a registered type the credential cannot read answers an empty page", async () => {
    const res = await request(ctx.app, "GET", "/items?type=core.note", {
      key: narrowKey,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown[] };
    expect(body.data).toEqual([]);
  });

  it("the same credential is still refused for a type nobody registered", async () => {
    // Refusing an unknown type reveals nothing about the grant: the
    // registry is the same for every caller in the space.
    const res = await request(
      ctx.app,
      "GET",
      "/items?type=core.nonexistent_filter_type",
      { key: narrowKey },
    );
    expect(res.status).toBe(400);
    expect(await errorCode(res)).toBe("unknown_type");
  });
});
