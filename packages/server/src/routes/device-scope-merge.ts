import {
  parseScope,
  scopesToTypePermissions,
  scopesToEdgePermissions,
  scopesToMetadataPermissions,
  resolveTypePermission,
  edgePermissionCovers,
  metadataPermissionCovers,
  GLOBAL_TYPE_WILDCARD,
} from "@withmarfa/shared";
import type {
  ParsedScope,
  TypePermission,
  MetadataPermission,
} from "@withmarfa/shared";

/**
 * The scope set a device approval leaves on a grant it is re-approving.
 *
 * **A device approval never narrows a standing grant; it merges into it.**
 * The device screen CONFIRMS a scope list. It has no per-scope toggles, and
 * its own copy says the rows are confirmed rather than editable, so a device
 * request narrower than what the user already granted is an artifact of what
 * that client asked for, not the user electing to give something up. Signing
 * in on a CLI must not silently shrink what the same app already reaches from
 * the browser, and it must not leave `/auth/security` under-reporting access
 * that still works. Requiring full re-consent instead was the other candidate
 * and is worse: it revokes the user's live tokens as an unshown side effect
 * of a CLI login.
 *
 * `preserveBroaderGrant` in `routes/auth-consent.ts` is the deliberate
 * opposite and the pair is worth reading together. That screen offers
 * per-scope toggles, so a set arriving smaller is the user having unticked
 * something and is honored; it compares literals because what it restores is
 * the record of what the user ticked, verbatim.
 *
 * **Why this cannot be computed on the literals.** Scope resolution gives an
 * exact type id precedence over a wildcard spanning it, so a literal sitting
 * beneath a broader wildcard PINS that type to its own verb. Both obvious
 * literal-level merges are wrong, in opposite directions:
 *
 * - A plain set union NARROWS. Standing `core.*:write` plus an approved
 *   `core.note:read` yields a set that no longer confers write on notes,
 *   because the appended exact id outranks the wildcard.
 * - Appending only what the set does not already cover ESCALATES. Standing
 *   `core.*:read` and approved `core.*:write core.note:read` skips the
 *   `core.note:read` pin, because the standing wildcard already covers it,
 *   so the record becomes `core.*:read core.*:write` and confers write on
 *   notes, which neither input conferred. Comparing each candidate against
 *   the standing set rather than the growing one produces the identical
 *   record and the identical escalation; it fixes only order-dependence.
 *   That reading is also unbounded: coverage is not reflexive on a pinned
 *   set, so `core.*:write` is re-appended on every approval and the stored
 *   array grows by one entry per login.
 *
 * **So the merge happens on effective permissions, where "the greater of two
 * grants" can be said at all.** Both sides are projected into the permission
 * maps a credential is stored with, every key either side names is resolved
 * against BOTH whole maps with the resolver the request path uses, the two
 * answers are combined by taking the higher verb, and a literal list is
 * emitted from the result. Resolving each key against the whole opposing map
 * is the load-bearing step: it is what lets a wildcard on one side raise a
 * key pinned on the other, and what stops a pin on one side vanishing
 * because the other side said nothing about it.
 *
 * **Three axes carry breadth and two do not, and the split is not
 * cosmetic.** `scopesToTypePermissions` admits item-type scopes and nothing
 * else. Edge, metadata, OIDC and capability literals all project to
 * nothing, so a merge built on that map alone would drop four families on
 * the floor, and a dropped scope is a narrowing, which is the one thing this
 * function exists to prevent.
 *
 * - **Item types** resolve exact-then-longest-wildcard-then-global, so they
 *   pin. They are the axis the bug was found on.
 * - **Edge types** resolve by the same precedence through
 *   `resolveEdgePermission`, so they pin identically: held
 *   `edge.*:write edge.parent-of:read` does not confer write on
 *   `parent-of`. Handling only item types here would have left the same
 *   defect standing one axis over.
 * - **Metadata sub-resources** fall THROUGH to the namespace wildcard rather
 *   than being pinned by it, so this axis cannot narrow under a plain union.
 *   It is merged the same way regardless: one rule for everything with a
 *   verb is worth more than a second rule justified by today's resolver, and
 *   the day `metadataPermissionCovers` grows precedence this is already
 *   right.
 * - **Capabilities and OIDC literals carry no pattern and no verb.** A
 *   capability is granted by naming it and by nothing else. Membership is
 *   the whole of their algebra, so a literal union is exactly right for them
 *   and nothing can pin anything.
 * - **A literal this build cannot parse** is carried through untouched, on
 *   the same reasoning `grantCoversScope` applies to one: it is covered by
 *   being named and by nothing else, and dropping it over a grammar change
 *   would silently take away access.
 *
 * **What the record says changes, and that is intended.** The emitted list is
 * canonical rather than verbatim: a key the merge raised is written at its
 * merged verb, so a standing `core.note:read` under an approved
 * `core.*:write` is emitted as `core.note:write`. The record then states what
 * the grant actually confers, which is what `/auth/security` is read for.
 * Order is first appearance across standing-then-approved, so the standing
 * entries keep the order the user saw them in.
 *
 * **The record keeps one entry per key it confers, and the prune is what
 * makes that true.** The merge names every (axis, key) either side spelled,
 * so without a second step a key the standing grant already covers still
 * becomes its own entry, at the standing verb. Standing `*:write` under one
 * login per concrete type at `:read` grew an entry per type named, each one
 * already conferred by the wildcard and each written at `:write` though the
 * client only ever asked `:read`. Forty-five such logins reached forty-six
 * entries. `/auth/security` pushes the stored array verbatim, so the page
 * read as the history of how apps had spelled their requests rather than as
 * what the user granted. After the merge builds its list, every breadth entry
 * whose key the rest of the record already resolves to the same verb is
 * dropped, and that shape stays at one entry.
 *
 * **The elimination rule, and it is sequential on purpose.** Walk the emitted
 * entries of one breadth axis in first-appearance order and drop `K:v` if and
 * only if resolving `K` against the map built from the entries still
 * surviving, with `K` itself taken out, still yields `v`. Each drop is taken
 * against the shrinking working set rather than against the original list.
 *
 * That is the part a later reader will try to simplify into one pass over the
 * original. Take `{core.*:read, core.note:read}`. Measured against the whole
 * list, each entry resolves its own key to `read`, so both look redundant and
 * a pass that does not take the candidate out first drops both, and the
 * record then confers nothing on notes at all. Taking the candidate out is
 * what separates them: `core.note` resolves under `core.*` and goes, while
 * `core.*` measured against what is left resolves to `none`, because a
 * concrete key never answers for the pattern above it. Whichever of the two
 * is tested first, the wildcard stays.
 *
 * **Why testing the key is enough, and why no concrete id is enumerated
 * here.** An entry `K` with subtree root `R` can only be the resolver's
 * winner for ids inside `subtree(R)` that no longer key matches. If a longer
 * key strictly inside `subtree(R)` survives, it already outranked `K` for
 * those ids, so `K` was never their winner. If only keys at or above `R`
 * survive, they match `K` and those ids identically, so testing `K` tests
 * every id it governed. The key-level test is therefore equivalent to an
 * id-level one. The enumeration that shows this belongs in the test, over
 * concrete ids, and not in a runtime loop over the registries here.
 *
 * **The literal family is never pruned.** Capability, OIDC and unparseable
 * literals have membership as their whole algebra. There is no verb to
 * resolve, so nothing among them can be redundant, and a deletion rule that
 * reached them would take away a grant rather than a restatement of one.
 *
 * This is a third literal-level operation on a structure that has twice
 * proved not to be a set, so it is written as a removal that provably changes
 * nothing: an entry goes only where the rest of the record already resolves
 * its key to the same verb. Its property test probes concrete ids and never
 * patterns, because a pattern probe re-asks the fail-open question the
 * resolver exists to refuse, and passes against a broken prune.
 *
 * **Idempotent, which is what keeps a repeat login free.** Re-approving the
 * same set resolves every key to the verb it already holds, and a key the
 * request names that the record dropped as redundant is re-derived at the
 * verb the record already confers and dropped again. So the array comes back
 * byte-identical and no literal is ever appended twice.
 *
 * **What bounds the record is the platform allowlist, not what the user
 * approved.** The ceiling is the set of keys `buildAllowedScopes` can name,
 * since initiation refuses a scope outside it. For what that set holds, read
 * that function rather than a restatement here: this passage has carried two
 * different wrong bounds already, each one derived rather than read off the
 * code. Its own docblock states the part both got wrong. A custom type
 * registered at runtime through `POST /types` is NOT picked up as a concrete
 * scope, and a server restart is what re-enumerates from the larger registry.
 * The runtime namespace roots it folds in are installed once at boot and
 * contribute `<root>.*` wildcards, never concrete keys.
 *
 * Reaching that ceiling now takes a client whose varying requests confer
 * genuinely different things on each login, rather than one that merely
 * spells the same access differently. Two requests conferring exactly the
 * same thing leave the same record however they are written.
 */

