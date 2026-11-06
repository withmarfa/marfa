import { describe, expect, it } from "vitest";
import {
  CEILINGS,
  KNOWN_OVER,
  MIN_PROBE_READINGS,
  PROBE_REFERENCE_MS,
  NOT_JUDGED_MARGIN,
  SLOW_RUNNER_FACTOR,
  distribution,
  fragmentOf,
  scalar,
} from "./figures.js";
import {
  EXPECTED_STEPS,
  mergeFragments,
  parseFiguresFile,
  parseFragment,
  renderSummary,
  verdictOf,
  type FiguresFile,
} from "./report.js";

const run = {
  commit: "abc1234",
  runId: "42",
  date: "2026-11-03T04:43:00.000Z",
  profile: "scale-250k",
};

/** Fragments from every expected step, all within their ceilings. */
function healthyFragments() {
  return EXPECTED_STEPS.map((step) =>
    step === "seed"
      ? fragmentOf("seed", [scalar("seed_errors", "count", 0)], {
          items: 250_000,
        })
      : step === "restart"
        ? fragmentOf("restart", [scalar("rss_at_rest", "MB", 200)])
        : fragmentOf(step, []),
  );
}

describe("merging fragments", () => {
  it("joins every figure under the run's identity and takes the size from the seed", () => {
    const file = mergeFragments(healthyFragments(), run);
    expect(file).toMatchObject({ ...run, items: 250_000, missingSteps: [] });
    expect(file.figures.map((f) => f.name)).toEqual([
      "seed_errors",
      "rss_at_rest",
    ]);
  });

  it("names a step that left no fragment, since it crashed or timed out", () => {
    const fragments = healthyFragments().filter((f) => f.step !== "bulk");
    const file = mergeFragments(fragments, run);
    expect(file.missingSteps).toEqual(["bulk"]);
    expect(verdictOf(file)).toMatchObject({ passed: false });
  });

  it("keeps every figure recorded before a later step crashed", () => {
    const file = mergeFragments(
      [fragmentOf("seed", [scalar("seed_errors", "count", 0)], { items: 10 })],
      run,
    );
    expect(file.figures).toHaveLength(1);
    expect(file.missingSteps).toEqual(
      EXPECTED_STEPS.filter((step) => step !== "seed"),
    );
  });

  it("keeps the figures a crashed step recorded before it died, and still names the step", () => {
    const fragments = healthyFragments().filter((f) => f.step !== "bulk");
    const partial = fragmentOf("bulk", [scalar("rss_peak", "MB", 120)]);
    const file = mergeFragments(fragments, run, EXPECTED_STEPS, [partial]);
    expect(file.figures.map((f) => f.name)).toContain("rss_peak");
    expect(file.missingSteps).toEqual(["bulk"]);
    expect(verdictOf(file).passed).toBe(false);
  });

  it("does not count a partial record of a step that also finished", () => {
    const partial = fragmentOf("seed", [scalar("rss_peak", "MB", 1)]);
    const file = mergeFragments(healthyFragments(), run, EXPECTED_STEPS, [
      partial,
    ]);
    expect(file.figures.map((f) => f.name)).not.toContain("rss_peak");
    expect(file.missingSteps).toEqual([]);
  });

  it("reports a name two steps both wrote instead of keeping one quietly", () => {
    const file = mergeFragments(
      [
        fragmentOf("seed", [scalar("rss_at_rest", "MB", 1)]),
        fragmentOf("restart", [scalar("rss_at_rest", "MB", 2)]),
      ],
      run,
    );
    expect(file.problems.join("\n")).toMatch(/rss_at_rest.*seed.*restart/);
    expect(verdictOf(file).passed).toBe(false);
  });

  it("has no size when the seed step left none", () => {
    expect(mergeFragments([], run).items).toBeNull();
  });
});

