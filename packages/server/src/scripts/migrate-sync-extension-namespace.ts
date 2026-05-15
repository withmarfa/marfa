/**
 * T-130 phase 2 — copy `extensions['sync-agent']` to `extensions['sync']`
 * across every item carrying the legacy namespace, then clear the
 * legacy key.
 *
 * Runs server-side, idempotent, rerunnable, supports a dry-run flag.
 * Touches every item whose metadata has `extensions['sync-agent']`
 * populated — bulk-update shape, not a schema migration. Lives in
 * `src/scripts/` rather than `drizzle/` because it operates on
 * item-level data (the metadata row's `extensions` JSON), not schema.
 *
 * Per-item logic:
 *
 *   1. If the item has no `sync-agent` extension, skip (counted as
 *      `skipped_no_legacy`).
 *   2. If the item has both `sync` AND `sync-agent` extensions, log
 *      and skip — collisions in the wild signal a write under the new
 *      namespace landed before this migration ran. The dual-read
 *      window in `@mymehq/sync` 0.10.0 + handles this transparently
 *      ('sync' wins per-key); the migration leaves both values in
 *      place so the agent's read sees the union.
 *   3. Otherwise, copy the `sync-agent` value into `sync` and delete
 *      the `sync-agent` key. Persisted via storage.metadata.
 *      setExtension + deleteExtension; the metadata-changed bus
 *      fires both events so any downstream listeners (webhooks, SSE)
 *      see them.
 *
 * Dry-run mode (`--dry-run`) walks the same shape but never writes —
 * counts are accurate; database is untouched. Recommended first run
 * against any environment to size the change.
 *
 * The script lists items with `--include=extensions` so it gets
 * extensions inline, avoiding an N+1 round-trip per item.
 *
 * Usage:
 *   pnpm --filter @mymehq/server tsx src/scripts/migrate-sync-extension-namespace.ts \
 *     --dialect=sqlite [--dry-run] [--page-size=200]
 *   pnpm --filter @mymehq/server tsx src/scripts/migrate-sync-extension-namespace.ts \
 *     --dialect=pg [--dry-run] [--page-size=200]
 *
 * Environment:
 *   - SQLITE_PATH (sqlite default ./data/myme.db)
 *   - DATABASE_URL (pg required)
 *
 * Backup recommendation (PG, every-item blast radius):
 *   pg_dump <db> --table=items --table=metadata > pre-t130-migration.sql
 */
import type { Storage } from "../storage/interface.js";

const LEGACY_NAMESPACE = "sync-agent";
const CURRENT_NAMESPACE = "sync";

export interface MigrationReport {
  /** Items walked (limited to those with non-empty extensions). */
  scanned: number;
  /** Items where the migration ran (or would run, in dry-run). */
  migrated: number;
  /** Items where both namespaces are present — left untouched so the
   *  agent's dual-read merges them. */
  collisions: number;
  /** Items walked that don't carry the legacy namespace. */
  skipped_no_legacy: number;
  /** Items where setExtension/deleteExtension threw. */
  failed: number;
  failures: { id: string; reason: string }[];
}

export interface MigrationOptions {
  dryRun?: boolean;
  pageSize?: number;
  /** Test seam — log lines flow here. Production uses console.log/warn. */
  log?: (level: "info" | "warn" | "error", msg: string) => void;
}

const defaultLog = (level: "info" | "warn" | "error", msg: string): void => {
  const fn =
    level === "error"
      ? console.error
      : level === "warn"
        ? console.warn
        : console.log;
  fn(`[t130-migrate] ${msg}`);
};

