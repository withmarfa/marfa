import { afterEach, beforeEach, expect, it } from "vitest";
import { createTestContext, request, type TestContext } from "../test-utils.js";
let ctx: TestContext;
beforeEach(async () => {
  ctx = await createTestContext();
});
afterEach(async () => {
  await ctx.cleanup();
});
async function refuse(action: string) {
  await (
    ctx.storage as typeof ctx.storage & {
      __sqliteRun(sql: string, args: unknown[]): Promise<unknown>;
    }
  ).__sqliteRun(
    `CREATE TRIGGER reject_key_audit BEFORE INSERT ON audit_log WHEN NEW.action = '${action}' BEGIN SELECT RAISE(ABORT, 'key audit rejected'); END`,
    [],
  );
}
it("does not expose or retain a minted credential when its audit fails", async () => {
  const before = await ctx.storage.keys.list();
  await refuse("key.create");
  const response = await request(ctx.app, "POST", "/keys", {
    key: ctx.workingKey,
    body: { label: "audited", source: "audit-proof" },
  });
  expect(response.status).toBe(500);
  expect(await response.text()).not.toContain("marfa_k1_");
  expect((await ctx.storage.keys.list()).map((row) => row.id)).toEqual(
    before.map((row) => row.id),
  );
});

async function dropRefusal() {
  await (
    ctx.storage as typeof ctx.storage & {
      __sqliteRun(sql: string, args: unknown[]): Promise<unknown>;
    }
  ).__sqliteRun("DROP TRIGGER reject_key_audit", []);
}
async function mint() {
  const response = await request(ctx.app, "POST", "/keys", {
    key: ctx.operatorKey,
    body: { label: "subject", source: "audit-subject" },
  });
  expect(response.status).toBe(201);
  return (await response.json()) as { id: string; key: string };
}
it("rolls key permissions and subscription retirement back when update or revoke audit fails", async () => {
  const subject = await mint();
  const created = await request(ctx.app, "POST", "/webhooks", {
    key: subject.key,
    body: { url: "https://receiver.example/audit", events: ["item.created"] },
  });
  expect(created.status).toBe(201);
  const hook = (await created.json()) as { id: string };
  const before = await ctx.storage.keys.get(subject.id);
  await refuse("key.update");
  const patch = () =>
    request(ctx.app, "PATCH", `/keys/${subject.id}`, {
      key: ctx.operatorKey,
      body: { type_permissions: { "core.note": "read" } },
    });
  expect((await patch()).status).toBe(500);
  expect((await ctx.storage.keys.get(subject.id))?.type_permissions).toEqual(
    before?.type_permissions,
  );
  expect(
    (await request(ctx.app, "GET", "/keys/current", { key: subject.key }))
      .status,
  ).toBe(200);
  await dropRefusal();
  expect((await patch()).status).toBe(200);
  expect((await ctx.storage.keys.get(subject.id))?.type_permissions).toEqual({
    "core.note": "read",
  });
  expect(
    (
      await ctx.storage.audit.list({
        action: "key.update",
        resource_id: subject.id,
      })
    ).data,
  ).toHaveLength(1);
  await refuse("key.revoke");
  const revoke = () =>
    request(ctx.app, "DELETE", `/keys/${subject.id}`, { key: subject.key });
  expect((await revoke()).status).toBe(500);
  expect((await ctx.storage.outboundWebhooks.get(hook.id))?.active).toBe(true);
  expect(
    (await request(ctx.app, "GET", "/keys/current", { key: subject.key }))
      .status,
  ).toBe(200);
  await dropRefusal();
  expect((await revoke()).status).toBe(200);
  expect(
    (await request(ctx.app, "GET", "/keys/current", { key: subject.key }))
      .status,
  ).toBe(401);
  expect(await ctx.storage.outboundWebhooks.get(hook.id)).toBeNull();
  const records = await ctx.storage.audit.list({
    action: "key.revoke",
    resource_id: subject.id,
  });
  expect(records.data).toHaveLength(1);
  expect(records.data[0]?.key_id).toBe(subject.id);
  expect(
    (
      await request(ctx.app, "DELETE", `/keys/${subject.id}`, {
        key: ctx.operatorKey,
      })
    ).status,
  ).toBe(404);
  expect(
    (
      await ctx.storage.audit.list({
        action: "key.revoke",
        resource_id: subject.id,
      })
    ).data,
  ).toHaveLength(1);
});
