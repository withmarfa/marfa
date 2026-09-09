/**
 * A key an app made is never widened afterwards.
 *
 * The consent screen tells a person what an app may do, and one of the things
 * an app holding `space.keys` may do is mint a durable credential that outlives
 * the grant it came from. The mint clamp bounds that credential at what the app
 * itself held. **That is only half of the promise**, because the permission
 * maps are writable through `PATCH /keys/{id}` a moment later, and the person
 * who signed in can reach that door with a credential of their own. Without the
 * rule these tests cover, "an app cannot make a key wider than itself" means
 * "an app cannot make a key wider than itself in one step".
 *
 * The rule is a property of the key rather than of whoever is editing it, so
 * there is no exemption for the operator key — a guarantee with a credential
 * that can lift it quietly is not a guarantee. The case at the end is what
 * holds that.
 *
 * **Every refusal is paired with the edit that must still succeed.** Narrowing
 * stays open, and an ordinary key stays editable, or this would pass against a
 * route that refused every patch.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { scopesToTypePermissions } from "@withmarfa/shared";
import {
  createTestContext,
  request,
  TEST_API_KEY_SALT,
} from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { hashApiKey } from "../middleware/auth.js";

const SPACE = "spc_app_keys";

let ctx: TestContext;
/** The person's own credential: wide, and holding the permission to edit. */
let editorKey: string;

async function seedKey(
  label: string,
  overrides: Record<string, unknown>,
): Promise<{ id: string; raw: string }> {
  const suffix = Math.random().toString(36).slice(2, 12);
  const raw = `marfa_k1_${label}_${suffix}`;
  const stored = await ctx.storage.keys.create(
    {
      label,
      // Unique per key: the store holds one source display name per space, so
      // a fixture that seeds the same shape twice collides on it.
      source: `app-key-test-${label}-${suffix}`,
      space_permissions: [],
      type_permissions: {},
      extension_permissions: {},
      edge_permissions: {},
      metadata_permissions: {},
      profile_permissions: {},
      default_tier: "library",
      is_operator: false,
      ...overrides,
    },
    hashApiKey(raw, TEST_API_KEY_SALT),
    SPACE,
  );
  return { id: stored.id, raw };
}

/** A key the app "Notes" minted: read on one type, one space permission. */
async function seedAppKey(): Promise<string> {
  const { id } = await seedKey("app-made", {
    oauth_client_id: "client-notes",
    type_permissions: { "core.note": "read" },
    space_permissions: ["space.webhooks"],
    extension_permissions: { "com.notes": "read" },
    profile_permissions: { display_name: "read" },
  });
  return id;
}

beforeAll(async () => {
  ctx = await createTestContext();
  const editor = await seedKey("editor", {
    type_permissions: { "*": "write" },
    extension_permissions: { "*": "write" },
    edge_permissions: { "*": "write" },
    metadata_permissions: { "*": "write" },
    profile_permissions: { "*": "write" },
    space_permissions: ["space.keys", "space.webhooks", "space.settings"],
  });
  editorKey = editor.raw;
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("editing a key an app made", () => {
  it("refuses a content map wider than the key already holds", async () => {
    const id = await seedAppKey();
    const res = await request(ctx.app, "PATCH", `/keys/${id}`, {
      key: editorKey,
      body: { type_permissions: { "core.note": "write" } },
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as {
      error: { message: string; details?: { required_scope?: string } };
    };
    expect(body.error.message).toContain("created by an app");
    expect(body.error.details?.required_scope).toBe("core.note:write");
  });

  it("refuses a wildcard that erases the denials the key carries", async () => {
    // **The shape an ordinary grant actually produces.** `content:read`
    // projects to a global `read` plus a `none` on every system type, and an
    // exact entry outranks a wildcard, so those entries are denials rather
    // than omissions. A patch to `{"*":"read"}` reads as a no-op and is a
    // widening: it keeps the wildcard and drops what was holding it down.
    const held = scopesToTypePermissions(["content:read"]);
    expect(Object.values(held)).toContain("none");
    const { id } = await seedKey("app-content-read", {
      oauth_client_id: "client-notes",
      type_permissions: held,
    });

    const res = await request(ctx.app, "PATCH", `/keys/${id}`, {
      key: editorKey,
      body: { type_permissions: { "*": "read" } },
    });
    expect(res.status).toBe(403);

    // And the denials are still on the row, so a refused patch did not
    // half-apply.
    const after = await ctx.storage.keys.get(id);
    expect(Object.values(after?.type_permissions ?? {})).toContain("none");
  });

  it("allows the same edit to narrow it", async () => {
    const id = await seedAppKey();
    const res = await request(ctx.app, "PATCH", `/keys/${id}`, {
      key: editorKey,
      body: { type_permissions: {} },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      type_permissions: Record<string, string>;
    };
    expect(body.type_permissions).toEqual({});
  });

  it("refuses a space permission the key does not already hold", async () => {
    const id = await seedAppKey();
    const res = await request(ctx.app, "PATCH", `/keys/${id}`, {
      key: editorKey,
      body: { space_permissions: ["space.webhooks", "space.settings"] },
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as {
      error: { details?: { required_scope?: string } };
    };
    expect(body.error.details?.required_scope).toBe("space.settings");
  });

  it("allows dropping a space permission it holds", async () => {
    const id = await seedAppKey();
    const res = await request(ctx.app, "PATCH", `/keys/${id}`, {
      key: editorKey,
      body: { space_permissions: [] },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { space_permissions: string[] };
    expect(body.space_permissions).toEqual([]);
  });

  it("refuses an extension namespace it was not given", async () => {
    const id = await seedAppKey();
    const res = await request(ctx.app, "PATCH", `/keys/${id}`, {
      key: editorKey,
      body: { extension_permissions: { "com.other": "read" } },
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("com.other");
  });

  it("refuses a profile row it was not given", async () => {
    const id = await seedAppKey();
    const res = await request(ctx.app, "PATCH", `/keys/${id}`, {
      key: editorKey,
      body: { profile_permissions: { handle: "write" } },
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("handle");
  });

  it("refuses the operator key too, because the rule is the key's", async () => {
    const id = await seedAppKey();
    const res = await request(ctx.app, "PATCH", `/keys/${id}`, {
      key: ctx.spaceKey,
      body: { type_permissions: { "*": "write" } },
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("never widened afterwards");
  });

  it("leaves a key the person made themselves editable", async () => {
    // The control. Same editor, same widening, no app stamp — so a route that
    // simply refused every widening would fail here.
    const { id } = await seedKey("own", {
      type_permissions: { "core.note": "read" },
      space_permissions: ["space.webhooks"],
    });
    const res = await request(ctx.app, "PATCH", `/keys/${id}`, {
      key: editorKey,
      body: {
        type_permissions: { "*": "write" },
        space_permissions: ["space.webhooks", "space.settings"],
      },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      type_permissions: Record<string, string>;
      space_permissions: string[];
    };
    expect(body.type_permissions).toEqual({ "*": "write" });
    expect(body.space_permissions).toContain("space.settings");
  });
});
