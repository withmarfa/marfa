import { describe, expect, it } from "vitest";
import {
  CEILINGS,
  KNOWN_OVER,
  distribution,
  fragmentOf,
  scalar,
} from "./figures.js";
import {
  EXPECTED_STEPS,
  mergeFragments,
  parseFiguresFile,
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

  it("excuses the folder's edit time and quiet watch while their issues are open", () => {
    const fragments = healthyFragments();
    fragments[1] = fragmentOf("restart", [
      scalar("folder_watch_cpu", "cpu_s_per_min", 26),
      distribution(
        "folder_edit_to_server",
        "ms",
        Array.from({ length: 30 }, () => 7_500),
      ),
    ]);
    const file = mergeFragments(fragments, run);
    expect(verdictOf(file).passed).toBe(true);
    expect(renderSummary(file, null)).toContain("over, #2608 open");
    expect(renderSummary(file, null)).toContain("over, #2611 open");
    expect(verdictOf(file, {}).failedFigures).toEqual([
      "folder_watch_cpu",
      "folder_edit_to_server",
    ]);
  });

  it("does not excuse an edit that never arrived, even on a listed figure", () => {
    const fragments = healthyFragments();
    fragments[1] = fragmentOf("restart", [
      distribution(
        "folder_edit_to_server",
        "ms",
        Array.from({ length: 29 }, () => 100),
        { errors: 1 },
      ),
    ]);
    expect(verdictOf(mergeFragments(fragments, run)).failedFigures).toEqual([
      "folder_edit_to_server",
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
