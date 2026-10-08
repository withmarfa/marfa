import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Permission } from "@withmarfa/shared";
import {
  createTestContext,
  mintWorkingKey,
  request,
  seedOauthBearer,
  type TestContext,
} from "../test-utils.js";

let ctx: TestContext;
let runs = 0;
beforeAll(async () => {
  ctx = await createTestContext();
  ctx.housekeeping.register({
    name: "management-proof",
    intervalMs: 3_600_000,
    firstRunDelayMs: 3_600_000,
    run: () => Promise.resolve({ runs: ++runs }),
  });
  await ctx.housekeeping.start();
});
afterAll(async () => {
  await ctx.housekeeping.stop();
  await ctx.cleanup();
});

async function credential(permission?: Permission): Promise<string> {
  return mintWorkingKey(ctx, {
    type_permissions: {},
    edge_permissions: {},
    extension_permissions: {},
    metadata_permissions: {},
    profile_permissions: {},
    permissions: permission ? [permission] : [],
  });
}

describe("explicit management permissions", () => {
  it("separates instance inspection from running maintenance for keys and apps", async () => {
    for (const key of [
      await credential("instance.read"),
      (await seedOauthBearer(ctx, ["instance.read"])).token,
    ]) {
      for (const path of [
        "/metrics",
        "/housekeeping",
        "/platform-types/drift",
        "/blobs/stores",
        "/blobs/orphans",
      ]) {
        expect(
          (await request(ctx.app, "GET", path, { key })).status,
          path,
        ).toBe(200);
      }
      expect(
        (
          await request(ctx.app, "POST", "/housekeeping/management-proof/run", {
            key,
          })
        ).status,
      ).toBe(403);
    }
    const maintainer = await credential("instance.maintain");
    expect(
      (
        await request(ctx.app, "POST", "/housekeeping/management-proof/run", {
          key: maintainer,
        })
      ).status,
    ).toBe(200);
    expect(runs).toBe(1);
    expect(
      (await request(ctx.app, "GET", "/metrics", { key: maintainer })).status,
    ).toBe(403);
  });

  it("separates reading and cancelling another credential's bulk job", async () => {
    const writer = await mintWorkingKey(ctx, { permissions: [] });
    const created = await request(ctx.app, "POST", "/items", {
      key: writer,
      body: {
        type: "core.note",
        tags: ["management-job"],
        properties: { body: "before" },
      },
    });
    expect(created.status).toBe(201);
    const queued = await request(ctx.app, "POST", "/items/bulk-actions", {
      key: writer,
      body: {
        action: "update_properties",
        filter: { type: "core.note", tags: ["management-job"] },
        patch: { body: "after" },
      },
    });
    expect(queued.status).toBe(202);
    const { id } = (await queued.json()) as { id: string };
    const path = `/items/bulk-actions/jobs/${id}`;
    const reader = await credential("instance.read");
    const maintainer = await credential("instance.maintain");
    expect((await request(ctx.app, "GET", path, { key: writer })).status).toBe(
      200,
    );
    expect((await request(ctx.app, "GET", path, { key: reader })).status).toBe(
      200,
    );
    expect(
      (await request(ctx.app, "GET", path, { key: maintainer })).status,
    ).toBe(403);
    expect(
      (await request(ctx.app, "POST", `${path}/cancel`, { key: reader }))
        .status,
    ).toBe(403);
    expect(
      (await request(ctx.app, "POST", `${path}/cancel`, { key: maintainer }))
        .status,
    ).toBe(200);
  });

  it("does not infer management access from wildcard content maps", async () => {
    const key = await mintWorkingKey(ctx, { permissions: [] });
    for (const path of [
      "/metrics",
      "/housekeeping",
      "/platform-types/drift",
      "/blobs/stores",
      "/blobs/orphans",
    ]) {
      expect((await request(ctx.app, "GET", path, { key })).status, path).toBe(
        403,
      );
    }
  });

  it("allows broad blob access without granting content writes or archive restore", async () => {
    const key = await credential("blobs.manage");
    const upload = await ctx.app.request("/blobs", {
      method: "POST",
      body: new TextEncoder().encode("unreferenced management bytes"),
      headers: {
        "Content-Type": "application/octet-stream",
        Authorization: `Bearer ${key}`,
      },
    });
    expect(upload.status).toBe(201);
    const { hash } = (await upload.json()) as { hash: string };
    const bytes = await request(ctx.app, "GET", `/blobs/${hash}`, { key });
    expect(bytes.status).toBe(200);
    expect(await bytes.text()).toBe("unreferenced management bytes");
    const reader = await credential("instance.read");
    expect(
      (await request(ctx.app, "GET", `/blobs/${hash}`, { key: reader })).status,
    ).toBe(403);
    expect(
      (
        await request(ctx.app, "POST", "/items", {
          key,
          body: { type: "core.note", properties: { body: "not authorized" } },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await request(ctx.app, "POST", "/restore", {
          key,
          body: new Uint8Array(),
          headers: { "Content-Type": "application/gzip" },
        })
      ).status,
    ).toBe(403);
  });

  it("lets a management app administer another connector without impersonating it", async () => {
    const ownKey = await credential();
    const registered = await request(ctx.app, "POST", "/connectors", {
      key: ownKey,
      body: { name: "management permission witness" },
    });
    expect(registered.status).toBe(201);
    const { id } = (await registered.json()) as { id: string };
    const { token: manager } = await seedOauthBearer(ctx, [
      "connectors.manage",
    ]);
    const outsider = await credential();
    expect(
      (await request(ctx.app, "GET", `/connectors/${id}`, { key: outsider }))
        .status,
    ).toBe(404);
    expect(
      (await request(ctx.app, "GET", `/connectors/${id}`, { key: manager }))
        .status,
    ).toBe(200);
    expect(
      (
        await request(ctx.app, "GET", `/connectors/${id}/runs`, {
          key: manager,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await request(ctx.app, "POST", `/connectors/${id}/endpoints`, {
          key: manager,
          body: { label: "managed endpoint" },
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await request(ctx.app, "GET", `/connectors/${id}/endpoints`, {
          key: manager,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await request(ctx.app, "POST", `/connectors/${id}/heartbeat`, {
          key: ownKey,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await request(ctx.app, "POST", `/connectors/${id}/heartbeat`, {
          key: manager,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await request(ctx.app, "GET", `/connectors/${id}/deliveries`, {
          key: manager,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await request(ctx.app, "DELETE", `/connectors/${id}/state`, {
          key: manager,
        })
      ).status,
    ).toBe(200);
    expect(
      (await request(ctx.app, "DELETE", `/connectors/${id}`, { key: manager }))
        .status,
    ).toBe(200);
    expect(
      (await request(ctx.app, "GET", `/connectors/${id}`, { key: manager }))
        .status,
    ).toBe(404);
  });
});
