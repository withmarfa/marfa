import { describe, it } from "vitest";
import { notWrittenYet, skipIfPending } from "./pending.js";

/**
 * "The server answers with a verdict."
 *
 * Six verdicts, and the set is closed. An open set means a default branch in
 * practice, and a default branch is where a refusal becomes a retry and a
 * merge becomes a silent overwrite. The three a successful answer can carry
 * are told apart by one field rather than by comparing rows, because every
 * answer carries fields the server stamped and the device never sent.
 */

describe("the set is closed", () => {
  it("answers every write with one of the six verdicts", (context) => {
    skipIfPending(context);
    notWrittenYet("the closed verdict set");
  });

  it("tells the three successful verdicts apart by the resolution the answer carries", (context) => {
    skipIfPending(context);
    notWrittenYet("the discriminator between the three successful verdicts");
  });
});

describe("the server took the write", () => {
  it("accepted: adopts the row the server returned", (context) => {
    skipIfPending(context);
    notWrittenYet("an accepted write");
  });

  it("accepted: takes an upsert and a replayed repeat as accepted", (context) => {
    skipIfPending(context);
    notWrittenYet("an upsert and a replayed repeat");
  });

  it("merged: adopts the row a resolution returned", (context) => {
    skipIfPending(context);
    notWrittenYet("a merged write");
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

  it("answers about whole fields, never about part of one", (context) => {
    skipIfPending(context);
    notWrittenYet("a verdict about a whole field");
  });
});
