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

describe("a script that starts a container releases it when killed", () => {
  it("finds the scripts it is meant to be checking", () => {
    // The guard this test most needs is against itself: a directory that
    // moves, or a match that stops matching, turns this file into a test
    // that checks nothing and reports success.
    const allocating = shellScripts().filter((s) => allocatesContainer(s.body));
    expect(allocating.length).toBeGreaterThan(0);
    expect(allocating.map((s) => s.path)).toContain("scripts/test-pg.sh");
  });

  it("traps INT and TERM, not EXIT alone", () => {
    for (const script of shellScripts()) {
      if (!allocatesContainer(script.body)) continue;
      const traps = [...script.body.matchAll(/^\s*trap\s+\S+\s+([^\n]*)$/gm)]
        .map((m) => m[1] ?? "")
        .join(" ");
      expect(traps, `${script.path} has no trap at all`).not.toBe("");
      for (const signal of ["EXIT", "INT", "TERM"]) {
        expect(
          traps.includes(signal),
          `${script.path} allocates a container but its trap does not cover ${signal}, so a killed run leaks it`,
        ).toBe(true);
      }
    }
  });
});
