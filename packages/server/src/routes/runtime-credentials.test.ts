import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestContext, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { hashApiKey } from "../middleware/auth.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(() => {
  ctx.cleanup();
});

interface RuntimeCredentialResponse {
  id: string;
  api_key: string;
  connection_id: string;
  label: string;
  source: string;
  expires_at: string;
  created_at: string;
}

interface ErrorResponse {
  error: {
    code: string;
    message: string;
  };
}

describe("POST /system/runtime-credentials", () => {
  it("admin (which is a platform credential at bootstrap) can mint a runtime credential", async () => {
    const suffix = Math.random().toString(36).slice(2, 10);
    const res = await request(ctx.app, "POST", "/system/runtime-credentials", {
      key: ctx.adminKey,
      body: {
        connection_id: "conn_test_admin_mint",
        label: `runtime ${suffix}`,
        source: `runtime-${suffix}`,
      },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as RuntimeCredentialResponse;
    expect(body.api_key).toMatch(/^myme_k1_/);
    expect(body.connection_id).toBe("conn_test_admin_mint");
    expect(body.id).toBeDefined();
    expect(body.expires_at).toBeDefined();
  });

  it("rejects callers without is_platform: true", async () => {
    // Mint a non-platform admin key first.
    const suffix = Math.random().toString(36).slice(2, 10);
    const memberRaw = `myme_k1_runtime_member_${suffix}`;
    await ctx.storage.keys.create(
      {
        label: `member-${suffix}`,
        source: `member-source-${suffix}`,
        role: "admin",
        type_permissions: { "*": "write" },
        is_platform: false,
      },
      hashApiKey(memberRaw, "test-salt"),
    );
    const res = await request(ctx.app, "POST", "/system/runtime-credentials", {
      key: memberRaw,
      body: {
        connection_id: "conn_test_member_denied",
        label: "should fail",
        source: `should-fail-${suffix}`,
      },
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as ErrorResponse;
    expect(body.error.message).toMatch(/platform/i);
  });

  it("rejects unauthenticated callers", async () => {
    const res = await request(ctx.app, "POST", "/system/runtime-credentials", {
      body: {
        connection_id: "conn_test_unauth",
        label: "x",
        source: `x-${Math.random().toString(36).slice(2, 8)}`,
      },
    });
    expect(res.status).toBe(401);
  });

  it("validates the request body", async () => {
    const res = await request(ctx.app, "POST", "/system/runtime-credentials", {
      key: ctx.adminKey,
      body: {
        // missing connection_id
        label: "x",
        source: "x",
      },
    });
    expect(res.status).toBe(400);
  });

  it("stamps is_runtime_credential + connection_id on the row", async () => {
    const suffix = Math.random().toString(36).slice(2, 10);
    const res = await request(ctx.app, "POST", "/system/runtime-credentials", {
      key: ctx.adminKey,
      body: {
        connection_id: `conn_stamp_${suffix}`,
        label: `stamp ${suffix}`,
        source: `stamp-${suffix}`,
      },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as RuntimeCredentialResponse;
    const stored = await ctx.storage.keys.get(body.id);
    expect(stored).not.toBeNull();
    expect(stored?.is_runtime_credential).toBe(true);
    expect(stored?.connection_id).toBe(`conn_stamp_${suffix}`);
    expect(stored?.is_platform).toBe(false);
    expect(stored?.role).toBe("member");
  });
});

describe("connection.runtime extension gate", () => {
  let runtimeKey: string;
  let connectionId: string;
  let runtimeKeyId: string;

  beforeAll(async () => {
    // Create an item that represents the Connection. Use core.note as a
    // placeholder — the actual system.connection type doesn't change the
    // gate behavior since the gate keys off the credential's
    // connection_id stamp matching the URL :id.
    const itemRes = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: {
        type: "core.note",
        properties: { body: "connection placeholder" },
      },
    });
    const itemBody = (await itemRes.json()) as { item: { id: string } };
    connectionId = itemBody.item.id;

    const suffix = Math.random().toString(36).slice(2, 10);
    const mintRes = await request(
      ctx.app,
      "POST",
      "/system/runtime-credentials",
      {
        key: ctx.adminKey,
        body: {
          connection_id: connectionId,
          label: `gate ${suffix}`,
          source: `gate-${suffix}`,
        },
      },
    );
    expect(mintRes.status).toBe(201);
    const minted = (await mintRes.json()) as RuntimeCredentialResponse;
    runtimeKey = minted.api_key;
    runtimeKeyId = minted.id;
  });

  it("runtime credential CAN write its own connection's connection.runtime namespace", async () => {
    const res = await request(
      ctx.app,
      "PUT",
      `/items/${connectionId}/extensions/connection.runtime`,
      {
        key: runtimeKey,
        body: { cursor: { last_run_at: "2026-05-01T00:00:00Z" } },
      },
    );
    expect(res.status).toBe(200);
  });

  it("runtime credential CANNOT write a different connection's connection.runtime namespace", async () => {
    // Create another item to act as a different connection.
    const otherItemRes = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: { type: "core.note", properties: { body: "other connection" } },
    });
    const otherBody = (await otherItemRes.json()) as { item: { id: string } };
    const otherId = otherBody.item.id;

    const res = await request(
      ctx.app,
      "PUT",
      `/items/${otherId}/extensions/connection.runtime`,
      {
        key: runtimeKey,
        body: { cursor: "x" },
      },
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as ErrorResponse;
    expect(body.error.message).toMatch(/connection_id|cannot write|cross/i);
  });

  it("admin credential CANNOT write the connection.runtime namespace (read-only for ops)", async () => {
    const res = await request(
      ctx.app,
      "PUT",
      `/items/${connectionId}/extensions/connection.runtime`,
      {
        key: ctx.adminKey,
        body: { cursor: "should fail" },
      },
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as ErrorResponse;
    expect(body.error.message).toMatch(/runtime credential/i);
  });

  it("ordinary credential without is_runtime_credential CANNOT write the namespace", async () => {
    const suffix = Math.random().toString(36).slice(2, 10);
    const ordinaryRaw = `myme_k1_ordinary_${suffix}`;
    await ctx.storage.keys.create(
      {
        label: `ordinary-${suffix}`,
        source: `ord-${suffix}`,
        role: "member",
        type_permissions: { "*": "write" },
        extension_permissions: { "connection.runtime": "write" },
      },
      hashApiKey(ordinaryRaw, "test-salt"),
    );
    const res = await request(
      ctx.app,
      "PUT",
      `/items/${connectionId}/extensions/connection.runtime`,
      {
        key: ordinaryRaw,
        body: { cursor: "x" },
      },
    );
    expect(res.status).toBe(403);
  });

  it("admin can READ the connection.runtime namespace (operator inspection)", async () => {
    const res = await request(
      ctx.app,
      "GET",
      `/items/${connectionId}/extensions/connection.runtime`,
      { key: ctx.adminKey },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      namespace: string;
      data: Record<string, unknown> | null;
    };
    expect(body.namespace).toBe("connection.runtime");
    expect(body.data).toMatchObject({
      cursor: { last_run_at: "2026-05-01T00:00:00Z" },
    });
  });

  it("runtime credential CAN delete its own connection.runtime namespace", async () => {
    const res = await request(
      ctx.app,
      "DELETE",
      `/items/${connectionId}/extensions/connection.runtime`,
      { key: runtimeKey },
    );
    expect(res.status).toBe(200);
  });

  it("runtime credential CANNOT delete a different connection's namespace", async () => {
    const otherItemRes = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: { type: "core.note", properties: { body: "delete cross-tenant" } },
    });
    const otherBody = (await otherItemRes.json()) as { item: { id: string } };
    const otherId = otherBody.item.id;

    const res = await request(
      ctx.app,
      "DELETE",
      `/items/${otherId}/extensions/connection.runtime`,
      { key: runtimeKey },
    );
    expect(res.status).toBe(403);
  });

  // Sanity: the runtime credential row is queryable.
  it("the runtime credential is gettable via storage.keys.get", async () => {
    const stored = await ctx.storage.keys.get(runtimeKeyId);
    expect(stored?.is_runtime_credential).toBe(true);
    expect(stored?.connection_id).toBe(connectionId);
  });
});
