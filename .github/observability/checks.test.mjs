/**
 * Tests for the pure decision logic in the fleet health check.
 *
 * Run with `node --test '.github/observability/*.test.mjs'` — the quoted glob
 * rather than the directory, because Node has treated a bare directory
 * argument as a search root in some versions and as a module to execute in
 * others. Deliberately uses the Node test runner rather than the repository's
 * Vitest setup: this directory runs standalone on a CI runner with no install
 * step and is outside every workspace project, so it has no dependencies to
 * reach for.
 *
 * The cases below are not invented. Most encode something a real incident
 * taught, and the comments say which — a threshold with a story attached is
 * much harder to "tidy up" into uselessness later.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  classifyFailure,
  summarizeSamples,
  checkLiveness,
  SAMPLE_COUNT,
  SAMPLE_INTERVAL_MS,
  MAX_SAMPLE_SPREAD_MS,
} from "./probes.mjs";
import { waitForDeployedBuild, healthUrlFor } from "./deploy-gate.mjs";
import {
  evaluateService,
  servicesFromRows,
  unobservablePairing,
  buildTelemetryQuery,
  MEASURED_SCALE_TO_ZERO,
  AUTHORIZE_REFUSAL_THRESHOLD,
  AUTHORIZE_REFUSED_MESSAGE,
} from "./posthog.mjs";
import {
  countOscillations,
  heartbeatIntervals,
  heartbeatGapTolerance,
  checkHeartbeatGap,
  checkFleetOscillation,
  evaluateProjectMatch,
  buildHistoryQuery,
} from "./heartbeat.mjs";
import { splitFindings, describeHistory, visibilityLines } from "./summary.mjs";

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

  // A fail-open in the one function whose stated purpose is to stop a probe
  // reporting health it did not observe. Zero failures out of zero samples
  // satisfies "nothing failed", so an empty array used to reach `up`.
  test("no samples is not a healthy surface", () => {
    const r = summarizeSamples(surface, []);
    assert.equal(r.ok, false, "an unprobed surface must never report ok");
    assert.notEqual(r.state, "up");
    assert.equal(r.samples, 0);
  });
});

describe("checkLiveness", () => {
  // `takeSample` reaches the network, so the probe itself is stubbed out. The
  // behavior under test is the sampling plan, which is where the untested
  // claims were.
  const stubFetch = (status = 200) => {
    const original = globalThis.fetch;
    globalThis.fetch = () => Promise.resolve(new Response("ok", { status }));
    return () => {
      globalThis.fetch = original;
    };
  };
  const staticSurface = (id) => ({
    id,
    label: `Surface ${id}`,
    url: `https://example.test/${id}`,
    kind: "static",
  });

  // The spacing is the entire reason the sampling exists: three samples taken
  // in the same instant see exactly what one sample sees. The comment claiming
  // they are spread had no guard, so setting the interval to zero passed.
  test("spreads its samples rather than taking them back to back", async () => {
    const restore = stubFetch();
    const waits = [];
    try {
      await checkLiveness([staticSurface("a")], {
        sleep: (ms) => {
          waits.push(ms);
          return Promise.resolve();
        },
      });
    } finally {
      restore();
    }
    assert.equal(waits.length, SAMPLE_COUNT - 1);
    for (const ms of waits) {
      assert.ok(ms > 0, "samples taken back to back cannot see intermittency");
      assert.equal(ms, SAMPLE_INTERVAL_MS);
    }
  });

  // The other side of that trade is billing: a job bills as a whole minute,
  // and the spread is added on top of a run whose 95th percentile was already
  // 29 seconds when this was measured. Widening it is a cost decision.
  test("the sample plan fits the measured billing budget", () => {
    assert.ok(SAMPLE_COUNT >= 3, "fewer than three samples cannot disagree");
    assert.ok(
      (SAMPLE_COUNT - 1) * SAMPLE_INTERVAL_MS <= MAX_SAMPLE_SPREAD_MS,
      `the sample plan spreads over ${String(((SAMPLE_COUNT - 1) * SAMPLE_INTERVAL_MS) / 1000)}s, ` +
        "which pushes the run past the one-minute billing boundary",
    );
  });

  test("a zero sample count still probes", async () => {
    // `??` does not fall back on `0`, so this once produced a green fleet
    // with no request made at all.
    const restore = stubFetch();
    let result;
    try {
      result = await checkLiveness([staticSurface("a")], {
        sampleCount: 0,
        sleep: () => Promise.resolve(),
      });
    } finally {
      restore();
    }
    assert.ok(result.results[0].samples > 0, "a probe stage must probe");
    assert.equal(result.results[0].state, "up");
  });

  test("two surfaces sharing an id do not merge into one verdict", async () => {
    const restore = stubFetch();
    let result;
    try {
      result = await checkLiveness(
        [staticSurface("dupe"), staticSurface("dupe")],
        { sleep: () => Promise.resolve() },
      );
    } finally {
      restore();
    }
    assert.equal(result.results.length, 2);
    for (const r of result.results) {
      assert.equal(
        r.samples,
        SAMPLE_COUNT,
        "samples from both surfaces landed in one bucket, so each was " +
          "summarized from the other's results as well as its own",
      );
    }
  });
});

describe("evaluateService", () => {
  const service = (over) => ({
    project: "production",
    service: "marfa-server",
    errors: 0,
    authorizeRefusals: 0,
    boots: 0,
    shutdowns: 0,
    uncleanRestarts: 0,
    // The measurement in `posthog.mjs` says the shutdown line is currently
    // lost far more often than it lands, so the default here is the state
    // these thresholds are meant to be judged in: pairing is worth reading.
    pairingObservable: true,
    deliveryRate: 1,
    total: 100,
    ...over,
  });

  test("stays silent on a quiet, healthy service", () => {
    assert.deepEqual(evaluateService(service()), []);
  });

  // The fault this counter exists for took hosted sign-in down for days while
  // every other rule here stayed green: the refusals logged at `warn`, so the
  // error count never moved, and the HTTP probes kept getting 200 because an
  // SPA shell renders perfectly well when sign-in is broken.
  test("reports refused authorizations as red", () => {
    const findings = evaluateService(
      service({ authorizeRefusals: AUTHORIZE_REFUSAL_THRESHOLD }),
    );
    assert.equal(findings.length, 1);
    assert.equal(findings[0].area, "authorize-refusals");
    assert.equal(findings[0].severity, "red");
  });

  test("stays quiet on a handful of refusals below the threshold", () => {
    // A misconfigured third-party client refusing a few times is not an
    // outage, and a counter that fires on it gets muted.
    assert.deepEqual(
      evaluateService(
        service({ authorizeRefusals: AUTHORIZE_REFUSAL_THRESHOLD - 1 }),
      ),
      [],
    );
  });

  test("refusals are judged separately from the error count", () => {
    // Deliberately NOT folded together: a client asking for a scope the
    // server will not grant is not a server error, and putting it in the same
    // counter as a crash corrupts the meaning of both.
    const findings = evaluateService(
      service({ authorizeRefusals: AUTHORIZE_REFUSAL_THRESHOLD, errors: 0 }),
    );
    assert.deepEqual(
      findings.map((f) => f.area),
      ["authorize-refusals"],
    );
  });

  // A hosted container under intermittent traffic sleeps and wakes, logging a
  // startup and a matching shutdown each time. The one measurement behind
  // every threshold in this file lives in `MEASURED_SCALE_TO_ZERO`; these
  // cases read from it rather than restating a number, because two hand-copied
  // "measured from production" figures is how this file previously came to
  // carry two that disagreed by fifty times.
  test("does not call matched startup/shutdown pairs a crash loop", () => {
    const measured = MEASURED_SCALE_TO_ZERO.peakStartupsPerWindow;
    assert.deepEqual(
      evaluateService(
        service({ boots: measured, shutdowns: measured, uncleanRestarts: 0 }),
      ),
      [],
    );
  });

  // The regression this rule was rewritten for. Ten startups with ten matching
  // clean shutdowns is textbook scale-to-zero by this file's own definition,
  // and it was reported red because the absolute threshold sat at ten and ran
  // as an `if` before the pairing comparison could be consulted. The pairing
  // signal was the whole point of the change that introduced it.
  test("paired cycling well above the measured peak is still not a crash loop", () => {
    assert.deepEqual(
      evaluateService(
        service({ boots: 10, shutdowns: 10, uncleanRestarts: 0 }),
      ),
      [],
    );
    assert.deepEqual(
      evaluateService(
        service({ boots: 20, shutdowns: 20, uncleanRestarts: 0 }),
      ),
      [],
    );
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

  // The premise the unpaired count rests on, checked rather than assumed. A
  // service whose clean stops are almost never recorded produces unpaired
  // startups continuously while behaving perfectly — measured at 6 recorded
  // stops against 217 startups in staging, which reaches this threshold twice
  // a week on infrastructure that was serving fine. No threshold value
  // separates that from the real thing: set it above the noise and it sits
  // above the incident, which is one or two unpaired startups per window.
  test("holds the unpaired verdict when clean stops are not being recorded", () => {
    assert.deepEqual(
      evaluateService(
        service({
          boots: 4,
          shutdowns: 0,
          uncleanRestarts: 4,
          pairingObservable: false,
          deliveryRate: 0.03,
        }),
      ),
      [],
    );
  });

  test("tolerates one unmatched event at a window edge", () => {
    // A shutdown can fall just outside a window whose startup falls inside.
    assert.deepEqual(
      evaluateService(service({ boots: 3, shutdowns: 2, uncleanRestarts: 1 })),
      [],
    );
  });

  // The absolute rule survives the rewrite, but its job narrowed: it now
  // fires only where the rate itself is pathological, matched or not. Ninety
  // startups in fifteen minutes is one every ten seconds; nothing healthy
  // does that, so the pairing is irrelevant here in a way it was not at ten.
  test("catches a fast catastrophic loop regardless of pairing", () => {
    const findings = evaluateService(
      service({ boots: 90, shutdowns: 90, uncleanRestarts: 0 }),
    );
    assert.equal(findings.length, 1);
    assert.match(findings[0].title, /Restart loop/);
  });

  test("the absolute threshold clears the busiest window ever measured", () => {
    // Anything at or below the measured peak must be silent when paired,
    // whatever the constant is set to.
    assert.deepEqual(
      evaluateService(
        service({
          boots: MEASURED_SCALE_TO_ZERO.peakStartupsPerWindow,
          shutdowns: 0,
          uncleanRestarts: MEASURED_SCALE_TO_ZERO.peakUnpairedPerWindow,
          pairingObservable: false,
        }),
      ),
      [],
    );
  });

  test("reports an error-rate spike independently of restarts", () => {
    const findings = evaluateService(service({ errors: 28 }));
    assert.equal(findings.length, 1);
    assert.equal(findings[0].area, "error-rate");
  });
});

describe("servicesFromRows", () => {
  // The subtraction that defines an unpaired restart happens here, not in
  // `evaluateService`, which is only ever handed a value someone else derived.
  // Nothing used to check that the field came from the other two at all, so
  // hardcoding it to zero deleted the entire slow-crash-loop capability with
  // every test still green.
  const row = (over = {}) => {
    const base = {
      service: "marfa-server",
      errors: 0,
      authorizeRefusals: 0,
      boots: 5,
      shutdowns: 1,
      total: 100,
      baselineBoots: 100,
      baselineShutdowns: 90,
      ...over,
    };
    // Positional, and it has to match `buildTelemetryQuery`'s SELECT order
    // exactly. A column inserted in the query without being inserted here
    // does not fail loudly — every later field simply reads the one before
    // it, so the assertions keep passing against the wrong numbers.
    return [
      base.service,
      base.errors,
      base.authorizeRefusals,
      base.boots,
      base.shutdowns,
      base.total,
      base.baselineBoots,
      base.baselineShutdowns,
    ];
  };

  test("derives unpaired restarts from startups minus clean stops", () => {
    const [s] = servicesFromRows(
      [row({ boots: 5, shutdowns: 1 })],
      "production",
    );
    assert.equal(s.uncleanRestarts, 4);
  });

  test("never reports a negative excess", () => {
    // A shutdown whose startup fell before the window is not a negative
    // restart; it is an edge effect.
    const [s] = servicesFromRows(
      [row({ boots: 1, shutdowns: 4 })],
      "production",
    );
    assert.equal(s.uncleanRestarts, 0);
  });

  test("marks a service whose clean stops go unrecorded as unobservable", () => {
    const [staging] = servicesFromRows(
      [row({ baselineBoots: 217, baselineShutdowns: 6 })],
      "staging",
    );
    assert.equal(staging.pairingObservable, false);
    assert.deepEqual(unobservablePairing([staging]).length, 1);

    const [healthy] = servicesFromRows(
      [row({ baselineBoots: 100, baselineShutdowns: 95 })],
      "production",
    );
    assert.equal(healthy.pairingObservable, true);
    assert.deepEqual(unobservablePairing([healthy]), []);
  });

  test("a service with no startups at all is still judged", () => {
    // Nothing to pair against is not the same as stops going unrecorded.
    const [s] = servicesFromRows(
      [row({ baselineBoots: 0, baselineShutdowns: 0 })],
      "production",
    );
    assert.equal(s.pairingObservable, true);
  });

  test("the delivery baseline is wider than the alerting window", () => {
    // Judging the premise from the same rows as the symptom would let a crash
    // loop suppress its own detection: the window it is crashing in is also
    // the window with no clean stops in it.
    const query = buildTelemetryQuery();
    assert.match(query, /INTERVAL 24 HOUR/);
    assert.match(query, /INTERVAL 15 MINUTE/);
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

/**
 * Intervals between every heartbeat already recorded, in minutes, exactly as
 * the history reader sees them — the scheduled runs plus the pull-request and
 * dispatch beats from the day this was first wired, none of which carry the
 * trigger marker because the marker is newer than they are.
 *
 * Measured 2026-07-29 from `marfa_watchdog_heartbeat` events in the
 * production telemetry project, at minute resolution. The nine intervals
 * under half an hour are those bursts.
 */