/** Ordering on the verb lattice the three breadth-carrying axes share. */
const VERB_RANK: Record<TypePermission, number> = {
  none: 0,
  read: 1,
  write: 2,
};

function higherVerb(a: TypePermission, b: TypePermission): TypePermission {
  return VERB_RANK[a] >= VERB_RANK[b] ? a : b;
}

/**
 * Reads an effective verb out of a predicate that only answers yes/no per
 * verb. `resolveTypePermission` returns the level directly; the edge and
 * metadata resolvers are not exported, so their level is recovered from the
 * `*PermissionCovers` helpers the request path itself calls.
 */
function verbFrom(covers: (op: "read" | "write") => boolean): TypePermission {
  if (covers("write")) return "write";
  if (covers("read")) return "read";
  return "none";
}

/** The three permission maps a scope list projects into. */
interface AxisMaps {
  type: Record<string, TypePermission>;
  edge: Record<string, "read" | "write">;
  metadata: Record<string, MetadataPermission>;
}

function project(scopes: readonly string[]): AxisMaps {
  return {
    type: scopesToTypePermissions(scopes),
    edge: scopesToEdgePermissions(scopes),
    metadata: scopesToMetadataPermissions(scopes),
  };
}

type BreadthAxis = "type" | "edge" | "metadata";

