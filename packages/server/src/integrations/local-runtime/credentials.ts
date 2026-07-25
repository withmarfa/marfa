/**
 * `mintCredential` short-circuit for the local runtime. The Cloudflare
 * substrate goes through the runtime-control lease broker → POST
 * `/system/runtime-credentials` → cached on the per-Connection Durable
 * Object. The local substrate skips the HTTP round-trip and calls
 * `storage.keys.createRuntimeCredential` directly.
 *
 * Permissions are translated from the Integration manifest via the same
 * builders the hosted install pipeline uses (`manifest-permissions.ts`),
 * so a credential can only touch the types, edges, and extension
 * namespaces its manifest declares, plus the two substrate-contract
 * grants every connector needs (`connection.runtime` write for its own
 * state subtree, `system.activity` write for status reporting). A
 * connection whose manifest cannot be resolved mints fail-closed: those
 * two grants only, no type or edge reach beyond them.
 *
 * The credential is short-TTL by design — the SDK refreshes via the
 * same callback on every dispatch, so a 10-minute window is fine even
 * if the integration runs every minute. The TTL is stamped onto the row
 * as `expires_at` (enforced at the bearer gate), and each mint retires
 * the connection's older credentials once they are past TTL plus a
 * one-TTL grace, so per-dispatch minting cannot accumulate live keys.
 */
import { randomBytes } from "node:crypto";
import type { RuntimeCredential } from "@withmarfa/runtime-sdk";
import type { IntegrationManifest } from "@withmarfa/shared";
import { hashApiKey } from "../../middleware/auth.js";
import { log } from "../../middleware/logger.js";
import type { Storage } from "../../storage/interface.js";
import {
  buildEdgePermissions,
  buildExtensionPermissions,
  buildTypePermissions,
} from "../../connections/manifest-permissions.js";

const KEY_PREFIX = "marfa_k1_";

/**
 * Default runtime-credential lifetime. Shared with the retention reaper's
 * legacy sweep so "older than TTL + grace" means the same thing whether a
 * row was stamped with an expiry or predates expiry stamping. The hosted
 * mint route's default (`ttl_seconds: 600`) matches deliberately.
 */
export const DEFAULT_RUNTIME_CREDENTIAL_TTL_MS = 600 * 1000;
const DEFAULT_TTL_MS = DEFAULT_RUNTIME_CREDENTIAL_TTL_MS;

interface ConnectionProperties {
  kind?: string;
  integration_ref?: string;
  status?: string;
}

interface IntegrationProperties {
  manifest?: IntegrationManifest;
}

/**
 * Mint a fresh runtime credential for a Connection. Returns the wire
 * `RuntimeCredential` shape the SDK consumes — `{ api_key, expires_at,
 * connection_id }`.
 *
 * Throws when:
 *   - the Connection doesn't exist
 *   - the Connection isn't of kind `integration`
 *   - the Connection's `state` isn't `"active"` — symmetric with
 *     the HTTP-side mint gate; a revoked Connection cannot mint and
 *     therefore cannot run handlers
 */
export async function mintLocalRuntimeCredential(
  storage: Storage,
  salt: string,
  connectionId: string,
  ttlMs = DEFAULT_TTL_MS,
): Promise<RuntimeCredential> {
  const connection = await storage.items.get(connectionId);
  if (connection?.type !== "system.connection") {
    throw new Error(`Connection ${connectionId} not found`);
  }
  if (connection.state !== "active") {
    throw new Error(
      `Connection ${connectionId} is ${connection.state}; cannot mint runtime credential`,
    );
  }
  const props = connection.properties as ConnectionProperties;
  if (props.kind !== "integration") {
    throw new Error(
      `Connection ${connectionId} is not of kind integration (got ${props.kind ?? "undefined"})`,
    );
  }

  // Resolve the manifest so the credential carries exactly the reach the
  // Integration declared at registration — the same translation the
  // hosted install pipeline applies. No manifest means no reach beyond
  // the credential's own `connection.runtime` subtree: minting wide on a
  // resolution failure would silently hand out the whole tenant.
  let manifest: IntegrationManifest | undefined;
  if (props.integration_ref) {
    const integration = await storage.items.get(props.integration_ref);
    if (integration?.type === "system.integration") {
      manifest = (integration.properties as IntegrationProperties).manifest;
    }
  }

  const rawKey = KEY_PREFIX + randomBytes(32).toString("hex");
  const keyHash = hashApiKey(rawKey, salt);
  const expiresAt = new Date(Date.now() + ttlMs).toISOString();
  // source is unique-checked per tenant; the random suffix prevents collisions
  // within the credential's short TTL window.
  const suffix = randomBytes(4).toString("hex");
  const tenantId = connection.tenant_id ?? undefined;

  const minted = await storage.keys.createRuntimeCredential(
    {
      label: `local-runtime ${connectionId}`,
      source: `local-runtime:${connectionId}:${suffix}`,
      role: "member",
      type_permissions: buildTypePermissions(manifest),
      extension_permissions: buildExtensionPermissions(manifest),
      edge_permissions: buildEdgePermissions(manifest),
      connection_id: connectionId,
      expires_at: expiresAt,
    },
    keyHash,
    tenantId,
  );

  // Retire this connection's older runtime credentials. The cutoff is
  // TTL + one-TTL grace: anything past it has been expired for at least
  // a full TTL, so no in-flight dispatch can still be holding it.
  // Best-effort — a supersede failure must not fail the dispatch that
  // triggered the mint; the retention reaper is the backstop.
  const cutoff = new Date(Date.now() - 2 * ttlMs).toISOString();
  try {
    const stale = await storage.keys.listByConnectionId(connectionId, tenantId);
    for (const key of stale) {
      if (key.id === minted.id) continue;
      if (!key.is_runtime_credential) continue;
      if (key.created_at >= cutoff) continue;
      await storage.keys.revoke(key.id);
    }
  } catch (err) {
    log("error", "Runtime credential supersede revoke failed", {
      connection_id: connectionId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return {
    api_key: rawKey,
    expires_at: expiresAt,
    connection_id: connectionId,
  };
}
