import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));

/** The tracked files whose text names `needle`. */
function namingFiles(needle: string): string[] {
  const listed = execFileSync("git", ["ls-files", "-z"], {
    cwd: root,
    maxBuffer: 64 * 1024 * 1024,
  })
    .toString("utf8")
    .split("\0")
    .filter((path) => path !== "");
  const found: string[] = [];
  for (const path of listed) {
    if (
      path.endsWith(".png") ||
      path.endsWith(".ico") ||
      path.endsWith(".woff2")
    )
      continue;
    let text: string;
    try {
      text = readFileSync(`${root}${path}`, "utf8");
    } catch {
      continue;
    }
    if (text.includes(needle)) found.push(path);
  }
  return found;
}

describe("the test hooks and what is released", () => {
  it("sets none of the hooks in the image, so the released server runs with them off", () => {
    const dockerfile = readFileSync(`${root}deploy/Dockerfile`, "utf8");
    // The environment the image sets, which is what an owner's server starts with.
    const set = [...dockerfile.matchAll(/^ENV\s+((?:.*\\\n)*.*)$/gm)]
      .flatMap((match) => match[1]?.replace(/\\\n/g, " ").split(/\s+/) ?? [])
      .map((pair) => pair.split("=")[0] ?? "")
      .filter((name) => name !== "");
    // The witness: it reads the names the Dockerfile does set.
    expect(set).toContain("SQLITE_PATH");
    expect(set.filter((name) => name.startsWith("MARFA_TEST_"))).toEqual([]);
    expect(dockerfile).not.toContain("MARFA_TEST_HOOKS");

    for (const name of [
      "MARFA_TEST_HOOKS",
      "MARFA_TEST_CLOCK_OFFSET_MS",
      "MARFA_TEST_CONTRACT_VERSION",
    ]) {
      const naming = namingFiles(name);
      // The witness: the scan finds the harness that sets the hooks, so an
      // empty answer below would mean none does.
      expect(naming.some((path) => path.startsWith("conformance/"))).toBe(true);
      for (const path of naming) {
        expect(
          path.startsWith("packages/server/src/") ||
            path.startsWith("core/marfa-server/") ||
            path.startsWith("conformance/") ||
            path === ".env.example" ||
            path === "ci/test-hooks-release.test.ts",
          `${path} names ${name}, which only the server, the conformance harness and the example settings may`,
        ).toBe(true);
      }
    }
  });
});
