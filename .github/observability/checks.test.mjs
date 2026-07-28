/**
 * Tests for the pure decision logic in the fleet health check.
 *
 * Run with `node --test .github/observability/`. Deliberately uses the Node
 * test runner rather than the repository's Vitest setup: this directory runs
 * standalone on a CI runner with no install step and is outside every
 * workspace project, so it has no dependencies to reach for.
 *
 * The cases below are not invented. Most encode something a real incident
 * taught, and the comments say which — a threshold with a story attached is
 * much harder to "tidy up" into uselessness later.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { classifyFailure, summarizeSamples } from "./probes.mjs";
import { evaluateService } from "./posthog.mjs";
import {
  countOscillations,
  heartbeatIntervals,
  heartbeatGapTolerance,
  checkHeartbeatGap,
  checkFleetOscillation,
  evaluateProjectMatch,
} from "./heartbeat.mjs";

const surface = {
  id: "x",
  label: "Test surface",
  url: "https://example.test/",
};
const ok = (sha = null) => ({ ok: true, durationMs: 100, sha });
const bad = (kind, summary) => ({
  ok: false,
  kind,
  summary,
  durationMs: 50,
  sha: null,
});

describe("classifyFailure", () => {
  // These three strings are the exact bodies observed from the edge during a
  // real production outage. They mean different things and must not collapse
  // into one generic "HTTP 500".
  test("separates a failed start from a missing instance", () => {
    assert.equal(
      classifyFailure(
        500,
        "Failed to start container: There has been an internal error connecting to the port",
      ).kind,
      "instance-will-not-start",
    );
    assert.equal(
      classifyFailure(
        500,
        "Failed to start container: The container is not running, consider calling start()",
      ).kind,
      "instance-will-not-start",
    );
    assert.equal(
      classifyFailure(
        500,
        "Error proxying request to container: The container is not running, consider calling start()",
      ).kind,
      "instance-not-running",
    );
  });

  test("falls back to layer-appropriate kinds", () => {
    assert.equal(
      classifyFailure(503, "upstream unavailable").kind,
      "server-error",
    );
    assert.equal(classifyFailure(404, "not found").kind, "http-error");
  });
});

describe("summarizeSamples", () => {
  test("all samples passing is up", () => {
    const r = summarizeSamples(surface, [ok(), ok(), ok()]);
    assert.equal(r.state, "up");
    assert.equal(r.ok, true);
    assert.equal(r.failed, 0);
  });

  test("all samples failing is down", () => {
    const r = summarizeSamples(surface, [
      bad(
        "instance-will-not-start",
        "the edge tried to start an instance and failed",
      ),
      bad(
        "instance-will-not-start",
        "the edge tried to start an instance and failed",
      ),
      bad(
        "instance-will-not-start",
        "the edge tried to start an instance and failed",
      ),
    ]);
    assert.equal(r.state, "down");
    assert.equal(r.kind, "instance-will-not-start");
  });

  // The regression that matters. A single-sample probe landed inside an up
  // window during a real outage and reported the surface healthy while it was
  // failing either side of that moment. Disagreement between samples has to
  // be a finding in its own right, not rounded to either verdict.
  test("samples that disagree are intermittent, not up and not down", () => {
    const r = summarizeSamples(surface, [
      ok(),
      bad("instance-not-running", "no instance is running behind the edge"),
      ok(),
    ]);
    assert.equal(r.state, "intermittent");
    assert.equal(r.ok, false, "an intermittent surface must never report ok");
    assert.equal(r.failed, 1);
    assert.match(r.detail, /1 of 3 samples failed/);
  });

  test("a single failure among many is still intermittent", () => {
    const r = summarizeSamples(surface, [
      ok(),
      ok(),
      ok(),
      ok(),
      bad("server-error", "500"),
    ]);
    assert.equal(r.state, "intermittent");
    assert.equal(r.ok, false);
  });

  test("carries a build SHA through from whichever sample saw one", () => {
    const r = summarizeSamples(surface, [
      bad("server-error", "500"),
      ok("abc1234"),
      ok(),
    ]);
    assert.equal(r.sha, "abc1234");
  });
});

describe("evaluateService", () => {
  const service = (over) => ({
    project: "production",
    service: "marfa-server",
    errors: 0,
    boots: 0,
    shutdowns: 0,
    uncleanRestarts: 0,
    total: 100,
    ...over,
  });

  test("stays silent on a quiet, healthy service", () => {
    assert.deepEqual(evaluateService(service()), []);
  });

  // Measured from real telemetry: a hosted container under intermittent
  // traffic sleeps and wakes every few minutes, logging a startup and a
  // matching shutdown each time. Production did exactly this — 13 startups in
  // 24 hours, each paired — throughout a period when it was serving fine.
  // Alerting here would fire constantly on healthy infrastructure.
  test("does not call matched startup/shutdown pairs a crash loop", () => {
    const findings = evaluateService(
      service({ boots: 6, shutdowns: 6, uncleanRestarts: 0 }),
    );
    assert.deepEqual(findings, []);
  });

  // The complement: the same modest startup count, but nothing shut down
  // cleanly. A process that dies does not get to log a shutdown, so this is
  // the slow crash loop that a raw startup count cannot distinguish from
  // ordinary scale-to-zero cycling.
  test("catches a slow crash loop hiding under the absolute threshold", () => {
    const findings = evaluateService(
      service({ boots: 4, shutdowns: 0, uncleanRestarts: 4 }),
    );
    assert.equal(findings.length, 1);
    assert.equal(findings[0].area, "crash-loop");
    assert.match(findings[0].title, /Unclean restarts/);
  });

  test("tolerates one unmatched event at a window edge", () => {
    // A shutdown can fall just outside a window whose startup falls inside.
    assert.deepEqual(
      evaluateService(service({ boots: 3, shutdowns: 2, uncleanRestarts: 1 })),
      [],
    );
  });

  test("catches a fast catastrophic loop on absolute count alone", () => {
    const findings = evaluateService(
      service({ boots: 90, shutdowns: 90, uncleanRestarts: 0 }),
    );
    assert.equal(findings.length, 1);
    assert.match(findings[0].title, /Restart loop/);
  });

  test("reports an error-rate spike independently of restarts", () => {
    const findings = evaluateService(service({ errors: 28 }));
    assert.equal(findings.length, 1);
    assert.equal(findings[0].area, "error-rate");
  });
});

describe("countOscillations", () => {
  test("counts transitions, not occurrences", () => {
    assert.equal(countOscillations([true, true, true]), 0);
    assert.equal(countOscillations([true, false]), 1);
    assert.equal(countOscillations([true, false, true, false]), 3);
  });

  test("ignores malformed entries rather than inventing a flip", () => {
    // A missing or unreadable property must not manufacture instability.
    assert.equal(countOscillations([true, null, true]), 0);
    assert.equal(countOscillations([undefined, "yes", 1]), 0);
  });

  test("reads a verdict the backend serialized as text", () => {
    // The property is a boolean column and arrives as a boolean today. If
    // that ever changes, a reader insisting on the JavaScript type would
    // discard every row and report a fleet that never flaps — silent, total,
    // and indistinguishable from health, which is the failure this whole
    // file exists to prevent.
    assert.equal(countOscillations([true, "false", true]), 2);
    assert.equal(countOscillations(["True", "TRUE", "false"]), 1);
  });

  test("handles empty and single-run histories", () => {
    assert.equal(countOscillations([]), 0);
    assert.equal(countOscillations([true]), 0);
  });
});

/**
 * Intervals in minutes between consecutive scheduled runs of this workflow,
 * oldest gap last, measured on 2026-07-28 from the 40 most recent scheduled
 * runs — `gh run list --workflow=observability.yml --json event,createdAt`,
 * filtered to `event == "schedule"` — spanning 2026-07-25T10:06Z to
 * 2026-07-28T01:09Z.
 *
 * This fixture is the point of the suite below. Every timing constant in
 * `heartbeat.mjs` was once derived from the `cron` line, which asks for a run
 * every five minutes; not one delivered interval is remotely close to that.
 * The consequence was a staleness tolerance under half the real interval,
 * firing on every single run, and an oscillation window too narrow to ever
 * hold enough runs to trip. Every unit test passed throughout, because each
 * unit was correct and it was their relationship to the environment that was
 * broken. These tests pin that relationship instead.
 *
 * Re-measure with the command above rather than adjusting these by hand.
 */
