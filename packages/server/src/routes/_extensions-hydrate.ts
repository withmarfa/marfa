import { filterExtensionsByPermission } from "@mymehq/shared";
import type { ApiKey } from "@mymehq/shared";
import type { Storage } from "../storage/interface.js";

/**
 * Batched hydration for `GET /items?include=extensions` and friends. One
 * SELECT covers the whole list; each per-item record is then passed
 * through `filterExtensionsByPermission` so the caller only sees
 * namespaces it can read — same rule `GET /items/:id/extensions`
 * enforces.
 *
 * Mirrors the `_edges-hydrate.ts` pattern so future `?include=` values
 * have a consistent shape. List reads stay lean by default; callers opt
 * into extras via `?include=`.
 */
export async function hydrateExtensionsForItems(
  storage: Storage,
  itemIds: string[],
  apiKey: ApiKey | undefined,
): Promise<Map<string, Record<string, Record<string, unknown>>>> {
  if (itemIds.length === 0) return new Map();
  const raw = await storage.metadata.getExtensionsForItems(itemIds);
  if (apiKey?.role === "admin") return raw;
  const out = new Map<string, Record<string, Record<string, unknown>>>();
  for (const [id, extensions] of raw) {
    out.set(
      id,
      filterExtensionsByPermission(
        extensions,
        apiKey?.extension_permissions,
        apiKey?.label ?? "",
        false,
      ),
    );
  }
  return out;
}