describe("the verdict", () => {
  it("passes when every figure is within its ceiling and every step reported", () => {
    expect(verdictOf(mergeFragments(healthyFragments(), run))).toEqual({
      passed: true,
      failedFigures: [],
      notJudged: [],
      slowRunner: [],
      missingSteps: [],
      problems: [],
    });
  });

  it("fails on one figure over its ceiling and names it", () => {
    const fragments = healthyFragments();
    fragments[1] = fragmentOf("restart", [scalar("rss_at_rest", "MB", 400)]);
    const verdict = verdictOf(mergeFragments(fragments, run));
    expect(verdict.passed).toBe(false);
    expect(verdict.failedFigures).toEqual(["rss_at_rest"]);
  });

  it("excuses a listed figure that is over, and names the issue in the summary", () => {
    const fragments = healthyFragments();
    fragments[1] = fragmentOf("restart", [scalar("rss_at_rest", "MB", 400)]);
    const file = mergeFragments(fragments, run);
    const known = { rss_at_rest: 2609 };
    expect(verdictOf(file, known).passed).toBe(true);
    expect(renderSummary(file, null, known)).toContain("over, #2609 open");
    // The witness: without the entry the same figure fails.
    expect(verdictOf(file, {}).passed).toBe(false);
  });

  it("fails a listed figure that answered errors", () => {
    const fragments = healthyFragments();
    fragments[1] = fragmentOf("restart", [
      distribution("get_item", "ms", [900, 900, 900], { errors: 2 }),
    ]);
    const file = mergeFragments(fragments, run);
    expect(verdictOf(file, { get_item: 1 }).failedFigures).toEqual([
      "get_item",
    ]);
  });

  it("excuses only figures that have a ceiling", () => {
    for (const name of Object.keys(KNOWN_OVER)) {
      expect(CEILINGS[name]?.ceiling ?? null, name).not.toBeNull();
    }
  });

  it("fails a quiet watch over its ceiling, now that no issue excuses it", () => {
    const fragments = healthyFragments();
    fragments[1] = fragmentOf("restart", [
      scalar("folder_watch_cpu", "cpu_s_per_min", 1.01),
    ]);
    const file = mergeFragments(fragments, run);
    expect(KNOWN_OVER).not.toHaveProperty("folder_watch_cpu");
    expect(verdictOf(file).failedFigures).toEqual(["folder_watch_cpu"]);
  });

  it("does not excuse a search that answered an error, even on a listed figure", () => {
    const fragments = healthyFragments();
    fragments[1] = fragmentOf("restart", [
      distribution(
        "search_common",
        "ms",
        Array.from({ length: 29 }, () => 100),
        { errors: 1 },
      ),
    ]);
    expect(verdictOf(mergeFragments(fragments, run)).failedFigures).toEqual([
      "search_common",
    ]);
  });

  it("names the device, folder and watch steps when they leave no figures", () => {
    expect(EXPECTED_STEPS).toEqual(
      expect.arrayContaining(["device", "folder", "watch"]),
    );
    const fragments = healthyFragments().filter((f) => f.step !== "watch");
    expect(mergeFragments(fragments, run).missingSteps).toEqual(["watch"]);
  });

  it("does not fail on a figure that has no ceiling", () => {
    const fragments = healthyFragments();
    fragments[1] = fragmentOf("restart", [scalar("seed_rate", "per_s", 1)]);
    expect(verdictOf(mergeFragments(fragments, run)).passed).toBe(true);
  });
});

/** A night's readings of the probes, this many times their references. */
function probesAt(cpuTimes: number, diskTimes = 1, readings = 5) {
  const of = (name: keyof typeof PROBE_REFERENCE_MS, times: number) =>
    distribution(
      name,
      "ms",
      Array.from({ length: readings }, () => PROBE_REFERENCE_MS[name] * times),
    );
  return [of("runner_cpu_probe", cpuTimes), of("runner_disk_probe", diskTimes)];
}

const overTime = () => scalar("server_restart", "ms", 3_000);

