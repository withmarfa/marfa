/**
 * A script that starts a container releases it on every exit path, the
 * killed one included.
 *
 * The estate already has the rule that test infrastructure owns what it
 * allocates. What the wording predates is anyone reaching it through a
 * kill: `trap cleanup EXIT` reads as complete and covers only a shell that
 * exits on its own, so a run stopped with Ctrl-C or SIGTERM runs no
 * teardown at all.
 *
 * That is the exit path that most needs it. On a clean exit somebody is
 * watching the output and would see a warning; on a kill nobody is, and
 * what survives is a Postgres, a pooler, an anonymous volume and a
 * network. The networks are the part that accumulates invisibly: their
 * names carry the invoking shell's PID, so a later run can never reclaim
 * one, and nothing can tell an orphan from a live run's without inspecting
 * every one. Seven had built up before anyone looked, the oldest thirteen
 * hours dead, and sweeping them meant checking each for attached
 * containers first because deleting a live run's network breaks a suite
 * somebody is waiting on.
 *
 * A green run proves nothing here, which is why this is a test rather than
 * a convention. Both the covered and the uncovered spelling behave
 * identically until something kills the script.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SCRIPT_DIRS = ["scripts", "packages/server/scripts"];

/** Conventional exit status per signal: 128 + the signal's number. */
const EXPECTED_STATUS: Record<string, number> = {
  INT: 130,
  TERM: 143,
  HUP: 129,
};

/** Every shell script in the repository's script directories. */
function shellScripts(): { path: string; body: string }[] {
  const found: { path: string; body: string }[] = [];
  for (const dir of SCRIPT_DIRS) {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith(".sh")) continue;
      const path = join(dir, name);
      found.push({ path, body: readFileSync(path, "utf-8") });
    }
  }
  return found;
}

/**
 * Scripts that start a container. Matched on `docker run` rather than on a
 * name list, so a new script is covered the day it is written rather than
 * the day somebody remembers to add it here.
 */
