/**
 * Merging a night's fragments into one file, comparing it with the previous
 * night's, and judging it. Pure: the steps and the final script do the I/O.
 */
import {
  explainedBySlowRunner,
  KNOWN_OVER,
  MIN_PROBE_READINGS,
  PROBE_REFERENCE_MS,
  slowRunner,
  SLOW_RUNNER_FACTOR,
  type Figure,
  type Fragment,
  type Unit,
} from "./figures.js";

/**
 * The steps a night runs, in order. A step in this list that left no
 * fragment crashed or timed out, and fails the night by name.
 */
export const EXPECTED_STEPS = [
  "seed",
  "restart",
  "reads",
  "bulk",
  "edges",
  "export",
  "storage",
  "device",
  "folder",
  "watch",
] as const;

export interface FiguresFile {
  commit: string;
  runId: string;
  date: string;
  profile: string;
  /** The instance's real size, counted by the seed step; null if it never reported. */
  items: number | null;
  figures: Figure[];
  missingSteps: string[];
  /** Faults in the recording itself, such as two steps writing one name. */
  problems: string[];
}

export interface RunIdentity {
  commit: string;
  runId: string;
  date: string;
  profile: string;
}

export function mergeFragments(
  fragments: Fragment[],
  run: RunIdentity,
  expected: readonly string[] = EXPECTED_STEPS,
  partials: Fragment[] = [],
): FiguresFile {
  const figures: Figure[] = [];
  const writtenBy = new Map<string, string>();
  const problems: string[] = [];
  let items: number | null = null;

  // What a step recorded before it crashed counts only for a step that left
  // no whole fragment, and never makes that step look finished.
  const whole = new Set(fragments.map((fragment) => fragment.step));
  const kept = [
    ...fragments,
    ...partials.filter((partial) => !whole.has(partial.step)),
  ];
  for (const fragment of kept) {
    if (fragment.items !== null) items = fragment.items;
    for (const figure of fragment.figures) {
      const earlier = writtenBy.get(figure.name);
      if (earlier !== undefined) {
        problems.push(
          `Figure ${figure.name} was written by both ${earlier} and ${fragment.step}.`,
        );
        continue;
      }
      writtenBy.set(figure.name, fragment.step);
      figures.push(figure);
    }
  }

  return {
    ...run,
    items,
    figures,
    missingSteps: expected.filter((step) => !whole.has(step)),
    problems,
  };
}

export interface Verdict {
  passed: boolean;
  failedFigures: string[];
  /** Over a time ceiling on a slow runner: shown, and failing nothing. */
  notJudged: string[];
  /** Why the runner counts as slow tonight; empty when it does not. */
  slowRunner: string[];
  missingSteps: string[];
  problems: string[];
}

/** The issue that excuses a figure's miss tonight, or null when none does. */
export function knownOverIssue(
  figure: Figure,
  known: Readonly<Record<string, number>> = KNOWN_OVER,
): number | null {
  if (figure.passed || figure.errors > 0 || figure.samples === 0) return null;
  return known[figure.name] ?? null;
}

export function verdictOf(
  file: FiguresFile,
  known: Readonly<Record<string, number>> = KNOWN_OVER,
): Verdict {
  const reasons = slowRunner(file.figures);
  const missed = file.figures.filter(
    (figure) => !figure.passed && knownOverIssue(figure, known) === null,
  );
  const isNotJudged = (figure: Figure) =>
    explainedBySlowRunner(figure, file.figures);
  const failedFigures = missed
    .filter((figure) => !isNotJudged(figure))
    .map((figure) => figure.name);
  return {
    passed:
      failedFigures.length === 0 &&
      file.missingSteps.length === 0 &&
      file.problems.length === 0,
    failedFigures,
    notJudged: missed.filter(isNotJudged).map((figure) => figure.name),
    slowRunner: reasons,
    missingSteps: file.missingSteps,
    problems: file.problems,
  };
}

/** How many things failed, for the event: figures, missing steps and faults. */
export function failedCount(file: FiguresFile): number {
  const verdict = verdictOf(file);
  return (
    verdict.failedFigures.length +
    verdict.missingSteps.length +
    verdict.problems.length
  );
}

const UNITS: readonly Unit[] = [
  "ms",
  "s",
  "MB",
  "ratio",
  "per_s",
  "count",
  "cpu_s_per_min",
];

