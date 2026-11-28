import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { oneFileAtATime } from "../vitest.shared.js";

const ROOT = resolve(import.meta.dirname, "..");

describe("the conformance run keeps its files one at a time", () => {
  it("drops the worker count a shell or wrapper sets, which overrides the config", () => {
    const shell: NodeJS.ProcessEnv = {
      PATH: "/usr/bin",
      VITEST_MAX_WORKERS: "4",
    };
    oneFileAtATime(shell);
    expect(shell).toEqual({ PATH: "/usr/bin" });
  });

  it("is called by the conformance config, which sets fileParallelism to false", () => {
    const config = readFileSync(
      resolve(ROOT, "conformance/vitest.config.ts"),
      "utf8",
    );
    expect(config).toMatch(/^oneFileAtATime\(\);$/m);
    expect(config).toMatch(/^\s+fileParallelism: false,$/m);
  });
});
