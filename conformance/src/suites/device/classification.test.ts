import { describe, it } from "vitest";
import { notWrittenYet, skipIfPending } from "./pending.js";

/**
 * "Environmental failures retry indefinitely; contract failures do not."
 *
 * The split is the whole of the classification and it is closed. Retry a
 * contract failure and the queue loops on a refusal that will never change;
 * count an environmental one and a valid write is stranded behind an outage
 * and then needs a person to release it. Three refusals sit in neither class,
 * and each of the three was learned the hard way: a dead credential retried
 * for ever, a spent key spending a ceiling on identical refusals, and a base
 * version the server no longer holds re-sent unchanged.
 */

describe("the environmental class", () => {
  it("retries an environmental failure past the ceiling without counting it", (context) => {
    skipIfPending(context);
    notWrittenYet("a connectivity failure");
  });

  it("retries a 5xx and a 429 without counting them", (context) => {
    skipIfPending(context);
    notWrittenYet("a 5xx and a 429");
  });
});

describe("the contract class", () => {
  it("refuses a contract failure on the first answer", (context) => {
    skipIfPending(context);
    notWrittenYet("a contract refusal");
  });
});

describe("the three that are neither", () => {
  it("blocks the whole queue on a refused credential, and stops the drain", (context) => {
    skipIfPending(context);
    notWrittenYet("a refused credential");
  });

  it("blocks a spent key on the first refusal rather than spending the ceiling", (context) => {
    skipIfPending(context);
    notWrittenYet("a spent idempotency key");
  });

  it("blocks a write whose base version the server no longer holds", (context) => {
    skipIfPending(context);
    notWrittenYet("an unavailable ancestor");
  });

  it("blocks a conflict the server declined to resolve", (context) => {
    skipIfPending(context);
    notWrittenYet("a conflict the server declined");
  });
});

describe("the ceiling, and what releases a row", () => {
  it("releases a held write when its dependency is answered", (context) => {
    skipIfPending(context);
    notWrittenYet("a dependency being answered");
  });

  it("counts refusals rather than attempts, so a long outage does not exhaust the ceiling", (context) => {
    skipIfPending(context);
    notWrittenYet("refusals counted rather than attempts");
  });

  it("reaches the ceiling on the fifth refusal", (context) => {
    skipIfPending(context);
    notWrittenYet("the fifth refusal");
  });

  it("reports one of the five blocked reasons and no other", (context) => {
    skipIfPending(context);
    notWrittenYet("the closed set of blocked reasons");
  });
});
