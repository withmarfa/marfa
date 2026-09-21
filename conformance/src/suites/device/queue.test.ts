import { describe, it, expect, afterEach } from "vitest";
import { startHarness, type Harness } from "./harness.js";
import { notWrittenYet, skipIfPending } from "./pending.js";

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.stop();
  harness = undefined;
});

/**
 * "A device holds a working copy and a queue."
 *
 * The queue is what makes a device usable when the server is not there, and
 * every rule in it guards a way of losing a write that nobody can see: a write
 * sent without the version it read, a retry that spends a key, a write sent
 * before the row it depends on, a queue cleared by a re-hydration. A queue
 * that drops a write reports nothing, because the caller was already told the
 * write was queued.
 */

describe("the queue answers before there is anything in it", () => {
  it("reports an empty queue on a store that has never been written to", async () => {
    harness = await startHarness("queue-empty");

    // Answerable without a hydration, and this is the case that says so. A
    // caller asking what is outstanding is asking about what they queued,
    // not about the copy: a device that made them hydrate first would
    // refuse the question at the moment it matters most, which is when the
    // server cannot be reached.
    const queued = await harness.device.queue();
    expect(
      queued.ok,
      `a device refused to report its queue, so a caller cannot find out what is outstanding: ${JSON.stringify(queued)}`,
    ).toBe(true);
    if (!queued.ok) return;
    expect(
      queued.value,
      "a store with no writes reported something queued, so the queue reports rows nobody asked for",
    ).toEqual([]);
  });
});

describe("the queue keeps its order", () => {
  it("sends queued writes in the order they were queued", (context) => {
    skipIfPending(context);
    notWrittenYet("the order a drain sends in");
  });

  it("keeps the queue across a restart", (context) => {
    skipIfPending(context);
    notWrittenYet("a queue outliving the process that made it");
  });
});

describe("every write names the version it read", () => {
  it("refuses an update queued with no version", (context) => {
    skipIfPending(context);
    notWrittenYet("an update queued with no version");
  });

  it("sends a create with the version it was based on", (context) => {
    skipIfPending(context);
    notWrittenYet("a create carrying the version it was based on");
  });
});

describe("a write is answered once", () => {
  it("retries under the key it was queued with, and is answered from the record rather than written twice", (context) => {
    skipIfPending(context);
    notWrittenYet("a retry under the key the write was queued with");
  });
});

describe("a write waits for what it depends on", () => {
  it("holds a write whose create has not been answered", (context) => {
    skipIfPending(context);
    notWrittenYet("a write held for its dependency");
  });
});

describe("what a drain sends and reports", () => {
  it("sends every update with the server asked to resolve", (context) => {
    skipIfPending(context);
    notWrittenYet("an update sent with the server asked to resolve");
  });

  it("reports a verdict for every write it sent", (context) => {
    skipIfPending(context);
    notWrittenYet("a drain's report");
  });
});

describe("what a queue holds", () => {
  it("holds one kind per write, from the closed set", (context) => {
    skipIfPending(context);
    notWrittenYet("the closed set of write kinds");
  });

  it("queues an edge, a tag and an extension as writes of their own", (context) => {
    skipIfPending(context);
    notWrittenYet("an edge, a tag and an extension as separate writes");
  });
});

describe("offline, reconnect and re-hydration", () => {
  it("queues writes while the server is unreachable", (context) => {
    skipIfPending(context);
    notWrittenYet("queuing while the server is unreachable");
  });

  it("drains in order on reconnect", (context) => {
    skipIfPending(context);
    notWrittenYet("the order a reconnected drain sends in");
  });

  it("keeps the queue through a re-hydration", (context) => {
    skipIfPending(context);
    notWrittenYet("a queue surviving a re-hydration");
  });

  it("shows an unanswered local write to a local read", (context) => {
    skipIfPending(context);
    notWrittenYet("a local read seeing an unanswered write");
  });
});
