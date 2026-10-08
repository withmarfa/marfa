/**
 * A key cannot mint or edit a key that reaches further than itself.
 *
 * **The half of the ceiling that had nothing to bite on until now.** While a
 * role admitted a credential past its own permission maps, every caller that
 * could reach `POST /keys` already reached everything, so "wider than its
 * creator" described no reachable state and the clamp was written for the one
 * caller that could be narrow: a session. Under one permission model a narrow
 * key is ordinary — `keys.mint` says a credential may mint, and says nothing
 * about how far what it mints may go — so the same question has to be asked of
 * a key, and these are the cases that ask it.
 *
 * **Every case pairs the refusal with the mint that must still succeed.**
 * Asserting the 403 alone would pass against a route that refused everything,
 * which is the shape this area has produced twice.
 */
import { scopesToTypePermissions } from "@withmarfa/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TestContext } from "../test-utils.js";
import { createTestContext, mintWorkingKey, request } from "../test-utils.js";

let ctx: TestContext;
let narrowKey: string;

/** Holds `keys.mint` and read on one type. A coherent credential now. */
async function mintNarrow(): Promise<string> {
  const raw = await mintWorkingKey(ctx, {
    profile_permissions: {},
    label: "narrow",
    source: "ceiling-test",
    permissions: ["keys.mint"],
    type_permissions: { "core.note": "read" },
    extension_permissions: {},
    edge_permissions: {},
    metadata_permissions: {},
    default_tier: "library",
  });
  return raw;
}

beforeAll(async () => {
  ctx = await createTestContext();
  narrowKey = await mintNarrow();
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("a creator whose own map carries denials", () => {
  /**
   * The hole a scope projection leaves. A creator holding the projection of
   * `content:read` carries a global `read` and a `none` on every system type;
   * reduced to the literals it confers that is just `*:read`, and a child
   * asking for `{"*":"read"}` then reads as covered while resolving `read` on
   * rows its parent is refused.
   */
  let contentReadKey: string;

  beforeAll(async () => {
    const raw = await mintWorkingKey(ctx, {
      profile_permissions: {},
      label: "content-read",
      source: "ceiling-content-read",
      permissions: ["keys.mint"],
      type_permissions: scopesToTypePermissions(["content:read"]),
      extension_permissions: {},
      edge_permissions: {},
      metadata_permissions: {},
      default_tier: "library",
    });
    contentReadKey = raw;
  });

  it("refuses a child that keeps the wildcard and drops the denials", async () => {
    const res = await request(ctx.app, "POST", "/keys", {
      key: contentReadKey,
      body: {
        label: "denials-dropped",
        source: "ceiling-denials-dropped",
        type_permissions: { "*": "read" },
      },
    });
    expect(res.status).toBe(403);
  });

  it("still mints a child holding exactly what it holds", async () => {
    // The control, and the case the default path takes: naming nothing at all
    // copies the creator's, so identity has to be covered or nothing could be
    // minted from a credential whose map denies anything.
    const res = await request(ctx.app, "POST", "/keys", {
      key: contentReadKey,
      body: { label: "same-again", source: "ceiling-same-again" },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      type_permissions: Record<string, string>;
    };
    expect(Object.values(body.type_permissions)).toContain("none");
  });
});

describe("a key minting a key", () => {
  it("refuses a content map its own does not cover", async () => {
    const res = await request(ctx.app, "POST", "/keys", {
      key: narrowKey,
      body: {
        label: "wider",
        source: "ceiling-wider",
        type_permissions: { "*": "write" },
      },
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as {
      error: { message: string; details?: { required_scope?: string } };
    };
    // Names the literal, so a caller can narrow toward something.
    expect(body.error.details?.required_scope).toBe("*:write");
  });

  it("refuses a level above its own on a type it does hold", async () => {
    const res = await request(ctx.app, "POST", "/keys", {
      key: narrowKey,
      body: {
        label: "upgraded",
        source: "ceiling-upgraded",
        type_permissions: { "core.note": "write" },
      },
    });
    expect(res.status).toBe(403);
  });

  it("refuses an extension namespace it does not hold", async () => {
    const res = await request(ctx.app, "POST", "/keys", {
      key: narrowKey,
      body: {
        label: "extended",
        source: "ceiling-extended",
        extension_permissions: { "vendor.thing": "read" },
      },
    });
    expect(res.status).toBe(403);
  });

  it("permits a mint at its own reach, and one below it", async () => {
    const same = await request(ctx.app, "POST", "/keys", {
      key: narrowKey,
      body: {
        label: "same",
        source: "ceiling-same",
        type_permissions: { "core.note": "read" },
      },
    });
    expect(same.status).toBe(201);

    const narrower = await request(ctx.app, "POST", "/keys", {
      key: narrowKey,
      body: {
        label: "narrower",
        source: "ceiling-narrower",
        type_permissions: {},
      },
    });
    expect(narrower.status).toBe(201);
  });

  it("takes the creator's whole set when the body names no reach", async () => {
    // The other half of one rule: omitting a family takes what the creator
    // holds, so the default is never wider than the ceiling and never the
    // empty map that would mint a credential able to administer what it
    // cannot read a row of.
    const res = await request(ctx.app, "POST", "/keys", {
      key: narrowKey,
      body: { label: "derived", source: "ceiling-derived" },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      type_permissions: Record<string, string>;
      permissions: string[];
    };
    expect(body.type_permissions).toEqual({ "core.note": "read" });
    expect(body.permissions).toEqual(["keys.mint"]);
  });
});

describe("a key editing a key", () => {
  it("cannot widen an existing key past its own reach", async () => {
    const created = await request(ctx.app, "POST", "/keys", {
      key: narrowKey,
      body: { label: "target", source: "ceiling-target" },
    });
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };

    // The door that reaches every key, not only the ones this
    // credential minted. A clamp only at the mint is not a clamp.
    const widened = await request(ctx.app, "PATCH", `/keys/${id}`, {
      key: narrowKey,
      body: { type_permissions: { "*": "write" } },
    });
    expect(widened.status).toBe(403);

    const permitted = await request(ctx.app, "PATCH", `/keys/${id}`, {
      key: narrowKey,
      body: { type_permissions: { "core.note": "read" } },
    });
    expect(permitted.status).toBe(200);
  });

  it("cannot give a key a permission it does not hold", async () => {
    const created = await request(ctx.app, "POST", "/keys", {
      key: narrowKey,
      body: { label: "target2", source: "ceiling-target2" },
    });
    const { id } = (await created.json()) as { id: string };

    const res = await request(ctx.app, "PATCH", `/keys/${id}`, {
      key: narrowKey,
      body: { permissions: ["keys.mint", "config.manage"] },
    });
    expect(res.status).toBe(403);
  });
});
