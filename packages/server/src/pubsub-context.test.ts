import { expect, it, vi } from "vitest";
import { createTestContext } from "./test-utils.js";
import {
  announceFromLog,
  initEventLog,
  publish,
  subscribeAll,
  __resetEventLogForTests,
} from "./pubsub.js";
import {
  TransactionControl,
  transactionControl,
} from "./storage/sqlite/transaction-control.js";
import type { Item } from "@withmarfa/shared";

it("announces committed events after the caller's transaction context closes", async () => {
  const ctx = await createTestContext();
  const abort = new AbortController();
  const frames = subscribeAll({ signal: abort.signal });
  const first = frames.next();
  try {
    initEventLog(ctx.storage.eventLog);
    const id = await ctx.storage.runInTransaction(() =>
      publish(
        {
          type: "created",
          item: { id: "probe", type: "core.note" } as Item,
        },
        { announce: "from_log" },
      ),
    );
    expect(id).toBeDefined();
    const control = new TransactionControl();
    control.invalidate(new Error("closed writer"), "ended", "committed");
    const contexts: (TransactionControl | undefined)[] = [];
    const read = ctx.storage.eventLog.getAfter.bind(ctx.storage.eventLog);
    vi.spyOn(ctx.storage.eventLog, "getAfter").mockImplementation((...args) => {
      contexts.push(transactionControl.getStore());
      return read(...args);
    });
    transactionControl.run(control, () => {
      expect(transactionControl.getStore()).toBe(control);
      announceFromLog({ first: id!, last: id! });
    });
    const delivered = await first;
    expect(delivered.done).toBe(false);
    expect(delivered.value).toMatchObject([{ event: { eventId: id } }]);
    expect(contexts).toEqual([undefined]);
  } finally {
    abort.abort();
    await frames.return(undefined);
    vi.restoreAllMocks();
    __resetEventLogForTests();
    await ctx.cleanup();
  }
});
