/**
 * One-shot data migration — sync re-presentation.
 *
 * Re-presents an existing `~/.marfa/sync.json` configuration as a
 * `system.connection` (kind: integration,
 * runtime_compatibility: ["local"]) plus a `system.credential`
 * (kind: api_key, secret_encrypted under
 * SECRET_INFO.apiKeyCredential).
 *
 * Steps:
 *   1. Read sync.json. Exit 0 if already migrated (sentinel file
 *      present at SYNC_CONNECTION_PATH).
 *   2. Register the manifest as a system.integration item if no
 *      matching (manifest_name, manifest_version) exists.
 *   3. Encrypt sync.json's `key` and create a system.credential
 *      (kind: api_key, secret_encrypted, label).
 *   4. Create a system.connection with credential_ref +
 *      integration_ref + configuration carrying the migrated
 *      sync.json fields (roots, debounceMs, types).
 *   5. Write the sentinel file with the new IDs so the agent
 *      reads from it on next start.
 *
 * Idempotent: re-running with the sentinel present is a no-op.
 *
 * Usage:
 *   pnpm --filter @withmarfa/server migrate:sync-json-to-connection
 *   SYNC_JSON_PATH=/path/to/sync.json pnpm tsx \
 *     packages/server/src/scripts/deprecated/migrate-sync-json-to-connection.ts
 *     [--dialect=sqlite|pg]
 *
 * Environment:
 *   - SYNC_JSON_PATH (default `~/.marfa/sync.json`)
 *   - SYNC_CONNECTION_PATH (default `~/.marfa/sync.connection.json`)
 *   - SQLITE_PATH (sqlite default `./data/marfa.db`)
 *   - DATABASE_URL (pg required)
 *   - MARFA_AUTH_SECRET (required for encryption)
 */
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { encryptSecret, SECRET_INFO } from "../../crypto/secret-encryption.js";
import { SYNC_MANIFEST } from "@withmarfa/integration-sync";
import type { Storage } from "../../storage/interface.js";

interface SyncJsonShape {
  url?: string;
  key: string;
  types?: string[];
  debounceMs?: number;
  roots?: unknown[];
}

interface SyncConnectionPointer {
  schema_version: 1;
  connection_id: string;
  credential_id: string;
  integration_id: string;
  migrated_at: string;
}

export interface SyncMigrationReport {
  status:
    | "migrated"
    | "already_migrated"
    | "no_sync_json"
    | "missing_key"
    | "failed";
  /** When status === "migrated", populated with the IDs that were
   *  written to the sentinel file. */
  pointer?: SyncConnectionPointer;
  reason?: string;
}

export interface MigrationPaths {
  sync_json_path: string;
  sync_connection_path: string;
}

export function defaultPaths(): MigrationPaths {
  const home = homedir();
  return {
    sync_json_path:
      process.env.SYNC_JSON_PATH ?? join(home, ".marfa", "sync.json"),
    sync_connection_path:
      process.env.SYNC_CONNECTION_PATH ??
      join(home, ".marfa", "sync.connection.json"),
  };
}

