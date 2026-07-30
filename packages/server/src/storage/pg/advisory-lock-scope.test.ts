/**
 * No session-scoped advisory lock in the Postgres storage layer.
 *
 * `pg_advisory_lock` needs a session, and a pooled endpoint is not one.
 * Behind a transaction-mode pooler every bare statement is its own
 * transaction, so the acquire lands on whichever backend was free and the
 * matching unlock need not reach it. Measured against PgBouncer, that
 * shape lets two callers hold one lock and leaves a lock alive past the
 * client that took it — see `coordination-store-pooler.test.ts`, which
 * pins both the premise and the fix.
 *
 * The hosted container runs `MARFA_DB_POOL_MODE=transaction`, so the wrong
 * primitive is wrong everywhere it appears here, and it appeared twice:
 * once in the coordination store and once in the boot-time bootstrap,
 * where the second survived the pull request that fixed the first.
 *
 * A grep is a blunt test and it is the right one. The failure it guards is
 * someone reaching for the familiar name, and no behavioural test on a
 * direct endpoint can tell the two primitives apart — that is exactly why
 * this survived the first fix.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const HERE = new URL(".", import.meta.url).pathname;

/**
 * The one deliberate exception carries this marker on the line above it.
 * Marking rather than exempting the file keeps the guard useful: a new
 * session-scoped lock in the same file still fails.
 */
const ALLOW_MARKER = "session-scoped-by-design";

/** Every `.ts` in this directory that is not itself a test. */
function sourceFiles(): string[] {
  return readdirSync(HERE)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .map((f) => join(HERE, f));
}

describe("advisory locks in the pg layer", () => {
  it("are transaction-scoped, never session-scoped", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      const text = readFileSync(file, "utf8");
      for (const [i, line] of text.split("\n").entries()) {
        // Match the call, not the word: the comments here discuss
        // `pg_advisory_lock` by name precisely to explain why it is wrong.
        if (!/pg_(try_)?advisory(_unlock)?\s*\(/.test(line)) continue;
        if (line.includes("pg_advisory_xact_lock")) continue;
        const prev = text.split("\n")[i - 1] ?? "";
        if (prev.includes(ALLOW_MARKER) || line.includes(ALLOW_MARKER))
          continue;
        offenders.push(`${file.split("/").pop() ?? file}:${String(i + 1)}`);
      }
    }
    expect(
      offenders,
      `session-scoped advisory lock found; use pg_advisory_xact_lock inside an explicit transaction:\n  ${offenders.join("\n  ")}`,
    ).toEqual([]);
  });

  it("still uses the transaction-scoped form somewhere, so the check above is not vacuous", () => {
    const used = sourceFiles().some((f) =>
      readFileSync(f, "utf8").includes("pg_advisory_xact_lock"),
    );
    expect(used).toBe(true);
  });
});
