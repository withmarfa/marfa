import { afterEach, expect, it } from "vitest";
import { Hono } from "hono";
import {
  createTestContext,
  mintWorkingKey,
  request,
  seedOauthBearer,
  type TestContext,
} from "../test-utils.js";
import { directAuthorityMiddleware } from "../middleware/direct-authority.js";
import { createErrorHandler } from "../middleware/error-handler.js";
import type { AppEnv } from "../middleware/auth.js";
import { webhookRoutes } from "./webhooks.js";
let ctx: TestContext;
afterEach(async () => ctx.cleanup());
it("lets owner and local authority read every maker without minting a key or widening writes", async () => {
  ctx = await createTestContext();
  const other = await mintWorkingKey(ctx, { label: "Second maker" });
  const app = await seedOauthBearer(ctx, ["webhooks.manage", "content:read"]);
  const ids: string[] = [];
  for (const key of [ctx.workingKey, other, app.token]) {
    const response = await request(ctx.app, "POST", "/webhooks", {
      key,
      body: {
        url: "https://receiver.example/hook",
        events: ["item.created"],
        secret: "private-signing-secret-1234567890xx",
      },
    });
    expect(response.status).toBe(201);
    ids.push(((await response.json()) as { id: string }).id);
  }
  const grantId = await ctx.storage.oauthProvider!.findGrantItemId({
    clientId: app.clientId,
    authUserId: ctx.owner.id,
  });
  expect(grantId).toBeTruthy();
  expect(
    (
      await ctx.ownerRequest(`/owner/sign-ins/${grantId!}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Renamed app" }),
      })
    ).status,
  ).toBe(200);
  const before = await ctx.storage.keys.list();
  const local = new Hono<AppEnv>();
  local.onError(createErrorHandler({ errorWebhookUrl: "" }));
  local.use(
    "*",
    directAuthorityMiddleware(
      ctx.storage,
      ctx.auth,
      ctx.config.authBaseUrl,
      true,
    ),
  );
  local.route(
    "/webhooks",
    webhookRoutes(ctx.storage, { allowPrivateAddresses: false }),
  );
  for (const read of [
    ctx.ownerRequest,
    (path: string, init?: RequestInit) => local.request(path, init),
  ]) {
    const response = await read("/webhooks");
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: {
        id: string;
        maker: { kind: string; id: string; name: string | null };
      }[];
    };
    expect(body.data.map((w) => w.id)).toEqual(expect.arrayContaining(ids));
    expect(body.data.map((w) => w.maker.kind).sort()).toEqual([
      "app",
      "key",
      "key",
    ]);
    expect(body.data.find((w) => w.maker.kind === "app")?.maker).toEqual({
      kind: "app",
      id: app.clientId,
      name: "Renamed app",
    });
    expect(JSON.stringify(body)).not.toContain("private-signing-secret");
    for (const id of ids) {
      expect((await read(`/webhooks/${id}`)).status).toBe(200);
      expect((await read(`/webhooks/${id}/deliveries`)).status).toBe(200);
      for (const method of ["PATCH", "DELETE"])
        expect(
          (
            await read(`/webhooks/${id}`, {
              method,
              headers: { "content-type": "application/json" },
              ...(method === "PATCH"
                ? { body: JSON.stringify({ active: false }) }
                : {}),
            })
          ).status,
        ).toBe(401);
    }
    expect(
      (
        await read("/webhooks", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            url: "https://receiver.example/new",
            events: ["item.created"],
          }),
        })
      ).status,
    ).toBe(401);
  }
  expect((await ctx.storage.keys.list()).map((k) => k.id)).toEqual(
    before.map((k) => k.id),
  );
  const ordinary = await request(ctx.app, "GET", "/webhooks", { key: other });
  expect(
    ((await ordinary.json()) as { data: { id: string }[] }).data.map(
      (w) => w.id,
    ),
  ).toEqual([ids[1]]);
});
