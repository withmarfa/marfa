/**
 * Resolve the Integration manifest for a Connection — workstream 3
 * Layer 2 PR 2.
 *
 * WS2 routes (`/connections/:id/inbound-webhooks`,
 * `/connections/:id/lease-token`) accepted the manifest inline in the
 * request body. Layer 2's install pipeline persists the manifest as a
 * `system.integration` item and binds the connection to it via
 * `properties.integration_ref`. This helper does the lookup so route
 * handlers can fetch the canonical, version-pinned manifest without
 * trusting per-request inline data.
 *
 * Dual-read fallback. For one release we accept either path:
 *
 *   1. **Preferred** — the connection has `integration_ref` set and it
 *      resolves to a `system.integration` item; we validate that item's
 *      stored manifest blob and return it.
 *   2. **Legacy** — the caller supplied an inline `manifest` object in
 *      the request body and the connection has no `integration_ref`
 *      (or the ref doesn't resolve). We validate the inline manifest
 *      and return it, with a console warning so operators see the
 *      deprecated path being exercised.
 *
 * After Layer 2 ships and downstream callers have migrated, the legacy
 * branch is removed in a follow-up PR (tracked in the project Backlog
 * — "drop connection-proxy / inbound-webhooks / lease-token inline
 * manifest fallback ~2 weeks after Layer 2 closes").
 *
 * Errors:
 *   - `NOT_FOUND` — connection doesn't exist or isn't visible in the
 *     caller's tenant scope.
 *   - `VALIDATION_ERROR` — the legacy inline manifest fails validation.
 *   - `MISSING_REQUIRED_FIELD` — neither path is available (no resolvable
 *     integration_ref, no inline manifest).
 *
 * Orphaned `integration_ref` (set but doesn't resolve to a system.integration
 * item) falls through to the inline path with a warning, rather than
 * failing the request — keeps legacy connections from breaking when the
 * registry item is missing.
 */
import { MymeError, ErrorCode } from "@mymehq/shared";
import type { IntegrationManifest } from "@mymehq/shared";
import type { Storage } from "../storage/interface.js";
import { validateManifest } from "../integrations/validate-manifest.js";

export interface ResolvedManifest {
  manifest: IntegrationManifest;
  /** Where the manifest was loaded from. Useful for telemetry and the
   *  cleanup PR that drops the legacy branch — operators can see whether
   *  any callers still depend on inline manifests in production. */
  source: "integration_ref" | "inline_legacy";
  /** Item id of the resolved system.integration item, when source is
   *  `integration_ref`. Null on the legacy path. */
  integration_item_id: string | null;
}

interface ConnectionProperties {
  kind?: string;
  integration_ref?: string;
}

interface IntegrationProperties {
  manifest?: unknown;
}

export async function resolveConnectionManifest(
  storage: Storage,
  connectionId: string,
  tenantId: string | undefined,
  inlineManifest: unknown,
): Promise<ResolvedManifest> {
  const connection = await storage.items.get(connectionId, tenantId);
  if (connection?.type !== "system.connection") {
    throw new MymeError(
      ErrorCode.NOT_FOUND,
      `Connection ${connectionId} not found`,
    );
  }

  const props = connection.properties as ConnectionProperties;
  const integrationRef = props.integration_ref;

  // Preferred path — connection bound to a registry item that resolves.
  if (integrationRef) {
    const integration = await storage.items.get(integrationRef, tenantId);
    if (integration?.type === "system.integration") {
      const intProps = integration.properties as IntegrationProperties;
      const result = validateManifest(intProps.manifest);
      if (result.ok) {
        return {
          manifest: result.manifest,
          source: "integration_ref",
          integration_item_id: integration.id,
        };
      }
      // The persisted manifest failed validation — likely a
      // manifest_schema major bump that retired this item's contract
      // version. Surface clearly rather than silently using the inline
      // fallback; the operator needs to re-register the integration at
      // a supported version.
      throw new MymeError(
        ErrorCode.VALIDATION_ERROR,
        `Persisted manifest for integration ${integrationRef} failed validation`,
        { errors: result.errors },
      );
    }
    // Orphan ref — system.integration item missing. Fall through to the
    // inline path with a warning so callers see the misconfiguration.
    console.warn(
      `[resolve-manifest] Connection ${connectionId} has integration_ref '${integrationRef}' but no matching system.integration item exists. Falling back to inline manifest.`,
    );
  }

  // Legacy fallback — connection has no integration_ref. Accept the
  // inline manifest, but warn so operators can spot lingering callers
  // before the cleanup PR removes this branch.
  if (inlineManifest === undefined || inlineManifest === null) {
    throw new MymeError(
      ErrorCode.MISSING_REQUIRED_FIELD,
      `Connection ${connectionId} has no integration_ref and no inline manifest was supplied. Either install the connection via /integrations/:id/install (preferred), or include the manifest in the request body (deprecated).`,
      { field: "manifest" },
    );
  }
  const result = validateManifest(inlineManifest);
  if (!result.ok) {
    throw new MymeError(
      ErrorCode.VALIDATION_ERROR,
      "Inline manifest failed validation (legacy path)",
      { errors: result.errors },
    );
  }
  console.warn(
    `[resolve-manifest] Connection ${connectionId} resolved via legacy inline manifest path. This path will be removed in a follow-up PR — install the connection via /integrations/:id/install to migrate.`,
  );
  return {
    manifest: result.manifest,
    source: "inline_legacy",
    integration_item_id: null,
  };
}
