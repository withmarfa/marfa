/**
 * One-shot data migration — Layer 3 PR 4 (sync-agent re-presentation).
 *
 * Re-presents an existing `~/.myme/sync.json` configuration as a
 * `system.connection` (kind: external-service-connector,
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
 *   pnpm --filter @mymehq/server migrate:sync-json-to-connection
 *   SYNC_JSON_PATH=/path/to/sync.json pnpm tsx \
 *     packages/server/src/scripts/migrate-sync-json-to-connection.ts
 *     [--dialect=sqlite|pg]
 *
 * Environment:
 *   - SYNC_JSON_PATH (default `~/.myme/sync.json`)
 *   - SYNC_CONNECTION_PATH (default `~/.myme/sync.connection.json`)
 *   - SQLITE_PATH (sqlite default `./data/myme.db`)
 *   - DATABASE_URL (pg required)
 *   - MYME_AUTH_SECRET (required for encryption)
 */
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { encryptSecret, SECRET_INFO } from "../crypto/secret-encryption.js";
import { SYNC_AGENT_MANIFEST } from "@mymehq/integration-sync-agent";
import type { Storage } from "../storage/interface.js";

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
      process.env.SYNC_JSON_PATH ?? join(home, ".myme", "sync.json"),
    sync_connection_path:
      process.env.SYNC_CONNECTION_PATH ??
      join(home, ".myme", "sync.connection.json"),
  };
}

export async function migrateSyncJsonToConnection(
  storage: Storage,
  paths: MigrationPaths = defaultPaths(),
  tenantId?: string,
): Promise<SyncMigrationReport> {
  // 1. Idempotency: sentinel present → already migrated.
  if (existsSync(paths.sync_connection_path)) {
    return { status: "already_migrated" };
  }

  // 2. Read sync.json.
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

  // 3. Find or create the system.integration item for the manifest.
  const integrationId = await ensureIntegrationItem(storage, tenantId);

  // 4. Encrypt the api_key + create the system.credential.
  const secret_encrypted = encryptSecret(
    parsed.key,
    SECRET_INFO.apiKeyCredential,
  );
  const credential = await storage.items.create(
    {
      type: "system.credential",
      properties: {
        label: "sync-agent (migrated from sync.json)",
        kind: "api_key",
        secret_encrypted,
      },
    },
    tenantId,
  );

  // 5. Create the system.connection bound to both refs.
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
        kind: "external-service-connector",
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

  // 6. Write the sentinel pointer so the agent reads from it.
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
  const filter = `properties.manifest_name eq "${SYNC_AGENT_MANIFEST.name}" AND properties.manifest_version eq "${SYNC_AGENT_MANIFEST.version}"`;
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
        manifest_name: SYNC_AGENT_MANIFEST.name,
        manifest_version: SYNC_AGENT_MANIFEST.version,
        publisher: SYNC_AGENT_MANIFEST.publisher,
        summary: SYNC_AGENT_MANIFEST.description,
        direction: SYNC_AGENT_MANIFEST.direction,
        runtime_compatibility: SYNC_AGENT_MANIFEST.runtime_compatibility,
        manifest: SYNC_AGENT_MANIFEST as unknown as Record<string, unknown>,
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
    : process.env.STORAGE_DIALECT === "pg"
      ? "pg"
      : "sqlite";

  let storage: Storage;
  if (dialect === "pg") {
    const url = process.env.DATABASE_URL;
    if (!url) {
      console.error("DATABASE_URL is required for --dialect=pg");
      process.exit(1);
    }
    const { createPgStorage } = await import("../storage/pg/index.js");
    storage = await createPgStorage(url);
  } else {
    const { createSqliteStorage } = await import("../storage/sqlite/index.js");
    const path = process.env.SQLITE_PATH ?? "./data/myme.db";
    storage = createSqliteStorage(path);
  }

  try {
    const report = await migrateSyncJsonToConnection(storage);
    printReport(report);
    if (report.status === "failed") process.exit(2);
  } finally {
    await storage.close();
  }
}
