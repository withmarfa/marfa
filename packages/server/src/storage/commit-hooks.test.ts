/**
 * Work registered inside a transaction runs once it commits, never when it
 * rolls back, and a savepoint that rolls back takes its own work with it.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestContext } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { afterCommit } from "./commit-hooks.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("work after a commit", () => {
  it("runs after the outermost commit, in the order it was registered", async () => {
    const ran: string[] = [];
    await ctx.storage.runInTransaction(async () => {
      afterCommit(() => ran.push("outer"));
      await ctx.storage.runInTransaction(() => {
        afterCommit(() => ran.push("inner"));
      });
      expect(ran).toEqual([]);
    });
    expect(ran).toEqual(["outer", "inner"]);
  });

  it("drops what a rolled-back transaction or savepoint registered", async () => {
    const ran: string[] = [];
    await ctx.storage.runInTransaction(async () => {
      afterCommit(() => ran.push("kept"));
      await expect(
        ctx.storage.runInTransaction(() => {
          afterCommit(() => ran.push("savepoint"));
          throw new Error("rolled back");
        }),
      ).rejects.toThrow("rolled back");
    });
    await expect(
      ctx.storage.runInTransaction(() => {
        afterCommit(() => ran.push("transaction"));
        throw new Error("rolled back");
      }),
    ).rejects.toThrow("rolled back");
    expect(ran).toEqual(["kept"]);
  });

  it("runs at once outside a transaction", () => {
    const ran: string[] = [];
    afterCommit(() => ran.push("now"));
    expect(ran).toEqual(["now"]);
  });

  it("does not turn a committed transaction into a failure when the work throws", async () => {
    const ran: string[] = [];
    await expect(
      ctx.storage.runInTransaction(() => {
        afterCommit(() => {
          throw new Error("a subscriber failed");
        });
        afterCommit(() => ran.push("after it"));
        return "committed";
      }),
    ).resolves.toBe("committed");
    expect(ran).toEqual(["after it"]);
  });
});
