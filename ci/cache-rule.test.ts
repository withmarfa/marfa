/**
 * The pnpm cache must stay off on any runner that keeps its store, and on
 * every runner that does not it must stay on.
 *
 * `actions/setup-node`'s post step tars the whole pnpm store. On the
 * self-hosted pool that store is about 12 GB and already persists between
 * jobs, so the cache restores nothing and costs everything; several jobs
 * finishing together is what once made runs take about an hour with every
 * visible step green, on a machine that also serves every other repository's
 * CI. On an ephemeral runner the store does not survive the job at all, so
 * the same key is what stops a fifteen-package install hitting the registry
 * on every run. The two failures point in opposite directions and neither is
 * visible in a green run.
 *
 * Every `actions/setup-node` step in `ci.yml` decides this with the same
 * expression, resolved through its own job's `runs-on`. Two things about that
 * are invisible to a reader:
 *
 *   - The chain is written out a second time inside the `cache:` value.
 *     `runs-on` cannot read `env`, which is the usual explanation, and the
 *     usual explanation does not finish the argument: `runs-on` *can* read
 *     `needs`, and every job that caches already declares `needs: changes`
 *     except the surface-lock drift check, which is deliberately ungated —
 *     so the `changes` job could emit the resolved runner once and both keys
 *     could read it for the rest. That route was considered and declined, not missed. It moves
 *     where a job runs out of the job and into another job's output, so
 *     `runs-on` stops telling you where the job runs and you have to trace
 *     an output to find out. That legibility is worth more than the second
 *     copy, now that the copy is cheaply policed, by this file. Two copies
 *     of a chain drift, so something has to hold them together; it does not
 *     have to be the workflow's own structure.
 *   - The recognition used to be `!= 'self-hosted'`, which was right only by
 *     the spelling of one variable. The override variables exist so jobs can
 *     be pointed at another pool, and naming that pool is what makes a
 *     not-equal test false and switches the tar back on.
 *
 * **A green CI run cannot prove any of this.** On the pool the resolved
 * runner is `self-hosted` under the old rule and the new one alike, so the
 * cache is off either way and the run is green whether the file is right or
 * wrong. The check that would catch the regression is the one that cannot run
 * where the regression bites. That is worth saying plainly, because "CI was
 * green" is the first thing anybody reaches for.
 *
 * ## How this checks it, and why not by evaluating
 *
 * The assertions are string comparisons against a template built from each
 * job's own `runs-on`. An earlier version evaluated the expressions with a
 * hand-written interpreter for GitHub's expression language. That was worse
 * in both directions: nothing here can serve as an oracle for GitHub's
 * semantics, so the interpreter's own divergences were untestable, and a
 * legitimate workflow it did not model — a matrix job resolving
 * `${{ matrix.runner }}`, say — would have failed with a message blaming the
 * workflow. Template equality is stronger against every failure this guards
 * (a restored `!= 'self-hosted'`, an inverted condition, a chain that drifted
 * from `runs-on`, a new job written subtly differently) and it cannot fail a
 * correct workflow. The cost is that it pins one spelling of the rule: a
 * genuine change to the rule is a two-file change, which is the intended
 * friction.
 *
 * ## What it cannot see
 *
 * Reading a cache key off setup-node steps leaves other ways to tar the same
 * store. These are refused outright rather than skipped: a cache action from
 * any owner, which is the obvious move for someone who finds the cache off
 * and wants it back; a composite action under `.github/actions`, read here
 * for that reason; a local action from anywhere else, which is not read and
 * so is refused instead; a cache key on a step that is not setup-node, such
 * as a `setup-python`; and a reusable-workflow call, whose steps live in a
 * file this check does not read. None of them exists today, which is exactly
 * when a claim of coverage is worth writing down.
 *
 * **That list is not complete, and reads as though it were.** Not covered: a
 * `run:` step that tars or restores a store itself, through `tar`, `gh
 * cache`, or a script of its own; caching inside a `container:` or a service
 * image; and a third-party action that caches without saying so in its name,
 * since the refusal matches on the name. Nothing structural rules those out.
 * The rule also trusts that a runner label's prefix describes the machine
 * behind it, which is a naming convention rather than a fact; see the note
 * about that in `ci.yml`.
 *
 * ## Why it lives here rather than in a package
 *
 * It guards repository infrastructure, not any package's behavior. Filed
 * under `packages/server` it would be invisible to whoever next edits a
 * workflow, and it would quietly disappear if that package were restructured,
 * which is the exact failure mode this file is about. `ci/` is a vitest
 * project of its own, declared in the root `vitest.config.ts`, so `pnpm test`
 * runs it; a change under `.github/workflows/` is a code change to the
 * `changes` job, so the lane that runs `pnpm test` runs on every pull request
 * that touches a workflow.
 */

