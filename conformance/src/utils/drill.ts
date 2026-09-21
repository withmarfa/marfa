/**
 * The restore drill's two pure pieces, kept apart from the script so the
 * offline lane can hold them: the comparison every verdict rests on, and
 * the rewrite that moves the shipped Litestream configuration's replica
 * under a prefix of the drill's own.
 */

/** Whether two values are the same, as JSON: what every "same" line in
 *  the drill's report means. */
export function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * The shipped configuration with its replica path moved under `prefix`.
 * Everything else, the names it expands and the cadences, stays what a
 * deployment runs, so what the drill proves is the recipe. Refuses a file
 * without the one line it rewrites, rather than replicating to `db/` at
 * the bucket's root beside a deployment's own replica.
 */
export function moveReplicaPath(shipped: string, prefix: string): string {
  const line = /^(\s*)path: db$/m;
  if (!line.test(shipped)) {
    throw new Error(
      "the shipped litestream.yml has no replica line `path: db` to move",
    );
  }
  return shipped.replace(line, `$1path: ${prefix}/db`);
}
