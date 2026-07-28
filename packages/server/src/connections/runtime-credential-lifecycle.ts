/**
 * Shared lifecycle helpers for hosted and local runtime credentials.
 *
 * The server owns manifest projection. A control plane can ask for a
 * credential, but it cannot choose that credential's reach. Missing or
 * invalid manifests fail closed to the two substrate grants supplied by the
 * permission builders.
 */
import { MarfaError, ErrorCode } from "@withmarfa/shared";
import type { IntegrationManifest, Item } from "@withmarfa/shared";
import { log } from "../middleware/logger.js";
import type { Storage } from "../storage/interface.js";
import { validateManifest } from "../integrations/validate-manifest.js";

interface ConnectionProperties {
  integration_ref?: string;
}

interface IntegrationProperties {
  manifest?: unknown;
  manifest_name?: unknown;
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
 * Refuse to mint a runtime credential whose reach would not be fenced
 * by a tenant.
 *
 * A credential with no `tenant_id` is not a narrow credential — it is
 * the platform tier. The per-request RLS wrapper skips a tenant-less
 * caller entirely, and the storage layer's tenant predicate widens from
 * an equality to no predicate at all, so the credential reads and
 * writes every tenant's rows. A Connection installed by a platform
 * admin without naming a tenant produces exactly that: an integration
 * built for one customer holding a key to all of them.
 *
 * Only a deployment that has tenants can be wrong about this. In `keys`
 * mode nothing carries a `tenant_id`, so a tenant-less credential is as
 * scoped as every other credential on the instance and refusing would
 * break every self-host. `authMode` is the switch that says whether
 * tenants exist, which is why the rule reads it rather than inferring
 * from whether some tenant happens to have been created.
 *
 * A refused Connection becomes undispatchable rather than dangerous.
 * That is the intended trade: the failure is loud, it names the missing
 * tenant, and an operator fixes it by installing the Connection into a
 * tenant.
 */
export function assertMintableTenantScope(
  connection: Item,
  authMode: "hosted" | "keys",
): void {
  if (authMode !== "hosted") return;
  if (connection.tenant_id) return;
  throw new MarfaError(
    ErrorCode.FORBIDDEN,
    `Connection ${connection.id} has no tenant; a runtime credential minted for it would reach every tenant`,
    { connection_id: connection.id },
  );
}

/**
 * Confirm the caller is asking for a Connection belonging to the
 * integration it authenticated as.
 *
 * The control plane authenticates an integration Worker against a key
 * derived from that integration's name, then forwards the name it
 * proved. This is where the claim is checked against state neither the
 * Worker nor the control plane can edit: the manifest persisted on the
 * Connection at install time. A Worker that has somehow reached the
 * broker for a sibling's Connection — a queue envelope carrying the
 * wrong id, a Service Binding wired to the wrong Worker, a compromised
 * Worker walking Connection ids — is refused by the one party that
 * knows which integration the Connection was installed for.
 *
 * Resolution failure is a refusal, not a pass. A Connection whose
 * `integration_ref` no longer resolves cannot be shown to belong to the
 * caller, and "cannot prove" has to read as "no" for a check whose
 * whole job is proving ownership.
 */
export async function assertConnectionBelongsToIntegration(
  storage: Storage,
  connection: Item,
  integrationName: string,
): Promise<void> {
  const integrationRef = (connection.properties as ConnectionProperties)
    .integration_ref;
  const integration = integrationRef
    ? await storage.items.get(
        integrationRef,
        connection.tenant_id ?? undefined,
        {
          includePlatformScoped: true,
        },
      )
    : null;
  const persistedName =
    integration?.type === "system.integration"
      ? (integration.properties as IntegrationProperties).manifest_name
      : undefined;

  if (typeof persistedName !== "string" || persistedName.length === 0) {
    throw new MarfaError(
      ErrorCode.VALIDATION_ERROR,
      `Connection ${connection.id} has no resolvable integration manifest to check the caller against`,
      { connection_id: connection.id },
    );
  }
  if (persistedName !== integrationName) {
    throw new MarfaError(
      ErrorCode.FORBIDDEN,
      `Connection ${connection.id} belongs to a different integration than the caller`,
      { connection_id: connection.id },
    );
  }
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