describe("the verdict on a slow runner", () => {
  const verdictWith = (...figures: ReturnType<typeof scalar>[]) =>
    verdictOf(fileWith(figures), {});

  it("fails a figure over a time ceiling on a normal runner", () => {
    const verdict = verdictWith(...probesAt(1), overTime());
    expect(verdict.failedFigures).toEqual(["server_restart"]);
    expect(verdict.notJudged).toEqual([]);
    expect(verdict.passed).toBe(false);
  });

  it("does not judge the same figure on a slow runner", () => {
    const verdict = verdictWith(...probesAt(2), overTime());
    expect(verdict.failedFigures).toEqual([]);
    expect(verdict.notJudged).toEqual(["server_restart"]);
    expect(verdict.passed).toBe(true);
  });

  it("takes a slow disk alone for a slow runner", () => {
    const verdict = verdictWith(...probesAt(1, 2), overTime());
    expect(verdict.notJudged).toEqual(["server_restart"]);
    expect(verdict.slowRunner.join()).toMatch(/disk/);
  });

  it.each([
    ["a time in seconds", scalar("archive_export", "s", 999)],
    ["a distribution's p95", distribution("get_item", "ms", steady(70))],
    ["a quiet watch's CPU", scalar("folder_watch_cpu", "cpu_s_per_min", 2)],
  ])("does not judge %s over its ceiling", (_label, figure) => {
    expect(verdictWith(...probesAt(2), figure).notJudged).toEqual([
      figure.name,
    ]);
  });

  it.each([
    ["a memory figure", scalar("rss_at_rest", "MB", 400)],
    ["a ratio", scalar("bulk_page_ratio", "ratio", 3)],
    ["seed errors", scalar("seed_errors", "count", 3_000)],
    [
      "a time figure with errors",
      distribution("get_item", "ms", steady(70), { errors: 1 }),
    ],
    [
      "a time figure with errors, within its ceiling",
      distribution("get_item", "ms", steady(10), { errors: 1 }),
    ],
    ["a time figure with no samples", distribution("get_item", "ms", [])],
    [
      "a time figure with too few samples",
      distribution("get_item", "ms", [70, 70, 70]),
    ],
    ["a time figure with no value", scalar("server_restart", "ms", Number.NaN)],
  ])("still fails %s", (_label, figure) => {
    const verdict = verdictWith(...probesAt(2), figure);
    expect(verdict.failedFigures).toEqual([figure.name]);
    expect(verdict.passed).toBe(false);
  });

  it("still fails a time figure with no value once the file has been written and read", () => {
    const written = fileWith([
      ...probesAt(2),
      scalar("server_restart", "ms", Number.NaN),
    ]);
    const read = JSON.parse(JSON.stringify(written)) as FiguresFile;
    expect(verdictOf(read, {}).failedFigures).toEqual(["server_restart"]);
  });

  it("still names a step that left no figures", () => {
    const file = fileWith([...probesAt(2), overTime()], {
      missingSteps: ["bulk"],
    });
    expect(verdictOf(file, {}).passed).toBe(false);
  });

  it("judges as normal when the probe left no figures, excusing nothing", () => {
    const verdict = verdictWith(overTime());
    expect(verdict.slowRunner).toEqual([]);
    expect(verdict.failedFigures).toEqual(["server_restart"]);
    expect(verdict.notJudged).toEqual([]);
  });

  it("judges as normal on fewer readings than the probe needs", () => {
    const few = probesAt(2, 2, MIN_PROBE_READINGS - 1);
    expect(verdictWith(...few, overTime()).failedFigures).toEqual([
      "server_restart",
    ]);
    // The witness: one more reading makes it a slow runner.
    const enough = probesAt(2, 2, MIN_PROBE_READINGS);
    expect(verdictWith(...enough, overTime()).notJudged).toEqual([
      "server_restart",
    ]);
  });

  it("does not take a slow disk as the reason for a quiet watch's CPU", () => {
    const cpu = scalar("folder_watch_cpu", "cpu_s_per_min", 2);
    expect(verdictWith(...probesAt(1, 2), cpu).failedFigures).toEqual([
      "folder_watch_cpu",
    ]);
    // The witness: a slow CPU does explain it.
    expect(verdictWith(...probesAt(2, 1), cpu).notJudged).toEqual([
      "folder_watch_cpu",
    ]);
  });

  it("fails a figure further over its ceiling than the runner's slowness explains", () => {
    const limit = 2_000 * 2 * NOT_JUDGED_MARGIN;
    const past = scalar("server_restart", "ms", limit + 1);
    expect(verdictWith(...probesAt(2), past).failedFigures).toEqual([
      "server_restart",
    ]);
    // The witness: at the bound it is put down to the runner.
    const at = scalar("server_restart", "ms", limit);
    expect(verdictWith(...probesAt(2), at).notJudged).toEqual([
      "server_restart",
    ]);
  });

  it("calls a median that exactly meets the factor normal, and one just over it slow", () => {
    const at = verdictWith(...probesAt(SLOW_RUNNER_FACTOR), overTime());
    expect(at.slowRunner).toEqual([]);
    expect(at.failedFigures).toEqual(["server_restart"]);
    const over = verdictWith(
      ...probesAt(SLOW_RUNNER_FACTOR + 0.01),
      overTime(),
    );
    expect(over.notJudged).toEqual(["server_restart"]);
  });

  it("judges by the median, so noise on a minority of readings excuses nothing", () => {
    const reference = PROBE_REFERENCE_MS.runner_cpu_probe;
    const noisy = distribution("runner_cpu_probe", "ms", [
      reference,
      reference,
      reference,
      reference * 9,
      reference * 9,
    ]);
    expect(verdictWith(noisy, overTime()).failedFigures).toEqual([
      "server_restart",
    ]);
  });

  it("keeps the issue of a listed figure ahead of the slow runner", () => {
    const file = fileWith([...probesAt(2), overTime()]);
    const known = { server_restart: 2609 };
    expect(verdictOf(file, known).notJudged).toEqual([]);
    expect(renderSummary(file, null, known)).toContain("over, #2609 open");
  });

  it("says plainly in the summary which figures were not judged and why", () => {
    const text = renderSummary(
      fileWith([
        ...probesAt(2),
        overTime(),
        distribution("get_item", "ms", steady(10)),
      ]),
      null,
      {},
    );
    expect(text).toContain("Passed, with 1 time figure not judged.");
    expect(text).toMatch(/\*\*Slow runner:\*\*.*CPU probe.*2\.00 times/);
    expect(text).toMatch(/not judged tonight: server_restart/);
    expect(text).toMatch(
      /\| server_restart \| 3000\.0 ms \| none \| none \| 2000\.0 ms \| not judged: slow runner \|/,
    );
    expect(text).toMatch(/\| get_item \(p95\) .* pass \|/);
  });

  it("fails the summary's headline when a judged figure fails on a slow runner", () => {
    const text = renderSummary(
      fileWith([...probesAt(2), overTime(), scalar("rss_at_rest", "MB", 400)]),
      null,
      {},
    );
    expect(text).toContain("**The night failed.**");
    expect(text).toMatch(/\| rss_at_rest .* \*\*FAIL\*\* \|/);
    expect(text).toContain("not judged: slow runner");
  });

  it("says every ceiling was judged on a normal runner, and when the probe left no readings", () => {
    const normal = renderSummary(fileWith(probesAt(1)), null, {});
    expect(normal).toMatch(/Runner: normal speed, so every ceiling was judged/);
    expect(normal).not.toContain("Slow runner");
    for (const figures of [[], probesAt(2, 2, MIN_PROBE_READINGS - 1)]) {
      const text = renderSummary(fileWith(figures), null, {});
      expect(text).toMatch(
        /Runner: the probe left too few readings, so every ceiling was judged/,
      );
    }
  });
});

