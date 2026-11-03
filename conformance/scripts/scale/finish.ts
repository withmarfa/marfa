/**
 * The end of the night: merge the steps' fragments into `figures.json`, set
 * them beside the previous night's in the run's summary, send the night to
 * PostHog, and (as a separate command, after the figures are kept) fail the
 * night if any figure missed.
 *
 * Nothing here may stop the figures being kept: the previous night is looked
 * for and the report sent inside their own guards.
 */
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { benchmarkEvent, captureUrl } from "../../src/utils/scale/posthog.js";
import { pickPreviousArtifact } from "../../src/utils/scale/previous.js";
import {
  EXPECTED_STEPS,
  mergeFragments,
  parseFiguresFile,
  renderSummary,
  verdictOf,
  type FiguresFile,
} from "../../src/utils/scale/report.js";
import type { Fragment } from "../../src/utils/scale/figures.js";
import { log, readFragment, REPORTS_DIR, targetItems } from "./context.js";

/** One id for every night, so the event is a series and not a person. */
const DISTINCT_ID = "marfa-nightly-benchmarks";
export const FIGURES_FILE = resolve(REPORTS_DIR, "figures.json");

/** The profile's name, which says what shape and size the figures were measured at. */
function profileName(): string {
  return `scale-${targetItems()}`;
}

function previousNight(): FiguresFile | null {
  const repo = process.env.GITHUB_REPOSITORY;
  if (!repo || !process.env.GH_TOKEN) return null;
  let directory: string | undefined;
  try {
    const listing = JSON.parse(
      execFileSync(
        "gh",
        [
          "api",
          `repos/${repo}/actions/artifacts?name=scale-figures&per_page=30`,
        ],
        { encoding: "utf8" },
      ),
    ) as unknown;
    const artifact = pickPreviousArtifact(
      listing,
      process.env.GITHUB_RUN_ID ?? "",
    );
    if (artifact === null) return null;
    directory = mkdtempSync(resolve(tmpdir(), "scale-previous-"));
    execFileSync(
      "gh",
      [
        "run",
        "download",
        String(artifact.workflow_run.id),
        "--repo",
        repo,
        "--name",
        "scale-figures",
        "--dir",
        directory,
      ],
      { stdio: "pipe" },
    );
    const file = resolve(directory, "figures.json");
    return existsSync(file)
      ? parseFiguresFile(readFileSync(file, "utf8"))
      : null;
  } catch (error) {
    log(`could not read the previous night: ${String(error).slice(0, 300)}`);
    return null;
  } finally {
    if (directory !== undefined)
      rmSync(directory, { recursive: true, force: true });
  }
}

/** Only the schedule reports, or a dispatch that asks to. */
function shouldSend(): boolean {
  return (
    process.env.GITHUB_EVENT_NAME === "schedule" ||
    process.env.MARFA_SCALE_SEND_REPORT === "true"
  );
}

async function sendReport(file: FiguresFile): Promise<void> {
  if (!shouldSend()) {
    log(
      "not a scheduled run and no report was asked for; nothing sent to PostHog",
    );
    return;
  }
  const host = process.env.MARFA_POSTHOG_HOST;
  const token = process.env.MARFA_POSTHOG_PROJECT_TOKEN;
  if (!host || !token) {
    console.log(
      "::notice::MARFA_POSTHOG_HOST or MARFA_POSTHOG_PROJECT_TOKEN is not set; the night was not sent to PostHog.",
    );
    return;
  }
  try {
    const response = await fetch(captureUrl(host), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        benchmarkEvent(file, { token, distinctId: DISTINCT_ID }),
      ),
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
      console.log(
        `::warning::PostHog answered ${response.status} to the nightly report.`,
      );
    } else {
      log("sent the night to PostHog");
    }
  } catch (error) {
    console.log(
      `::warning::The nightly report did not reach PostHog: ${String(error).slice(0, 200)}`,
    );
  }
}

export async function finish(): Promise<void> {
  mkdirSync(REPORTS_DIR, { recursive: true });
  const whole: Fragment[] = [];
  const partial: Fragment[] = [];
  for (const step of EXPECTED_STEPS) {
    const done = readFragment(step);
    if (done !== null) whole.push(done);
    const part = readFragment(step, true);
    if (part !== null) partial.push(part);
  }
  const file = mergeFragments(
    whole,
    {
      commit: (process.env.GITHUB_SHA ?? "local").slice(0, 12),
      runId: process.env.GITHUB_RUN_ID ?? "local",
      date: new Date().toISOString(),
      profile: profileName(),
    },
    EXPECTED_STEPS,
    partial,
  );
  writeFileSync(FIGURES_FILE, JSON.stringify(file, null, 2));

  const summary = renderSummary(file, previousNight());
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
  }
  console.log(summary);
  await sendReport(file);
}

/** Fails when a figure missed, a step left no figures or the recording was at fault. */
export function judge(): void {
  if (!existsSync(FIGURES_FILE)) {
    throw new Error("no figures.json: the merge step did not run");
  }
  const file = JSON.parse(readFileSync(FIGURES_FILE, "utf8")) as FiguresFile;
  const verdict = verdictOf(file);
  if (verdict.passed) {
    log("every figure is within its ceiling");
    return;
  }
  const reasons = [
    ...verdict.failedFigures.map((name) => `${name} missed its ceiling`),
    ...verdict.missingSteps.map((step) => `step ${step} left no figures`),
    ...verdict.problems,
  ];
  console.log(`::error::The scale benchmark failed: ${reasons.join("; ")}`);
  process.exitCode = 1;
}
