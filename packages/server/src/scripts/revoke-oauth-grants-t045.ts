/**
 * T-045 — One-shot re-consent migration.
 *
 * Wave B Part 3 ships actual scope-grammar enforcement on the data
 * plane. Pre-T-045 OAuth tokens were issued under a regime where most
 * scopes were decorative — the consent screen rendered them, but only
 * `metadata.types:write` actually gated routes. After T-045 the full
 * grammar is load-bearing.
 *
 * Forward-compat with the old grants is unsafe: a token previously
 * granted `core.note:read` was treated as admin-shaped against the
 * data plane (because nothing checked the scope), so a bug fix that
 * suddenly enforces the scope might mask broader access the user
 * didn't realise they had granted. The honest path is to revoke
 * every existing user-app-grant on T-045 deploy and let users
 * re-grant via the consent screen — minor user friction once, no
 * silent semantic drift.
 *
 * What this script does:
 *   1. Finds every active `system.connection` of kind
 *      `user-app-grant` across all tenants.
 *   2. Flips each grant's `properties.status` to `revoked` and stamps
 *      `revoked_at` + `revoke_reason: "scope_grammar_enforcement"`.
 *   3. Calls `oauth.revokeGrantTokens(grant.id)` so every access /
 *      refresh / authorisation code under the grant is invalidated.
 *   4. Writes an audit row per revocation with
 *      `action: "key.revoke"`, `details.reason: "scope_grammar_enforcement"`,
 *      `details.ticket: "T-045"` so operators have an attributable
 *      trail rather than seeing what looks like organic revocations.
 *
 * Idempotent — grants already in `revoked` state are skipped, so
 * re-running the script is safe. New grants minted after the run go
 * through the new enforcement path correctly.
 *
 * Usage:
 *   pnpm --filter @mymehq/server tsx src/scripts/revoke-oauth-grants-t045.ts --dialect=sqlite
 *   pnpm --filter @mymehq/server tsx src/scripts/revoke-oauth-grants-t045.ts --dialect=pg
 *
 * Environment:
 *   - SQLITE_PATH (sqlite default ./data/myme.db)
 *   - DATABASE_URL (pg required)
 */
import type { Storage } from "../storage/interface.js";

interface Report {
  total: number;
  revoked: number;
  skipped_already_revoked: number;
  skipped_wrong_kind: number;
  failed: number;
  failures: { id: string; reason: string }[];
}

export async function revokeOauthGrantsT045(storage: Storage): Promise<Report> {
  const report: Report = {
    total: 0,
    revoked: 0,
    skipped_already_revoked: 0,
    skipped_wrong_kind: 0,
    failed: 0,
    failures: [],
  };

  // Page through every system.connection (any state) so we can also see
  // grants that have already been revoked — used for the
  // skipped_already_revoked counter. tenantId omitted so the listing
  // crosses tenants for the platform-admin operator running this
  // migration.
  let cursor: string | undefined;
  do {
    const page = await storage.items.list({
      type: "system.connection",
      cursor,
      limit: 200,
    });
    for (const item of page.data) {
      const props = item.properties as {
        kind?: string;
        status?: string;
      };
      if (props.kind !== "user-app-grant") {
        report.skipped_wrong_kind += 1;
        continue;
      }
      report.total += 1;
      if (props.status === "revoked") {
        report.skipped_already_revoked += 1;
        continue;
      }
      try {
        const now = new Date().toISOString();
        // Flip status + stamp revocation metadata. Existing
        // revoked_at/revoke_reason fields (e.g. from a prior partial run)
        // are overwritten — idempotency relies on the status check
        // above.
        await storage.items.update(
          item.id,
          {
            properties: {
              ...item.properties,
              status: "revoked",
              revoked_at: now,
              revoke_reason: "scope_grammar_enforcement",
            },
          },
          item.tenant_id ?? undefined,
        );
        // Cascade to oauth_tokens / oauth_codes — every bearer minted
        // under this grant is now dead.
        await storage.oauth.revokeGrantTokens(item.id);
        // Per-revocation audit trail. tenant_id stamped on the audit
        // row so per-tenant operators can see their own grants
        // disappear; null for grants without a tenant scope (single-
        // tenant self-host).
        await storage.audit.log({
          action: "key.revoke",
          resource_type: "oauth_grant",
          resource_id: item.id,
          tenant_id: item.tenant_id ?? null,
          details: {
            reason: "scope_grammar_enforcement",
            ticket: "T-045",
            client_id:
              typeof item.properties.client_id === "string"
                ? item.properties.client_id
                : null,
          },
          // System-initiated — no client_ip available.
          client_ip: null,
        });
        report.revoked += 1;
      } catch (err) {
        report.failed += 1;
        report.failures.push({
          id: item.id,
          reason: err instanceof Error ? err.message : String(err),
        });
        console.error(
          `[t045-revoke] grant ${item.id} failed:`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }
    cursor = page.has_more ? (page.cursor as string | undefined) : undefined;
  } while (cursor);

  return report;
}

async function main(): Promise<void> {
  const dialect = process.argv.includes("--dialect=pg") ? "pg" : "sqlite";
  let storage: Storage;
  if (dialect === "pg") {
    const { createPgStorage } = await import("../storage/pg/index.js");
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
      throw new Error(
        "DATABASE_URL is required for --dialect=pg (T-045 revoke script)",
      );
    }
    storage = await createPgStorage(databaseUrl);
  } else {
    const { createSqliteStorage } = await import("../storage/sqlite/index.js");
    const sqlitePath = process.env.SQLITE_PATH ?? "./data/myme.db";
    storage = createSqliteStorage(sqlitePath);
  }

  console.log(
    `[t045-revoke] Scanning user-app-grants on ${dialect} storage...`,
  );
  const report = await revokeOauthGrantsT045(storage);
  console.log("[t045-revoke] Report:", JSON.stringify(report, null, 2));
  await storage.close();
  if (report.failed > 0) process.exitCode = 1;
}

// Only run when invoked directly (not when imported by tests).
if (
  import.meta.url ===
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  `file://${process.argv[1]!}`
) {
  void main();
}
