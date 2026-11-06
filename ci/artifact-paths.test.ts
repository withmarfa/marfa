/**
 * `actions/upload-artifact` refuses a path with a `.` or `..` segment, and
 * failing there both turns the step red and loses what it was keeping. A path
 * can hide the segment in a variable, so each is read through the environment
 * the workflow gives it.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

const WORKFLOWS = resolve(import.meta.dirname, "..", ".github", "workflows");

interface Step {
  name?: string;
  uses?: string;
  run?: string;
  with?: { path?: string };
}
interface Job {
  env?: Record<string, string>;
  steps?: Step[];
}
interface Workflow {
  env?: Record<string, string>;
  jobs: Record<string, Job>;
}

/** A variable's value, from the job or workflow, or a step's `$GITHUB_ENV` line. */
function valueOf(name: string, job: Job, workflow: Workflow): string | null {
  const declared = job.env?.[name] ?? workflow.env?.[name];
  if (declared !== undefined) return declared;
  for (const step of job.steps ?? []) {
    const written = new RegExp(
      `${name}=([^\\s"]+)"?\\s*>>\\s*"?\\$GITHUB_ENV`,
    ).exec(step.run ?? "");
    if (written?.[1] !== undefined) return written[1];
  }
  return null;
}

function refusedPaths(workflow: Workflow): string[] {
  const refused: string[] = [];
  for (const [id, job] of Object.entries(workflow.jobs)) {
    for (const step of job.steps ?? []) {
      if (!step.uses?.startsWith("actions/upload-artifact")) continue;
      const paths = (step.with?.path ?? "")
        .split("\n")
        .map((path) => path.trim())
        .filter((path) => path !== "");
      for (const path of paths) {
        const read = path.replace(
          /\$\{\{\s*env\.(\w+)\s*\}\}/g,
          (whole, name: string) => valueOf(name, job, workflow) ?? whole,
        );
        const unresolved = /\$\{\{\s*env\./.test(read);
        const segments = read.split(/[\\/]/);
        if (unresolved || segments.includes(".") || segments.includes("..")) {
          refused.push(`${id}: ${step.name ?? "unnamed"}: ${read}`);
        }
      }
    }
  }
  return refused;
}

const files = readdirSync(WORKFLOWS).filter((file) => file.endsWith(".yml"));
const read = (file: string) =>
  parse(readFileSync(join(WORKFLOWS, file), "utf8")) as Workflow;

const upload = (path: string): Step => ({
  name: "Keep",
  uses: "actions/upload-artifact@v7",
  with: { path },
});

describe("what upload-artifact is given", () => {
  it.each(files)("%s names no path upload-artifact refuses", (file) => {
    expect(refusedPaths(read(file))).toEqual([]);
  });

  it.each([
    ["a parent segment", { jobs: { a: { steps: [upload("x/../y/log")] } } }],
    ["a current segment", { jobs: { a: { steps: [upload("./y/log")] } } }],
    [
      "a parent segment in the job's variable",
      {
        jobs: {
          a: {
            env: { STATE: "${{ github.workspace }}/../state" },
            steps: [upload("${{ env.STATE }}/log")],
          },
        },
      },
    ],
    [
      "a parent segment in a variable a step wrote",
      {
        jobs: {
          a: {
            steps: [
              { run: 'echo "STATE=$HOME/../state" >> "$GITHUB_ENV"' },
              upload("${{ env.STATE }}/log"),
            ],
          },
        },
      },
    ],
    [
      "a variable nothing sets",
      { jobs: { a: { steps: [upload("${{ env.STATE }}/log")] } } },
    ],
  ])("refuses %s", (_label, workflow) => {
    expect(refusedPaths(workflow)).toHaveLength(1);
  });

  it("passes the same shapes without the segment, so the refusals mean something", () => {
    expect(
      refusedPaths({
        jobs: {
          a: {
            env: { STATE: "${{ github.workspace }}/state" },
            steps: [
              { run: 'echo "TEMP=$RUNNER_TEMP/x" >> "$GITHUB_ENV"' },
              upload("${{ env.STATE }}/log\n${{ env.TEMP }}/log\nx/y.z/log"),
            ],
          },
        },
      }),
    ).toEqual([]);
  });
});

describe("a job's env", () => {
  // GitHub does not give `jobs.<id>.env` the `runner` context, so a value that
  // names it stops the workflow from starting at all.
  it.each(files)("%s names no runner context in a job's env", (file) => {
    for (const [id, job] of Object.entries(read(file).jobs)) {
      for (const [name, value] of Object.entries(job.env ?? {})) {
        expect(value, `${id}: ${name}`).not.toMatch(/\$\{\{[^}]*\brunner\./);
      }
    }
  });
});

describe("the scale benchmark's state directory", () => {
  it("is under the runner's temporary folder, with no parent segment", () => {
    const job = read("benchmarks.yml").jobs.scale;
    expect(job).toBeDefined();
    const value = valueOf("MARFA_SCALE_STATE", job ?? {}, { jobs: {} });
    expect(value).toBe("$RUNNER_TEMP/marfa-scale");
  });
});