export async function migrateSyncExtensionNamespace(
  storage: Storage,
  opts: MigrationOptions = {},
): Promise<MigrationReport> {
  const dryRun = opts.dryRun ?? false;
  const pageSize = opts.pageSize ?? 200;
  const log = opts.log ?? defaultLog;

  const report: MigrationReport = {
    scanned: 0,
    migrated: 0,
    collisions: 0,
    skipped_no_legacy: 0,
    failed: 0,
    failures: [],
  };

  log("info", `starting${dryRun ? " (DRY RUN — no writes)" : ""}`);

  // Walk every item across every tenant. We don't filter by type
  // because the legacy namespace could be on any item the agent
  // synced. tenantId omitted so the listing crosses tenants for the
  // platform-admin operator running this migration.
  let cursor: string | undefined;
  do {
    const page = await storage.items.list({
      cursor,
      limit: pageSize,
    });
    if (page.data.length === 0) break;

    // Batched extensions read — N+1-trap avoided per the
    // getExtensionsForItems helper's contract.
    const extensionsByItem = await storage.metadata.getExtensionsForItems(
      page.data.map((it) => it.id),
    );

    for (const item of page.data) {
      report.scanned += 1;
      const extensions = extensionsByItem.get(item.id) ?? {};
      const legacy = extensions[LEGACY_NAMESPACE];
      if (!legacy) {
        report.skipped_no_legacy += 1;
        continue;
      }
      const current = extensions[CURRENT_NAMESPACE];
      if (current) {
        report.collisions += 1;
        log(
          "warn",
          `${item.id}: both \`sync\` and \`sync-agent\` present; leaving both for agent dual-read merge`,
        );
        continue;
      }
      try {
        if (!dryRun) {
          // Order matters slightly — write the new namespace first, then
          // drop the legacy. If the process crashes between the two,
          // the next run sees the collision case (both present) and
          // skips cleanly; no data loss.
          await storage.metadata.setExtension(
            item.id,
            CURRENT_NAMESPACE,
            legacy,
          );
          await storage.metadata.deleteExtension(item.id, LEGACY_NAMESPACE);
        }
        report.migrated += 1;
      } catch (err) {
        report.failed += 1;
        const reason = err instanceof Error ? err.message : String(err);
        report.failures.push({ id: item.id, reason });
        log("error", `${item.id}: ${reason}`);
      }
    }
    cursor = page.has_more ? (page.cursor as string | undefined) : undefined;
  } while (cursor);

  log(
    "info",
    `done${dryRun ? " (DRY RUN)" : ""}: scanned=${String(report.scanned)} migrated=${String(report.migrated)} collisions=${String(report.collisions)} skipped_no_legacy=${String(report.skipped_no_legacy)} failed=${String(report.failed)}`,
  );

  return report;
}

async function main(): Promise<void> {
  const dialect = process.argv.includes("--dialect=pg") ? "pg" : "sqlite";
  const dryRun = process.argv.includes("--dry-run");
  const pageSizeArg = process.argv.find((a) => a.startsWith("--page-size="));
  const pageSize = pageSizeArg
    ? Number.parseInt(pageSizeArg.slice("--page-size=".length), 10)
    : 200;

  let storage: Storage;
  if (dialect === "pg") {
    const { createPgStorage } = await import("../storage/pg/index.js");
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
      throw new Error(
        "DATABASE_URL is required for --dialect=pg (T-130 migration script)",
      );
    }
    storage = await createPgStorage(databaseUrl);
  } else {
    const { createSqliteStorage } = await import("../storage/sqlite/index.js");
    const sqlitePath = process.env.SQLITE_PATH ?? "./data/myme.db";
    storage = await createSqliteStorage(sqlitePath);
  }

  console.log(
    `[t130-migrate] dialect=${dialect} dryRun=${String(dryRun)} pageSize=${String(pageSize)}`,
  );
  const report = await migrateSyncExtensionNamespace(storage, {
    dryRun,
    pageSize,
  });
  console.log("[t130-migrate] Report:", JSON.stringify(report, null, 2));
  await storage.close();
  if (report.failed > 0) process.exitCode = 1;
}

if (
  import.meta.url ===
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  `file://${process.argv[1]!}`
) {
  void main();
}
