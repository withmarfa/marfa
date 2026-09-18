/**
 * Lint Drizzle SQLite migrations for the `--> statement-breakpoint` marker.
 *
 * Background: Drizzle's libsql migrator splits each `.sql` file on the
 * literal marker `--> statement-breakpoint` and runs each chunk through
 * `client.execute(chunk)`. libsql's `execute` is single-statement —
 * if a chunk contains multiple `;`-terminated statements, ONLY THE FIRST
 * RUNS. Trailing statements are silently dropped without an error.
 *
 * Drizzle's libsql migrator splits on the marker, so a migration file
 * that writes two `;`-terminated statements without a breakpoint between
 * them silently drops all but the first — as "column never created" /
 * "table never dropped", surfacing far downstream from the migration
 * itself.
 *
 * This linter runs over `packages/server/drizzle/sqlite/*.sql`,
 * splits each file on `--> statement-breakpoint`, and asserts that
 * every chunk contains at most one statement (one terminating `;`
 * outside of strings and comments). A non-zero exit code carries the
 * list of offending files / chunks.
 *
 * Runs in CI on every PR (see `.github/workflows/ci.yml` —
 * `sqlite-migrations-lint` job).
 *
 * Run manually: `pnpm --filter @withmarfa/server lint:sqlite-migrations`
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, "..", "drizzle", "sqlite");

/**
 * Strip SQL comments and string/identifier literals from a SQL chunk
 * so that only "real" tokens remain. The output is used solely to
 * count `;` terminators — we don't try to reconstruct valid SQL.
 *
 * Handles:
 *   - `--` line comments (to end of line)
 *   - `/* … *\/` block comments (non-nesting)
 *   - `'…'` string literals with `''` escapes
 *   - `"…"` quoted identifiers with `""` escapes
 *
 * Any `;` inside these is removed alongside the surrounding content.
 */
function stripCommentsAndLiterals(sql: string): string {
  const out: string[] = [];
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    const next = sql[i + 1];

    // Line comment: `-- … <newline>`
    if (c === "-" && next === "-") {
      while (i < n && sql[i] !== "\n") i += 1;
      continue;
    }

    // Block comment: `/* … */`
    if (c === "/" && next === "*") {
      i += 2;
      while (i < n && !(sql[i] === "*" && sql[i + 1] === "/")) i += 1;
      if (i < n) i += 2; // consume closing `*/`
      continue;
    }

    // String literal: `'…'`, with `''` as an embedded quote
    if (c === "'") {
      i += 1;
      while (i < n) {
        if (sql[i] === "'" && sql[i + 1] === "'") {
          i += 2;
          continue;
        }
        if (sql[i] === "'") {
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }

    // Quoted identifier: `"…"`, with `""` as embedded quote
    if (c === '"') {
      i += 1;
      while (i < n) {
        if (sql[i] === '"' && sql[i + 1] === '"') {
          i += 2;
          continue;
        }
        if (sql[i] === '"') {
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }

    if (c !== undefined) out.push(c);
    i += 1;
  }
  return out.join("");
}

function countTerminators(chunk: string): number {
  const stripped = stripCommentsAndLiterals(chunk);
  let count = 0;
  for (const c of stripped) if (c === ";") count += 1;
  return count;
}

interface Offense {
  file: string;
  chunkIndex: number;
  terminatorCount: number;
  preview: string;
}

function lintFile(absPath: string, relPath: string): Offense[] {
  const content = readFileSync(absPath, "utf8");
  const chunks = content.split("--> statement-breakpoint");
  const offenses: Offense[] = [];
  for (let idx = 0; idx < chunks.length; idx += 1) {
    const chunk = chunks[idx] ?? "";
    const count = countTerminators(chunk);
    if (count > 1) {
      offenses.push({
        file: relPath,
        chunkIndex: idx,
        terminatorCount: count,
        preview: chunk.trim().slice(0, 200),
      });
    }
  }
  return offenses;
}

function main(): void {
  const entries = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const offenses: Offense[] = [];
  for (const f of entries) {
    const rel = `packages/server/drizzle/sqlite/${f}`;
    offenses.push(...lintFile(join(MIGRATIONS_DIR, f), rel));
  }

  if (offenses.length === 0) {
    console.log(
      `✓ All ${String(entries.length)} SQLite migration files have correct \`--> statement-breakpoint\` separators.`,
    );
    return;
  }

  console.error(
    `✗ Found ${String(offenses.length)} migration chunk(s) with multiple statements missing the \`--> statement-breakpoint\` marker.\n`,
  );
  console.error(
    "Drizzle's libsql migrator splits each .sql file on `--> statement-breakpoint` and runs each chunk via\n" +
      "libsql's single-statement `execute()`. Multiple `;`-terminated statements in one chunk silently drop\n" +
      "all but the first — each chunk must contain exactly one `;`-terminated statement.\n",
  );
  for (const o of offenses) {
    console.error(
      `  ${o.file} — chunk ${String(o.chunkIndex + 1)} has ${String(o.terminatorCount)} statements`,
    );
    const previewLine = o.preview.replace(/\n+/g, " ⏎ ");
    console.error(
      `    preview: ${previewLine}${o.preview.length === 200 ? "…" : ""}`,
    );
  }
  console.error(
    "\nFix: insert `--> statement-breakpoint` between each `;`-terminated statement in the offending chunks.",
  );
  process.exit(1);
}

main();