function isFigure(value: unknown): value is Figure {
  if (typeof value !== "object" || value === null) return false;
  const f = value as Record<string, unknown>;
  return (
    typeof f.name === "string" &&
    typeof f.value === "number" &&
    typeof f.unit === "string" &&
    UNITS.includes(f.unit as Unit) &&
    typeof f.passed === "boolean"
  );
}

/**
 * A step's fragment file. A step killed while writing leaves it cut off, which
 * is no fragment, so the merge names the step. A figure whose value was not a
 * number comes back with a null value and must stay: it fails the night.
 */
export function parseFragment(text: string): Fragment | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const fragment = raw as Record<string, unknown>;
  if (typeof fragment.step !== "string" || !Array.isArray(fragment.figures)) {
    return null;
  }
  return {
    step: fragment.step,
    figures: fragment.figures.filter(
      (figure: unknown): figure is Figure =>
        typeof figure === "object" &&
        figure !== null &&
        typeof (figure as Record<string, unknown>).name === "string",
    ),
    items: typeof fragment.items === "number" ? fragment.items : null,
  };
}

/**
 * The previous night's file, read from an artifact that may be unreadable or
 * from an older shape. Anything that is not a usable file is no previous night.
 */
export function parseFiguresFile(text: string): FiguresFile | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const file = raw as Record<string, unknown>;
  if (!Array.isArray(file.figures)) return null;
  const string = (value: unknown) => (typeof value === "string" ? value : "");
  return {
    commit: string(file.commit),
    runId: string(file.runId),
    date: string(file.date),
    profile: string(file.profile),
    items: typeof file.items === "number" ? file.items : null,
    figures: file.figures.filter(isFigure),
    missingSteps: Array.isArray(file.missingSteps)
      ? file.missingSteps.filter((s): s is string => typeof s === "string")
      : [],
    problems: [],
  };
}

const UNIT_LABEL: Record<Unit, string> = {
  ms: " ms",
  s: " s",
  MB: " MB",
  ratio: "x",
  per_s: "/s",
  count: "",
  cpu_s_per_min: " CPU s/min",
};

function digits(unit: Unit): number {
  return unit === "count"
    ? 0
    : unit === "ratio" || unit === "cpu_s_per_min"
      ? 2
      : 1;
}

function number(value: number, unit: Unit): string {
  if (!Number.isFinite(value)) return "n/a";
  return unit === "count"
    ? Math.round(value).toLocaleString("en-US")
    : value.toFixed(digits(unit));
}

function amount(value: number, unit: Unit): string {
  return `${number(value, unit)}${UNIT_LABEL[unit]}`;
}

function change(tonight: Figure, previous: Figure): string {
  if (previous.unit !== tonight.unit) return "unit changed";
  const delta = tonight.value - previous.value;
  if (!Number.isFinite(delta)) return "n/a";
  const sign = delta > 0 ? "+" : delta < 0 ? "-" : "";
  const magnitude = `${sign}${number(Math.abs(delta), tonight.unit)}${UNIT_LABEL[tonight.unit]}`;
  if (previous.value === 0 || delta === 0) return magnitude;
  return `${magnitude} (${sign}${Math.round(Math.abs(delta / previous.value) * 100)}%)`;
}

