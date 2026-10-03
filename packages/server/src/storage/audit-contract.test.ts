import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestContext, type TestContext } from "../test-utils.js";
import { runAuditedTransaction } from "./audited-transaction.js";
import { afterCommit } from "./commit-hooks.js";

let ctx: TestContext;
beforeEach(async () => {
  ctx = await createTestContext();
});
afterEach(async () => {
  await ctx.cleanup();
});

const entry = { action: "test.audit.strict", resource_type: "settings" };

async function expectNativeAuditFailure(pending: Promise<unknown>) {
  const error: unknown = await pending.catch((failure: unknown) => failure);
  expect(error).toBeInstanceOf(Error);
  const cause = (error as Error).cause;
  expect(cause).toBeInstanceOf(Error);
  expect((cause as Error).message).toContain("strict audit refused");
}

describe("the awaited audit writer", () => {
  it("exposes serialization failure and leaves no record", async () => {
    await expect(
      ctx.storage.audit.log({ ...entry, details: { attempts: 1n } }),
    ).rejects.toThrow();
    expect(
      (await ctx.storage.audit.list({ action: entry.action })).data,
    ).toEqual([]);
  });

  it("propagates native insert rejection and rolls back the represented unit and its publication", async () => {
    const raw = ctx.storage as typeof ctx.storage & {
      __sqliteRun(sql: string, args: unknown[]): Promise<unknown>;
    };
    await raw.__sqliteRun(
      "CREATE TRIGGER reject_strict_audit BEFORE INSERT ON audit_log WHEN NEW.action = 'test.audit.strict' BEGIN SELECT RAISE(ABORT, 'strict audit refused'); END",
      [],
    );
    await expectNativeAuditFailure(ctx.storage.audit.log(entry));
    const emitted: string[] = [];
    const operation = () =>
      runAuditedTransaction(
        ctx.storage,
        async () => {
          await ctx.storage.settings.set("audit.strict", "accepted");
          afterCommit(() => emitted.push("accepted"));
        },
        { ...entry, client_ip: "203.0.113.7", details: { reason: "contract" } },
      );
    await expectNativeAuditFailure(operation());
    expect(await ctx.storage.settings.get("audit.strict")).toBeNull();
    expect(
      (await ctx.storage.audit.list({ action: entry.action })).data,
    ).toEqual([]);
    expect(emitted).toEqual([]);
    await raw.__sqliteRun("DROP TRIGGER reject_strict_audit", []);
    await operation();
    expect(await ctx.storage.settings.get("audit.strict")).toBe("accepted");
    const rows = (await ctx.storage.audit.list({ action: entry.action })).data;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      client_ip: "203.0.113.7",
      details: { reason: "contract" },
    });
    expect(emitted).toEqual(["accepted"]);
  });
});