function allocatesContainer(body: string): boolean {
  return /^\s*(?!#)[^\n]*docker\s+run\b/m.test(body);
}

/**
 * Every `trap` line, split into handler and signal list.
 *
 * Quoted alternatives first. `\S+` matches `'cleanup;` and leaves the rest
 * of the handler in the signal list, which makes a substring test for
 * `TERM` succeed on the `TERM` inside `exit 143' TERM` and a test for
 * "does the handler exit" fail on every quoted handler. Both sibling
 * tests had that bug; they now share this.
 */
function trapLines(body: string): { handler: string; signals: string }[] {
  return [
    ...body.matchAll(/^\s*trap\s+('[^']*'|"[^"]*"|\S+)\s+([^\n]*)$/gm),
  ].map((m) => ({ handler: m[1] ?? "", signals: m[2] ?? "" }));
}

/** A handler of `""` disarms rather than handles; it has nothing to exit. */
function isDisarm(handler: string): boolean {
  return handler.replace(/['"]/g, "") === "";
}

describe("a script that starts a container releases it when killed", () => {
  it("finds the scripts it is meant to be checking", () => {
    // The guard this test most needs is against itself: a directory that
    // moves, or a match that stops matching, turns this file into a test
    // that checks nothing and reports success.
    const allocating = shellScripts().filter((s) => allocatesContainer(s.body));
    expect(allocating.length).toBeGreaterThan(0);
    // Both by name. Naming only one lets the guard silently lose the
    // other — which is not hypothetical: `with-temp-pg.sh` was found to
    // have the identical defect by this file, not by reading.
    expect(allocating.map((s) => s.path)).toContain("scripts/test-pg.sh");
    expect(allocating.map((s) => s.path)).toContain(
      "packages/server/scripts/with-temp-pg.sh",
    );
  });

  it("traps INT, TERM and HUP, not EXIT alone", () => {
    for (const script of shellScripts()) {
      if (!allocatesContainer(script.body)) continue;
      const lines = trapLines(script.body);
      const traps = lines.map((t) => t.signals).join(" ");
      expect(traps, `${script.path} has no trap at all`).not.toBe("");
      // HUP alongside the other two: a runner tearing its session down
      // ends the script without exiting, and an untrapped fatal signal
      // does not run the EXIT trap.
      for (const signal of ["EXIT", "INT", "TERM", "HUP"]) {
        expect(
          traps.includes(signal),
          `${script.path} allocates a container but its trap does not cover ${signal}, so a killed run leaks it`,
        ).toBe(true);
      }
    }
  });

  it("exits from each signal handler rather than resuming", () => {
    /**
     * The decisive half, and the one nothing else here covers: reverting
     * `trap 'cleanup; exit 143' TERM` to `trap cleanup TERM` leaves every
     * other assertion in this file green while reintroducing the exact
     * behavior that was observed — the handler tears the container down
     * and the script carries on from where it was interrupted, in one
     * case polling for the container it had just removed.
     *
     * A bare `trap cleanup EXIT` is right and is not matched here: the
     * EXIT trap fires on the way out and has nothing to resume.
     */
    for (const script of shellScripts()) {
      if (!allocatesContainer(script.body)) continue;
      const signalTraps = trapLines(script.body)
        .filter((t) => /\b(INT|TERM|HUP)\b/.test(t.signals))
        // `trap "" INT TERM HUP` disarms rather than handles, and is the
        // correct first statement of a cleanup that must not be re-entered
        // mid-teardown. It has nothing to exit from.
        .filter((t) => !isDisarm(t.handler));
      expect(
        signalTraps.length,
        `${script.path} registers no INT/TERM/HUP trap`,
      ).toBeGreaterThan(0);
      for (const { handler, signals } of signalTraps) {
        // 128 + signal number, per signal named on the line. `exit 0`
        // would satisfy a bare "does it exit" check while telling a
        // caller the run succeeded — a cancelled matrix reported green.
        for (const [name, status] of Object.entries(EXPECTED_STATUS)) {
          if (!new RegExp(`\\b${name}\\b`).test(signals)) continue;
          expect(
            new RegExp(`\\bexit\\s+${String(status)}\\b`).test(handler),
            `${script.path} traps ${name} with \`${handler}\`, which does not exit ${String(status)} (128 + the signal number). A handler that returns resumes the script after tearing its resources down; one that exits 0 reports a cancelled run as a success.`,
          ).toBe(true);
        }
      }
    }
  });

  it("backgrounds its long-running command and waits on that command's own pid", () => {
    /**
     * Trapping the signal is not enough, which is what the first version
     * of this file missed: **bash defers a trap until the foreground
     * command finishes**. With the suite in the foreground a `TERM` was
     * recorded and not acted on, the runner's grace period expired, and
     * the `KILL` that followed ran no trap at all. Measured: fifteen
     * seconds after a `TERM` the script was still running tests, and the
     * `KILL` left both containers, the network and fourteen vitest
     * processes behind.
     *
     * **Tied to the long command's own pid, not to any `wait` in the
     * file.** The first version of this check was one regex match
     * anywhere in the script, which the pre-pull step's
     * `wait "${PULL_PID}"` satisfied on its own — so reverting the suite
     * to a foreground `pnpm test` left the guard green while restoring
     * the entire defect. Every spawn below is matched to the variable its
     * `$!` was assigned to and to a `wait` on that same variable.
     *
     * The blind spot that remains: the pattern requires a named variable,
     * so `cmd & wait $!` is rejected, but `PID=$!` where the spawn is a
     * pipeline (`cmd | tee log & PID=$!; wait "$PID"`) is accepted and is
     * worse than the foreground form — `$!` is the pipeline's last stage,
     * so `wait` reports `tee`'s status and a failure in `cmd` is dropped
     * even under `pipefail`. If a script here needs to tee, read
     * `PIPESTATUS` rather than the wait's status.
     */
    for (const script of shellScripts()) {
      if (!allocatesContainer(script.body)) continue;
      const lines = script.body.split("\n");

      // The commands these scripts exist to run, and the only ones long
      // enough for a signal to land during. Asserted non-empty below, so
      // a script that stops matching fails rather than passing silently.
      const isLongCommand = (line: string): boolean =>
        /(^|\s)pnpm\s+test(\s|$)/.test(line) || /^\s*"\$@"/.test(line);

      const spawns = lines
        .map((line, i) => ({ line, i }))
        .filter(({ line }) => isLongCommand(line) && !/^\s*#/.test(line));
      expect(
        spawns.length,
        `${script.path} allocates a container but this test found no long-running command in it, so it is checking nothing`,
      ).toBeGreaterThan(0);

      for (const { line, i } of spawns) {
        expect(
          /&\s*$/.test(line),
          `${script.path}:${String(i + 1)} runs its long-running command in the foreground (\`${line.trim()}\`), so every trap is deferred until it returns`,
        ).toBe(true);

        // The very next statement must capture that spawn's pid.
        const next = (lines[i + 1] ?? "").trim();
        const captured = /^([A-Za-z_][A-Za-z0-9_]*)=\$!$/.exec(next);
        expect(
          captured,
          `${script.path}:${String(i + 2)} does not capture the spawn's pid (\`${next}\`); without it the cleanup cannot signal what it started`,
        ).not.toBeNull();

        const variable = captured?.[1] ?? "";
        const waitsOnIt = new RegExp(
          `^\\s*wait\\s+"?\\$\\{?${variable}\\b`,
          "m",
        ).test(script.body);
        expect(
          waitsOnIt,
          `${script.path} captures the spawn into ${variable} but never waits on it. A wait elsewhere in the file does not help: the trap stays deferred for as long as this command runs.`,
        ).toBe(true);
      }
    }
  });
});
