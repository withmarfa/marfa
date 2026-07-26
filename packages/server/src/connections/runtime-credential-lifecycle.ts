/**
 * Shared lifecycle helpers for hosted and local runtime credentials.
 *
 * The server owns manifest projection. A control plane can ask for a
 * credential, but it cannot choose that credential's reach. Missing or
 * invalid manifests fail closed to the two substrate grants supplied by the
 * permission builders.
 */
import type { IntegrationManifest, Item } from "@withmarfa/shared";
import { log } from "../middleware/logger.js";
import type { Storage } from "../storage/interface.js";
import { validateManifest } from "../integrations/validate-manifest.js";

interface ConnectionProperties {
  integration_ref?: string;
}

interface IntegrationProperties {
  manifest?: unknown;
}

export async function resolveRuntimeCredentialManifest(
  storage: Storage,
  connection: Item,
): Promise<IntegrationManifest | undefined> {
  const integrationRef = (connection.properties as ConnectionProperties)
    .integration_ref;
  if (!integrationRef) return undefined;

  const tenantId = connection.tenant_id ?? undefined;
  const integration = await storage.items.get(integrationRef, tenantId, {
    includePlatformScoped: true,
  });
  if (integration?.type !== "system.integration") return undefined;

  const result = validateManifest(
    (integration.properties as IntegrationProperties).manifest,
  );
  return result.ok ? result.manifest : undefined;
}

/**
 * Revoke credentials that can no longer belong to a live dispatch.
 *
 * Expiry is the cutoff for stamped rows. Rows created before expiry stamping
 * use age against the mint TTL, matching the retention reaper's rollout
 * behavior. Failures are best-effort because the reaper remains the backstop
 * and a cleanup failure must not discard the newly minted credential.
 */
export async function revokeSupersededRuntimeCredentials(
  storage: Storage,
  connectionId: string,
  tenantId: string | undefined,
  mintedId: string,
  ttlMs: number,
): Promise<void> {
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const legacyCutoff = new Date(now - ttlMs).toISOString();

  try {
    const siblings = await storage.keys.listByConnectionId(
      connectionId,
      tenantId,
    );
    for (const key of siblings) {
      if (key.id === mintedId || !key.is_runtime_credential) continue;
      const expired = key.expires_at
        ? key.expires_at <= nowIso
        : key.created_at < legacyCutoff;
      if (expired) await storage.keys.revoke(key.id);
    }
  } catch (err) {
    log("error", "Runtime credential supersede revoke failed", {
      connection_id: connectionId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
