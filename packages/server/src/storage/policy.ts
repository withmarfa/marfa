// Server-side resolvers for inheritance-aware views of a type schema. Walk the
// type's inheritance chain and merge block-by-block, mirroring the codegen-time
// resolution in `packages/types/scripts/generate.ts`. Pure functions — used at
// 409-response assembly time (merge policy) and at GET /types/:id (full schema)
// so callers always see a fully-resolved view.

import type {
  DisplayHints,
  FieldDefinition,
  MergePolicy,
  MergeStrategy,
  TypeSchema,
  VersionPolicy,
} from "@withmarfa/shared";

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
 * strategies as `last_writer_wins` (the default).
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

/**
 * Builds the parent chain for `typeId` in root→leaf order, with cycle guard.
 * Returns an empty array if the type is unknown.
 */
function buildChain(typeId: string, registry: TypeRegistry): TypeSchema[] {
  const chain: TypeSchema[] = [];
  let current = registry.get(typeId);
  const seen = new Set<string>();
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    chain.unshift(current);
    current = current.parent ? registry.get(current.parent) : undefined;
  }
  return chain;
}

/**
 * Resolves the effective type schema for `typeId` by walking its parent chain
 * and returning an inheritance-resolved view:
 *
 * - `fields` — merged root→leaf, per-key. Children cannot redeclare ancestor
 *   fields (enforced at POST /types), so per-key merge is equivalent to union.
 * - `display_hints` — nearest-ancestor-wins. The first ancestor with a
 *   non-undefined block (starting from the leaf) supplies the whole block.
 * - `version_policy` — merged root→leaf, per-key. Documented as
 *   "merges field-by-field" (see `docs/concepts/versions.mdx`); matches
 *   `merge_policy`'s inheritance behaviour.
 * - `merge_policy` — delegated to `resolveMergePolicy`.
 * - `id`, `parent`, `version`, `label`, `description` — kept as-is on the leaf
 *   (these identify the leaf type, not the inherited schema).
 *
 * Returns `undefined` for unknown type ids.
 */
export function resolveTypeSchema(
  typeId: string,
  registry: TypeRegistry,
): TypeSchema | undefined {
  const self = registry.get(typeId);
  if (!self) return undefined;

  const chain = buildChain(typeId, registry);

  // fields: root→leaf, per-key merge.
  const fields: Record<string, FieldDefinition> = {};
  for (const ancestor of chain) {
    Object.assign(fields, ancestor.fields);
  }

  // display_hints: nearest-ancestor-wins. Walk leaf→root (chain is root→leaf,
  // so iterate in reverse) and take the first defined block.
  let displayHints: DisplayHints | undefined;
  for (let i = chain.length - 1; i >= 0; i--) {
    const hints = chain[i]?.display_hints;
    if (hints) {
      displayHints = hints;
      break;
    }
  }

  // version_policy: root→leaf, per-key merge. Matches merge_policy semantics
  // and the "merges field-by-field" contract documented for version_policy.
  let versionPolicy: VersionPolicy | undefined;
  for (const ancestor of chain) {
    const vp = ancestor.version_policy;
    if (!vp) continue;
    versionPolicy = { ...(versionPolicy ?? {}), ...vp };
  }

  const mergePolicy = resolveMergePolicy(typeId, registry);
  const hasMergePolicy =
    mergePolicy.fields !== undefined || mergePolicy.default !== undefined;

  const resolved: TypeSchema = {
    id: self.id,
    version: self.version,
    fields,
  };
  if (self.parent !== undefined) resolved.parent = self.parent;
  if (self.label !== undefined) resolved.label = self.label;
  if (self.description !== undefined) resolved.description = self.description;
  if (displayHints) resolved.display_hints = displayHints;
  if (versionPolicy) resolved.version_policy = versionPolicy;
  if (hasMergePolicy) resolved.merge_policy = mergePolicy;
  return resolved;
}