import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve } from "node:path";
import { parse } from "yaml";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workflowsDir = join(repoRoot, ".github", "workflows");
const actionsDir = join(repoRoot, ".github", "actions");

/* -------------------------------------------------------------------------
 * The rule
 *
 * One list, used both to build the expression the workflows must carry and to
 * judge a step whose runner is a fixed literal and so has no expression to
 * compare against.
 * ---------------------------------------------------------------------- */

/** Runner label prefixes that keep no dependency store between jobs. */
const EPHEMERAL_PREFIXES = ["ubuntu-", "blacksmith-"];

/**
 * The one spelling of the cache rule, for a job that resolves its runner with
 * `runnerExpression`. Whitespace-normalized, matching `expressionBody`.
 */
function canonicalRule(runnerExpression: string): string {
  return `${recognizesEphemeral(runnerExpression)} && 'pnpm' || ''`;
}

/**
 * The half of the rule that answers "does this job's runner keep a store".
 *
 * Extracted because a standalone cache step has to carry the same answer in
 * its `if:` and has no `cache:` key to put it in. One spelling, two
 * consumers, so the two cannot drift into disagreeing about the same
 * question.
 */
function recognizesEphemeral(runnerExpression: string): string {
  const recognized = EPHEMERAL_PREFIXES.map(
    (prefix) => `startsWith((${runnerExpression}), '${prefix}')`,
  ).join(" || ");
  return `(${recognized})`;
}

/** The `|| 'some-runner'` a runner chain ends with, when it has one. */
const TRAILING_LITERAL = /\|\|\s*'([^']*)'\s*$/;

/** A context whose value the repository sets, and can therefore leave unset. */
const READS_A_SETTABLE_INPUT = /\b(?:vars|inputs)\s*[.[]/;

function isEphemeralLabel(label: string): boolean {
  return EPHEMERAL_PREFIXES.some((prefix) => label.startsWith(prefix));
}

/* -------------------------------------------------------------------------
 * Reading the workflows and composite actions
 * ---------------------------------------------------------------------- */

interface Step {
  uses?: string;
  if?: unknown;
  with?: Record<string, unknown>;
}

interface Job {
  "runs-on"?: unknown;
  /** Set when the job calls a reusable workflow instead of running steps. */
  uses?: string;
  steps?: Step[];
}

interface Workflow {
  jobs?: Record<string, Job>;
}

interface CompositeAction {
  runs?: { steps?: Step[] };
}

/** One `actions/setup-node` step, with the runner of the job it sits in. */
interface SetupNodeStep {
  source: string;
  jobId: string;
  /** The job's `runs-on`, verbatim. */
  runsOn: string;
  /** The step's `with.cache`, verbatim, or undefined when it sets none. */
  cache: string | undefined;
}

/** Somewhere this check cannot see into, or must not allow. */
interface Refusal {
  source: string;
  detail: string;
}

function yamlFilesIn(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
    .sort()
    .map((name) => join(dir, name));
}

/** `.github/actions/<name>/action.yml`, for any composite action that exists. */
/**
 * Every `action.yml` / `action.yaml` under `.github/actions`, at any depth.
 * Recursive rather than one level down, so a nested action, or one sitting at
 * the top of the directory, is read rather than missed.
 */
function compositeActionFiles(dir: string = actionsDir): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) return compositeActionFiles(full);
      return /^action\.ya?ml$/i.test(entry.name) ? [full] : [];
    })
    .sort();
}

/** The action reference with any `@ref` stripped, lowercased. */
function actionPath(step: Step): string {
  return (step.uses ?? "").split("@")[0]?.toLowerCase() ?? "";
}

/**
 * Any owner's setup-node, not only `actions/`. Blacksmith publishes its own,
 * and that is exactly what a future editor reaches for, precisely because
 * `blacksmith-` is in the allowlist above. GitHub resolves `uses:`
 * case-insensitively, so this does too.
 */
function usesSetupNode(step: Step): boolean {
  return actionPath(step).split("/").includes("setup-node");
}