const MEASURED_HEARTBEAT_GAPS_INCLUDING_UNMARKED = [
  0, 1, 1, 1, 2, 5, 13, 21, 25, 57, 58, 58, 61, 61, 62, 63, 64, 64, 64, 65, 65,
  66, 66, 66, 68, 68, 69, 69, 75, 79, 79, 84, 84, 84, 85, 86, 98, 99, 100, 107,
  109, 120, 139, 165, 171, 187, 195, 200, 221, 225, 227,
];

describe("reading a history recorded before the trigger marker existed", () => {
  // The marker is written by the same change that reads it, so every row that
  // exists carries NULL — and `NULL = 'schedule'` is NULL, not false. A bare
  // equality therefore returns nothing on the first run after merge, and both
  // watchdog mechanisms need history before either can speak: five intervals
  // for the gap baseline, four verdicts for the oscillation check. At the
  // interval this schedule delivers that is most of a working day reporting
  // nothing, described in the summary as a first-ever run.
  test("the query does not discard rows recorded before the marker", () => {
    const query = buildHistoryQuery();
    assert.match(
      query,
      /properties\.trigger IS NULL/,
      "a history query that only matches the marker returns zero rows until " +
        "enough marked heartbeats exist, which is a self-inflicted blackout",
    );
    assert.match(query, /properties\.trigger = 'schedule'/);
  });

  // What admitting them costs, measured rather than assumed. The bursts drag
  // the median down, so the derived tolerance shrinks; the question is whether
  // it shrinks past an interval the scheduler genuinely produces, because that
  // is the always-firing warning this whole change removed.
  test("the looser baseline still clears every interval the scheduler delivered", () => {
    const withUnmarked = heartbeatGapTolerance(
      MEASURED_HEARTBEAT_GAPS_INCLUDING_UNMARKED,
    );
    const widest = Math.max(...MEASURED_SCHEDULE_GAPS);
    assert.ok(
      withUnmarked.toleranceMinutes > widest,
      `admitting unmarked heartbeats drops the tolerance to ` +
        `${String(withUnmarked.toleranceMinutes)} min, under the ${String(widest)} min the ` +
        "scheduler has actually delivered, so the gap warning would fire on " +
        "ordinary scheduling",
    );
  });

  test("no gap is reported for a normal interval on the mixed history", () => {
    const history = historyFrom(MEASURED_HEARTBEAT_GAPS_INCLUDING_UNMARKED);
    for (const gap of MEASURED_SCHEDULE_GAPS) {
      const now = new Date(history.beats[0].at.getTime() + gap * 60_000);
      assert.deepEqual(
        checkHeartbeatGap({ history, now }).findings,
        [],
        `a ${String(gap)}-minute interval must stay quiet even with the unmarked ` +
          "bursts in the baseline",
      );
    }
  });

  test("the median is what keeps the cost small", () => {
    // Nine near-zero intervals in fifty-one would move a mean enormously. The
    // choice of median is the reason admitting them is affordable at all.
    const scheduledOnly = heartbeatGapTolerance(MEASURED_SCHEDULE_GAPS);
    const mixed = heartbeatGapTolerance(
      MEASURED_HEARTBEAT_GAPS_INCLUDING_UNMARKED,
    );
    assert.ok(
      mixed.toleranceMinutes > scheduledOnly.toleranceMinutes * 0.75,
      `the bursts cost ${String(scheduledOnly.toleranceMinutes - mixed.toleranceMinutes)} ` +
        "minutes of tolerance, which is more headroom than this trade is worth",
    );
  });
});

