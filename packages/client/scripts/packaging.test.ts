import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));
const require = createRequire(import.meta.url);

function bin(pkg: string, name: string): string {
  const manifest = require.resolve(`${pkg}/package.json`);
  const bins = (require(manifest) as { bin: Record<string, string> }).bin;
  return join(dirname(manifest), bins[name] ?? name);
}

function run(args: string[]): string {
  return execFileSync(process.execPath, args, {
    cwd: root,
    encoding: "utf8",
    stdio: "pipe",
  }).trim();
}

describe("the published package", () => {
  beforeAll(() => {
    run([bin("tsup", "tsup"), "--silent"]);
  }, 120_000);

  it("loads through require", () => {
    expect(
      run([
        "--input-type=commonjs",
        "-e",
        `console.log(typeof require("@withmarfa/client").createClient)`,
      ]),
    ).toBe("function");
  });

  it("loads through import", () => {
    expect(
      run([
        "--input-type=module",
        "-e",
        `const m = await import("@withmarfa/client"); console.log(typeof m.createClient)`,
      ]),
    ).toBe("function");
  });

  it("type-checks in a CommonJS and an ES module project compiled with node16", () => {
    run([bin("typescript", "tsc"), "-p", "consumers/tsconfig.json"]);
  }, 120_000);
});