describe("reading a step's fragment", () => {
  const whole = fragmentOf("seed", [scalar("seed_errors", "count", 0)], {
    items: 10,
  });

  it("accepts what a step wrote", () => {
    expect(parseFragment(JSON.stringify(whole))).toEqual(whole);
  });

  it.each([
    ["a file cut off by a killed step", JSON.stringify(whole).slice(0, 25)],
    ["an empty file", ""],
    ["null", "null"],
    ["a fragment with no step", JSON.stringify({ figures: [] })],
    [
      "figures that are not a list",
      JSON.stringify({ step: "seed", figures: 3 }),
    ],
  ])("treats %s as no fragment", (_label, text) => {
    expect(parseFragment(text)).toBeNull();
  });

  it("keeps a figure whose value was not a number, so it still fails the night", () => {
    const failed = fragmentOf("restart", [
      scalar("server_restart", "ms", Number.NaN),
    ]);
    const read = parseFragment(JSON.stringify(failed));
    expect(read?.figures.map((figure) => figure.name)).toEqual([
      "server_restart",
    ]);
    expect(
      verdictOf(mergeFragments([read ?? failed], run)).failedFigures,
    ).toEqual(["server_restart"]);
  });

  it("drops an entry that is no figure at all, and keeps the rest", () => {
    const read = parseFragment(
      JSON.stringify({
        ...whole,
        figures: [null, { name: 1 }, ...whole.figures],
      }),
    );
    expect(read?.figures).toEqual(whole.figures);
  });
});

/** Twenty samples of one value: enough for a ceiling to be judged. */
const steady = (value: number) => Array.from({ length: 20 }, () => value);

function fileWith(
  figures: ReturnType<typeof scalar>[],
  overrides: Partial<FiguresFile> = {},
): FiguresFile {
  return {
    ...run,
    items: 250_000,
    figures,
    missingSteps: [],
    problems: [],
    ...overrides,
  };
}

