import { relative, sep } from "node:path";
import { BaseSequencer, type TestSpecification } from "vitest/node";
import { SHARD_SECONDS, UNKNOWN_SECONDS } from "./shard-weights.js";

/** What a file is expected to take, by its path from the package root. */
export function secondsOf(path: string): number {
  return SHARD_SECONDS[path] ?? UNKNOWN_SECONDS;
}

/**
 * Splits files over `count` shards, longest first onto the shard with the
 * least so far. Nothing but the paths and their weights decides where a file
 * goes, so every runner, given the same files, makes the same split and the
 * shards together hold each file once.
 */
export function assignShards(
  paths: readonly string[],
  count: number,
  seconds: (path: string) => number = secondsOf,
): string[][] {
  const shards: string[][] = Array.from({ length: count }, () => []);
  const loads = new Array<number>(count).fill(0);
  const ordered = [...paths].sort(
    (a, b) => seconds(b) - seconds(a) || (a < b ? -1 : 1),
  );
  for (const path of ordered) {
    const lightest = loads.indexOf(Math.min(...loads));
    shards[lightest]?.push(path);
    loads[lightest] = (loads[lightest] ?? 0) + seconds(path);
  }
  return shards;
}

/** The seconds each shard of a split is expected to take. */
export function shardLoads(
  shards: readonly (readonly string[])[],
  seconds: (path: string) => number = secondsOf,
): number[] {
  return shards.map((shard) =>
    shard.reduce((total, path) => total + seconds(path), 0),
  );
}

/**
 * Vitest's own `--shard` hashes each path and gives every shard the same
 * number of files, so a shard that draws two of the five slowest files runs
 * twice as long as the one that draws none. This splits by the time each file
 * takes instead, and only when `--shard` is given.
 */
export default class WeightedShards extends BaseSequencer {
  override shard(files: TestSpecification[]): Promise<TestSpecification[]> {
    const { config } = this.ctx;
    if (config.shard === undefined) return Promise.resolve(files);
    const { index, count } = config.shard;
    const pathOf = (file: TestSpecification) =>
      relative(config.root, file.moduleId).split(sep).join("/");
    const mine = new Set(assignShards(files.map(pathOf), count)[index - 1]);
    return Promise.resolve(files.filter((file) => mine.has(pathOf(file))));
  }
}
