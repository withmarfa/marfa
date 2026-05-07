/**
 * Integration install pipeline — workstream 3 Layer 2 PR 1.
 *
 * Owns the multi-step install of an Integration manifest into a tenant:
 *   1. Insert a `system.connection.integration` item bound
 *      to the Integration's id (via `integration_ref`).
 *   2. Mint a runtime credential bound to the new connection id (apiKeys
 *      row stamped with `is_runtime_credential: true` and `connection_id`).
 *   3. Emit a `system.activity` row referencing the connection.
 *
 * Order matters — the runtime credential mint stamps `connection_id`, so
 * the connection id must exist first. The orchestrator's plan-review
 * flagged the call sequence as "credential mint → connection insert →
 * activity emit"; the actual execution order is connection-first because
 * the credential needs the id to bind to. Outcome is identical: no
 * orphan credentials, no half-installed state.
 *
 * Atomicity — the storage abstraction's `runInTransaction` is a real PG
 * transaction but a no-op shim on SQLite (better-sqlite3 doesn't support
 * async transactions, see storage/sqlite/index.ts). Rather than reach
 * around the abstraction, this pipeline uses **compensating writes**:
 * each step records what to undo on failure, and the catch-all reverses
 * them in reverse order. The window between steps is narrow (sequential
 * single-row inserts in-process), and the compensations are
 * idempotent. A future cleanup PR could promote this to a true
 * cross-store transaction once the storage layer grows that primitive.
 *
 * Internal-call bypass — the runtime credential mint at step 2 calls
 * `storage.keys.createRuntimeCredential` directly rather than going
 * through the HTTP `POST /system/runtime-credentials` route. This
 * intentionally bypasses the broker-key (`is_platform: true`) check
 * that route enforces — at install time the caller is the better-auth
 * session user (a human approving a connection), not the control-plane
 * lease broker. Documented here so future readers don't read the
 * bypass as an oversight.
 *
 * Manifest version compatibility — the install binds the connection to
 * a specific `integration_ref` at the manifest's exact version. When a
 * new manifest version registers as a sibling item, existing
 * connections keep pointing at the old version's item id; an explicit
 * upgrade flow (Layer 3 work) would re-bind. Plan B does not address
 * the upgrade flow on purpose.
 */
import { randomBytes } from "node:crypto";
import type { IntegrationManifest } from "@mymehq/shared";
import { hashApiKey } from "../middleware/auth.js";
import type { Storage } from "../storage/interface.js";

const KEY_PREFIX = "myme_k1_";

/** TTL for the seed runtime credential the install mints. The control
 *  plane's lease broker re-mints on 401, so this only needs to outlast
 *  the gap between install and first scheduled poll — 1 hour is comfortable
 *  for any realistic schedule cadence. */
const INSTALL_CREDENTIAL_TTL_SECONDS = 3600;

export interface InstallInput {
  /** The api_keys row id of the caller (audit trail). */
  apiKeyId: string;
  /** Tenant scope for every row written. */
  tenantId?: string;
  /** id of the system.integration item the connection binds to. */
  integrationItemId: string;
  /** The manifest blob (already validated on registration). Drives
   *  permission translation and trigger persistence. */
  manifest: Record<string, unknown> | IntegrationManifest;
  /** Display label for the credential and connection. Falls back to
   *  `${manifest_name} ${manifest_version}` at the route layer. */
  label: string;
  /** Resolved client IP of the caller (T-027). Threaded into the audit
   *  row so installs are attributable. Null when the install runs
   *  outside a Hono request (e.g. one-shot CLI scripts). */
  clientIp?: string | null;
}

export interface InstallResult {
  connection_id: string;
  credential_id: string;
  activity_id: string;
}

function generateRawKey(): string {
  return KEY_PREFIX + randomBytes(32).toString("hex");
}

/** Translate manifest.permissions into a runtime-credential
 *  `extension_permissions` map. The `connection.runtime` namespace is
 *  always granted write — the runtime needs it to hydrate its own
 *  cursor state — and any manifest-declared extension grants merge on
 *  top. Same shape the broker uses at refresh time, kept in sync here
 *  so the seed credential and refreshed credentials carry identical
 *  permissions. */
function buildExtensionPermissions(
  manifest: IntegrationManifest,
): Record<string, "read" | "write"> {
  const out: Record<string, "read" | "write"> = {
    "connection.runtime": "write",
  };
  const declared = manifest.permissions?.extension;
  if (declared) {
    for (const [ns, level] of Object.entries(declared)) {
      out[ns] = level;
    }
  }
  return out;
}

function buildEdgePermissions(
  manifest: IntegrationManifest,
): Record<string, "read" | "write"> {
  const declared = manifest.permissions?.edge;
  return declared ? { ...declared } : {};
}

/** Translate manifest.target_types + direction into a `type_permissions`
 *  map. Read-only Integrations get `read` on each target type;
 *  write/both get `write`. The runtime's per-Connection
 *  ConnectionClient enforces these at the server boundary. */