function cell(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function label(figure: Figure): string {
  return figure.p95 === null ? figure.name : `${figure.name} (p95)`;
}

function verdictCell(
  figure: Figure,
  known: Readonly<Record<string, number>>,
  verdict: Verdict,
): string {
  const issue = knownOverIssue(figure, known);
  if (issue !== null) return `over, #${issue} open`;
  if (verdict.notJudged.includes(figure.name)) return "not judged: slow runner";
  if (!figure.passed) return "**FAIL**";
  return figure.ceiling === null ? "recorded" : "pass";
}

/** Whether every ceiling was judged tonight, and if not, which were not and why. */
function runnerLine(figures: readonly Figure[], verdict: Verdict): string {
  if (verdict.slowRunner.length > 0) {
    const missed =
      verdict.notJudged.length > 0
        ? `A figure over a time ceiling is not judged tonight: ${verdict.notJudged.join(", ")}.`
        : "Every ceiling was judged.";
    return `**Slow runner:** ${verdict.slowRunner.join("; ")}, over the ${SLOW_RUNNER_FACTOR} times that counts as slow. ${missed} A figure with errors or no measurement, a memory or size figure and \`seed_errors\` are judged as on any night.`;
  }
  const probed = figures.some(
    (figure) =>
      figure.name in PROBE_REFERENCE_MS &&
      (figure.samples ?? 0) >= MIN_PROBE_READINGS,
  );
  return probed
    ? "Runner: normal speed, so every ceiling was judged."
    : "Runner: the probe left too few readings, so every ceiling was judged.";
}

/** The Markdown the run's summary shows. */
export function renderSummary(
  tonight: FiguresFile,
  previous: FiguresFile | null,
  known: Readonly<Record<string, number>> = KNOWN_OVER,
): string {
  const verdict = verdictOf(tonight, known);
  const lines: string[] = [];
  lines.push("## Scale benchmark", "");
  const size =
    tonight.items === null
      ? "an instance of unknown size"
      : `${tonight.items.toLocaleString("en-US")} items`;
  const notJudged = verdict.notJudged.length;
  const headline = !verdict.passed
    ? "**The night failed.**"
    : notJudged > 0
      ? `Passed, with ${notJudged} time figure${notJudged === 1 ? "" : "s"} not judged.`
      : "Passed";
  lines.push(
    `${headline} ${size}, commit \`${tonight.commit}\`, profile ${tonight.profile}.`,
    "",
    runnerLine(tonight.figures, verdict),
    "",
  );

  for (const step of verdict.missingSteps) {
    lines.push(
      `- Step \`${step}\` left no figures: it crashed, timed out or never ran.`,
    );
  }
  for (const problem of verdict.problems) lines.push(`- ${problem}`);
  if (verdict.missingSteps.length + verdict.problems.length > 0) lines.push("");

  const before = new Map(
    (previous?.figures ?? []).map((figure) => [figure.name, figure]),
  );
  if (previous === null) {
    lines.push("No previous night to compare with.", "");
  } else {
    lines.push(
      `Compared with the night of ${previous.date.slice(0, 10) || "an unknown date"} (commit \`${previous.commit || "unknown"}\`, run ${previous.runId || "unknown"}).`,
    );
    const caveats: string[] = [];
    if (previous.missingSteps.length > 0) {
      caveats.push(
        `That night left no figures for ${previous.missingSteps.join(", ")}.`,
      );
    }
    if (previous.profile !== tonight.profile) {
      caveats.push(
        `It ran profile ${previous.profile || "unknown"}, against tonight's ${tonight.profile}.`,
      );
    }
    if (previous.items !== tonight.items) {
      caveats.push(
        `It measured ${previous.items === null ? "an instance of unknown size" : `${previous.items.toLocaleString("en-US")} items`}, so the changes below say little.`,
      );
    }
    lines.push(...caveats.map((caveat) => `- ${caveat}`), "");
  }

  lines.push(
    "| Figure | Tonight | Previous night | Change | Ceiling | Verdict |",
    "| --- | --- | --- | --- | --- | --- |",
  );
  for (const figure of tonight.figures) {
    const old = before.get(figure.name);
    const ceiling =
      figure.ceiling === null ? "none" : amount(figure.ceiling, figure.unit);
    const row = [
      label(figure),
      amount(figure.value, figure.unit),
      old === undefined ? "none" : amount(old.value, old.unit),
      previous === null
        ? "none"
        : old === undefined
          ? "new"
          : change(figure, old),
      ceiling,
      verdictCell(figure, known, verdict),
    ];
    lines.push(`| ${row.map(cell).join(" | ")} |`);
  }
  lines.push("");

  const noted = tonight.figures.filter(
    (figure) => figure.note !== null || figure.errors > 0,
  );
  for (const figure of noted) {
    const parts = [
      figure.errors > 0 ? `${figure.errors} requests answered an error` : null,
      figure.note,
    ].filter((part): part is string => part !== null);
    lines.push(`- ${cell(figure.name)}: ${cell(parts.join("; "))}`);
  }
  if (noted.length > 0) lines.push("");

  const now = new Set(tonight.figures.map((figure) => figure.name));
  const gone = [...before.keys()].filter((name) => !now.has(name));
  if (gone.length > 0) {
    lines.push(`Not measured tonight: ${gone.join(", ")}.`, "");
  }
  return lines.join("\n");
}