describe("a history whose verdicts cannot be read", () => {
  // `readVerdict` deliberately drops anything that is not a boolean or one of
  // two exact strings, so a serialization change upstream lands here rather
  // than manufacturing flips. That makes "every row dropped" a reachable
  // state, and it must not share its reporting with a steady fleet: a
  // populated gap baseline sitting beside `0 flip(s) across 0 recent run(s)`
  // is a silently dead detector, with a zero that also appears when all is
  // well as the only tell.
  const unreadable = historyFrom(
    Array.from({ length: 6 }, () => MEASURED_MEDIAN_GAP),
    [1, 0, 1, 0, 1, 0, 1],
  );

  test("is reported as unknown rather than as no flips", () => {
    const result = checkFleetOscillation({ history: unreadable });
    assert.equal(result.unknown, true);
    assert.deepEqual(result.findings, []);
  });

  test("the summary says so instead of showing a steady count", () => {
    const heartbeat = checkHeartbeatGap({
      history: unreadable,
      now: new Date(unreadable.beats[0].at.getTime() + 60_000),
    });
    const line = describeHistory(
      heartbeat,
      checkFleetOscillation({ history: unreadable }),
    );
    assert.match(line, /UNKNOWN/);
    assert.doesNotMatch(
      line,
      /0 flip\(s\) across 0 recent run\(s\)/,
      "the wording for a dead detector must not be the wording for a calm fleet",
    );
  });

  test("a readable history still reports its counts", () => {
    const readable = alternating(8, MEASURED_MEDIAN_GAP);
    const oscillation = checkFleetOscillation({ history: readable });
    assert.notEqual(oscillation.unknown, true);
    assert.ok(oscillation.flips >= 3);
  });
});

