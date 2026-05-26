/**
 * T-140: boot-time detection for un-migrated `extensions['sync-agent'].*`
 * rows.
 *
 * The sync engine renamed its extension namespace from `sync-agent` to
 * `sync` in T-130. The migration script
 * `migrate-sync-extension-namespace.ts` copies legacy values across so
 * the engine's post-T-130 read path (which only consults
 * `extensions['sync']`) sees them. A self-hoster who skips the
 * migration but upgrades `@withmarfa/sync` past `0.10.0` silently loses
 * the legacy extension data — the agent still writes to the new
 * namespace but never reads from the old one again.
 *
 * This boot-time probe surfaces the situation operationally: a single
 * COUNT(*) query at server boot, structured WARN log if any rows
 * remain. Operator-actionable — the log line names the migration
 * script with the exact command. Best-effort: any error is swallowed
 * (a missing metadata table, dialect mismatch, etc.) so the probe
 * cannot block boot.
 *
 * Cost: one COUNT query per server boot. Negligible.
 */
import type { Storage } from "./interface.js";
import { log } from "../middleware/logger.js";

interface PgEscapeHatch {
  __pgClient?: (q: string, p?: unknown[]) => Promise<unknown[]>;
}

interface SqliteEscapeHatch {
  __sqliteAll?: (q: string) => Promise<unknown[]>;
}

/**
 * Best-effort boot probe. Logs a WARN naming the migration script if
 * any legacy `extensions['sync-agent'].*` rows are detected. Returns
 * the count for testability; never throws.
 */
export async function checkLegacySyncAgentExtensions(
  storage: Storage,
): Promise<number> {
  try {
    const dialect = (storage as { betterAuthDialect?: "pg" | "sqlite" })
      .betterAuthDialect;
    if (dialect === "pg") {
      const pg = storage as unknown as PgEscapeHatch;
      if (!pg.__pgClient) return 0;
      const rows = (await pg.__pgClient(
        `SELECT COUNT(*)::int AS c FROM metadata
          WHERE (extensions::jsonb) ? 'sync-agent'`,
      )) as { c: number }[];
      const count = rows[0]?.c ?? 0;
      if (count > 0) emitWarn(count);
      return count;
    }
    if (dialect === "sqlite") {
      const sqlite = storage as unknown as SqliteEscapeHatch;
      if (!sqlite.__sqliteAll) return 0;
      const rows = (await sqlite.__sqliteAll(
        `SELECT COUNT(*) AS c FROM metadata
          WHERE json_extract(extensions, '$."sync-agent"') IS NOT NULL`,
      )) as { c: number }[];
      const count = rows[0]?.c ?? 0;
      if (count > 0) emitWarn(count);
      return count;
    }
    return 0;
  } catch (err) {
    // Best-effort — never block boot. Log the error so it's not
    // entirely silent if the schema doesn't match the assumption.
    log("warn", "Legacy sync-agent extension probe failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return 0;
  }
}

function emitWarn(count: number): void {
  log(
    "warn",
    "Detected legacy `extensions['sync-agent'].*` rows. The sync engine post-0.10.0 reads only `extensions['sync']`, so these values are no longer surfaced. Run the T-130 migration to copy them across before any user-facing impact: `pnpm --filter @withmarfa/server tsx src/scripts/migrate-sync-extension-namespace.ts --dialect=<sqlite|pg>` (use `--dry-run` first to size the change).",
    {
      legacy_namespace: "sync-agent",
      current_namespace: "sync",
      affected_metadata_rows: count,
      ticket: "T-140",
    },
  );
}
