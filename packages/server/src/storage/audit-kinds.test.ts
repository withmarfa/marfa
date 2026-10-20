import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestContext, type TestContext } from "../test-utils.js";
import { AUDIT_KINDS, type AuditKind } from "./audit-kinds.js";

let ctx: TestContext;
beforeEach(async () => {
  ctx = await createTestContext();
});
afterEach(async () => {
  await ctx.cleanup();
});

const EXPECTED: Record<string, AuditKind> = {
  "auth.sign_in.success": "access",
  "owner.password.changed": "access",
  "key.create": "access",
  "keys.purged": "housekeeping",
  "folder.revoke": "access",
  "item.create": "data",
  "items.bulk": "data",
  "edge.create": "data",
  "type.register": "data",
  "blob.upload": "data",
  "export.run": "data",
  restore_archive: "data",
  update_tags: "data",
  "config.update": "settings",
  "webhook.create": "settings",
  "connector.register": "settings",
  "blob.stores_configured": "settings",
  "items.trash_purged": "housekeeping",
  "auth.grants.purged": "housekeeping",
  "blob.purge": "housekeeping",
};

async function actionsOf(kind: AuditKind, q?: string): Promise<string[]> {
  const page = await ctx.storage.audit.list({
    kind,
    q,
    resource_type: "test",
    limit: 200,
  });
  return page.data.map((row) => row.action);
}

describe("the audit log's kinds and search", () => {
  beforeEach(async () => {
    for (const action of Object.keys(EXPECTED))
      await ctx.storage.audit.log({
        action,
        resource_type: "test",
        resource_id: `id-${action}`,
        details: { note: "Sample" },
      });
  });

  it("puts every action in exactly one kind", async () => {
    for (const kind of AUDIT_KINDS) {
      const want = Object.entries(EXPECTED)
        .filter(([, expected]) => expected === kind)
        .map(([action]) => action)
        .sort();
      expect((await actionsOf(kind)).sort(), kind).toEqual(want);
    }
  });

  it("matches every word of a search, in any case and order, in the details too", async () => {
    expect(await actionsOf("data", "BULK items")).toEqual(["items.bulk"]);
    expect(await actionsOf("data", "sample id-item.create")).toEqual([
      "item.create",
    ]);
    expect(await actionsOf("data", "id-item.create nothing-like-this")).toEqual(
      [],
    );
  });

  it("reads an underscore or percent sign in a search as itself", async () => {
    expect(await actionsOf("data", "update_tags")).toEqual(["update_tags"]);
    expect(await actionsOf("data", "update%tags")).toEqual([]);
  });
});
