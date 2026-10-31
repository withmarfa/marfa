import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, relative, sep } from "node:path";
import type { Reporter, TestModule } from "vitest/node";

/**
 * Writes how long each test file took, in seconds by its path from the
 * package root, to the file `MARFA_SHARD_TIMES` names, and does nothing when
 * that is unset. `scripts/shard-drift.ts` reads it to compare the times with
 * `shard-weights.ts`. The time is the one the default reporter prints for the
 * file: its tests and hooks.
 */
export default class ShardTimes implements Reporter {
  onTestRunEnd(modules: ReadonlyArray<TestModule>): void {
    const target = process.env.MARFA_SHARD_TIMES;
    if (target === undefined || target === "") return;
    const seconds: Record<string, number> = {};
    for (const module of modules) {
      const path = relative(process.cwd(), module.moduleId)
        .split(sep)
        .join("/");
      seconds[path] = module.diagnostic().duration / 1000;
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, `${JSON.stringify(seconds, null, 2)}\n`);
  }
}
