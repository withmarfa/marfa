/**
 * The repository's Actions caches share a size limit, and a key that changes
 * with its inputs leaves the last one behind. `scripts/prune-caches.ts` keeps
 * the newest few of each kind and deletes the rest; `cache-upkeep.yml` runs it
 * each day. Nothing here reaches GitHub: the script runs against a stand-in
 * for `gh`.
 */
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse } from "yaml";
import { afterAll, describe, expect, it } from "vitest";
import { type Cache, FAMILIES, plan } from "../scripts/prune-caches.js";

const ROOT = resolve(import.meta.dirname, "..");
const SCRIPT = join(ROOT, "scripts", "prune-caches.ts");
const NOW = new Date("2026-11-15T12:00:00Z");

const hash = (seed: string, length = 64) =>
  seed.repeat(length).slice(0, length);
let nextId = 1;
function cache(
  key: string,
  hoursAgo: number,
  ref = "refs/heads/main",
  megabytes = 10,
): Cache {
  return {
    id: nextId++,
    key,
    ref,
    created_at: new Date(NOW.getTime() - hoursAgo * 3_600_000).toISOString(),
    size_in_bytes: megabytes * 1048576,
  };
}
const removed = (caches: Cache[]) =>
  plan(caches, NOW)
    .map(({ cache: c }) => c.key)
    .sort();

describe("which caches are deleted", () => {
  it("keeps the newest of a kind and deletes the older ones, whatever order they are listed in", () => {
    const device = (seed: string, hoursAgo: number) =>
      cache(`marfa-rust-contract-Linux-${hash(seed)}`, hoursAgo);
    const four = [
      device("a", 1),
      device("b", 5),
      device("c", 3),
      device("d", 9),
    ];
    expect(removed(four)).toEqual([`marfa-rust-contract-Linux-${hash("d")}`]);
    expect(removed([...four].reverse())).toEqual(removed(four));
    // The witness: the same four are all kept once the rule allows four.
    expect(removed(four.slice(0, 3))).toEqual([]);
  });

  it("keeps one dependency cache of each job, system and architecture, whatever the lockfile", () => {
    const rust = (job: string, os: string, lock: string, hoursAgo: number) =>
      cache(
        `v0-rust-${job}-${os}-x64-79ee1a6a-${lock}`,
        hoursAgo,
        undefined,
        1000,
      );
    const kept = rust("core-checks-linux", "Linux", "6002cadb", 2);
    const old = rust("core-checks-linux", "Linux", "fd4e1dea", 30);
    const other = rust("core-fault-injection", "Linux", "fd4e1dea", 60);
    const mac = cache("v0-rust-core-checks-Darwin-arm64-009b2da3-6002cadb", 90);
    expect(plan([kept, old, other, mac], NOW).map((r) => r.cache)).toEqual([
      old,
    ]);
  });

  it("counts a server built with the hooks and one built for release apart", () => {
    const hooked = [1, 2, 3, 4].map((hours) =>
      cache(`marfa-rust-server-hooks-Linux-${hash(String(hours))}`, hours),
    );
    const released = [1, 2].map((hours) =>
      cache(`marfa-rust-server-release-Linux-${hash(String(hours))}`, hours),
    );
    expect(plan([...hooked, ...released], NOW).map((r) => r.cache)).toEqual([
      hooked[3],
    ]);
  });

  it("deletes what another ref saved once it is a day old, and not before", () => {
    const fresh = cache("a-branch-key", 2, "refs/pull/9/merge");
    const stale = cache("a-branch-key-2", 30, "refs/heads/feature");
    expect(plan([fresh, stale], NOW).map((r) => r.cache)).toEqual([stale]);
  });

  it("never touches a key it does not recognize on main, however old", () => {
    const strange = [
      cache("codeql-overlay-base-database-1-abc-javascript-2.27.4-def", 400),
      cache("marfa-rust-contract-Linux-not-a-hash", 400),
      cache("something-else", 400),
    ];
    expect(plan(strange, NOW)).toEqual([]);
  });

  it("recognizes every key the workflows save, so that none is left to pile up", () => {
    // The witness: a key of each kind, written as the workflows write it.
    const keys = [
      `v0-rust-core-checks-Darwin-arm64-009b2da3-6002cadb`,
      `marfa-rust-server-hooks-Linux-${hash("1")}`,
      `marfa-rust-server-release-Linux-${hash("1")}`,
      `marfa-rust-contract-Linux-${hash("1")}`,
      `marfa-rust-contract-module-Linux-${hash("1")}`,
      `marfa-native-image-Linux-${hash("1", 16)}`,
      `marfa-native-Linux-${hash("1")}`,
      `node-cache-Linux-x64-pnpm-${hash("1")}`,
    ];
    for (const key of keys) {
      expect(
        FAMILIES.filter((family) => family.key.test(key)),
        key,
      ).toHaveLength(1);
    }
    expect(keys).toHaveLength(FAMILIES.length);
  });

  it("has a family for every key a workflow writes, so that a new cache is not left to pile up", () => {
    const written = readdirSync(join(ROOT, ".github"), {
      recursive: true,
      encoding: "utf8",
    })
      .filter((file) => /\.ya?ml$/.test(file))
      .flatMap((file) =>
        [
          ...readFileSync(join(ROOT, ".github", file), "utf8").matchAll(
            /key=(marfa-[\w-]*)\$RUNNER_OS/g,
          ),
        ].map((match) => match[1] ?? ""),
      );
    // The witness: the workflows write these, and the search finds them.
    expect([...new Set(written)].sort()).toEqual([
      "marfa-native-",
      "marfa-native-image-",
      "marfa-rust-contract-",
      "marfa-rust-contract-module-",
      "marfa-rust-server-hooks-",
      "marfa-rust-server-release-",
    ]);
    for (const prefix of new Set(written)) {
      const samples = [hash("1"), hash("1", 16)].map(
        (suffix) => `${prefix}Linux-${suffix}`,
      );
      expect(
        samples.some((sample) =>
          FAMILIES.some((family) => family.key.test(sample)),
        ),
        `no family prunes ${prefix}`,
      ).toBe(true);
    }
  });
});

