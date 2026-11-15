/**
 * Deletes the Actions caches no later run will read, so that the repository
 * stays under GitHub's size limit with room to spare.
 *
 * A cache is named by a hash of what it holds, so a change to the inputs
 * saves a new one and leaves the old one beside it until it goes unread for
 * seven days. A push to `main` can change a key, and a day of pushes left
 * more than a gigabyte of binaries nothing would restore again. This keeps
 * the newest few of each kind and deletes the rest, and a cache saved from
 * any ref but `main`, which only that ref can read, once it is a day old.
 * A cache of `main` whose key it does not recognize is never touched.
 *
 *   node scripts/prune-caches.ts [--dry-run]
 *
 * Needs `gh` signed in with `actions: write`, and `GITHUB_REPOSITORY`.
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export interface Cache {
  id: number;
  key: string;
  ref: string;
  created_at: string;
  size_in_bytes: number;
}

interface Family {
  /** What the family holds, for the report. */
  what: string;
  /** The key without its hash: group 1 names the family. */
  key: RegExp;
  /** How many of the newest to keep. */
  keep: number;
}

const HASH = "[0-9a-f]{64}";

/**
 * Kept by what a restore can ask for. A pull request restores by the exact key
 * of `main`'s current tree, so the newest is the one that is read, and the
 * others are for a run that started before it was saved.
 */
export const FAMILIES: readonly Family[] = [
  // `Swatinem/rust-cache`: a job's dependencies, keyed by the toolchain and the
  // lockfiles. A new lockfile saves a whole new cache of a gigabyte or more,
  // and a restore falls back to the newest of the job, so one is enough.
  {
    what: "a job's Rust dependencies",
    key: /^(v0-rust-.+-(?:Linux|macOS|Darwin|Windows)-(?:x64|arm64))-[0-9a-f]{8}-[0-9a-f]{8}$/,
    keep: 1,
  },
  {
    what: "the server built with the test hooks",
    key: new RegExp(`^(marfa-rust-server-hooks-[A-Za-z]+)-${HASH}$`),
    keep: 3,
  },
  {
    what: "the server built for release",
    key: new RegExp(`^(marfa-rust-server-release-[A-Za-z]+)-${HASH}$`),
    keep: 3,
  },
  {
    what: "the marfa command line the device fixtures drive",
    key: new RegExp(`^(marfa-rust-contract-[A-Za-z]+)-${HASH}$`),
    keep: 3,
  },
  {
    what: "the Node module the device fixtures drive",
    key: new RegExp(`^(marfa-rust-contract-module-[A-Za-z]+)-${HASH}$`),
    keep: 3,
  },
  {
    what: "the native build image",
    key: /^(marfa-native-image-[A-Za-z]+)-[0-9a-f]{16}$/,
    keep: 2,
  },
  {
    what: "the native readers' downloads and PDFium library",
    key: new RegExp(`^(marfa-native-[A-Za-z]+)-${HASH}$`),
    keep: 2,
  },
  {
    what: "the pnpm store",
    key: new RegExp(`^(node-cache-[A-Za-z]+-[A-Za-z0-9]+-pnpm)-${HASH}$`),
    keep: 2,
  },
];

/** A cache saved from another ref is read by that ref alone. */
const OTHER_REF_DAYS = 1;

export interface Removal {
  cache: Cache;
  reason: string;
}

/** What to delete, given every cache and the time. */
export function plan(caches: readonly Cache[], now: Date): Removal[] {
  const removals: Removal[] = [];
  const kept: Cache[] = [];
  for (const cache of caches) {
    const age = now.getTime() - Date.parse(cache.created_at);
    if (cache.ref !== "refs/heads/main") {
      if (age > OTHER_REF_DAYS * 86_400_000) {
        removals.push({
          cache,
          reason: `saved from ${cache.ref}, which only that ref reads`,
        });
      }
      continue;
    }
    kept.push(cache);
  }

  const families = new Map<string, { family: Family; caches: Cache[] }>();
  for (const cache of kept) {
    for (const family of FAMILIES) {
      const name = family.key.exec(cache.key)?.[1];
      if (name === undefined) continue;
      const group = families.get(name) ?? { family, caches: [] };
      group.caches.push(cache);
      families.set(name, group);
      break;
    }
  }
  for (const [name, { family, caches: group }] of families) {
    const newestFirst = [...group].sort(
      (a, b) =>
        Date.parse(b.created_at) - Date.parse(a.created_at) || b.id - a.id,
    );
    for (const cache of newestFirst.slice(family.keep)) {
      removals.push({
        cache,
        reason: `${family.what}: ${name} keeps its newest ${String(family.keep)}`,
      });
    }
  }
  return removals.sort((a, b) => a.cache.id - b.cache.id);
}

function gh(...args: string[]): string {
  return execFileSync("gh", args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** `gh` reports an HTTP error as `gh: <message> (HTTP <status>)` on stderr. */
export function isNotFound(error: unknown): boolean {
  const stderr = (error as { stderr?: unknown }).stderr;
  return typeof stderr === "string" && /\(HTTP 404\)/.test(stderr);
}

function megabytes(bytes: number): string {
  return `${String(Math.round(bytes / 1048576))} MB`;
}

function main(): void {
  const dryRun = process.argv.includes("--dry-run");
  const repository = process.env.GITHUB_REPOSITORY;
  if (!repository) throw new Error("GITHUB_REPOSITORY is not set");

  const caches = gh(
    "api",
    "--paginate",
    `repos/${repository}/actions/caches?per_page=100`,
    "--jq",
    ".actions_caches[]",
  )
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Cache);
  const total = caches.reduce((sum, cache) => sum + cache.size_in_bytes, 0);
  console.log(`${String(caches.length)} caches, ${megabytes(total)}`);

  const removals = plan(caches, new Date());
  let failed = 0;
  let freed = 0;
  for (const { cache, reason } of removals) {
    const label = `${megabytes(cache.size_in_bytes)}  ${cache.key}  (${reason})`;
    if (dryRun) {
      console.log(`would delete ${label}`);
      freed += cache.size_in_bytes;
      continue;
    }
    try {
      gh(
        "api",
        "--method",
        "DELETE",
        `repos/${repository}/actions/caches/${String(cache.id)}`,
      );
      console.log(`deleted ${label}`);
      freed += cache.size_in_bytes;
    } catch (error) {
      // GitHub evicted it first, which is what this run wanted.
      if (isNotFound(error)) {
        console.log(`already gone ${label}`);
        freed += cache.size_in_bytes;
        continue;
      }
      failed += 1;
      console.error(`could not delete ${label}: ${String(error)}`);
    }
  }
  console.log(
    `${dryRun ? "would free" : "freed"} ${megabytes(freed)} of ${megabytes(total)}`,
  );
  if (failed > 0) process.exitCode = 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