export async function migrateSyncJsonToConnection(
  storage: Storage,
  paths: MigrationPaths = defaultPaths(),
  tenantId?: string,
): Promise<SyncMigrationReport> {
  if (existsSync(paths.sync_connection_path)) {
    return { status: "already_migrated" };
  }

  if (!existsSync(paths.sync_json_path)) {
    return {
      status: "no_sync_json",
      reason: `sync.json not found at ${paths.sync_json_path}`,
    };
  }
  const raw = await readFile(paths.sync_json_path, "utf8");
  let parsed: SyncJsonShape;
  try {
    parsed = JSON.parse(raw) as SyncJsonShape;
  } catch (err) {
    return {
      status: "failed",
      reason: `sync.json parse failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (typeof parsed.key !== "string" || parsed.key.length === 0) {
    return {
      status: "missing_key",
      reason: "sync.json has no `key` field — nothing to migrate",
    };
  }

  const integrationId = await ensureIntegrationItem(storage, tenantId);

  const secret_encrypted = encryptSecret(
    parsed.key,
    SECRET_INFO.apiKeyCredential,
  );
  const credential = await storage.items.create(
    {
      type: "system.credential",
      properties: {
        label: "sync (migrated from sync.json)",
        kind: "api_key",
        secret_encrypted,
      },
    },
    tenantId,
  );

  const configuration: Record<string, unknown> = {};
  if (parsed.roots !== undefined) configuration.roots = parsed.roots;
  if (parsed.debounceMs !== undefined) {
    configuration.debounceMs = parsed.debounceMs;
  }
  if (parsed.types !== undefined) configuration.types = parsed.types;
  if (parsed.url !== undefined) configuration.url = parsed.url;

  const connection = await storage.items.create(
    {
      type: "system.connection",
      properties: {
        kind: "integration",
        status: "active",
        granted_at: new Date().toISOString(),
        integration_ref: integrationId,
        credential_ref: credential.id,
        runtime_compatibility: ["local"],
        configuration,
      },
    },
    tenantId,
  );

  const pointer: SyncConnectionPointer = {
    schema_version: 1,
    connection_id: connection.id,
    credential_id: credential.id,
    integration_id: integrationId,
    migrated_at: new Date().toISOString(),
  };
  await writeFile(
    paths.sync_connection_path,
    `${JSON.stringify(pointer, null, 2)}\n`,
    { mode: 0o600 },
  );

  return { status: "migrated", pointer };
}

async function ensureIntegrationItem(
  storage: Storage,
  tenantId: string | undefined,
): Promise<string> {
  // Check existence by manifest_name + manifest_version.
  const filter = `properties.manifest_name eq "${SYNC_MANIFEST.name}" AND properties.manifest_version eq "${SYNC_MANIFEST.version}"`;
  const page = await storage.items.list({
    type: "system.integration",
    limit: 1,
    filter,
    tenantId,
  });
  const existing = page.data[0];
  if (existing !== undefined) return existing.id;

  const created = await storage.items.create(
    {
      type: "system.integration",
      properties: {
        manifest_name: SYNC_MANIFEST.name,
        manifest_version: SYNC_MANIFEST.version,
        publisher: SYNC_MANIFEST.publisher,
        summary: SYNC_MANIFEST.description,
        direction: SYNC_MANIFEST.direction,
        runtime_compatibility: SYNC_MANIFEST.runtime_compatibility,
        manifest: SYNC_MANIFEST as unknown as Record<string, unknown>,
        registered_at: new Date().toISOString(),
      },
    },
    tenantId,
  );
  return created.id;
}

function printReport(report: SyncMigrationReport): void {
  console.log("--- migrate-sync-json-to-connection report ---");
  console.log(`status: ${report.status}`);
  if (report.reason !== undefined) console.log(`reason: ${report.reason}`);
  if (report.pointer !== undefined) {
    console.log(`integration_id:  ${report.pointer.integration_id}`);
    console.log(`credential_id:   ${report.pointer.credential_id}`);
    console.log(`connection_id:   ${report.pointer.connection_id}`);
  }
  console.log("---------------------------------------------");
}

// Only fires when invoked directly via tsx, not when imported by tests.
const invokedDirectly =
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith("migrate-sync-json-to-connection.ts") ||
    process.argv[1].endsWith("migrate-sync-json-to-connection.js"));

if (invokedDirectly) {
  await main();
}

async function main(): Promise<void> {
  const dialectArg = process.argv.find((a) => a.startsWith("--dialect="));
  const dialect: "sqlite" | "pg" = dialectArg
    ? (dialectArg.slice("--dialect=".length) as "sqlite" | "pg")
    : process.env.DB_DIALECT === "pg"
      ? "pg"
      : "sqlite";

  let storage: Storage;
  if (dialect === "pg") {
    const url = process.env.DATABASE_URL;
    if (!url) {
      console.error("DATABASE_URL is required for --dialect=pg");
      process.exit(1);
    }
    const { createPgStorage } = await import("../../storage/pg/index.js");
    storage = await createPgStorage(url);
  } else {
    const { createSqliteStorage } =
      await import("../../storage/sqlite/index.js");
    const path = process.env.SQLITE_PATH ?? "./data/marfa.db";
    storage = await createSqliteStorage(path);
  }

  try {
    const report = await migrateSyncJsonToConnection(storage);
    printReport(report);
    if (report.status === "failed") process.exit(2);
  } finally {
    await storage.close();
  }
}
