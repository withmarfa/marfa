import { extensionLabelOf } from "../auth/extension-label.js";
import { filterExtensionsByPermission } from "@withmarfa/shared";
import type { ApiKey, Metadata } from "@withmarfa/shared";

export function parseIntParam(
  raw: string | undefined,
  defaultValue: number,
  min: number,
  max: number,
): number {
  if (raw === undefined) return defaultValue;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) return defaultValue;
  return Math.max(min, Math.min(max, parsed));
}

/**
 * Metadata returned to a caller must hide extension namespaces the caller
 * has no read access to — same rule `GET /items/:id/extensions` enforces.
 * Every list and single-item route that includes metadata in its response
 * goes through this so the permission model is uniform across paths.
 */
export function filterMetadataForCaller(
  metadata: Metadata,
  apiKey: ApiKey | undefined,
): Metadata {
  return {
    ...metadata,
    extensions: filterExtensionsByPermission(
      metadata.extensions,
      apiKey?.extension_permissions,
      extensionLabelOf(apiKey),
      false,
    ),
  };
}