describe("what the run records and what it says", () => {
  const finding = (severity, area) => ({
    severity,
    area,
    title: `${area} title`,
    detail: "detail",
  });
  const inputs = (over = {}) => ({
    liveness: { findings: [] },
    drift: { findings: [] },
    telemetry: { findings: [] },
    heartbeat: { findings: [] },
    oscillation: { findings: [] },
    projectMatch: { findings: [], note: "confirmed" },
    ...over,
  });

  // The most reasoned-about decision in this directory and the least guarded.
  // The oscillation finding is derived from the `healthy` values on previous
  // heartbeats, so recording it would feed the detector's own output back into
  // the sequence it reads next time and manufacture the transitions it counts.
  test("the recorded verdict answers 'was the fleet healthy', not 'did the watcher have a problem'", () => {
    const watchdogOnly = splitFindings(
      inputs({
        oscillation: { findings: [finding("red", "flapping")] },
        heartbeat: { findings: [finding("warn", "watchdog")] },
        projectMatch: {
          findings: [finding("red", "watchdog")],
          note: "MISMATCH",
        },
      }),
    );
    assert.equal(
      watchdogOnly.fleetHealthy,
      true,
      "a watcher finding recorded as an unhealthy fleet re-arms the feedback " +
        "loop the split exists to break",
    );
    assert.equal(watchdogOnly.red.length, 2, "but it must still alert");
  });

  test("a genuine fleet failure is recorded as one", () => {
    const broken = splitFindings(
      inputs({ liveness: { findings: [finding("red", "liveness")] } }),
    );
    assert.equal(broken.fleetHealthy, false);
    assert.equal(broken.red.length, 1);
  });

  // Both watchdog checks fail closed, so the run has to state what the history
  // was on every run — including the runs where it was nothing. Deleting the
  // line is the whole answer to that, and nothing used to notice.
  test("every run states what the watchdog could see", () => {
    const lines = visibilityLines({
      alert: { action: "none", url: null },
      heartbeat: { configured: false, findings: [] },
      oscillation: { findings: [] },
      projectMatch: { note: "confirmed (project 1234)" },
      beat: { emitted: true },
    });
    const text = lines.join("\n");
    assert.match(text, /Watchdog history:/);
    assert.match(text, /Watchdog project:/);
    assert.match(text, /Heartbeat:/);
    assert.match(text, /Alert issue:/);
  });

  test("the visibility lines render as a list, not a paragraph", () => {
    // Four consecutive non-blank lines are one paragraph in markdown, so the
    // place the fail-closed trade is meant to be legible read as a run-on
    // sentence at the bottom of the summary.
    const lines = visibilityLines({
      alert: { action: "none", url: null },
      heartbeat: { configured: false, findings: [] },
      oscillation: { findings: [] },
      projectMatch: { note: "confirmed" },
      beat: { emitted: true },
    });
    for (const line of lines) assert.match(line, /^- /);
  });

  test("an unjudged restart-pairing check is stated rather than hidden", () => {
    const lines = visibilityLines({
      alert: { action: "none", url: null },
      heartbeat: { configured: false, findings: [] },
      oscillation: { findings: [] },
      projectMatch: { note: "confirmed" },
      beat: { emitted: true },
      unobservablePairing: ["marfa-server (staging) — 3% of startups"],
    });
    assert.match(lines.join("\n"), /Restart pairing:/);
  });

  test("the marker changeover is stated rather than read as silence", () => {
    const lines = visibilityLines({
      alert: { action: "none", url: null },
      heartbeat: {
        configured: true,
        firstRun: true,
        unmarked: 12,
        findings: [],
      },
      oscillation: { findings: [] },
      projectMatch: { note: "confirmed" },
      beat: { emitted: true },
    });
    assert.match(lines.join("\n"), /predate the trigger marker/);
  });
});

