import { describe, it } from "vitest";
import { notWrittenYet, skipIfPending } from "./pending.js";

/**
 * "Environmental failures retry indefinitely; contract failures do not."
 *
 * Retry a contract failure and the queue loops on a refusal that will never
 * change; count an environmental one and a valid write is stranded behind an
 * outage and then needs a person to release it. Between the two sits the class
 * the ceiling exists for, and without it `dead` is a verdict nothing reaches.
 * Four refusals sit outside all three, and each of the four is a case where
 * the obvious classification is wrong: a dead credential is not a network, a
 * spent key is not a spent write, an ancestor the server has thinned does not
 * come back, and a conflict a device may not resolve is not a conflict it may
 * retry.
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

describe("the class the ceiling exists for", () => {
  it("retries an answer it cannot read, and counts it", (context) => {
    skipIfPending(context);
    notWrittenYet("an answer the device cannot read");
  });

  it("retries a key the server reports in flight, and counts it", (context) => {
    skipIfPending(context);
    notWrittenYet("a key the server reports in flight");
  });
});

describe("the four that are none of the three", () => {
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

  it("sends a released row again under a fresh key", (context) => {
    skipIfPending(context);
    notWrittenYet("a released row sent again");
  });
});
