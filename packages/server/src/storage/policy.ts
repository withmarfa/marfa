// Server-side resolver for the per-type merge policy. Walks the type's
// inheritance chain and merges field-by-field, mirroring the codegen-time
// resolution in `packages/types/scripts/generate.ts`. Pure function — used at
// 409-response assembly time so each conflict carries a fully-resolved policy.

import type { MergePolicy, MergeStrategy, TypeSchema } from "@mymehq/shared";

export type TypeRegistry = ReadonlyMap<string, TypeSchema>;

/**
 * Resolves the effective merge policy for a type by walking its parent chain.
 *
 * - Child `fields` entries merge over parent `fields` (per-key).
 * - Child `default` replaces parent `default`.
 * - An absent `fields` on a child does not erase the parent's entries.
 *
 * Returns an empty `MergePolicy` (no `fields`, no `default`) for unknown types
 * or types with no policy in the chain. Callers should treat unspecified
 * strategies as `last_writer_wins` (the historical default).
 */
export function resolveMergePolicy(
  typeId: string,
  registry: TypeRegistry,
): MergePolicy {
  const chain: TypeSchema[] = [];
  let current = registry.get(typeId);
  const seen = new Set<string>();
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    chain.unshift(current);
    current = current.parent ? registry.get(current.parent) : undefined;
  }

  const fields: Record<string, MergeStrategy> = {};
  let defaultStrategy: MergeStrategy | undefined;
  for (const ancestor of chain) {
    const p = ancestor.merge_policy;
    if (!p) continue;
    if (p.fields) Object.assign(fields, p.fields);
    if (p.default) defaultStrategy = p.default;
  }

  const out: MergePolicy = {};
  if (Object.keys(fields).length > 0) out.fields = fields;
  if (defaultStrategy) out.default = defaultStrategy;
  return out;
}