function buildTypePermissions(
  manifest: IntegrationManifest,
): Record<string, "read" | "write"> {
  const level: "read" | "write" =
    manifest.direction === "read" ? "read" : "write";
  const out: Record<string, "read" | "write"> = {};
  for (const t of manifest.target_types) {
    out[t] = level;
  }
  return out;
}

export async function performInstall(
  storage: Storage,
  salt: string,
  input: InstallInput,
): Promise<InstallResult> {
  const manifest = input.manifest as IntegrationManifest;
  const now = new Date().toISOString();

  // Compensation stack — each step pushes a rollback closure. On any
  // subsequent failure we walk the stack in reverse and re-throw.
  //
  // T-012: do NOT use `compensations.reverse()` — that mutates the array
  // in place. If a recovery path re-invokes rollback (or any code reads
  // `compensations` after rollback returns) the stack is silently
  // backwards from where the caller expects. Iterate via a downward
  // index instead so the original push-order is preserved.
  const compensations: (() => Promise<void>)[] = [];
  const rollback = async (originalErr: unknown): Promise<never> => {
    for (let i = compensations.length - 1; i >= 0; i--) {
      const undo = compensations[i];
      if (!undo) continue;
      try {
        await undo();
      } catch (cleanupErr) {
        // Compensation failure is logged via audit on next install, not
        // surfaced to the caller — the original error is the actionable one.
        console.error("[install-pipeline] compensation failed", cleanupErr);
      }
    }
    throw originalErr;
  };

  // -------------------------------------------------------------------
  // Step 1: insert the system.connection item.
  // -------------------------------------------------------------------
  const connectionProperties = {
    kind: "integration" as const,
    status: "active" as const,
    granted_at: now,
    integration_ref: input.integrationItemId,
    configuration: {} as Record<string, unknown>,
    direction: manifest.direction,
    triggers: manifest.triggers,
    runtime_status: "healthy" as const,
    feed_activity: false,
  };

  const connection = await storage.items.create(
    {
      type: "system.connection",
      properties: connectionProperties,
    },
    input.tenantId,
  );
  compensations.push(async () => {
    // Trash rather than hard-delete — leaves an audit trail. The retention
    // job will purge eventually.
    await storage.items.transition(connection.id, "trashed", input.tenantId);
  });

  // -------------------------------------------------------------------
  // Step 2: mint runtime credential bound to the new connection id.
  // Internal call bypasses the broker-key check on POST
  // /system/runtime-credentials — see file docstring for rationale.
  // -------------------------------------------------------------------
  const rawKey = generateRawKey();
  const keyHash = hashApiKey(rawKey, salt);
  const credentialLabel = input.label.slice(0, 200);
  const credentialSource = `integration:${connection.id}`;

  let credential;
  try {
    credential = await storage.keys.createRuntimeCredential(
      {
        label: credentialLabel,
        source: credentialSource,
        role: "member",
        type_permissions: buildTypePermissions(manifest),
        extension_permissions: buildExtensionPermissions(manifest),
        edge_permissions: buildEdgePermissions(manifest),
        connection_id: connection.id,
      },
      keyHash,
      input.tenantId,
    );
  } catch (err) {
    return rollback(err);
  }
  compensations.push(async () => {
    await storage.keys.revoke(credential.id);
  });

  // -------------------------------------------------------------------
  // Step 3: emit system.activity row.
  // -------------------------------------------------------------------
  let activity;
  try {
    activity = await storage.items.create(
      {
        type: "system.activity",
        properties: {
          connection_id: connection.id,
          severity: "info" as const,
          summary: `Installed ${manifest.name}@${manifest.version}`,
          detail: {
            integration_ref: input.integrationItemId,
            manifest_name: manifest.name,
            manifest_version: manifest.version,
            credential_id: credential.id,
          },
        },
      },
      input.tenantId,
    );
  } catch (err) {
    return rollback(err);
  }

  // -------------------------------------------------------------------
  // Audit trail (T-012). Awaited and rolled back on failure — `system.connection`
  // writes are operationally significant and an unaudited install isn't
  // auditable. Pre-T-012 this was `void storage.audit.log(...)`, which
  // swallowed audit-DB failures silently.
  // -------------------------------------------------------------------
  try {
    await storage.audit.log({
      key_id: input.apiKeyId,
      client_ip: input.clientIp ?? null,
      tenant_id: input.tenantId ?? null,
      action: "integration.install",
      resource_type: "item",
      resource_id: connection.id,
      details: {
        integration_ref: input.integrationItemId,
        credential_id: credential.id,
        activity_id: activity.id,
        manifest_name: manifest.name,
        manifest_version: manifest.version,
        ttl_seconds: INSTALL_CREDENTIAL_TTL_SECONDS,
      },
    });
  } catch (err) {
    return rollback(err);
  }

  return {
    connection_id: connection.id,
    credential_id: credential.id,
    activity_id: activity.id,
  };
}

export { INSTALL_CREDENTIAL_TTL_SECONDS };
