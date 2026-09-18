import { describe, it } from "vitest";
import { notWrittenYet, skipIfPending } from "./pending.js";

/**
 * "The server answers with a verdict."
 *
 * Six verdicts, and the set is closed. An engine with an open set has, in
 * practice, a default branch, and the default branch is where a refusal
 * becomes a retry and a merge becomes a silent overwrite. Each verdict below
 * is the one thing a caller needs in order to know what happened to a write
 * it was told had been queued.
 */

describe("the set is closed", () => {
  it("answers every write with one of the six verdicts", (context) => {
    skipIfPending(context);
    notWrittenYet("the closed verdict set");
  });
});

describe("the server took the write", () => {
  it("accepted: adopts the row the server returned", (context) => {
    skipIfPending(context);
    notWrittenYet("an accepted write");
  });

  it("merged: adopts the server's row when it differs from the one it expected", (context) => {
    skipIfPending(context);
    notWrittenYet("a merged write");
  });

  it("merged: reports a resolution that named no conflicted copy", (context) => {
    skipIfPending(context);
    notWrittenYet("a resolution with no sibling");
  });

  it("conflicted: names the sibling the server wrote", (context) => {
    skipIfPending(context);
    notWrittenYet("a conflicted copy");
  });
});

describe("the server did not take the write", () => {
  it("refused: carries the server's code and is not sent again", (context) => {
    skipIfPending(context);
    notWrittenYet("a refused write");
  });

  it("blocked: is passed over by a drain and reported with its reason", (context) => {
    skipIfPending(context);
    notWrittenYet("a blocked write");
  });

  it("dead: is terminal once the ceiling is reached", (context) => {
    skipIfPending(context);
    notWrittenYet("a write that reached the ceiling");
  });
});

describe("a verdict is reported, not acted on", () => {
  it("reports a conflict rather than resolving it", (context) => {
    skipIfPending(context);
    notWrittenYet("a conflict reported rather than resolved");
  });

  it("refuses the writes that were waiting on a create the server refused", (context) => {
    skipIfPending(context);
    notWrittenYet("the dependants of a refused create");
  });
});