describe("scripts/prune-caches.ts", () => {
  const scratch = mkdtempSync(join(tmpdir(), "marfa-prune-caches-"));
  afterAll(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  const listing = [
    ...[1, 2, 3, 4, 5].map((hours) => ({
      id: 100 + hours,
      key: `marfa-rust-contract-Linux-${hash(String(hours))}`,
      ref: "refs/heads/main",
      created_at: new Date(Date.now() - hours * 3_600_000).toISOString(),
      size_in_bytes: 16 * 1048576,
    })),
    {
      id: 200,
      key: "docker.io--tonistiigi--binfmt-latest-linux-x64",
      ref: "refs/heads/some-branch",
      created_at: new Date(Date.now() - 5 * 86_400_000).toISOString(),
      size_in_bytes: 31 * 1048576,
    },
  ];

  /** Runs the script with a `gh` that serves the listing and records what it is asked to delete. */
  function run(args: string[], failDelete?: { id: number; error: string }) {
    const bin = mkdtempSync(join(scratch, "bin-"));
    const calls = join(bin, "calls.txt");
    writeFileSync(
      join(bin, "listing.jsonl"),
      listing.map((c) => JSON.stringify(c)).join("\n"),
    );
    writeFileSync(
      join(bin, "gh"),
      [
        "#!/bin/sh",
        `echo "$*" >> "${calls}"`,
        'case "$*" in',
        `  *"--method DELETE"*${failDelete === undefined ? "NEVER" : `"caches/${String(failDelete.id)}"`}) echo "${failDelete?.error ?? ""}" >&2; exit 1 ;;`,
        '  *"--method DELETE"*) exit 0 ;;',
        `  api*"--paginate"*) cat "${join(bin, "listing.jsonl")}" ;;`,
        '  *) echo "unexpected: $*" >&2; exit 97 ;;',
        "esac",
        "",
      ].join("\n"),
    );
    chmodSync(join(bin, "gh"), 0o755);
    let status = 0;
    let output: string;
    try {
      output = execFileSync("node", [SCRIPT, ...args], {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH ?? ""}`,
          GITHUB_REPOSITORY: "example/repo",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      const failed = error as { status: number; stdout: string };
      status = failed.status;
      output = failed.stdout;
    }
    let recorded: string[] = [];
    try {
      recorded = readFileSync(calls, "utf8").trim().split("\n");
    } catch {
      // Nothing was called.
    }
    return { status, output, calls: recorded };
  }

  it("deletes the older caches of a kind and a branch's old cache, and nothing else", () => {
    const { status, calls, output } = run([]);
    expect(status).toBe(0);
    expect(
      calls
        .filter((call) => call.includes("DELETE"))
        .map((call) => call.replace(/^.*caches\//, ""))
        .sort(),
    ).toEqual(["104", "105", "200"]);
    expect(output).toContain("freed 63 MB of 111 MB");
  });

  it("deletes nothing on a dry run, and says what it would", () => {
    const { status, calls, output } = run(["--dry-run"]);
    expect(status).toBe(0);
    expect(calls.filter((call) => call.includes("DELETE"))).toEqual([]);
    expect(output).toContain("would delete");
    expect(output).toContain("would free 63 MB of 111 MB");
  });

  it("fails the run when a cache cannot be deleted, after trying the others", () => {
    const { status, calls } = run([], {
      id: 104,
      error: "gh: Internal Server Error (HTTP 500)",
    });
    expect(status).toBe(1);
    expect(calls.filter((call) => call.includes("DELETE"))).toHaveLength(3);
  });

  it("counts a cache GitHub already evicted as deleted, says so, and goes on", () => {
    const { status, calls, output } = run([], {
      id: 104,
      error: "gh: Not Found (HTTP 404)",
    });
    expect(status).toBe(0);
    expect(calls.filter((call) => call.includes("DELETE"))).toHaveLength(3);
    expect(output).toMatch(/already gone .*marfa-rust-contract-Linux/);
    expect(output).toContain("freed 63 MB of 111 MB");
  });
});

describe("the workflow that runs it", () => {
  const workflow = parse(
    readFileSync(
      join(ROOT, ".github", "workflows", "cache-upkeep.yml"),
      "utf8",
    ),
  ) as {
    on: Record<string, unknown>;
    permissions?: Record<string, string>;
    jobs: Record<
      string,
      {
        permissions?: Record<string, string>;
        steps: { run?: string; env?: Record<string, string> }[];
      }
    >;
  };

  it("runs each day, and by hand with a dry run", () => {
    expect(workflow.on).toHaveProperty("schedule");
    expect(workflow.on).toHaveProperty("workflow_dispatch");
    expect(workflow.on).not.toHaveProperty("pull_request");
    expect(workflow.on).not.toHaveProperty("push");
  });

  it("may delete caches in the one job that does, and nowhere else", () => {
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(workflow.jobs.prune?.permissions).toEqual({
      contents: "read",
      actions: "write",
    });
    expect(workflow.jobs["report-failure"]?.permissions?.actions).toBe("read");
  });

  it("runs the script with the workflow's own token, and passes a dry run on", () => {
    const step = workflow.jobs.prune?.steps.find((s) =>
      s.run?.includes("scripts/prune-caches.ts"),
    );
    expect(step?.env?.GH_TOKEN).toBe("${{ github.token }}");
    expect(step?.run).toContain("--dry-run");
  });

  it("is the only workflow that holds `actions: write` for a cache, besides the run-stopping jobs", () => {
    const holders = readdirSync(join(ROOT, ".github", "workflows"))
      .filter((file) => file.endsWith(".yml"))
      .filter((file) =>
        /^\s+actions: write$/m.test(
          readFileSync(join(ROOT, ".github", "workflows", file), "utf8"),
        ),
      )
      .sort();
    expect(holders).toEqual(["cache-upkeep.yml", "ci.yml"]);
  });
});
