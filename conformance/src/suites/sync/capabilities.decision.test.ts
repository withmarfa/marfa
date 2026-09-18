/**
 * The renamed-time-filter verdict, driven over both door shapes it has to work
 * against.
 *
 * A live run reaches only one of them: a door that ignores an undeclared key
 * answers the control 200, and a door that refuses every undeclared key
 * answers it 400. The probe has to be right on both, because the verdict is
 * taken in `beforeAll` and one it cannot reach takes every file that probes
 * with it red.
 *
 * Requests are not made here, so this file needs no target. It runs in the
 * no-network lane for that reason — a decision this load-bearing should fail
 * without a server rather than only when somebody points one at it.
 */
import { describe, it, expect } from "vitest";
import { readRenamedTimeFilterAnswers } from "./capabilities.js";

/** An answer in the shape `rawRequest` returns. */
function answer(status: number, details?: Record<string, unknown>) {
  return {
    status,
    ok: status >= 200 && status < 300,
    error:
      status >= 400
        ? {
            error: {
              code: "validation_error",
              message: "refused",
              ...(details === undefined ? {} : { details }),
            },
          }
        : undefined,
  };
}

const RENAMED = { renamed_from: "since", use: "timestamp_after" };
const UNRECOGNIZED = { unknown_parameters: ["since"] };

describe("a door that still ignores an undeclared key", () => {
  it("reads a refusal of the old name as the rename", () => {
    const finding = readRenamedTimeFilterAnswers(answer(200), answer(400));
    expect(finding.present).toBe(true);
    expect(finding.evidence).toContain("ignored");
  });

  it("reads a 200 on the old name as the rename not having happened", () => {
    const finding = readRenamedTimeFilterAnswers(answer(200), answer(200));
    expect(finding.present).toBe(false);
  });
});

describe("a door that refuses every undeclared key", () => {
  it("reads the rename off the refusal rather than off the status", () => {
    // A door that refuses the control as well. The status is the same for
    // both refusals, so the verdict has to come from the refusal's details.
    const finding = readRenamedTimeFilterAnswers(
      answer(400, UNRECOGNIZED),
      answer(400, RENAMED),
    );
    expect(finding.present).toBe(true);
    expect(finding.evidence).toContain("renamed_from");
    expect(finding.evidence).toContain("timestamp_after");
  });

  it("does not read a general refusal as the rename", () => {
    // The false positive a status check produces here, and the one a
    // substring check on the message produces too: the general refusal names
    // every parameter the door accepts, `timestamp_after` among them.
    const finding = readRenamedTimeFilterAnswers(
      answer(400, UNRECOGNIZED),
      answer(400, UNRECOGNIZED),
    );
    expect(finding.present).toBe(false);
    expect(finding.evidence).toContain("unrecognized parameter");
  });

  it("refuses to guess when the refusal names neither", () => {
    // Both refusals are 400 and neither says which it is, so nothing
    // separates them. Throwing is the honest answer: guessing `present` would
    // run the tests that need the rule against a server that has renamed
    // nothing, and guessing `absent` would fail them naming the server for a
    // probe that could not see.
    expect(() =>
      readRenamedTimeFilterAnswers(answer(400, UNRECOGNIZED), answer(400)),
    ).toThrow(/names neither a replacement nor an unrecognized parameter/);
  });

  it("refuses to guess when the old name is not refused at all", () => {
    // The door refuses what it does not declare, so an accepted `since` means
    // it declares one — under a behavior this probe has not established.
    expect(() =>
      readRenamedTimeFilterAnswers(answer(400, UNRECOGNIZED), answer(200)),
    ).toThrow(/neither that refusal nor the rename's/);
  });
});

describe("a control that is neither ignored nor refused", () => {
  it("refuses to guess", () => {
    expect(() =>
      readRenamedTimeFilterAnswers(answer(500), answer(400, RENAMED)),
    ).toThrow(/neither the 200 that means it was ignored/);
  });
});
