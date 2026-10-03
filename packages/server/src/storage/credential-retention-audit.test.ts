import { beforeEach, afterEach, expect, it } from "vitest";
import { generateId } from "@withmarfa/shared";
import { createTestContext, type TestContext } from "../test-utils.js";
import { itemWrites } from "./item-writes.js";
import {
  RevokedGrantPurger,
  RevokedKeyReaper,
  DcrClientCleaner,
} from "./retention.js";
import { catchUpClientScopeCeiling } from "../auth/ceiling-catchup.js";
let ctx: TestContext;
beforeEach(async () => {
  ctx = await createTestContext();
});
afterEach(async () => {
  await ctx.cleanup();
});
function raw() {
  return ctx.storage as typeof ctx.storage & {
    __sqliteRun(sql: string, args: unknown[]): Promise<unknown>;
    __sqliteAll(sql: string): Promise<unknown[]>;
  };
}
async function client(clientId: string) {
  await ctx.storage.oauthProvider!.createClient({
    clientId,
    name: "Audit Cleanup",
    isPublic: true,
    grantTypes: ["authorization_code"],
    responseTypes: ["code"],
    tokenEndpointAuthMethod: "none",
    scopes: ["core.note:read"],
    redirectUris: ["https://example.test/callback"],
  });
}
it.each(["grant", "key", "client"] as const)(
  "couples bounded %s cleanup to audit, preserving rows on failure and skipping empty audits",
  async (family) => {
    for (let n = 0; n < 201; n++) {
      if (family === "grant")
        await itemWrites(ctx.storage).create({
          type: "system.connection",
          properties: {
            kind: "app",
            status: "revoked",
            granted_at: "2019-01-01T00:00:00.000Z",
            revoked_at: "2020-01-01T00:00:00.000Z",
            client_id: generateId(),
          },
        });
      else if (family === "key") {
        const row = await ctx.storage.keys.create(
          { label: "Audit Cleanup", source: "audit-purge", is_operator: true },
          generateId(),
        );
        await raw().__sqliteRun(
          "UPDATE api_keys SET revoked_at = '2020-01-01T00:00:00.000Z' WHERE id = ?",
          [row.id],
        );
      } else {
        const id = generateId();
        await client(id);
        await raw().__sqliteRun(
          "UPDATE auth_oauth_client SET created_at = 1 WHERE client_id = ?",
          [id],
        );
      }
    }
    const action =
      family === "grant"
        ? "auth.grants.purged"
        : family === "key"
          ? "keys.purged"
          : "auth.clients.purged";
    const query =
      family === "grant"
        ? "SELECT id FROM items WHERE type = 'system.connection' ORDER BY id"
        : family === "key"
          ? "SELECT id FROM api_keys WHERE source = 'audit-purge' ORDER BY id"
          : "SELECT id FROM auth_oauth_client WHERE name = 'Audit Cleanup' ORDER BY id";
    const before = await raw().__sqliteAll(query);
    expect(before).toHaveLength(201);
    const sweep =
      family === "grant"
        ? new RevokedGrantPurger(ctx.storage, 90)
        : family === "key"
          ? new RevokedKeyReaper(ctx.storage)
          : new DcrClientCleaner(ctx.storage, 30);
    await raw().__sqliteRun(
      `CREATE TRIGGER reject_cleanup_audit BEFORE INSERT ON audit_log WHEN NEW.action = '${action}' BEGIN SELECT RAISE(ABORT, 'cleanup audit refused'); END`,
      [],
    );
    await expect(sweep.runOnce()).rejects.toThrow();
    expect(await raw().__sqliteAll(query)).toEqual(before);
    expect((await ctx.storage.audit.list({ action })).data).toHaveLength(0);
    await raw().__sqliteRun("DROP TRIGGER reject_cleanup_audit", []);
    expect(await sweep.runOnce()).toBe(200);
    expect(await raw().__sqliteAll(query)).toHaveLength(1);
    expect(await sweep.runOnce()).toBe(1);
    expect(await raw().__sqliteAll(query)).toHaveLength(0);
    expect(await sweep.runOnce()).toBe(0);
    const audits = (await ctx.storage.audit.list({ action })).data;
    expect(audits).toHaveLength(2);
    expect(
      audits
        .map((row) => row.details.count)
        .sort((a, b) => Number(a) - Number(b)),
    ).toEqual([1, 200]);
    expect(audits.every((row) => row.key_id === null)).toBe(true);
  },
);
it("rolls a scope ceiling back on audit refusal and records a concurrent catch-up once", async () => {
  const id = generateId();
  await client(id);
  const catchUp = () =>
    catchUpClientScopeCeiling({
      storage: ctx.storage,
      clientId: id,
      ceiling: ["core.note:read"],
      requested: ["core.note:read", "core.note:write"],
      bundleScopes: new Set(["core.note:write"]),
      surface: "authorize",
    });
  await raw().__sqliteRun(
    "CREATE TRIGGER reject_ceiling_audit BEFORE INSERT ON audit_log WHEN NEW.action = 'auth.client.scopes_widened' BEGIN SELECT RAISE(ABORT, 'ceiling audit refused'); END",
    [],
  );
  expect(await catchUp()).toEqual(["core.note:read"]);
  expect((await ctx.storage.oauthProvider!.getClient(id))?.scopes).toEqual([
    "core.note:read",
  ]);
  expect(
    (
      await ctx.storage.audit.list({
        action: "auth.client.scopes_widened",
        resource_id: id,
      })
    ).data,
  ).toHaveLength(0);
  await raw().__sqliteRun("DROP TRIGGER reject_ceiling_audit", []);
  const results = await Promise.all([catchUp(), catchUp()]);
  expect(results).toContainEqual(["core.note:read", "core.note:write"]);
  expect((await ctx.storage.oauthProvider!.getClient(id))?.scopes).toEqual([
    "core.note:read",
    "core.note:write",
  ]);
  const rows = (
    await ctx.storage.audit.list({
      action: "auth.client.scopes_widened",
      resource_id: id,
    })
  ).data;
  expect(rows).toHaveLength(1);
  expect(rows[0]?.details.added_scopes).toEqual(["core.note:write"]);
});
