import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("..", import.meta.url));
const PRAGMA =
  "/** @jsxRuntime automatic */\n/** @jsxImportSource hono/jsx */\n";

function tsxFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory())
      return entry.name === "node_modules" ? [] : tsxFiles(path);
    return entry.name.endsWith(".tsx") ? [path] : [];
  });
}

// Tests that start a child with `node --import tsx` from outside this package
// read no tsconfig, so each file names its JSX runtime itself.
describe("the JSX pragma", () => {
  it("opens every .tsx file in the server", () => {
    const files = tsxFiles(SRC);
    expect(files.length).toBeGreaterThan(0);
    const missing = files
      .filter((file) => !readFileSync(file, "utf8").startsWith(PRAGMA))
      .map((file) => relative(SRC, file));
    expect(missing).toEqual([]);
  });
});
