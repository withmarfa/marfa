// Server-side resolvers for inheritance-aware views of a type schema. Walk the
// type's inheritance chain and merge block-by-block. Pure functions — used at
// 409-response assembly time (merge policy) and at both type reads (full
// schema, and roles on the list) so callers always see a fully-resolved view.
//
// Codegen resolves merge_policy at build time for shipped types
// (`packages/types/scripts/generate.ts`), and these mirror it. Roles are not
// resolved there and deliberately so: a type registered at runtime under a
// shipped parent never passes through codegen, so a role flattened at build
// time would be a role only in-tree types could hold.

import { MAX_RESOLUTION_DEPTH } from "@withmarfa/shared";
import type {
  DisplayHints,
  FieldDefinition,
  MergePolicy,
  MergeStrategy,
  TypeRole,
  TypeSchema,
  VersionPolicy,
} from "@withmarfa/shared";

/**
 * A space-scoped type lookup: resolves a type id to its schema, or undefined.
 * Inheritance chains walk through this so a custom type's ancestors resolve in
 * the same space scope. Callers pass `(id) => getTypeSchema(id, spaceId)`.
 */
export type TypeResolver = (id: string) => TypeSchema | undefined;

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
  resolve: TypeResolver,
): MergePolicy {
  const chain = buildChain(typeId, resolve);

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
 * Builds the parent chain for `typeId` in root→leaf order. Returns an empty
 * array if the type is unknown, and throws on a cycle or excessive depth.
 *
 * Throwing rather than truncating is deliberate, and it is what the registry's
 * own walkers (`typeHasRole`, `isSubtypeOf`, `getResolvedFields`) already do.
 * A truncated chain yields a partial merge policy or a partial role set that
 * looks like a real answer, so the two sides of a rule can silently disagree —
 * `roles` here says a type is a container while `typeHasRole` throws under the
 * edge check. A wrong answer is worse than a loud one.
 */
function buildChain(typeId: string, resolve: TypeResolver): TypeSchema[] {
  const chain: TypeSchema[] = [];
  let current = resolve(typeId);
  const seen = new Set<string>();
  while (current) {
    if (seen.has(current.id) || seen.size >= MAX_RESOLUTION_DEPTH) {
      throw new Error(
        `Inheritance cycle or excessive depth detected resolving type "${typeId}" (at "${current.id}")`,
      );
    }
    seen.add(current.id);
    chain.unshift(current);
    current = current.parent ? resolve(current.parent) : undefined;
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
 *   "merges field-by-field" (see `docs/guides/schema/versions.mdx`); matches
 *   `merge_policy`'s inheritance behavior.
 * - `merge_policy` — delegated to `resolveMergePolicy`.
 * - `roles` — union across the chain, delegated to `resolveRoles`. Absent
 *   rather than empty when the chain declares none.
 * - `id`, `parent`, `version`, `label`, `description`, `compatible_with` —
 *   kept as-is on the leaf (these identify the leaf type and its own claims,
 *   not the inherited schema).
 *
 * Returns `undefined` for unknown type ids.
 */
export function resolveTypeSchema(
  typeId: string,
  resolve: TypeResolver,
): TypeSchema | undefined {
  const self = resolve(typeId);
  if (!self) return undefined;

  const chain = buildChain(typeId, resolve);

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

  const roles = resolveRoles(typeId, resolve);
  const mergePolicy = resolveMergePolicy(typeId, resolve);
  const hasMergePolicy =
    mergePolicy.fields !== undefined || mergePolicy.default !== undefined;

  const resolved: TypeSchema = {
    id: self.id,
    version: self.version,
    fields,
  };
  if (self.parent !== undefined) resolved.parent = self.parent;
  if (self.compatible_with !== undefined) {
    resolved.compatible_with = self.compatible_with;
  }
  if (self.label !== undefined) resolved.label = self.label;
  if (self.description !== undefined) resolved.description = self.description;
  if (displayHints) resolved.display_hints = displayHints;
  if (versionPolicy) resolved.version_policy = versionPolicy;
  if (hasMergePolicy) resolved.merge_policy = mergePolicy;
  if (roles) resolved.roles = roles;
  return resolved;
}

/**
 * The roles a type carries, its own and every ancestor's, or `undefined` when
 * it carries none.
 *
 * Its own function because two endpoints need it and they must not diverge.
 * The list returns schemas as declared rather than resolved, which is fine for
 * fields and policies — a caller reading those wants one type and fetches it —
 * and wrong for roles, because a role exists precisely to be enumerated across
 * types. A client building "which of these can hold a collection" reads the
 * list, and a list answering with declared roles omits every subtype of a
 * container while the write path accepts them.
 *
 * The union is what the rule already does. `typeHasRole` walks the parent
 * chain and answers true for a role any ancestor declares, so an edge
 * constrained on `role:container` already admits a subtype of a container.
 * Returning only the leaf's own roles would have the read surface say a type
 * is not a container while the write path takes it as one.
 *
 * Sorted, so the answer does not depend on chain order. `undefined` rather
 * than an empty array, because a reader cannot tell `[]` from "declares none"
 * and a generated client surfacing an always-empty array reads as a definite
 * no rather than as absent.
 */
export function resolveRoles(
  typeId: string,
  resolve: TypeResolver,
): TypeRole[] | undefined {
  const roles = new Set<TypeRole>();
  for (const ancestor of buildChain(typeId, resolve)) {
    for (const role of ancestor.roles ?? []) roles.add(role);
  }
  return roles.size > 0 ? [...roles].sort() : undefined;
}
