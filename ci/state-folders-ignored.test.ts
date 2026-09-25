import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));

/** Whether `.gitignore` ignores a path, whatever the tree holds there. */
function ignored(path: string): boolean {
  const checked = spawnSync("git", ["check-ignore", "-q", "--no-index", path], {
    cwd: root,
  });
  if (checked.status !== 0 && checked.status !== 1) {
    throw new Error(`git check-ignore failed: ${String(checked.stderr)}`);
  }
  return checked.status === 0;
}

/**
 * A local server's state folder holds its keys. The boot scripts write a
 * `.gitignore` into the folder whatever `--state` names it; this holds the
 * root rule for a folder under the names in use made any other way.
 */
describe("a local server's state folder", () => {
  it("is ignored under any name with the prefix, at any depth", () => {
    for (const path of [
      ".marfa-state/env",
      "conformance/.marfa-state/env",
      "conformance/.marfa-state-s7r/env",
      "conformance/.marfa-state-s7r/blobs/ab/cd",
      "packages/server/.marfa-state.second/server.log",
    ]) {
      expect(ignored(path), `${path} is committable`).toBe(true);
    }
  });

  it("leaves a path without the prefix alone", () => {
    // The witness: the check answers false for a path the rule does not
    // name, so the answers above are the rule's.
    for (const path of [
      "conformance/marfa-state-s7r/env",
      "conformance/src/marfa-state.ts",
    ]) {
      expect(ignored(path), `${path} is ignored`).toBe(false);
    }
  });
});