// ---------------------------------------------------------------------------
// The deploy gate
//
// `wrangler deploy` returning zero says the Worker rolled. It says nothing
// about the container behind it, which has its own replacement rules — so the
// pipeline used to end while the previous build was still answering, and
// nothing measured the gap.
// ---------------------------------------------------------------------------

/** A fetch stand-in answering with each health payload in turn. */
function healthSequence(payloads) {
  let i = 0;
  return () => {
    const payload = payloads[Math.min(i, payloads.length - 1)];
    i += 1;
    if (typeof payload === "number") {
      return Promise.resolve({
        ok: false,
        status: payload,
        text: () => Promise.resolve("Error proxying request to container"),
      });
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      text: () => Promise.resolve(JSON.stringify(payload)),
    });
  };
}

/** A clock that advances by the interval every time the gate sleeps. */
function fakeClock(intervalMs) {
  let now = 0;
  return {
    now: () => now,
    sleep: (ms) => {
      now += ms ?? intervalMs;
      return Promise.resolve();
    },
  };
}

describe("waitForDeployedBuild", () => {
  test("returns as soon as the deployed build answers, and reports the window", async () => {
    const clock = fakeClock(5_000);
    const result = await waitForDeployedBuild(
      "https://example.test/health",
      "abc1234",
      {
        fetch: healthSequence([
          { status: "ok", version: { sha: "old0000" } },
          { status: "ok", version: { sha: "old0000" } },
          { status: "ok", version: { sha: "abc1234" } },
        ]),
        ...clock,
      },
    );

    assert.equal(result.ok, true);
    assert.equal(result.attempts, 3);
    // Two sleeps at 5s. The number is the point: it is what the pipeline
    // prints, so the roll window is measured on every deploy rather than once.
    assert.equal(result.rollWindowMs, 10_000);
  });

  test("fails with the build it kept seeing when the roll never happens", async () => {
    // The stranded-container case. Silence here would read as success, which
    // is exactly how the previous build kept serving unnoticed.
    const clock = fakeClock(5_000);
    const result = await waitForDeployedBuild(
      "https://example.test/health",
      "abc1234",
      {
        fetch: healthSequence([{ status: "ok", version: { sha: "old0000" } }]),
        budgetMs: 20_000,
        ...clock,
      },
    );

    assert.equal(result.ok, false);
    assert.equal(result.lastSeen, "old0000");
  });

  test("names the failure when nothing is behind the edge", async () => {
    const clock = fakeClock(5_000);
    const result = await waitForDeployedBuild(
      "https://example.test/health",
      "abc1234",
      { fetch: healthSequence([503]), budgetMs: 10_000, ...clock },
    );

    assert.equal(result.ok, false);
    assert.equal(result.lastFailure.kind, "instance-not-running");
  });

  test("survives a request that throws rather than answering", async () => {
    const clock = fakeClock(5_000);
    const result = await waitForDeployedBuild(
      "https://example.test/health",
      "abc1234",
      {
        fetch: () => Promise.reject(new Error("ECONNRESET")),
        budgetMs: 10_000,
        ...clock,
      },
    );

    assert.equal(result.ok, false);
    assert.equal(result.lastFailure.kind, "unreachable");
  });

  test("reports a build that is serving but degraded rather than hiding it", async () => {
    // A 200 with a downed database is still an outage. The gate passes,
    // because the deploy did land, and says so.
    const clock = fakeClock(5_000);
    const result = await waitForDeployedBuild(
      "https://example.test/health",
      "abc1234",
      {
        fetch: healthSequence([
          {
            status: "degraded",
            version: { sha: "abc1234" },
            components: { database: { status: "down", error: "no route" } },
          },
        ]),
        ...clock,
      },
    );

    assert.equal(result.ok, true);
    assert.ok(result.degraded.some((line) => line.includes("database")));
  });
});

describe("healthUrlFor", () => {
  test("resolves each deployed environment to the surface the watchdog probes", () => {
    // Shared with the watchdog on purpose: a gate that checked a different URL
    // than the alarm would pass a deploy the alarm then screams about.
    assert.equal(healthUrlFor("staging"), "https://staging.marfa.so/health");
    assert.equal(healthUrlFor("prod"), "https://api.marfa.so/health");
  });

  test("refuses an environment nothing declares", () => {
    assert.throws(() => healthUrlFor("nowhere"), /no server surface/);
  });
});
