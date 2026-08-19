/**
 * Tests for the deploy gate and the probe logic it stands on.
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
  inspectHealthPayload,
  summarizeSamples,
  checkLiveness,
  SAMPLE_COUNT,
  SAMPLE_INTERVAL_MS,
  MAX_SAMPLE_SPREAD_MS,
} from "./probes.mjs";
import {
  waitForDeployedBuild,
  healthUrlFor,
  checkPlacement,
} from "./deploy-gate.mjs";

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

describe("inspectHealthPayload placement", () => {
  test("reads the region and location the server reports", () => {
    const { region, location } = inspectHealthPayload(
      JSON.stringify({
        status: "ok",
        placement: { region: "WEUR", location: "mrs05", country: "FR" },
        version: { sha: "abc1234" },
      }),
    );
    assert.equal(region, "WEUR");
    assert.equal(location, "mrs05");
  });

  // A self-hosted server publishes no placement at all. Reporting null rather
  // than a blank string is what lets the gate tell "not reported" apart from
  // "reported wrong" — collapsing the two would fail every self-hosted deploy.
  test("reports null when the payload carries no placement", () => {
    const { region, location } = inspectHealthPayload(
      JSON.stringify({ status: "ok", version: { sha: "abc1234" } }),
    );
    assert.equal(region, null);
    assert.equal(location, null);
  });
});

describe("checkPlacement", () => {
  // The case this whole check exists for: production served every request
  // from Western North America while its database and bucket were in Europe,
  // for four months, with a green pipeline throughout.
  test("fails when the container is on the wrong continent", () => {
    const reason = checkPlacement("WEUR", {
      region: "WNAM",
      location: "sjc08",
    });
    assert.match(reason, /WNAM/);
    assert.match(reason, /sjc08/);
    assert.match(reason, /expected WEUR/);
  });

  test("passes when the region matches", () => {
    assert.equal(
      checkPlacement("WEUR", { region: "WEUR", location: "mrs05" }),
      null,
    );
  });

  // The constraint bounds the region, not the colo, so production moving
  // between European datacenters is the mechanism working rather than a fault.
  test("passes on a different colo inside the expected region", () => {
    assert.equal(
      checkPlacement("WEUR", { region: "WEUR", location: "mad06" }),
      null,
    );
  });

  // Silence is not a failure. A self-hosted deployment reports no placement,
  // and a gate that read that as a fault would block every one of them.
  test("passes when the server reports no region", () => {
    assert.equal(checkPlacement("WEUR", { region: null }), null);
    assert.equal(checkPlacement("WEUR", undefined), null);
  });

  // Nor is an unset expectation. A deploy path that does not declare a region
  // should not start failing because this check was added.
  test("passes when no region is expected", () => {
    assert.equal(checkPlacement(undefined, { region: "WNAM" }), null);
    assert.equal(checkPlacement("", { region: "WNAM" }), null);
  });

  // The message has to name both sides. "Container is in WNAM, expected WEUR"
  // is the sentence that would have ended the four months; a bare assertion
  // failure would not have.
  test("names both regions in the failure", () => {
    const reason = checkPlacement("WEUR", { region: "APAC" });
    assert.match(reason, /container is in APAC, expected WEUR/);
  });
});
