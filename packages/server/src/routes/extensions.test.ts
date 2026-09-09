import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createTestContext, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { hashApiKey } from "../middleware/auth.js";

let ctx: TestContext;

// The credential's label doubles as the namespace owner: a key with label
// "noter" can implicitly write to the "noter" namespace.
const SCOPED_LABEL = "noter";
let scopedKey: string;

// The scoped credential is bound to a space rather than left space-less, and
// that is load-bearing rather than incidental. The reserved-namespace fence
// admits any operator key, and a space-less key must be one — the api_keys
// CHECK constraint ties the two together — so a space-less fixture would pass
// the very door two tests here exist to see refused. Items are therefore
// seeded straight into this space instead of being written through the
// space-less admin key, which the scoped credential could not see.
const SCOPED_SPACE = `ext-space-${Math.random().toString(36).slice(2, 10)}`;

async function createItem(): Promise<string> {
  const item = await ctx.storage.items.create(
    {
      type: "core.note",
      properties: { body: `ext-item-${String(Math.random())}` },
    },
    SCOPED_SPACE,
  );
  return item.id;
}

beforeAll(async () => {
  ctx = await createTestContext();

  // Seed the scoped credential. `extension_permissions` grants read on the
  // "friends" namespace; the implicit own-namespace write keeps the "noter"
  // namespace writable.
  const suffix = Math.random().toString(36).slice(2, 10);
  scopedKey = `marfa_k1_ext_scoped_${suffix}`;
  await ctx.storage.keys.create(
    {
      label: SCOPED_LABEL,
      source: `ext-scoped-${suffix}`,
      type_permissions: { "*": "write" },
      extension_permissions: { friends: "read" },
      default_tier: "feed",
      is_operator: false,
    },
    hashApiKey(scopedKey, "test-salt"),
    SCOPED_SPACE,
  );
});

afterAll(async () => {
  await ctx.cleanup();
});

// Audit writes in the route handlers are fire-and-forget
// (`void storage.audit.log(...)`). Under Postgres the write is genuinely
// async — poll briefly so the test doesn't race the pending insert.
interface AuditRow {
  action: string;
  resource_id: string | null;
  resource_type: string;
  details: Record<string, unknown>;
}

async function waitForAuditEntry(filter: {
  action: string;
  resource_id: string;
}): Promise<{ data: AuditRow[] }> {
  let result = await ctx.storage.audit.list(filter);
  while (result.data.length === 0) {
    await new Promise((r) => setTimeout(r, 25));
    result = await ctx.storage.audit.list(filter);
  }
  return result;
}

