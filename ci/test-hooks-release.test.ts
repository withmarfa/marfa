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
  it("sets nothing in the image or the release but NODE_ENV=production, which refuses the hooks", () => {
    const dockerfile = readFileSync(`${root}deploy/Dockerfile`, "utf8");
    // The image is the released server, and its runtime stage is production.
    const runtime = dockerfile.slice(dockerfile.lastIndexOf("AS runtime"));
    expect(runtime).toMatch(/^ENV NODE_ENV=production$/m);

    for (const name of [
      "MARFA_TEST_HOOKS",
      "MARFA_TEST_CLOCK_OFFSET_MS",
      "MARFA_TEST_CONTRACT_VERSION",
      "MARFA_TEST_MIGRATION_FAULT",
      "MARFA_TEST_FREE_DISK_BYTES",
    ]) {
      const naming = namingFiles(name);
      // The witness: the scan finds the harness that sets the hooks, so an
      // empty answer below would mean none does.
      expect(naming.some((path) => path.startsWith("conformance/"))).toBe(true);
      for (const path of naming) {
        expect(
          path.startsWith("packages/server/src/") ||
            path.startsWith("conformance/") ||
            path === ".env.example" ||
            path === "ci/test-hooks-release.test.ts",
          `${path} names ${name}, which only the server, the conformance harness and the example settings may`,
        ).toBe(true);
      }
    }
  });
});
