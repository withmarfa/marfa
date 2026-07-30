/**
 * One-shot data migration.
 *
 * Walks every `system.connection` of kind `integration`,
 * extracts the OAuth provider config from `properties.configuration`,
 * encrypts the `oauth_client_secret` under the `connectionOauthToken`
 * HKDF domain, mints a new `system.credential` item with
 * `kind: oauth_token`, and updates the connection to:
 *   - set `properties.credential_ref` to the new credential's id
 *   - remove the OAuth fields from `properties.configuration`
 *     (upstream_base_url, oauth_token_url, oauth_client_id,
 *     oauth_client_secret) so the older plaintext path no longer has
 *     a fallback for that connection
 *
 * Per-connection failures are logged and skipped; one bad row doesn't
 * block the rest. The script prints a final report of total / migrated
 * / skipped / failed counts.
 *
 * Idempotent — connections that already have `credential_ref` set are
 * skipped. Re-running is safe.
 *
 * Usage:
 *   pnpm --filter @withmarfa/server migrate:oauth-to-credential
 *   pnpm --filter @withmarfa/server exec tsx src/scripts/deprecated/migrate-oauth-to-credential.ts --dialect=sqlite
 *   pnpm --filter @withmarfa/server exec tsx src/scripts/deprecated/migrate-oauth-to-credential.ts --dialect=pg
 *
 * Environment:
 *   - SQLITE_PATH (sqlite default ./data/marfa.db)
 *   - DATABASE_URL (pg required)
 *   - MARFA_AUTH_SECRET (required for encryption — same key the server uses)
 */
import { encryptSecret, SECRET_INFO } from "../../crypto/secret-encryption.js";
import type { Storage } from "../../storage/interface.js";

interface MigrationReport {
  total: number;
  migrated: number;
  skipped_already_migrated: number;
  skipped_no_oauth_config: number;
  skipped_wrong_kind: number;
  failed: number;
  failures: { id: string; reason: string }[];
}

interface InlineOAuthFields {
  upstream_base_url: string;
  oauth_token_url: string;
  oauth_client_id: string;
  oauth_client_secret: string;
}

function readInlineOAuthFields(
  configuration: unknown,
): InlineOAuthFields | null {
  if (
    typeof configuration !== "object" ||
    configuration === null ||
    Array.isArray(configuration)
  ) {
    return null;
  }
  const cfg = configuration as Record<string, unknown>;
  if (
    typeof cfg.upstream_base_url !== "string" ||
    typeof cfg.oauth_token_url !== "string" ||
    typeof cfg.oauth_client_id !== "string" ||
    typeof cfg.oauth_client_secret !== "string"
  ) {
    return null;
  }
  return {
    upstream_base_url: cfg.upstream_base_url,
    oauth_token_url: cfg.oauth_token_url,
    oauth_client_id: cfg.oauth_client_id,
    oauth_client_secret: cfg.oauth_client_secret,
  };
}

export async function migrateOauthToCredential(
  storage: Storage,
): Promise<MigrationReport> {
  const report: MigrationReport = {
    total: 0,
    migrated: 0,
    skipped_already_migrated: 0,
    skipped_no_oauth_config: 0,
    skipped_wrong_kind: 0,
    failed: 0,
    failures: [],
  };

  let cursor: string | undefined;
  do {
    const page = await storage.items.list({
      type: "system.connection",
      limit: 200,
      cursor,
    });
    for (const connection of page.data) {
      report.total += 1;
      const props = connection.properties as {
        kind?: string;
        credential_ref?: string;
        configuration?: unknown;
      };

      if (props.kind !== "integration") {
        report.skipped_wrong_kind += 1;
        continue;
      }
      if (props.credential_ref) {
        report.skipped_already_migrated += 1;
        continue;
      }

      const inline = readInlineOAuthFields(props.configuration);
      if (!inline) {
        report.skipped_no_oauth_config += 1;
        continue;
      }

      try {
        // encryptSecret throws on key misconfiguration; surfaced per-row
        // so one bad row doesn't abort the rest of the migration.
        const secret_encrypted = encryptSecret(
          inline.oauth_client_secret,
          SECRET_INFO.connectionOauthToken,
        );
        const credentialItem = await storage.items.create(
          {
            type: "system.credential",
            properties: {
              label: `oauth: ${connection.id}`,
              kind: "oauth_token",
              oauth_provider_config: {
                upstream_base_url: inline.upstream_base_url,
                oauth_token_url: inline.oauth_token_url,
                oauth_client_id: inline.oauth_client_id,
              },
              secret_encrypted,
            },
          },
          // space_id isn't carried on the public Item type. The storage
          // layer will accept undefined here (single-space fallback).
          // Multi-space deployments need to extend this script to enumerate
          // spaces — flagged in the README until that surface lands.
          undefined,
        );

        const remainingConfig = stripOauthFields(props.configuration);
        const newProps: Record<string, unknown> = {
          ...connection.properties,
          credential_ref: credentialItem.id,
          configuration: remainingConfig,
        };
        await storage.items.update(connection.id, {
          properties: newProps,
        });

        report.migrated += 1;
      } catch (err) {
        report.failed += 1;
        report.failures.push({
          id: connection.id,
          reason: err instanceof Error ? err.message : String(err),
        });
        console.error(
          `[migrate-oauth] connection ${connection.id} failed:`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }
    cursor = page.cursor ?? undefined;
  } while (cursor);

  return report;
}

function stripOauthFields(configuration: unknown): Record<string, unknown> {
  if (
    typeof configuration !== "object" ||
    configuration === null ||
    Array.isArray(configuration)
  ) {
    return {};
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(
    configuration as Record<string, unknown>,
  )) {
    if (
      key === "upstream_base_url" ||
      key === "oauth_token_url" ||
      key === "oauth_client_id" ||
      key === "oauth_client_secret"
    ) {
      continue;
    }
    out[key] = value;
  }
  return out;
}

function printReport(report: MigrationReport): void {
  console.log("--- migrate-oauth-to-credential report ---");
  console.log(`total connections inspected: ${String(report.total)}`);
  console.log(`migrated:                    ${String(report.migrated)}`);
  console.log(
    `skipped (already migrated):  ${String(report.skipped_already_migrated)}`,
  );
  console.log(
    `skipped (no OAuth config):   ${String(report.skipped_no_oauth_config)}`,
  );
  console.log(
    `skipped (wrong kind):        ${String(report.skipped_wrong_kind)}`,
  );
  console.log(`failed:                      ${String(report.failed)}`);
  if (report.failures.length > 0) {
    console.log("--- failures ---");
    for (const f of report.failures) {
      console.log(`  ${f.id}: ${f.reason}`);
    }
  }
  console.log("------------------------------------------");
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith("migrate-oauth-to-credential.ts") ||
    process.argv[1].endsWith("migrate-oauth-to-credential.js"));

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
    const report = await migrateOauthToCredential(storage);
    printReport(report);
    if (report.failed > 0) process.exit(2);
  } finally {
    await storage.close();
  }
}