describe("GET /items/:id/extensions", () => {
  it("returns only namespaces the key can see", async () => {
    const itemId = await createItem();

    // Seed a namespace the scoped key can read ("friends") and one it
    // cannot ("other").
    await ctx.storage.metadata.setExtension(itemId, "friends", { count: 3 });
    await ctx.storage.metadata.setExtension(itemId, "other", { secret: true });

    // Admin sees everything.
    const adminRes = await request(
      ctx.app,
      "GET",
      `/items/${itemId}/extensions`,
      { key: ctx.spaceKey },
    );
    expect(adminRes.status).toBe(200);
    const adminBody = (await adminRes.json()) as {
      extensions: Record<string, unknown>;
    };
    expect(Object.keys(adminBody.extensions)).toEqual(
      expect.arrayContaining(["friends", "other"]),
    );

    // Scoped key is filtered to "friends" only.
    const scopedRes = await request(
      ctx.app,
      "GET",
      `/items/${itemId}/extensions`,
      { key: scopedKey },
    );
    expect(scopedRes.status).toBe(200);
    const scopedBody = (await scopedRes.json()) as {
      extensions: Record<string, unknown>;
    };
    expect(Object.keys(scopedBody.extensions)).toContain("friends");
    expect(Object.keys(scopedBody.extensions)).not.toContain("other");
  });

  it("returns 400 on invalid item ID", async () => {
    const res = await request(
      ctx.app,
      "GET",
      "/items/not-a-valid-id/extensions",
      { key: ctx.spaceKey },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("invalid_id");
  });

  it("returns 404 when item is missing", async () => {
    const res = await request(
      ctx.app,
      "GET",
      "/items/019537a0-7b80-7000-8000-000000000000/extensions",
      { key: ctx.spaceKey },
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("item_not_found");
  });
});

describe("GET /items/:id/extensions/:namespace", () => {
  it("returns 403 when the key has no read permission", async () => {
    const itemId = await createItem();
    await ctx.storage.metadata.setExtension(itemId, "other", { foo: 1 });

    const res = await request(
      ctx.app,
      "GET",
      `/items/${itemId}/extensions/other`,
      { key: scopedKey },
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("forbidden");
  });

  it("returns 200 with data when the key can read", async () => {
    const itemId = await createItem();
    await ctx.storage.metadata.setExtension(itemId, "friends", {
      count: 7,
    });

    const res = await request(
      ctx.app,
      "GET",
      `/items/${itemId}/extensions/friends`,
      { key: scopedKey },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      namespace: string;
      data: Record<string, unknown> | null;
    };
    expect(body.namespace).toBe("friends");
    expect(body.data).toEqual({ count: 7 });
  });

  it("returns data: null for a missing namespace on an existing item", async () => {
    const itemId = await createItem();

    const res = await request(
      ctx.app,
      "GET",
      `/items/${itemId}/extensions/friends`,
      { key: scopedKey },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      namespace: string;
      data: Record<string, unknown> | null;
    };
    expect(body.data).toBeNull();
  });

  it("returns 404 when the item does not exist", async () => {
    const res = await request(
      ctx.app,
      "GET",
      "/items/019537a0-7b80-7000-8000-000000000001/extensions/friends",
      { key: ctx.spaceKey },
    );
    expect(res.status).toBe(404);
  });
});

describe("PUT /items/:id/extensions/:namespace", () => {
  it("rejects a reserved namespace write from a non-operator key with 403", async () => {
    const itemId = await createItem();

    for (const namespace of ["core", "marfa", "system"]) {
      const res = await request(
        ctx.app,
        "PUT",
        `/items/${itemId}/extensions/${namespace}`,
        { key: scopedKey, body: { hello: "world" } },
      );
      expect(res.status, `namespace ${namespace}`).toBe(403);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("forbidden");
    }
  });

  it("rejects payloads exceeding 100KB with 400", async () => {
    const itemId = await createItem();

    // JSON.stringify of { big: <string> } adds 10 characters of framing.
    // Use a 102_400 byte string -> serialized length 102_410 -> > 102_400.
    const big = "x".repeat(102_400);
    const res = await request(
      ctx.app,
      "PUT",
      `/items/${itemId}/extensions/noter`,
      { key: scopedKey, body: { big } },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("validation_error");
  });

  it("writes on happy path and records an audit entry", async () => {
    const itemId = await createItem();

    const res = await request(
      ctx.app,
      "PUT",
      `/items/${itemId}/extensions/noter`,
      { key: scopedKey, body: { starred: true } },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      extensions: Record<string, Record<string, unknown>>;
    };
    expect(body.extensions.noter).toEqual({ starred: true });

    const auditResult = await waitForAuditEntry({
      action: "extension.set",
      resource_id: itemId,
    });
    expect(auditResult.data.length).toBeGreaterThanOrEqual(1);
    expect(auditResult.data[0]?.resource_type).toBe("item");
    expect(auditResult.data[0]?.details).toMatchObject({
      namespace: "noter",
    });
  });
});

describe("DELETE /items/:id/extensions/:namespace", () => {
  it("rejects a reserved namespace delete from a non-operator key with 403", async () => {
    const itemId = await createItem();

    for (const namespace of ["core", "marfa", "system"]) {
      const res = await request(
        ctx.app,
        "DELETE",
        `/items/${itemId}/extensions/${namespace}`,
        { key: scopedKey },
      );
      expect(res.status, `namespace ${namespace}`).toBe(403);
    }
  });

  it("deletes on happy path and records an audit entry", async () => {
    const itemId = await createItem();
    await ctx.storage.metadata.setExtension(itemId, "noter", {
      starred: true,
    });

    const res = await request(
      ctx.app,
      "DELETE",
      `/items/${itemId}/extensions/noter`,
      { key: scopedKey },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      extensions: Record<string, unknown>;
    };
    expect(body.extensions.noter).toBeUndefined();

    const auditResult = await waitForAuditEntry({
      action: "extension.delete",
      resource_id: itemId,
    });
    expect(auditResult.data.length).toBeGreaterThanOrEqual(1);
    expect(auditResult.data[0]?.details).toMatchObject({
      namespace: "noter",
    });
  });

  it("returns 404 when the item is missing", async () => {
    const res = await request(
      ctx.app,
      "DELETE",
      "/items/019537a0-7b80-7000-8000-000000000002/extensions/noter",
      { key: ctx.spaceKey },
    );
    expect(res.status).toBe(404);
  });
});