const MEASURED_SCHEDULE_GAPS = [
  57, 58, 61, 62, 62, 62, 63, 63, 64, 65, 66, 66, 66, 66, 67, 67, 68, 69, 69,
  75, 79, 80, 84, 84, 85, 86, 98, 99, 100, 107, 109, 120, 139, 165, 187, 195,
  220, 225, 227,
];

const MEASURED_MEDIAN_GAP = 75;
const HISTORY_ENDS_AT = new Date("2026-07-28T01:09:00Z");

/**
 * A heartbeat history, newest first, from a list of intervals in minutes and
 * an optional list of verdicts. Verdicts default to healthy so the gap tests
 * cannot accidentally trip the oscillation check.
 */
function historyFrom(gapMinutes, verdicts = []) {
  const beats = [];
  let at = HISTORY_ENDS_AT.getTime();
  for (let i = 0; i <= gapMinutes.length; i += 1) {
    beats.push({ at: new Date(at), healthy: verdicts[i] ?? true });
    at -= (gapMinutes[i] ?? 0) * 60_000;
  }
  return { configured: true, beats };
}

/** `count` runs at a fixed interval, alternating healthy and unhealthy. */
function alternating(count, gapMinutes) {
  return historyFrom(
    Array.from({ length: count - 1 }, () => gapMinutes),
    Array.from({ length: count }, (_, i) => i % 2 === 0),
  );
}

