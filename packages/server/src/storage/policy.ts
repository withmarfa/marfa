// Server-side resolvers for inheritance-aware views of a type schema. Walk the
// type's inheritance chain and merge block-by-block. Pure functions — used at
// 409-response assembly time (merge policy), type reads and normalization.
//
// Codegen resolves merge_policy at build time for shipped types
// (`packages/types/scripts/generate.ts`), and these mirror it. Roles are not
// resolved there and deliberately so: a type registered at runtime under a
// shipped parent never passes through codegen, so a role flattened at build
// time would be a role only in-tree types could hold.

import {
  ErrorCode,
  MarfaError,
  MAX_RESOLUTION_DEPTH,
  mergeFieldChain,
  withFieldLabels,
} from "@withmarfa/shared";
import type {
  DisplayHints,
  MergePolicy,
  MergeStrategy,
  RetentionPolicy,
  TypeRole,
  TypeSchema,
  VersionPolicy,
} from "@withmarfa/shared";

/**
 * A type lookup: resolves a type id to its schema, or undefined. Inheritance
 * chains walk through this. Callers pass `(id) => getTypeSchema(id)`.
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
 * Resolves the effective retention policy for a type by walking its parent
 * chain, root to leaf, key by key. A descendant's `feed_days` replaces the
 * ancestor's, `null` included, which is how it keeps its feed items although
 * a parent expires them. `undefined` when no type in the chain declares one.
 */
export function resolveRetentionPolicy(
  typeId: string,
  resolve: TypeResolver,
): RetentionPolicy | undefined {
  let resolved: RetentionPolicy | undefined;
  for (const ancestor of buildChain(typeId, resolve)) {
    const policy = ancestor.retention_policy;
    if (!policy) continue;
    resolved = { ...(resolved ?? {}), ...policy };
  }
  return resolved;
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
 *
 * Loud, but coded. A bare throw here reached the caller as a 500, which says
 * the server broke rather than that this type's stored chain did, and left
 * nothing to act on. The same code the registry's walkers raise makes the
 * state nameable, and correcting it through `PUT /types/{id}` stays open
 * because that route reads the stored schema directly rather than resolving
 * it.
 */
function buildChain(typeId: string, resolve: TypeResolver): TypeSchema[] {
  const chain: TypeSchema[] = [];
  let current = resolve(typeId);
  const seen = new Set<string>();
  while (current) {
    if (seen.has(current.id) || seen.size >= MAX_RESOLUTION_DEPTH) {
      throw new MarfaError(
        ErrorCode.TYPE_CHAIN_UNRESOLVABLE,
        `Inheritance cycle or excessive depth detected resolving type "${typeId}" (at "${current.id}")`,
        { type_id: typeId, at: current.id },
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
 * - `fields`: merged root→leaf, per-key, preserving child-owned refinements,
 *   a status field carrying every word the chain declares.
 * - `display_hints` — per hint, nearest-ancestor-wins. `title_field`,
 *   `body_field` and `icon` each come from the nearest type in the chain
 *   that sets that hint.
 * - `version_policy` — merged root→leaf, per-key, which is
 *   `merge_policy`'s inheritance behavior.
 * - `merge_policy` — delegated to `resolveMergePolicy`.
 * - `retention_policy` — delegated to `resolveRetentionPolicy`.
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

  // fields: root→leaf, per-key merge, a status field joining its words and a
  // redeclaration keeping a label above it; then each field and member that
  // no type in the chain names takes the label its name makes.
  const fields = withFieldLabels(
    mergeFieldChain(chain.map((ancestor) => ancestor.fields)),
  );

  // display_hints: each hint comes from the nearest type that sets that hint,
  // so a child can set an icon and keep its parent's title. Walk root→leaf and
  // let a nearer value replace a farther one.
  let displayHints: DisplayHints | undefined;
  for (const ancestor of chain) {
    const hints = ancestor.display_hints;
    if (!hints) continue;
    const set = Object.fromEntries(
      Object.entries(hints).filter(([, value]) => value !== undefined),
    );
    if (Object.keys(set).length === 0) continue;
    displayHints = { ...(displayHints ?? {}), ...set };
  }

  // version_policy: root→leaf, per-key merge. Matches merge_policy semantics
  // and the "merges field-by-field" contract documented for version_policy.
  let versionPolicy: VersionPolicy | undefined;
  for (const ancestor of chain) {
    const vp = ancestor.version_policy;
    if (!vp) continue;
    versionPolicy = { ...(versionPolicy ?? {}), ...vp };
  }

  const retentionPolicy = resolveRetentionPolicy(typeId, resolve);

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
  if (self.plural !== undefined) resolved.plural = self.plural;
  if (self.description !== undefined) resolved.description = self.description;
  if (displayHints) resolved.display_hints = displayHints;
  // The type's own and never an ancestor's: a link identifies rows of
  // exactly the type that names it.
  if (self.link_field !== undefined) resolved.link_field = self.link_field;
  if (versionPolicy) resolved.version_policy = versionPolicy;
  if (hasMergePolicy) resolved.merge_policy = mergePolicy;
  if (retentionPolicy) resolved.retention_policy = retentionPolicy;
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
