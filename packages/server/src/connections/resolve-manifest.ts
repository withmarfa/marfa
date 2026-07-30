/**
 * Resolve the Integration manifest for a Connection.
 *
 * The connection must carry `properties.integration_ref` pointing at a
 * `system.integration` item; this helper looks up that item and
 * validates its stored manifest blob. A connection without
 * `integration_ref` is treated as a configuration error.
 *
 * Errors:
 *   - `NOT_FOUND` — connection doesn't exist or isn't visible in the
 *     caller's space scope.
 *   - `VALIDATION_ERROR` — the persisted manifest fails validation
 *     (typically a manifest_schema major bump retired the item's
 *     contract version; re-register the integration at a supported
 *     version).
 *   - `MISSING_REQUIRED_FIELD` — `integration_ref` not set or doesn't
 *     resolve to a `system.integration` item.
 */
import { MarfaError, ErrorCode } from "@withmarfa/shared";
import type { IntegrationManifest } from "@withmarfa/shared";
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
  spaceId: string | undefined,
): Promise<ResolvedManifest> {
  const connection = await storage.items.get(connectionId, spaceId);
  if (connection?.type !== "system.connection") {
    throw new MarfaError(
      ErrorCode.NOT_FOUND,
      `Connection ${connectionId} not found`,
    );
  }

  const props = connection.properties as ConnectionProperties;
  const integrationRef = props.integration_ref;
  if (!integrationRef) {
    throw new MarfaError(
      ErrorCode.MISSING_REQUIRED_FIELD,
      `Connection ${connectionId} has no integration_ref. Install the connection via /integrations/:id/install.`,
      { field: "integration_ref" },
    );
  }

  const integration = await storage.items.get(integrationRef, spaceId);
  if (integration?.type !== "system.integration") {
    throw new MarfaError(
      ErrorCode.MISSING_REQUIRED_FIELD,
      `Connection ${connectionId} has integration_ref '${integrationRef}' but no matching system.integration item exists.`,
      { field: "integration_ref" },
    );
  }

  const intProps = integration.properties as IntegrationProperties;
  const result = validateManifest(intProps.manifest);
  if (!result.ok) {
    throw new MarfaError(
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
