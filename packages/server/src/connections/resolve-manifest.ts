/**
 * Resolve the Integration manifest for a Connection — workstream 3
 * Layer 2 PR 2.
 *
 * The connection must carry `properties.integration_ref` pointing at a
 * `system.integration` item; this helper looks up that item and
 * validates its stored manifest blob.
 *
 * The transition-period inline-manifest fallback was removed in T-022 —
 * Layer 2 migrations have run and no production caller now depends on
 * the inline path. A connection without `integration_ref` is treated
 * as a configuration error.
 *
 * Errors:
 *   - `NOT_FOUND` — connection doesn't exist or isn't visible in the
 *     caller's tenant scope.
 *   - `VALIDATION_ERROR` — the persisted manifest fails validation
 *     (typically a manifest_schema major bump retired the item's
 *     contract version; re-register the integration at a supported
 *     version).
 *   - `MISSING_REQUIRED_FIELD` — `integration_ref` not set or doesn't
 *     resolve to a `system.integration` item.
 */
import { MymeError, ErrorCode } from "@mymehq/shared";
import type { IntegrationManifest } from "@mymehq/shared";
import type { Storage } from "../storage/interface.js";
import { validateManifest } from "../integrations/validate-manifest.js";

export interface ResolvedManifest {
  manifest: IntegrationManifest;
  /** Item id of the resolved `system.integration` item. */
  integration_item_id: string;
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
  if (!integrationRef) {
    throw new MymeError(
      ErrorCode.MISSING_REQUIRED_FIELD,
      `Connection ${connectionId} has no integration_ref. Install the connection via /integrations/:id/install.`,
      { field: "integration_ref" },
    );
  }

  const integration = await storage.items.get(integrationRef, tenantId);
  if (integration?.type !== "system.integration") {
    throw new MymeError(
      ErrorCode.MISSING_REQUIRED_FIELD,
      `Connection ${connectionId} has integration_ref '${integrationRef}' but no matching system.integration item exists.`,
      { field: "integration_ref" },
    );
  }

  const intProps = integration.properties as IntegrationProperties;
  const result = validateManifest(intProps.manifest);
  if (!result.ok) {
    throw new MymeError(
      ErrorCode.VALIDATION_ERROR,
      `Persisted manifest for integration ${integrationRef} failed validation`,
      { errors: result.errors },
    );
  }
  return {
    manifest: result.manifest,
    integration_item_id: integration.id,
  };
}
