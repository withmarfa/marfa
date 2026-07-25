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
import { countOscillations } from "./heartbeat.mjs";

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
    // A missing or non-boolean property must not manufacture instability.
    assert.equal(countOscillations([true, null, true]), 0);
    assert.equal(countOscillations([undefined, "yes", 1]), 0);
  });

  test("handles empty and single-run histories", () => {
    assert.equal(countOscillations([]), 0);
    assert.equal(countOscillations([true]), 0);
  });
});
