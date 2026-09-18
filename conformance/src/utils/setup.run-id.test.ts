import { describe, it, expect } from "vitest";
import { newRunId } from "./setup.js";

/**
 * The run id is embedded in identifiers the server parses, and the server's
 * grammar for a dotted segment requires a leading letter.
 *
 * Suites build `mock.register.<runId>` and friends — the token as a segment of
 * its own — so a run id starting with a digit is refused at registration, and
 * a raw `randomUUID()` slice does that ten times in sixteen.
 */
describe("newRunId", () => {
  // Sampled rather than asserted once, and that is the point rather than
  // thoroughness for its own sake: the defect is probabilistic, so a
  // single-sample test passes six times in sixteen against a broken
  // implementation, and a flaky guard against a probabilistic bug is worth
  // nothing.
  const SAMPLES = 200;

  it("always begins with a letter, so it can head a dotted segment", () => {
    const offenders = Array.from({ length: SAMPLES }, () => newRunId()).filter(
      (id) => !/^[a-z]/.test(id),
    );
    expect(offenders).toEqual([]);
  });

  it("carries nothing the identifier grammar refuses", () => {
    // Lowercase alphanumeric and the hyphen the UUID puts at position 8. An
    // uppercase letter or a stray character would be refused for a different
    // reason than the one above and would read identically at the call site.
    const offenders = Array.from({ length: SAMPLES }, () => newRunId()).filter(
      (id) => !/^[a-z][a-z0-9-]*[a-z0-9]$/.test(id),
    );
    expect(offenders).toEqual([]);
  });

  it("does not repeat, so two files never collide on a fixture id", () => {
    // The property the token exists for. A constant prefix that also fixed
    // the leading-letter problem would pass both cases above.
    const ids = new Set(Array.from({ length: SAMPLES }, () => newRunId()));
    expect(ids.size).toBe(SAMPLES);
  });
});
