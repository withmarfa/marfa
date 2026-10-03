import { TransactionFailure } from "./sqlite/transaction-control.js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { InStatement } from "@libsql/client";
import { createTestContext, type TestContext } from "../test-utils.js";
import { runAuditedTransaction } from "./audited-transaction.js";
import { afterCommit } from "./commit-hooks.js";

const fault = vi.hoisted(() => ({ mode: "none", fired: false }));
vi.mock("@libsql/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@libsql/client")>();
  return {
    ...actual,
    createClient: (...args: Parameters<typeof actual.createClient>) => {
      const client = actual.createClient(...args),
        execute = client.execute.bind(client);
      client.execute = async (
        statement: InStatement | string,
        ...rest: unknown[]
      ) => {
        const sql = typeof statement === "string" ? statement : statement.sql;
        const targeted =
          sql === "COMMIT" && fault.mode !== "none" && !fault.fired;
        if (targeted && fault.mode === "before") {
          fault.fired = true;
          throw new Error("commit acknowledgment witness");
        }
        const result = await execute(statement, ...(rest as []));
        if (targeted && fault.mode === "after") {
          fault.fired = true;
          throw new Error("commit acknowledgment witness");
        }
        return result;
      };
      return client;
    },
  };
});
let ctx: TestContext;
beforeEach(async () => {
  ctx = await createTestContext();
});
afterEach(async () => {
  fault.mode = "none";
  fault.fired = false;
  vi.restoreAllMocks();
  await ctx.cleanup();
});
const entry = { action: "test.unit", resource_type: "settings" };

it.each(["before", "after"])(
  "settles a lost %s-COMMIT acknowledgment from the exact audit row without retry",
  async (mode) => {
    const emitted: string[] = [];
    let work = 0;
    await runAuditedTransaction(
      ctx.storage,
      async () => {
        await ctx.storage.settings.set("audit.control", "control");
        afterCommit(() => emitted.push("control"));
      },
      entry,
    );
    expect(emitted).toEqual(["control"]);
    fault.mode = mode;
    const operation = runAuditedTransaction(
      ctx.storage,
      async () => {
        work++;
        await ctx.storage.settings.set("audit.fault", "fault");
        afterCommit(() => emitted.push("fault"));
        return "accepted";
      },
      entry,
    );
    if (mode === "after") await expect(operation).resolves.toBe("accepted");
    else
      await expect(operation).rejects.toThrow("commit acknowledgment witness");
    expect(fault.fired).toBe(true);
    expect(work).toBe(1);
    expect(await ctx.storage.settings.get("audit.fault")).toBe(
      mode === "after" ? "fault" : null,
    );
    expect(
      (await ctx.storage.audit.list({ action: entry.action })).data,
    ).toHaveLength(mode === "after" ? 2 : 1);
    expect(emitted).toEqual(
      mode === "after" ? ["control", "fault"] : ["control"],
    );
  },
);

it("rolls a refused inner audit back to its savepoint while retaining the outer unit", async () => {
  const raw = ctx.storage as typeof ctx.storage & {
    __sqliteRun(sql: string, args: unknown[]): Promise<unknown>;
  };
  const emitted: string[] = [];
  await raw.__sqliteRun(
    "CREATE TRIGGER reject_nested_audit BEFORE INSERT ON audit_log WHEN NEW.action = 'test.inner' BEGIN SELECT RAISE(ABORT, 'inner audit refused'); END",
    [],
  );
  await runAuditedTransaction(
    ctx.storage,
    async () => {
      await ctx.storage.settings.set("audit.outer", "kept");
      afterCommit(() => emitted.push("outer"));
      await expect(
        runAuditedTransaction(
          ctx.storage,
          async () => {
            await ctx.storage.settings.set("audit.inner", "refused");
            afterCommit(() => emitted.push("inner"));
          },
          { ...entry, action: "test.inner" },
        ),
      ).rejects.toThrow();
    },
    entry,
  );
  expect(await ctx.storage.settings.get("audit.outer")).toBe("kept");
  expect(await ctx.storage.settings.get("audit.inner")).toBeNull();
  expect(emitted).toEqual(["outer"]);
  expect(
    (await ctx.storage.audit.list({ action: entry.action })).data,
  ).toHaveLength(1);
  expect(
    (await ctx.storage.audit.list({ action: "test.inner" })).data,
  ).toHaveLength(0);
});

it("keeps a null-entry lost commit unknown rather than claiming rollback", async () => {
  fault.mode = "after";
  let failure: unknown;
  try {
    await runAuditedTransaction(
      ctx.storage,
      async () => {
        await ctx.storage.settings.set("audit.operational", "committed");
        afterCommit(() => undefined);
      },
      () => null,
    );
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(TransactionFailure);
  expect((failure as TransactionFailure).control.outcome).toBe("unknown");
  expect(await ctx.storage.settings.get("audit.operational")).toBe("committed");
});

it.each(["missing", "unavailable"])(
  "keeps a %s witness unknown without rerunning work or releasing its event",
  async (mode) => {
    fault.mode = "after";
    let work = 0,
      emitted = 0,
      failure: unknown;
    const witness = vi.spyOn(ctx.storage.audit, "has");
    if (mode === "missing") witness.mockResolvedValue(false);
    else witness.mockRejectedValue(new Error("witness unavailable"));
    try {
      await runAuditedTransaction(
        ctx.storage,
        async () => {
          work++;
          await ctx.storage.settings.set("audit.unknown", "committed");
          afterCommit(() => {
            emitted++;
          });
        },
        entry,
      );
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(TransactionFailure);
    expect((failure as TransactionFailure).control.outcome).toBe("unknown");
    expect(work).toBe(1);
    expect(emitted).toBe(0);
    expect(await ctx.storage.settings.get("audit.unknown")).toBe("committed");
    expect(
      (await ctx.storage.audit.list({ action: entry.action })).data,
    ).toHaveLength(1);
  },
);
