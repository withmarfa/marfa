import { existsSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { TestSpecification, Vitest } from "vitest/node";
import WeightedShards, {
  assignShards,
  secondsOf,
  shardLoads,
} from "./shard-sequencer.js";
import { SHARD_SECONDS, UNKNOWN_SECONDS } from "./shard-weights.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Every file under a suite folder that a project's `include` would run. */
function suiteFiles(suite: string): string[] {
  return readdirSync(resolve(root, "src/suites", suite))
    .filter((name) => name.endsWith(".test.ts"))
    .filter((name) => !name.endsWith(".decision.test.ts"))
    .map((name) => `src/suites/${suite}/${name}`);
}

describe("splitting a project's files over its shards", () => {
  const files = Array.from(
    { length: 40 },
    (_, i) => `src/f${String(i)}.test.ts`,
  );
  const seconds = (path: string) => (path === "src/f0.test.ts" ? 100 : 5);

  it.each([1, 2, 3, 4, 7])(
    "gives every file to exactly one of %i shards",
    (count) => {
      const shards = assignShards(files, count, seconds);
      expect(shards).toHaveLength(count);
      expect(shards.flat().sort()).toEqual([...files].sort());
    },
  );

  it("gives the same answer however the files arrive", () => {
    const forward = assignShards(files, 4, seconds);
    const backward = assignShards([...files].reverse(), 4, seconds);
    expect(backward.map((shard) => [...shard].sort())).toEqual(
      forward.map((shard) => [...shard].sort()),
    );
  });

  it("puts the longest file where nothing else is heavy", () => {
    const [first] = assignShards(files, 4, seconds);
    // 100 seconds against 39 files of 5 seconds over the other three shards.
    expect(first).toEqual(["src/f0.test.ts"]);
    expect(shardLoads(assignShards(files, 4, seconds), seconds)).toEqual([
      100, 65, 65, 65,
    ]);
  });

  it("weighs a file nobody has timed as an ordinary one", () => {
    expect(secondsOf("src/suites/compliance/not-timed-yet.test.ts")).toBe(
      UNKNOWN_SECONDS,
    );
  });
});

describe("the weights", () => {
  it("name only files that exist, so a rename shows here and not as a lopsided shard", () => {
    const missing = Object.keys(SHARD_SECONDS).filter(
      (path) => !existsSync(resolve(root, path)),
    );
    expect(missing).toEqual([]);
  });

  it("name only files of the projects that are split", () => {
    const sharded = new Set([
      ...suiteFiles("compliance"),
      ...suiteFiles("device"),
    ]);
    expect(
      Object.keys(SHARD_SECONDS).filter((path) => !sharded.has(path)),
    ).toEqual([]);
  });
});

describe("the sequencer vitest runs for --shard", () => {
  const files = suiteFiles("compliance");
  const specs = files.map((path) => ({
    moduleId: resolve(root, path),
  })) as TestSpecification[];

  async function shard(index: number, count: number): Promise<string[]> {
    const sequencer = new WeightedShards({
      config: { root, shard: { index, count } },
    } as unknown as Vitest);
    const taken = await sequencer.shard(specs);
    return taken.map((spec) => spec.moduleId);
  }

  it("runs every compliance file in exactly one of the shards", async () => {
    expect(files.length).toBeGreaterThan(100);
    const taken = (
      await Promise.all([1, 2, 3, 4].map((index) => shard(index, 4)))
    ).flat();
    expect(taken.sort()).toEqual(specs.map((spec) => spec.moduleId).sort());
  });

  it("runs the same files for the same shard on every machine", async () => {
    expect(await shard(2, 4)).toEqual(await shard(2, 4));
  });
});