describe("thresholds against the cadence the scheduler actually delivers", () => {
  test("the fixture round-trips through the interval derivation", () => {
    assert.deepEqual(
      heartbeatIntervals(historyFrom(MEASURED_SCHEDULE_GAPS).beats),
      MEASURED_SCHEDULE_GAPS,
    );
  });

  // The single most important assertion here. If the tolerance ever drops
  // below an interval the scheduler routinely produces, the gap warning
  // becomes permanent — and a warning that is always present is a warning
  // nobody reads, on the one mechanism whose job is to be believed.
  test("the gap tolerance clears every interval the scheduler delivered", () => {
    const widest = Math.max(...MEASURED_SCHEDULE_GAPS);
    const baseline = heartbeatGapTolerance(MEASURED_SCHEDULE_GAPS);
    assert.ok(
      baseline.toleranceMinutes > widest,
      `tolerance is ${String(baseline.toleranceMinutes)} min but the scheduler has ` +
        `delivered intervals up to ${String(widest)} min, so the gap warning would fire ` +
        "on ordinary scheduling",
    );
  });

  test("no gap is reported for any interval the scheduler delivered", () => {
    const history = historyFrom(MEASURED_SCHEDULE_GAPS);
    for (const gap of MEASURED_SCHEDULE_GAPS) {
      const now = new Date(history.beats[0].at.getTime() + gap * 60_000);
      assert.deepEqual(
        checkHeartbeatGap({ history, now }).findings,
        [],
        `a ${String(gap)}-minute interval is normal for this scheduler and must not be reported`,
      );
    }
  });

  // The other side of the trade. A tolerance loose enough never to fire is
  // as useless as one that always fires, so half a day of blindness must
  // still be reported.
  test("a genuine multi-hour absence is still reported", () => {
    const history = historyFrom(MEASURED_SCHEDULE_GAPS);
    const now = new Date(history.beats[0].at.getTime() + 12 * 60 * 60 * 1_000);
    const result = checkHeartbeatGap({ history, now });
    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0].area, "watchdog");
  });

  // The headline capability, and the one that was unreachable. Three flips
  // need four runs to sit between them; at these intervals a ninety-minute
  // window held one or two, so the detector could not fire at all.
  test("flap detection can fire at the delivered cadence", () => {
    const result = checkFleetOscillation({
      history: alternating(8, MEASURED_MEDIAN_GAP),
    });
    assert.equal(
      result.findings.length,
      1,
      "alternating verdicts at the measured cadence must be reported as flapping",
    );
    assert.ok(result.flips >= 3);
  });

  test("flap detection still fires at the slowest delivered interval", () => {
    const slowest = Math.max(...MEASURED_SCHEDULE_GAPS);
    assert.equal(
      checkFleetOscillation({ history: alternating(8, slowest) }).findings
        .length,
      1,
      "the oscillation window must be counted in runs, not minutes — no " +
        "minute-based window narrow enough to mean 'recently' can hold four " +
        "runs at this interval",
    );
  });

  test("a steady fleet is not called flapping", () => {
    const history = historyFrom(
      Array.from({ length: 7 }, () => MEASURED_MEDIAN_GAP),
    );
    assert.deepEqual(checkFleetOscillation({ history }).findings, []);
  });

  test("a single recovery is not flapping", () => {
    // One flip is a fleet that broke, or one that recovered. Both are
    // already reported by the alert issue opening or closing.
    const history = historyFrom(
      Array.from({ length: 7 }, () => MEASURED_MEDIAN_GAP),
      [true, true, true, false, false, false, false, false],
    );
    assert.deepEqual(checkFleetOscillation({ history }).findings, []);
  });
});