/**
 * Any owner's cache action: `actions/cache` with its `/restore` and `/save`
 * entry points, and the third-party ones (`useblacksmith/cache`,
 * `buildjet/cache`, `Swatinem/rust-cache`). Matches a path segment that is
 * `cache` or ends in `-cache`, so `no-cache-check` does not trip it. A false
 * refusal here is loud and one line to fix; a miss tars the store.
 */
function usesCacheAction(step: Step): boolean {
  return actionPath(step)
    .split("/")
    .some((segment) => segment === "cache" || segment.endsWith("-cache"));
}

/** A local action reference, `uses: ./path`, rather than a published one. */
function localActionPath(step: Step): string | null {
  const path = step.uses ?? "";
  return path.startsWith("./") ? path : null;
}

function isScalarCache(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

const setupNodeSteps: SetupNodeStep[] = [];
const standaloneCacheSteps: Refusal[] = [];
/** One `actions/cache` step that IS gated, with what it is gated on. */
interface GatedCacheStep {
  source: string;
  jobId: string;
  /** The job's `runs-on`, verbatim. */
  runsOn: string;
  /** The step's `if:`, verbatim. */
  gate: string;
}
const gatedCacheSteps: GatedCacheStep[] = [];
const unreadableJobs: Refusal[] = [];
const cachingCompositeActions: Refusal[] = [];
const unmodeledSteps: Refusal[] = [];
const unreadLocalActions: Refusal[] = [];
const unaccountedCacheKeys: Refusal[] = [];

for (const file of yamlFilesIn(workflowsDir)) {
  const source = relative(repoRoot, file);
  const doc = parse(readFileSync(file, "utf8")) as Workflow;

  for (const [jobId, job] of Object.entries(doc.jobs ?? {})) {
    // A job that calls a reusable workflow has no steps here, and its steps
    // live in a file this check is not reading.
    if (job.uses !== undefined) {
      unreadableJobs.push({
        source,
        detail: `job \`${jobId}\` calls the reusable workflow \`${job.uses}\``,
      });
      continue;
    }

    for (const step of job.steps ?? []) {
      if (usesCacheAction(step)) {
        // Collected with its job's runner and its own `if:`, rather than
        // refused on sight. The refusal was never that caching is wrong —
        // it was that nothing here could tell a cache obeying the rule from
        // one reinstating a tar somebody had deliberately removed. Given
        // both halves, that is answerable, so it is answered below.
        const runsOn = job["runs-on"];
        const gate = step.if;
        if (typeof runsOn !== "string" || typeof gate !== "string") {
          standaloneCacheSteps.push({
            source,
            detail:
              `job \`${jobId}\` uses \`${step.uses ?? ""}\` with ` +
              (typeof gate !== "string"
                ? "no `if:`"
                : "a runs-on this check cannot read"),
          });
        } else {
          gatedCacheSteps.push({ source, jobId, runsOn, gate });
        }
      }

      // A local action under `.github/actions` is read below. One from
      // anywhere else is not, so it is refused rather than assumed clean.
      const local = localActionPath(step);
      if (local !== null && !local.startsWith("./.github/actions/")) {
        unreadLocalActions.push({
          source,
          detail: `job \`${jobId}\` uses \`${local}\``,
        });
      }

      if (!usesSetupNode(step)) {
        // Some other setup action managing a cache: same post-step tar, and
        // the rule below would be the wrong rule to hold it to.
        if (step.with?.cache !== undefined) {
          unaccountedCacheKeys.push({
            source,
            detail: `job \`${jobId}\` sets a cache on \`${step.uses ?? "(run)"}\``,
          });
        }
        continue;
      }

      // `runs-on` also accepts a `{ group, labels }` mapping, and `cache`
      // could be written as a non-scalar. Neither is used here, and guessing
      // at what either resolves to would be worse than refusing, so collect
      // them as refusals rather than reading them wrong. Collected, not
      // thrown: one unsupported job should name itself, not bury ten tests
      // under a stack trace.
      const runsOn = job["runs-on"];
      const cache = step.with?.cache;
      if (typeof runsOn !== "string" || !isScalarCache(cache)) {
        unmodeledSteps.push({
          source,
          detail:
            `job \`${jobId}\` runs setup-node with a runs-on or cache shape ` +
            `this check does not model`,
        });
        continue;
      }

      setupNodeSteps.push({ source, jobId, runsOn, cache });
    }
  }
}

for (const file of compositeActionFiles()) {
  const source = relative(repoRoot, file);
  const action = parse(readFileSync(file, "utf8")) as CompositeAction;

  for (const step of action.runs?.steps ?? []) {
    if (usesCacheAction(step) || step.with?.cache !== undefined) {
      cachingCompositeActions.push({
        source,
        detail: `step \`${step.uses ?? "(run)"}\` manages a dependency cache`,
      });
    }
  }
}

function where(step: SetupNodeStep): string {
  return `${step.source} job \`${step.jobId}\``;
}

/* -------------------------------------------------------------------------
 * Expressions
 * ---------------------------------------------------------------------- */

/** Collapses the line breaks a folded scalar leaves behind. */
function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * The body of a value that is entirely one `${{ … }}`, or null when the value
 * is a plain literal. A value that mixes literal text with an expression is
 * neither, and is rejected rather than silently read as a literal.
 */
function expressionBody(value: string): string | null {
  const whole = /^\$\{\{([\s\S]*)\}\}$/.exec(value.trim());
  if (whole) return normalize(whole[1] ?? "");
  if (value.includes("${{")) {
    throw new Error(
      `\`${value}\` mixes literal text with an expression, which this check ` +
        `does not model.`,
    );
  }
  return null;
}

/**
 * A boolean expression's top-level `&&` operands, trimmed.
 *
 * Depth-aware because the runner chain this file compares against carries
 * its own `&&` inside parentheses, and splitting on the operator naively
 * would cut the clause in half and then fail to find it.
 *
 * Not a parser and not trying to be. It answers one question — is this
 * clause one of the things being ANDed together, on its own, rather than
 * merely appearing somewhere in the text — and anything it cannot answer
 * that way falls out as a non-match, which is the refusing direction.
 */
function topLevelConjuncts(expression: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < expression.length; i++) {
    const char = expression[i];
    if (char === "(") depth++;
    else if (char === ")") depth--;
    else if (depth === 0 && char === "&" && expression[i + 1] === "&") {
      parts.push(expression.slice(start, i).trim());
      i++;
      start = i + 1;
    }
  }
  parts.push(expression.slice(start).trim());
  return parts.filter((part) => part.length > 0);
}