/**
 * The key a breadth-carrying scope occupies in its axis's permission map,
 * and how to write that key back out as a literal at a given verb. Returns
 * null for the families with no breadth, which the caller unions verbatim.
 *
 * The key is read off the map projection rather than off the literal, so the
 * two can never disagree about which entry a scope lands on.
 */
function breadthKey(
  parsed: ParsedScope,
): { axis: BreadthAxis; key: string } | null {
  // Unreachable through `parseScope`, and kept anyway. The only shapes it
  // catches that the switch below does not are a `type`, `edge` or `metadata`
  // scope carrying no verb, which the parser cannot produce: the two
  // verb-less families are `oidc` and `capability`, and both have arms of
  // their own. So this exists for a value built by hand or arriving from a
  // stale build, and it is not redundant with the switch even though it reads
  // that way. No test can reach it; deleting it is a decision, not a cleanup.
  if (parsed.operation === "none") return null;
  switch (parsed.kind) {
    case "type":
      return { axis: "type", key: parsed.typePattern };
    case "edge":
      return parsed.edgeType ? { axis: "edge", key: parsed.edgeType } : null;
    case "metadata":
      // A bare `metadata:<verb>` names no sub-resource and is stored under
      // the wildcard key, matching `scopesToMetadataPermissions`.
      return {
        axis: "metadata",
        key: parsed.subresource ?? GLOBAL_TYPE_WILDCARD,
      };
    case "oidc":
    case "capability":
      return null;
    default: {
      // Compile-time exhaustiveness, on the same reasoning as `isTypeScope`
      // in the shared package: a kind added to the union stops this
      // compiling until someone decides how breadth works on it, rather than
      // inheriting whichever arm happens to sit last. The runtime arm
      // unions the literal, which cannot narrow.
      const _exhaustive: never = parsed.kind;
      void _exhaustive;
      return null;
    }
  }
}

function resolveOn(
  axis: BreadthAxis,
  key: string,
  maps: AxisMaps,
): TypePermission {
  switch (axis) {
    case "type":
      return resolveTypePermission(key, maps.type);
    case "edge":
      return verbFrom((op) => edgePermissionCovers(maps.edge, key, op));
    case "metadata":
      return verbFrom((op) => metadataPermissionCovers(maps.metadata, key, op));
  }
}