describe("the summary", () => {
  const tonight = fileWith([
    distribution("get_item", "ms", steady(40)),
    scalar("rss_at_rest", "MB", 400),
  ]);

  it("shows each figure with last night's, the change, the ceiling and the verdict", () => {
    const previous = fileWith([
      distribution("get_item", "ms", steady(30)),
      scalar("rss_at_rest", "MB", 200),
    ]);
    const text = renderSummary(tonight, previous);
    expect(text).toContain(
      "| Figure | Tonight | Previous night | Change | Ceiling | Verdict |",
    );
    expect(text).toMatch(
      /\| get_item \(p95\) \| 40\.0 ms \| 30\.0 ms \| \+10\.0 ms \(\+33%\) \| 50\.0 ms \| pass \|/,
    );
    expect(text).toMatch(
      /\| rss_at_rest \| 400\.0 MB \| 200\.0 MB \| \+200\.0 MB \(\+100%\) \| 300\.0 MB \| \*\*FAIL\*\* \|/,
    );
  });

  it("says there is no previous night when none is given", () => {
    const text = renderSummary(tonight, null);
    expect(text).toContain("No previous night");
    expect(text).not.toContain("Previous night |  ");
    expect(text).toMatch(/\| get_item \(p95\) \| 40\.0 ms \| none \| none \|/);
  });

  it("renders when last night measured different figures, marking new ones and listing dropped ones", () => {
    const previous = fileWith([
      scalar("rss_at_rest", "MB", 200),
      scalar("search_rare", "ms", 5),
    ]);
    const text = renderSummary(tonight, previous);
    expect(text).toMatch(/\| get_item \(p95\) \| 40\.0 ms \| none \| new \|/);
    expect(text).toMatch(/not measured tonight.*search_rare/i);
  });

  it("warns when last night measured a different size, since the change then say little", () => {
    const previous = fileWith([scalar("rss_at_rest", "MB", 200)], {
      items: 5_000,
    });
    const text = renderSummary(tonight, previous);
    expect(text).toMatch(/5,000 items/);
    expect(text).toMatch(/say little/);
  });

  it("names the night it compares with by its date, commit and run", () => {
    const previous = fileWith([scalar("rss_at_rest", "MB", 200)], {
      commit: "def5678",
      runId: "41",
      date: "2026-11-02T04:43:00.000Z",
    });
    const text = renderSummary(tonight, previous);
    expect(text).toContain(
      "Compared with the night of 2026-11-02 (commit `def5678`, run 41).",
    );
    expect(text).not.toContain("say little");
  });

  it("says when that night missed steps, or ran another profile", () => {
    const previous = fileWith([scalar("rss_at_rest", "MB", 200)], {
      missingSteps: ["bulk", "export"],
      profile: "scale-5000",
    });
    const text = renderSummary(tonight, previous);
    expect(text).toMatch(/left no figures for bulk, export/);
    expect(text).toMatch(/profile scale-5000.*tonight's scale-250k/);
  });

  it("names the steps that left no figures and the problems, above the table", () => {
    const text = renderSummary(
      fileWith([], { missingSteps: ["bulk"], problems: ["odd"] }),
      null,
    );
    expect(text).toMatch(/Step `bulk` left no figures/);
    expect(text).toContain("odd");
    expect(text).toMatch(/failed/i);
  });

  it("shows the real size of the instance and the commit", () => {
    const text = renderSummary(tonight, null);
    expect(text).toContain("250,000 items");
    expect(text).toContain("abc1234");
  });

  it("handles a previous value of zero without dividing by it", () => {
    const text = renderSummary(
      fileWith([scalar("seed_errors", "count", 3)]),
      fileWith([scalar("seed_errors", "count", 0)]),
    );
    expect(text).toMatch(
      /\| seed_errors \| 3 \| 0 \| \+3 \| 0 \| \*\*FAIL\*\* \|/,
    );
    expect(text).not.toContain("Infinity");
    expect(text).not.toContain("NaN");
  });

  it("keeps a pipe in a note from breaking the table", () => {
    const figure = { ...scalar("seed_rate", "per_s", 1), note: "a|b" };
    expect(renderSummary(fileWith([figure]), null)).toContain("a\\|b");
  });
});

describe("reading last night's file", () => {
  const good = fileWith([scalar("rss_at_rest", "MB", 200)]);

  it("accepts what the run wrote", () => {
    expect(parseFiguresFile(JSON.stringify(good))).toEqual(good);
  });

  it.each([
    ["not json", "{"],
    ["null", "null"],
    ["no figures", JSON.stringify({ commit: "x" })],
    ["figures that are not a list", JSON.stringify({ ...good, figures: 3 })],
  ])("treats %s as no previous night", (_label, text) => {
    expect(parseFiguresFile(text)).toBeNull();
  });

  it("drops a figure that is not shaped like one and keeps the rest", () => {
    const text = JSON.stringify({
      ...good,
      figures: [good.figures[0], { name: 1 }, null],
    });
    expect(parseFiguresFile(text)?.figures).toEqual(good.figures);
  });
});
