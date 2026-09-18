/**
 * A soft delete respects the type's own lifecycle.
 *
 * `system.*` types are documented as bounded to `active | revoked`, and
 * `validateTransition` enforces exactly that — so the documentation and the
 * transition route agreed, and staging still held six `system.connection`
 * rows in `trashed`.
 *
 * `DELETE /items/:id` was the way in. It wrote `state: "trashed"`
 * unconditionally and never consulted the gate, so it produced a state the
 * type does not contain: no transition can reach it, none can leave it, and
 * `purge` refused it because it required literal `trashed`, which those rows
 * did have — but a `system.*` row can now never be in. The rows were also
 * invisible: a listing with no `state` filter omits trashed rows, which is
 * why successive inventories of the same data disagreed with each other.
 *
 * The fix routes the soft delete through the same gate, with the target state
 * derived from the type by `softDeleteState`. These tests pin the bound from
 * the delete side, which is the side that broke it.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestContext } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { softDeleteState } from "@withmarfa/shared";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.cleanup();
});

async function connection(): Promise<string> {
  const item = await ctx.storage.items.create({
    type: "system.connection",
    properties: {
      kind: "app",
      status: "active",
      granted_at: new Date().toISOString(),
    },
  });
  return item.id;
}

async function note(): Promise<string> {
  const item = await ctx.storage.items.create({
    type: "core.note",
    properties: { body: "soft delete fixture" },
  });
  return item.id;
}

async function stateOf(id: string): Promise<string | undefined> {
  const row = await ctx.storage.items.getIncludingTrashed(id);
  return row?.state;
}

describe("softDeleteState", () => {
  it("is revoked for system types and trashed for everything else", () => {
    expect(softDeleteState("system.connection")).toBe("revoked");
    expect(softDeleteState("system.activity")).toBe("revoked");
    expect(softDeleteState("core.note")).toBe("trashed");
    // A custom type is not a system type, so it follows the ordinary graph.
    expect(softDeleteState("acme.widget")).toBe("trashed");
  });
});

describe("deleting an item obeys its lifecycle", () => {
  it("REGRESSION: deleting a system item revokes it rather than trashing it", async () => {
    const id = await connection();
    await ctx.storage.items.delete(id);
    expect(await stateOf(id)).toBe("revoked");
  });

  it("still trashes an ordinary item", async () => {
    const id = await note();
    await ctx.storage.items.delete(id);
    expect(await stateOf(id)).toBe("trashed");
  });

  it("is idempotent on both, rather than refusing the second call", async () => {
    // `trashed → trashed` and `revoked → revoked` are both illegal
    // transitions, so routing the delete through the gate would turn a
    // repeat delete into an error if it did not short-circuit first. DELETE
    // is idempotent and has to stay that way.
    const sys = await connection();
    await ctx.storage.items.delete(sys);
    await ctx.storage.items.delete(sys);
    expect(await stateOf(sys)).toBe("revoked");

    const ord = await note();
    await ctx.storage.items.delete(ord);
    await ctx.storage.items.delete(ord);
    expect(await stateOf(ord)).toBe("trashed");
  });

  it("purges a revoked system item, which the trashed-only gate could not", async () => {
    // The second half of the same defect. Requiring literal `trashed` made a
    // correctly-revoked system row unpurgeable, so fixing the delete without
    // fixing the gate would have traded a wrong state for a stuck one.
    const id = await connection();
    await ctx.storage.items.delete(id);
    await ctx.storage.items.purge(id);
    expect(await stateOf(id)).toBeUndefined();
  });

  it("refuses to purge an item that has not been soft-deleted", async () => {
    const sys = await connection();
    await expect(ctx.storage.items.purge(sys)).rejects.toThrow(/revoked/);
    const ord = await note();
    await expect(ctx.storage.items.purge(ord)).rejects.toThrow(/trashed/);
  });

  it("leaves no system item in a state its lifecycle does not contain", async () => {
    // The inventory check, as a standing guard: the staging rows were found
    // by enumerating every state by hand rather than trusting the bound, and
    // that is the only way to ask the question.
    const ids = [await connection(), await connection(), await connection()];
    await ctx.storage.items.delete(ids[0]!);
    await ctx.storage.items.delete(ids[1]!);

    // One query per state, because the filter takes one — which is itself
    // part of why this went unnoticed: the convenient query is the default
    // one, and the default one cannot see the rows.
    const offending: string[] = [];
    for (const state of ["archived", "trashed"] as const) {
      const rows = await ctx.storage.items.list({
        type: "system.connection",
        state,
        limit: 500,
      });
      offending.push(...rows.data.map((r) => `${r.id}:${r.state}`));
    }
    expect(offending).toEqual([]);
  });
});
