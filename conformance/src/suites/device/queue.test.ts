import { describe, it } from "vitest";
import { notWrittenYet, skipIfPending } from "./pending.js";

/**
 * "A device holds a working copy and a queue."
 *
 * The queue is what makes a device usable when the server is not there, and
 * every rule in it exists because an engine got it wrong in a way nobody
 * could see: a write sent without the version it read, a retry that spent a
 * key, a write sent before the row it depends on, a queue cleared by a
 * re-hydration. A queue that drops a write reports nothing, because the
 * caller was already told the write was queued.
 */

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
