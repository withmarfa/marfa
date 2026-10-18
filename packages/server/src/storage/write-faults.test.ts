import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MarfaError } from "@withmarfa/shared";
import { clearFaults, activeFaults, setFault } from "../control/faults.js";
import { reportableError } from "../error-text.js";
import { diskFull } from "./disk-space.js";
import { createTestContext, type TestContext } from "../test-utils.js";
import { runAuditedTransaction } from "./audited-transaction.js";
import { afterCommit } from "./commit-hooks.js";
import { TransactionFailure } from "./sqlite/transaction-control.js";

let ctx: TestContext;
beforeEach(async () => {
  ctx = await createTestContext();
});
afterEach(async () => {
  clearFaults();
  await ctx.cleanup();
});

const SENTINEL = "sentinel-held-by-the-statement";

/** One audited write: a setting, its audit entry, and the event a subscriber would hear. */
async function write(
  key: string,
  action = "test.write",
  emitted: string[] = [],
): Promise<string> {
  return runAuditedTransaction(
    ctx.storage,
    async () => {
      await ctx.storage.settings.set(key, SENTINEL);
      afterCommit(() => emitted.push(key));
      return key;
    },
    { action, resource_type: "settings", details: { value: SENTINEL } },
  );
}

async function audited(action: string): Promise<number> {
  return (await ctx.storage.audit.list({ action })).data.length;
}

async function failureOf(operation: Promise<unknown>): Promise<unknown> {
  try {
    await operation;
  } catch (error) {
    return error;
  }
  throw new Error("the write was not refused");
}

describe("fail:lock", () => {
  it("refuses the nth write as write contention before it does any work, and the writes around it land", async () => {
    setFault("fail:lock", "2");
    let work = 0;
    const counted = (key: string) =>
      runAuditedTransaction(
        ctx.storage,
        async () => {
          work++;
          await ctx.storage.settings.set(key, "v");
        },
        { action: "test.write", resource_type: "settings" },
      );
    await counted("a");
    const refused = await failureOf(counted("b"));
    await counted("c");
    expect(refused).toBeInstanceOf(MarfaError);
    expect((refused as MarfaError).code).toBe("write_contention");
    expect(work).toBe(2);
    expect(await ctx.storage.settings.get("b")).toBeNull();
    expect(await audited("test.write")).toBe(2);
    expect(activeFaults()[0]).toMatchObject({ name: "fail:lock", fired: 1 });
  });
});

describe("fail:audit", () => {
  it("fails the audit insert as a statement of its own, rolls the write and its event back, and the next write lands", async () => {
    setFault("fail:audit", "test.write");
    const emitted: string[] = [];
    const error = await failureOf(write("a", "test.write", emitted));
    // The witness for what the report must drop: the failed statement is the
    // real insert, and the query layer carried its text and its values.
    expect((error as Error).message).toContain("audit_log");
    expect((error as Error).message).toContain(SENTINEL);
    expect((reportableError(error) as Error).message).not.toContain(
      "audit_log",
    );
    expect((reportableError(error) as Error).message).not.toContain(SENTINEL);
    expect((reportableError(error) as Error).message).toContain("SQLITE_IOERR");
    expect(await ctx.storage.settings.get("a")).toBeNull();
    expect(emitted).toEqual([]);
    expect(await audited("test.write")).toBe(0);

    await write("b", "test.write", emitted);
    expect(await ctx.storage.settings.get("b")).toBe(SENTINEL);
    expect(emitted).toEqual(["b"]);
  });

  it("counts only the writes that record its action", async () => {
    setFault("fail:audit", "test.target@2");
    await write("a", "test.other");
    await write("b", "test.target");
    await failureOf(
      write("c", "test.other").then(() => write("d", "test.target")),
    );
    await write("e", "test.other");
    expect(await ctx.storage.settings.get("d")).toBeNull();
    expect(await ctx.storage.settings.get("e")).toBe(SENTINEL);
  });
});

describe("fail:commit", () => {
  it("refuses the commit, rolls back, and leaves the outcome unknown because the audit entry is absent", async () => {
    setFault("fail:commit", null);
    const emitted: string[] = [];
    const error = await failureOf(write("a", "test.write", emitted));
    expect(error).toBeInstanceOf(TransactionFailure);
    expect((error as TransactionFailure).control.outcome).toBe("unknown");
    expect(await ctx.storage.settings.get("a")).toBeNull();
    expect(await audited("test.write")).toBe(0);
    expect(emitted).toEqual([]);

    await write("b", "test.write", emitted);
    expect(emitted).toEqual(["b"]);
  });

  it("is a full volume for fail:commit-full, which the server answers as 507 with the outcome unknown", async () => {
    setFault("fail:commit-full", null);
    const error = await failureOf(write("a"));
    const refusal = diskFull(error);
    expect(refusal?.code).toBe("insufficient_storage");
    expect(refusal?.details).toEqual({ write_outcome: "unknown" });
    expect(await ctx.storage.settings.get("a")).toBeNull();
  });
});

describe("fail:commit-ack", () => {
  it("lands the commit and loses its answer, which the audit entry settles as committed without a second write", async () => {
    setFault("fail:commit-ack", null);
    const emitted: string[] = [];
    let work = 0;
    const result = await runAuditedTransaction(
      ctx.storage,
      async () => {
        work++;
        await ctx.storage.settings.set("a", "v");
        afterCommit(() => emitted.push("a"));
        return "accepted";
      },
      { action: "test.write", resource_type: "settings" },
    );
    expect(result).toBe("accepted");
    expect(work).toBe(1);
    expect(await ctx.storage.settings.get("a")).toBe("v");
    expect(await audited("test.write")).toBe(1);
    expect(emitted).toEqual(["a"]);
    expect(activeFaults()[0]).toMatchObject({ fired: 1 });
  });
});

describe("a fault with nothing set", () => {
  it("changes nothing: the same writes commit, audit and announce", async () => {
    const emitted: string[] = [];
    await write("a", "test.write", emitted);
    await write("b", "test.write", emitted);
    expect(emitted).toEqual(["a", "b"]);
    expect(await audited("test.write")).toBe(2);
  });

  it("acts no more once cleared, and a cleared fault leaves no state on the next transaction", async () => {
    setFault("fail:commit", null);
    clearFaults();
    await write("a");
    expect(await ctx.storage.settings.get("a")).toBe(SENTINEL);
  });
});
