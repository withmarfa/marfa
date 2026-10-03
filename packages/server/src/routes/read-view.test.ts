import { serve } from "@hono/node-server";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestContext, readSse, type TestContext } from "../test-utils.js";
import { initEventLog } from "../pubsub.js";

let ctx: TestContext;
let server: Server;
let origin: string;
beforeAll(async () => {
  ctx = await createTestContext();
  initEventLog(ctx.storage.eventLog);
  server = serve({
    fetch: ctx.app.fetch,
    hostname: "127.0.0.1",
    port: 0,
  }) as Server;
  await new Promise<void>((resolve) => {
    if (server.listening) resolve();
    else server.once("listening", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("No TCP address");
  origin = `http://127.0.0.1:${String(address.port)}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
  await ctx.cleanup();
});
async function tcp(path: string, proof?: string): Promise<Response> {
  return fetch(`${origin}${path}`, {
    headers: {
      Authorization: `Bearer ${ctx.workingKey}`,
      ...(proof === undefined ? {} : { "X-Marfa-Read-View": proof }),
    },
  });
}
async function proof(): Promise<string> {
  const res = await tcp("/events?edges=all&copy=1");
  const { text } = await readSse(res, {
    until: (t) => t.includes("event: stream_live"),
  });
  const line = text
    .split("\n")
    .find((l) => l.startsWith('data: {"type":"stream_cursor"'));
  expect(line).toBeDefined();
  const tuple = JSON.parse(line!.slice(6)) as {
    cursor: string;
    instance_id: string;
    read_view: string;
  };
  expect(tuple.instance_id).toBe(
    ((await (await tcp("/")).json()) as { instance_id: string }).instance_id,
  );
  expect(tuple.read_view).toMatch(/^[0-9a-f]{64}$/);
  return tuple.read_view;
}
describe("certified read views over TCP", () => {
  it("refuses copy grammar that an ordinary stream accepts", async () => {
    const res = await tcp("/events?copy=1");
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: { code: "validation_error" },
    });
    expect(res.headers.has("X-Marfa-Read-View")).toBe(false);
  });
  it("certifies pages and resource absence only on supported conditional doors", async () => {
    const fence = await proof();
    const page = await tcp("/items?include=metadata", fence);
    expect(page.status).toBe(200);
    expect(page.headers.get("X-Marfa-Read-View")).toBe(fence);
    expect(page.headers.get("Cache-Control")).toBe("no-store");
    expect(await page.json()).toMatchObject({ data: [], next_cursor: null });
    const missing = await tcp(
      "/items/01900000-0000-7000-8000-000000000001",
      fence,
    );
    expect(missing.status).toBe(404);
    expect(missing.headers.get("X-Marfa-Read-View")).toBe(fence);
    for (const path of ["/items", "/search", "/types/core.note", "/missing"]) {
      const invalid = await tcp(path, fence);
      expect(invalid.status, path).toBe(400);
      expect(invalid.headers.has("X-Marfa-Read-View"), path).toBe(false);
    }
  });
  it("compares before no-type refusal and emits no certificate on mismatch", async () => {
    const fence = await proof();
    const key = await ctx.storage.keys.validate(
      (await import("../middleware/auth.js")).hashApiKey(
        ctx.workingKey,
        "test-salt",
      ),
    );
    if (!key) throw new Error("Working key missing");
    await ctx.storage.keys.update(key.id, { type_permissions: {} });
    try {
      const changed = await tcp("/items?include=metadata", fence);
      expect(changed.status).toBe(409);
      expect(await changed.json()).toEqual({
        error: {
          code: "read_view_changed",
          message: "The read view changed. Rebuild the working copy.",
        },
      });
      expect(changed.headers.has("X-Marfa-Read-View")).toBe(false);
    } finally {
      await ctx.storage.keys.update(key.id, {
        type_permissions: key.type_permissions,
      });
    }
  });
});