/* -------------------------------------------------------------------------
 * The assertions
 * ---------------------------------------------------------------------- */

describe("the dependency cache rule in .github/workflows", () => {
  it("is looking at the workflows and finding steps to check", () => {
    // A rule-checking test that silently matches nothing reports a confident
    // pass. These are floors, not counts, so adding a workflow or a job does
    // not touch them.
    expect(
      yamlFilesIn(workflowsDir).length,
      `no workflow files were read from ${workflowsDir}`,
    ).toBeGreaterThanOrEqual(5);

    expect(
      setupNodeSteps.length,
      `found no actions/setup-node steps, so every assertion below would ` +
        `pass over an empty list`,
    ).toBeGreaterThanOrEqual(8);

    expect(
      setupNodeSteps.filter((step) => expressionBody(step.runsOn) !== null)
        .length,
      `found no job that resolves its runner with an expression, which is ` +
        `the whole population this rule exists for`,
    ).toBeGreaterThanOrEqual(8);
  });

  it("decides the cache at every setup-node step, not just some", () => {
    // The original defect's other half: five steps left the key off entirely
    // with a comment saying to restore it on hosted runners. Pointing
    // CI_RUNNER at an ephemeral pool then made them reinstall from the
    // registry on every run, silently and on billed time.
    const undecided = setupNodeSteps.filter((step) => step.cache === undefined);
    expect(
      undecided.map(where),
      `these steps set no \`cache\` key, so the answer depends on where the ` +
        `job happens to land rather than on anything in the file`,
    ).toEqual([]);
  });

  it("pairs a fixed runner with a fixed answer", () => {
    for (const step of setupNodeSteps) {
      if (expressionBody(step.runsOn) !== null) continue;

      const cache = expressionBody(step.cache ?? "");
      expect(
        cache,
        `${where(step)} runs on the fixed runner \`${step.runsOn}\` but ` +
          `computes its cache from an expression, which is answering a ` +
          `question the job does not ask.`,
      ).toBeNull();

      if ((step.cache ?? "") === "") continue;
      expect(
        isEphemeralLabel(step.runsOn),
        `${where(step)} is pinned to \`${step.runsOn}\` and caches ` +
          `unconditionally. That label is not one this repository treats as ` +
          `keeping no store between jobs.`,
      ).toBe(true);
    }
  });

  it("resolves the cache through the job's own runner chain", () => {
    for (const step of setupNodeSteps) {
      const runsOn = expressionBody(step.runsOn);
      if (runsOn === null || step.cache === undefined) continue;

      const cache = expressionBody(step.cache);
      expect(
        cache,
        `${where(step)} chooses its runner with an expression but pins its ` +
          `cache to the literal \`${step.cache}\`, so moving the job ` +
          `to the pool would leave the cache on.`,
      ).not.toBeNull();

      expect(
        cache?.includes(runsOn),
        `${where(step)} resolves the runner differently in \`cache\` and in ` +
          `\`runs-on\`, so the two can disagree about where the job is. ` +
          `runs-on: ${runsOn} / cache: ${cache ?? ""}`,
      ).toBe(true);
    }
  });

  it("carries the same rule at every one of those steps", () => {
    for (const step of setupNodeSteps) {
      const runsOn = expressionBody(step.runsOn);
      if (runsOn === null || step.cache === undefined) continue;

      expect(
        expressionBody(step.cache),
        `${where(step)} does not carry the repository's cache rule. It ` +
          `should recognize the runners that keep no store between jobs ` +
          `(${EPHEMERAL_PREFIXES.join(", ")}) and cache on those alone, so ` +
          `that an unrecognized label gets no cache.`,
      ).toBe(canonicalRule(runsOn));
    }
  });

  it("defaults each runner chain to a runner the rule caches on", () => {
    // Template equality above rebuilds the expected rule out of `runs-on`, so
    // a chain and its cache stay in agreement even when both are edited
    // together. What that cannot notice is the default itself moving:
    // `|| 'ci-pool-1'` in place of `|| 'ubuntu-latest'` keeps the two in step
    // and silently stops caching wherever no variable is set, which is a
    // fresh clone, a fork, and every hosted run. The rule still fails closed,
    // so nothing breaks; it just gets slow forever, which is the kind of cost
    // nobody goes looking for.
    for (const step of setupNodeSteps) {
      const runsOn = expressionBody(step.runsOn);
      if (runsOn === null) continue;

      // Judge any trailing literal that is there, whatever the chain reads,
      // rather than only chains spelled with `vars.`, since `vars['CI_RUNNER']`
      // and `inputs.runner` are the same drifted-default case.
      const fallback = TRAILING_LITERAL.exec(runsOn)?.[1];

      if (fallback === undefined) {
        // No default to judge. Fine for a runner resolved some other way: a
        // matrix value has none to state. Not fine for a chain reading
        // something that can be unset, which then resolves to nothing.
        expect(
          READS_A_SETTABLE_INPUT.test(runsOn),
          `${where(step)} reads a variable or input for its runner and ends ` +
            `the chain with no literal default, so leaving it unset resolves ` +
            `the runner to nothing at all. runs-on: ${runsOn}`,
        ).toBe(false);
        continue;
      }

      expect(
        isEphemeralLabel(fallback),
        `${where(step)} falls back to \`${fallback}\` when nothing overrides ` +
          `the runner, and the rule does not cache on that. Every run ` +
          `without repository variables would reinstall from the registry.`,
      ).toBe(true);
    }
  });

  it("never recognizes a runner by testing it against `self-hosted`", () => {
    for (const step of setupNodeSteps) {
      expect(
        step.cache ?? "",
        `${where(step)} tests the runner against the literal \`self-hosted\`. ` +
          `That is correct only while the pool happens to be spelled that ` +
          `way: pointing the job at a named pool makes the test false and ` +
          `turns on a 12 GB tar per run. Recognize the runners that keep no ` +
          `store instead.`,
      ).not.toContain("self-hosted");
    }
  });

  it("has no setup-node step in a shape it cannot read", () => {
    expect(
      unmodeledSteps.map((r) => `${r.source}: ${r.detail}`),
      `a \`{ group, labels }\` runs-on, or a cache value that is not a plain ` +
        `scalar, is legitimate GitHub and is simply outside what the ` +
        `assertions above understand. Extend them rather than letting the ` +
        `step through unread.`,
    ).toEqual([]);
  });

  it("has no ungated standalone actions/cache step", () => {
    expect(
      standaloneCacheSteps.map((r) => `${r.source}: ${r.detail}`),
      `\`actions/cache\` tars the path it is given exactly as ` +
        `\`setup-node\`'s post step does, and it is the obvious move for ` +
        `someone who finds the cache off and wants it back. It is allowed ` +
        `only when its \`if:\` answers the same question the cache rule ` +
        `answers, resolved through its own job's runner — see the ` +
        `assertion below. One that carries no \`if:\`, or sits in a job ` +
        `whose runner this check cannot read, is refused rather than ` +
        `assumed clean.`,
    ).toEqual([]);
  });

  it("gates every standalone actions/cache step on its own job's runner", () => {
    // A cache action has no `cache:` key to put the rule in, so the rule
    // moves into its `if:`. The gate legitimately carries other conditions
    // beside this one — the SQLite lane's also skips a documentation-only
    // run — so demanding the whole expression would refuse a correct step
    // for saying something true as well.
    //
    // What it demands instead is that the clause is one of the gate's
    // top-level `&&` operands, **verbatim**. The first version of this
    // asked whether the gate CONTAINED the clause, and that was the same
    // defect this file exists to catch, one level up: a substring test
    // cannot tell a clause from a clause that has been defeated, because
    // both contain it. `!( … )` contains it and inverts it, which caches
    // on the pool and nowhere else — exactly the cost this file is for —
    // and `… || true` contains it and always fires. Neither is something
    // anyone writes on purpose, and neither is the point. The point is
    // that "assumed clean because the text is present" is not a standard
    // this file gets to apply while refusing everything else it cannot
    // read. Demonstrated rather than argued: the negated gate passed the
    // containment version with every other assertion green.
    //
    // The split has to respect parentheses, because the runner chain
    // carries its own `&&` (`github.event_name == 'push' && vars.X`) and a
    // naive split would shred the clause it is looking for.
    //
    // **There is no such step in the workflows today**, so this loop runs
    // over an empty list and passes over nothing. Said out loud because a
    // guard that silently matches nothing reports a confident pass, and
    // this one is in that state deliberately: the step it was written for
    // turned out to cache a directory nothing writes and was removed. The
    // refusal above is the half doing work right now — it applies to any
    // cache action that appears — and this is what lets that refusal be
    // narrow rather than absolute when one does.
    for (const step of gatedCacheSteps) {
      const runsOn = expressionBody(step.runsOn);
      const gate = expressionBody(step.gate);
      expect(
        gate,
        `${step.source} job \`${step.jobId}\` gates a cache step on a ` +
          `literal rather than an expression, so it cannot be resolving ` +
          `anything through the job's runner.`,
      ).not.toBeNull();
      expect(
        runsOn,
        `${step.source} job \`${step.jobId}\` caches on a fixed runner. ` +
          `That is legitimate on an ephemeral label and wrong on a pool, ` +
          `and this check does not model it — add the case rather than ` +
          `letting the step through.`,
      ).not.toBeNull();
      if (runsOn === null || gate === null) continue;
      expect(
        topLevelConjuncts(gate),
        `${step.source} job \`${step.jobId}\` caches without recognizing ` +
          `the runners that keep no store between jobs, resolved through ` +
          `its own \`runs-on\`, as a plain conjunct of its \`if:\`. On ` +
          `the pool this tars a store that is already there, which is the ` +
          `cost this file exists to keep off that machine. A clause that ` +
          `is present but negated or defeated does not count.` +
          `\n  runs-on: ${runsOn}\n  if: ${gate}`,
      ).toContain(recognizesEphemeral(runsOn));
    }
  });

  it("has no composite action managing a dependency cache", () => {
    expect(
      cachingCompositeActions.map((r) => `${r.source}: ${r.detail}`),
      `a composite action can cache on behalf of a job whose own steps look ` +
        `clean. Either fold the decision back into the workflow or extend ` +
        `this check to resolve the calling job's runner through it.`,
    ).toEqual([]);
  });

  it("has no local action this check does not read", () => {
    expect(
      unreadLocalActions.map((r) => `${r.source}: ${r.detail}`),
      `only \`.github/actions\` is scanned for composite actions, so a local ` +
        `action anywhere else could cache on a job's behalf unseen. Move it ` +
        `under \`.github/actions\` or widen the scan.`,
    ).toEqual([]);
  });

  it("has no cache key on a step this rule does not govern", () => {
    expect(
      unaccountedCacheKeys.map((r) => `${r.source}: ${r.detail}`),
      `a cache on some other setup action runs the same post-step tar, and ` +
        `the pnpm rule above is not the right rule to hold it to. Decide ` +
        `explicitly what it should do on the pool.`,
    ).toEqual([]);
  });

  it("has no reusable-workflow call hiding steps from this check", () => {
    expect(
      unreadableJobs.map((r) => `${r.source}: ${r.detail}`),
      `a called workflow's steps are in a file this check does not read, so ` +
        `its cache decisions are unexamined. Extend the reach to the called ` +
        `file rather than leaving the gap open.`,
    ).toEqual([]);
  });
});
