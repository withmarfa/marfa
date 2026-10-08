import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createTestContext, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("authentication", () => {
  it("returns 401 when no auth header is provided", async () => {
    const res = await request(ctx.app, "GET", "/items");
    expect(res.status).toBe(401);
  });

  it("returns 401 with invalid key", async () => {
    const res = await request(ctx.app, "GET", "/items", {
      key: "marfa_k1_invalid_key",
    });
    expect(res.status).toBe(401);
  });

  it("returns 200 with a valid key", async () => {
    const res = await request(ctx.app, "GET", "/items", {
      key: ctx.workingKey,
    });
    expect(res.status).toBe(200);
  });
});

describe("key management", () => {
  it("creates and lists keys", async () => {
    // A narrower set than the caller's, because that is the half a mint can
    // get wrong: an omitted list takes the creator's whole set, so a response
    // that reported the wrong one would be indistinguishable from a response
    // that reported nothing.
    const createRes = await request(ctx.app, "POST", "/keys", {
      key: ctx.workingKey,
      body: {
        label: "test-narrow",
        source: "test-narrow-src",
        permissions: ["webhooks.manage"],
      },
    });
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as {
      id: string;
      permissions?: string[];
    };
    expect(created.permissions).toEqual(["webhooks.manage"]);

    const listRes = await request(ctx.app, "GET", "/keys", {
      key: ctx.workingKey,
    });
    expect(listRes.status).toBe(200);
    const body = (await listRes.json()) as {
      data: { id: string; permissions?: string[] }[];
    };
    expect(body.data.length).toBeGreaterThanOrEqual(2);
    // The stored row says the same thing the mint response did. Asserted
    // separately because the two are built by different code, and the mint
    // response is the one a caller cannot go back and re-read.
    expect(body.data.find((k) => k.id === created.id)?.permissions).toEqual([
      "webhooks.manage",
    ]);
  });

  it("revokes a key", async () => {
    const createRes = await request(ctx.app, "POST", "/keys", {
      key: ctx.workingKey,
      body: { label: "to-revoke", source: "to-revoke-src" },
    });
    const created = (await createRes.json()) as Record<string, unknown>;

    const revokeRes = await request(
      ctx.app,
      "DELETE",
      `/keys/${created.id as string}`,
      { key: ctx.workingKey },
    );
    expect(revokeRes.status).toBe(200);
  });
});

describe("extension_permissions wiring", () => {
  it("persists and surfaces extension_permissions on POST /keys and GET /keys", async () => {
    const createRes = await request(ctx.app, "POST", "/keys", {
      key: ctx.workingKey,
      body: {
        label: "ext-write-key",
        source: "ext-write-key-src",
        permissions: [],
        type_permissions: { "*": "write" },
        extension_permissions: { "swift.calendar": "write" },
      },
    });
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as {
      id: string;
      extension_permissions: Record<string, string>;
    };
    expect(created.extension_permissions).toEqual({
      "swift.calendar": "write",
    });

    const listRes = await request(ctx.app, "GET", "/keys", {
      key: ctx.workingKey,
    });
    const list = (await listRes.json()) as {
      data: { id: string; extension_permissions?: Record<string, string> }[];
    };
    const found = list.data.find((k) => k.id === created.id);
    expect(found?.extension_permissions).toEqual({ "swift.calendar": "write" });
  });

  it("auth middleware copies extension_permissions onto the request context", async () => {
    // Create a key with an explicit grant on a namespace that doesn't match
    // its label. Without the wiring this would fall through to the implicit
    // own-namespace rule and 403 on the non-matching namespace.
    const createKeyRes = await request(ctx.app, "POST", "/keys", {
      key: ctx.workingKey,
      body: {
        label: "myapp",
        source: "myapp-grant-src",
        permissions: [],
        type_permissions: { "*": "write" },
        extension_permissions: { "other-app.notes": "write" },
      },
    });
    const { key: rawKey } = (await createKeyRes.json()) as { key: string };

    const itemRes = await request(ctx.app, "POST", "/items", {
      key: rawKey,
      body: { type: "core.note", properties: { body: "Ext write target" } },
    });
    const { item } = (await itemRes.json()) as { item: { id: string } };

    const putRes = await request(
      ctx.app,
      "PUT",
      `/items/${item.id}/extensions/other-app.notes`,
      { key: rawKey, body: { stored: true } },
    );
    expect(putRes.status).toBe(200);
  });

  it("persists and surfaces metadata_permissions on POST /keys and GET /keys", async () => {
    // Metadata-layer permissions ride a dedicated map, default-off for new
    // keys. Nothing reads past it: every credential is held to its maps.
    const createRes = await request(ctx.app, "POST", "/keys", {
      key: ctx.workingKey,
      body: {
        label: "metadata-types-key",
        source: "metadata-types-key-src",
        permissions: [],
        type_permissions: { "*": "write" },
        metadata_permissions: { types: "write" },
      },
    });
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as {
      id: string;
      metadata_permissions: Record<string, string>;
    };
    expect(created.metadata_permissions).toEqual({ types: "write" });

    const listRes = await request(ctx.app, "GET", "/keys", {
      key: ctx.workingKey,
    });
    const list = (await listRes.json()) as {
      data: { id: string; metadata_permissions?: Record<string, string> }[];
    };
    const found = list.data.find((k) => k.id === created.id);
    expect(found?.metadata_permissions).toEqual({ types: "write" });
  });

  it("grants no namespace by the key's label when extension_permissions is empty", async () => {
    const createKeyRes = await request(ctx.app, "POST", "/keys", {
      key: ctx.workingKey,
      body: {
        label: "selfns",
        source: "selfns-src",
        permissions: [],
        type_permissions: { "*": "write" },
      },
    });
    const { key: rawKey } = (await createKeyRes.json()) as { key: string };

    const itemRes = await request(ctx.app, "POST", "/items", {
      key: rawKey,
      body: { type: "core.note", properties: { body: "Self ns target" } },
    });
    const { item } = (await itemRes.json()) as { item: { id: string } };

    const putRes = await request(
      ctx.app,
      "PUT",
      `/items/${item.id}/extensions/selfns`,
      { key: rawKey, body: { ok: true } },
    );
    expect(putRes.status).toBe(403);
  });
});

describe("KeyStore.updateLastUsed — DB-side debounce", () => {
  it("collapses rapid updates in the same window to a single write", async () => {
    const createRes = await request(ctx.app, "POST", "/keys", {
      key: ctx.workingKey,
      body: {
        label: "last-used-debounce-key",
        source: "last-used-debounce-src",
        permissions: [],
      },
    });
    const { id } = (await createRes.json()) as { id: string };

    // Three writes in rapid succession: the first stamps `last_used_at`
    // (the witness that a write can move it) and the ones inside the
    // debounce window are no-ops.
    await ctx.storage.keys.updateLastUsed(id);
    const firstKey = await ctx.storage.keys.get(id);
    const firstStamp = firstKey?.last_used_at;
    expect(firstStamp).toEqual(expect.any(String));

    // A tiny pause so a naive always-overwrite would surface as a
    // monotonic change — if the stamp still moves, the debounce isn't
    // holding.
    await new Promise((r) => setTimeout(r, 5));
    await ctx.storage.keys.updateLastUsed(id);
    await new Promise((r) => setTimeout(r, 5));
    await ctx.storage.keys.updateLastUsed(id);

    const afterKey = await ctx.storage.keys.get(id);
    expect(afterKey?.last_used_at).toBe(firstStamp);
  });
});