describe("checkHeartbeatGap without an established rhythm", () => {
  test("a first-ever run reports no gap", () => {
    const result = checkHeartbeatGap({
      history: { configured: true, beats: [] },
      now: new Date(),
    });
    assert.deepEqual(result.findings, []);
    assert.equal(result.firstRun, true);
  });

  test("too few runs to know what normal is reports no gap", () => {
    // Two runs establish no rhythm, so there is nothing to have deviated
    // from. Staying quiet is the honest answer; guessing here would put back
    // the always-present warning this change removed.
    const history = historyFrom([70]);
    const now = new Date(history.beats[0].at.getTime() + 5 * 60 * 60 * 1_000);
    const result = checkHeartbeatGap({ history, now });
    assert.deepEqual(result.findings, []);
    assert.equal(result.baselineKnown, false);
  });

  test("one long outage in the history does not desensitize the check", () => {
    // The run that reports a gap never has that gap in its own baseline —
    // it has not emitted its heartbeat yet. The run after it does. Using the
    // median keeps that single outlier from moving the tolerance; a mean or
    // a maximum would let one outage blind the next.
    const clean = heartbeatGapTolerance(MEASURED_SCHEDULE_GAPS);
    const afterOutage = heartbeatGapTolerance([
      3000,
      ...MEASURED_SCHEDULE_GAPS,
    ]);
    assert.ok(
      afterOutage.toleranceMinutes <= clean.toleranceMinutes * 1.1,
      `a single 3000-minute outage moved the tolerance from ` +
        `${String(clean.toleranceMinutes)} to ${String(afterOutage.toleranceMinutes)} minutes`,
    );
  });

  test("a history that could not be read is reported as unknown, not healthy", () => {
    const result = checkHeartbeatGap({
      history: { configured: true, unknown: true, beats: [] },
      now: new Date(),
    });
    assert.deepEqual(result.findings, []);
    assert.equal(
      result.unknown,
      true,
      "the summary has to be able to say the read failed rather than showing nothing",
    );
  });
});

describe("evaluateProjectMatch", () => {
  // The heartbeat is written with an ingestion key and read back with a
  // project id. Nothing ties the two together, and if they ever name
  // different projects then both readers find no rows and report nothing
  // wrong — silently, permanently, and looking exactly like health.
  const mismatch = () =>
    evaluateProjectMatch({
      ingestionKey: "phc_written_here",
      projectToken: "phc_read_from_there",
      projectId: "1234",
    });

  test("writing to a different project than is read is red", () => {
    const result = mismatch();
    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0].severity, "red");
    assert.equal(result.findings[0].area, "watchdog");
  });

  test("neither token appears in the finding", () => {
    const [finding] = mismatch().findings;
    const text = `${finding.title} ${finding.detail}`;
    assert.ok(!text.includes("phc_written_here"));
    assert.ok(!text.includes("phc_read_from_there"));
  });

  test("a matching project is silent", () => {
    assert.deepEqual(
      evaluateProjectMatch({
        ingestionKey: "phc_same",
        projectToken: "phc_same",
        projectId: "1234",
      }).findings,
      [],
    );
  });

  test("an assertion that cannot be run never becomes a standing warning", () => {
    // Reading project details needs a permission the query path does not, so
    // a key scoped only for querying cannot confirm this. That belongs in
    // the run summary and nowhere else — a permanent warning here would
    // recreate the exact defect this change removed.
    const unconfirmable = [
      { ingestionKey: "phc_write", projectToken: null, projectId: "1234" },
      { ingestionKey: undefined, projectToken: null, projectId: "1234" },
      { ingestionKey: "phc_write", projectToken: null, projectId: undefined },
    ];
    for (const args of unconfirmable) {
      assert.deepEqual(evaluateProjectMatch(args).findings, []);
    }
  });
});
