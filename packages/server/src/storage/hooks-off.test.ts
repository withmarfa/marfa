import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { clearFaults, setFault } from "../control/faults.js";
import {
  createTestContext,
  request,
  runBulkActionAsync,
  type TestContext,
} from "../test-utils.js";
import { runAuditedTransaction } from "./audited-transaction.js";

const spies = vi.hoisted(() => ({ audit: vi.fn(), scope: vi.fn() }));
vi.mock("./sqlite/injected-failure.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./sqlite/injected-failure.js")>();
  return {
    ...actual,
    auditUnderFaults: (...args: Parameters<typeof actual.auditUnderFaults>) => {
      spies.audit();
      return actual.auditUnderFaults(...args);
    },
    withStatementFault: (
      ...args: Parameters<typeof actual.withStatementFault>
    ) => {
      spies.scope();
      return actual.withStatementFault(...args);
    },
  };
});

let ctx: TestContext;
beforeEach(async () => {
  ctx = await createTestContext();
  spies.audit.mockClear();
  spies.scope.mockClear();
});
afterEach(async () => {
  clearFaults();
  await ctx.cleanup();
});

const entry = { action: "test.hooks", resource_type: "settings" };
const write = () =>
  runAuditedTransaction(
    ctx.storage,
    () => ctx.storage.settings.set("hooks.off", "v"),
    entry,
  );

it("takes the original path with no fault set: no fault wrapper is built and no scope is entered", async () => {
  await write();
  expect(spies.audit).not.toHaveBeenCalled();
  expect(spies.scope).not.toHaveBeenCalled();
  expect(await ctx.storage.audit.list({ action: "test.hooks" })).toMatchObject({
    data: [expect.anything()],
  });
});

it("takes the fault path once a fault is set, which is the witness for the absence above", async () => {
  setFault("fail:commit-ack", null);
  await write();
  expect(spies.audit).toHaveBeenCalledTimes(1);
});

const ACTIONS: [string, Record<string, unknown>][] = [
  ["update_tags", { add: ["hooks-off-added"] }],
  ["update_tier", { tier: "feed" }],
  ["update_properties", { patch: { body: "patched" } }],
  ["update_occurred_at", { occurred_at: "2024-01-01T00:00:00.000Z" }],
  ["transition", { state: "archived" }],
  ["purge", { confirm: "PURGE" }],
];

async function jobFor(action: string, extra: Record<string, unknown>) {
  const made = await request(ctx.app, "POST", "/items", {
    key: ctx.workingKey,
    body: { type: "core.note", properties: { body: "row" }, tags: [action] },
  });
  expect(made.status).toBe(201);
  const ran = await runBulkActionAsync(
    ctx,
    { action, filter: { tags: [action] }, ...extra },
    ctx.workingKey,
  );
  expect(ran.initialStatus).toBe(202);
  return ran.job!;
}

it.each(ACTIONS)(
  "writes the rows of %s by the original code with no fault set, and through the fault scope once one is",
  async (action, extra) => {
    const job = await jobFor(action, extra);
    expect(job.status).toBe("completed");
    expect(spies.scope).not.toHaveBeenCalled();

    // The witness: with a fault set the same rows are written inside a scope.
    setFault("fail:job-row", null);
    await jobFor(action, extra);
    expect(spies.scope).toHaveBeenCalled();
  },
);
