import { existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * The contract test files the Rust server judges, by path from `conformance/`.
 * Every file not listed here is judged by the TypeScript server, as before.
 *
 * A listed file runs in the Rust contract jobs, where one test that does not
 * pass fails the run, and in no TypeScript shard: a run without
 * `MARFA_SERVER_BIN` leaves it out (`withoutRustJudged`). A file is listed
 * once it passes whole on the Rust server, and stays passing.
 */
export const RUST_JUDGED: readonly string[] = [];

/**
 * The globs a run against the TypeScript server leaves out: the judged files.
 * A run against another program (`MARFA_SERVER_BIN`) leaves out none.
 */
export function withoutRustJudged(
  env: Readonly<Record<string, string | undefined>> = process.env,
  judged: readonly string[] = RUST_JUDGED,
): string[] {
  const program = env.MARFA_SERVER_BIN;
  return program === undefined || program === "" ? [...judged] : [];
}

/** The listed paths that name no file under `root`. */
export function missingJudged(
  root: string,
  judged: readonly string[] = RUST_JUDGED,
): string[] {
  return judged.filter((path) => !existsSync(resolve(root, path)));
}