function literalFor(
  axis: BreadthAxis,
  key: string,
  verb: "read" | "write",
): string {
  switch (axis) {
    case "type":
      return `${key}:${verb}`;
    case "edge":
      return `edge.${key}:${verb}`;
    case "metadata":
      return key === GLOBAL_TYPE_WILDCARD
        ? `metadata:${verb}`
        : `metadata.${key}:${verb}`;
  }
}

/**
 * One entry of the record before it is written back out. A breadth entry
 * carries the axis and key it occupies so the prune can resolve it without
 * re-parsing; a literal entry carries the scope string it was named by,
 * because membership is all it has.
 */
type MergedEntry =
  | { kind: "literal"; scope: string }
  | {
      kind: "breadth";
      axis: BreadthAxis;
      key: string;
      verb: "read" | "write";
    };

function renderEntry(entry: MergedEntry): string {
  return entry.kind === "literal"
    ? entry.scope
    : literalFor(entry.axis, entry.key, entry.verb);
}

/**
 * Drops every breadth entry the rest of the record already confers, by
 * sequential single-entry elimination per axis. See the module docblock for
 * why this is sequential rather than one pass, and why resolving the key is
 * equivalent to resolving every concrete id beneath it.
 *
 * The remainder is re-projected through `project` on each test rather than
 * assembled by hand, so what the candidate is measured against is literally
 * the map the surviving record projects into. A literal entry contributes to
 * no axis map and is never a candidate.
 *
 * One interleaved walk rather than three, and that is the same thing: each
 * axis projects into its own map and `resolveOn` reads only the candidate's,
 * so an entry on another axis can neither keep a candidate nor drop it.
 */
function pruneRedundantEntries(entries: readonly MergedEntry[]): MergedEntry[] {
  let surviving = [...entries];

  for (const candidate of entries) {
    if (candidate.kind !== "breadth") continue;

    // Taking the candidate out BEFORE resolving is the whole rule. Left in,
    // it resolves its own key to its own verb and every entry reads as
    // redundant.
    const without = surviving.filter((entry) => entry !== candidate);
    const remainder = project(without.map(renderEntry));

    if (
      resolveOn(candidate.axis, candidate.key, remainder) === candidate.verb
    ) {
      surviving = without;
    }
  }

  return surviving;
}

/**
 * Merge a device approval into the grant it is re-approving. See the module
 * docblock: the result confers everything either side conferred and nothing
 * neither side conferred, and states it in one entry per key.
 */
export function mergeDeviceApprovalScopes(
  standing: readonly string[],
  approved: readonly string[],
): string[] {
  const standingMaps = project(standing);
  const approvedMaps = project(approved);

  const merged: MergedEntry[] = [];
  const emitted = new Set<string>();

  for (const scope of [...standing, ...approved]) {
    const parsed = parseScope(scope);
    const breadth = parsed ? breadthKey(parsed) : null;

    if (!breadth) {
      // Membership is the whole algebra here: a capability, an OIDC literal,
      // or something this build cannot read. Union verbatim.
      const id = `literal:${scope}`;
      if (emitted.has(id)) continue;
      emitted.add(id);
      merged.push({ kind: "literal", scope });
      continue;
    }

    // One entry per (axis, key), so `core.note:read` and `core.note:write`
    // collapse to the one key they share rather than both surviving.
    const id = `${breadth.axis}:${breadth.key}`;
    if (emitted.has(id)) continue;
    emitted.add(id);

    const verb = higherVerb(
      resolveOn(breadth.axis, breadth.key, standingMaps),
      resolveOn(breadth.axis, breadth.key, approvedMaps),
    );
    // Unreachable: the key came from a literal on one side, so that side
    // resolves it exactly. Guarded because emitting `<key>:none` would write
    // a literal the grammar refuses.
    if (verb === "none") continue;
    merged.push({
      kind: "breadth",
      axis: breadth.axis,
      key: breadth.key,
      verb,
    });
  }

  return pruneRedundantEntries(merged).map(renderEntry);
}
