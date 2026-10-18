import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { clearFaults, setFault } from "../control/faults.js";
import { createTestContext, type TestContext } from "../test-utils.js";
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
