import {
  parseScope,
  scopesToTypePermissions,
  scopesToEdgePermissions,
  scopesToMetadataPermissions,
  scopesToProfilePermissions,
  resolveTypePermission,
  edgePermissionCovers,
  metadataPermissionCovers,
  profilePermissionCovers,
  subtreeWildcardRoot,
  GLOBAL_TYPE_WILDCARD,
} from "@withmarfa/shared";
import type {
  ProfilePermission,
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
 * **Three axes carry breadth, and three families sit outside all of them.
 * The split is not cosmetic.** `scopesToTypePermissions` admits item-type
 * scopes, plus the content category, which reaches that map as a complement
 * rather than as a key anything could resolve against. Edge, metadata, OIDC
 * and capability literals project into it not at all, so a merge built on
 * that map alone would drop four families on the floor, and a dropped scope
 * is a narrowing, which is the one thing this function exists to prevent.
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
 * - **The content category is unioned beside them, and the reason differs.**
 *   It carries a verb and it does reach the item-type map, so it is not a
 *   membership family. What it writes there is a complement — the global
 *   wildcard at the granted level, exact exclusions beneath it — which is
 *   not a key any of the three axes could resolve a merge against. So it
 *   escapes the axis merge, and the exclusions its projection writes then
 *   outrank a wildcard the standing grant holds. `breadthKey`'s own arm
 *   carries what that costs and why nothing reaches it today.
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
 * **That sentence is about breadth entries, and one family is not one.** The
 * content category occupies no key on any of the three axes, so `breadthKey`
 * returns null, the merge unions its literals verbatim, and the prune — which
 * walks breadth entries and nothing else — never looks at them. A record
 * holding both levels therefore names the pattern `content` twice, once at
 * each verb, which is the shape the paragraph above exists to remove
 * everywhere it can reach. Both are kept deliberately: the pair projects at
 * `write`, and dropping either would drop a grant that this record is the
 * account of, which is the one thing a merge must not do. So the invariant is
 * "one entry per key on a breadth axis", not "one entry per key", and the
 * difference is written here because reading it as the second would make this
 * family look like a defect in the prune. Unreachable while the literals are
 * withheld from `buildAllowedScopes`; the change that publishes them decides
 * whether a pair naming one pattern is worth collapsing to one line.
 *
 * **The elimination rule.** Walk the emitted entries of one breadth axis in
 * first-appearance order and drop `K:v` if and only if resolving `K` against
 * the map built from the entries still surviving, with `K` itself taken out,
 * still yields `v`.
 *
 * **Taking the candidate out before resolving it is the load-bearing half.**
 * Take `{core.*:read, core.note:read}`. Resolved against the whole list, each
 * entry answers its own key with its own verb, so both read as redundant,
 * both go, and the record stops conferring read on notes altogether. Taking
 * the candidate out first separates them: `core.note` resolves under `core.*`
 * and goes, while `core.*` measured against what is left answers `none`,
 * because a concrete key never answers for the pattern above it. Whichever of
 * the two is tested first, the wildcard stays.
 *
 * **Sequential, and not because one pass would be wrong.** A single pass over
 * the original list that still takes each candidate out is equivalent, and
 * that example does not argue otherwise: it rules out a pass with no
 * exclusion, which is a different transformation. On these resolvers
 * domination is antisymmetric, so two keys cannot each be the other's reason
 * to go, and the two forms agree on every input. Sequential is written
 * because it is the form that needs no such argument. Every removal is
 * resolution-preserving against the set current when it is taken, so the
 * composition is safe by induction, and nothing has to be established about
 * how one drop bears on the next. Simplifying this to one pass does not break
 * it; dropping the exclusion does.
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
 * That argument has a precondition, and one axis does not meet it: the keys
 * have to form a prefix tree over concrete ids. See {@link keyIsResolvable},
 * which is what keeps the prune inside the set where the argument holds.
 *
 * **That filter reaches the prune and nothing else on this side.** The two
 * projections the merge resolves against are built from the raw lists, where
 * {@link intersectDeviceScopes} deliberately projects both sides through
 * `resolvableScopes` first, and the asymmetry is worth stating rather than
 * inferring from the two call sites. What follows from it is that a key the
 * prune may not reason about still answers for other keys here: `edge.*.*`
 * string-matches `edge.*` while reaching no ordinary edge type, and at a
 * nested root it is the longest match, so it outranks `edge.*` at
 * `edge.user.*` too. Both directions occur — a key raised above what either
 * input conferred, and a key pinned below — and neither is introduced by the
 * intersection or changed by it. Whether the merge should take the same
 * filter is open, and the stakes differ: what this writes is the record
 * `/auth/security` reports, not the list a token is minted from.
 *
 * **The unioned families are never pruned**, and there are four of them, not
 * three. Capability, OIDC and unparseable literals have membership as their
 * whole algebra: there is no verb to resolve, so nothing among them can be
 * redundant, and a deletion rule that reached them would take away a grant
 * rather than a restatement of one. The content category reaches the same
 * place by a different road — it does carry a verb, but not on a key any
 * axis holds — and the conclusion is the same, so the rule needs no arm for
 * it. What differs is only why, which is why it is named here rather than
 * folded into the sentence above it.
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

function lowerVerb(a: TypePermission, b: TypePermission): TypePermission {
  return VERB_RANK[a] <= VERB_RANK[b] ? a : b;
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
  profile: Record<string, ProfilePermission>;
}

function project(scopes: readonly string[]): AxisMaps {
  return {
    type: scopesToTypePermissions(scopes),
    edge: scopesToEdgePermissions(scopes),
    metadata: scopesToMetadataPermissions(scopes),
    profile: scopesToProfilePermissions(scopes),
  };
}

type BreadthAxis = "type" | "edge" | "metadata" | "profile";

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
    case "profile":
      // An axis of its own rather than `null`, because this family carries
      // real breadth: `profile:<verb>` is the wildcard key and
      // `profile.<row>:<verb>` is an exact one, exactly as metadata is. Left
      // unioned verbatim, a standing `profile:read` beside an approved
      // `profile.name:write` would survive as two literals whose projection
      // then resolves the row at write and the category at read — which is
      // correct, but the prune could never see the pair as one breadth
      // question and would keep restating it.
      return {
        axis: "profile",
        key: parsed.profileRow ?? GLOBAL_TYPE_WILDCARD,
      };
    case "oidc":
    case "capability":
      return null;
    case "content":
      // Union verbatim, with the two membership families, even though this
      // one carries a verb. The category is a complement over the item-type
      // axis rather than an entry in any of the three maps, so it occupies
      // no key a breadth merge could resolve against. Between the two content
      // literals the union is right on its own terms: if one side holds
      // `content:read` and the other `content:write`, both survive and the
      // projection resolves the pair at `write`, which is what either side
      // conferring write means.
      //
      // **But returning `null` puts this arm back inside the hazard the
      // header names, one level down.** "A plain set union NARROWS, because
      // the appended exact id outranks the wildcard" is stated up there about
      // literals; the category is not a literal on any axis, so it escapes
      // the axis merge — and then its PROJECTION writes the exact keys. Every
      // `SYSTEM_TYPE_IDS` member lands at `"none"` and `marfa.*` is clamped to
      // read, both outranking whatever wildcard the standing grant holds. So
      // unioning `content:read` into a standing `*:read` takes
      // `system.credential` from read to none. The union preserves the
      // literals; the projection underneath is what reorders. Fail-closed, so
      // nothing is conferred, but it is a narrowing, and this arm is where it
      // would go unnoticed.
      //
      // Returning null also puts both literals outside the prune, which
      // walks breadth entries only. A record holding the pair names the
      // pattern `content` twice, once at each verb — the restatement the
      // prune exists to remove, kept here because collapsing it would drop a
      // grant. The header's record invariant is scoped to breadth keys for
      // this reason and says so.
      //
      // Not reachable today: the two literals are withheld from
      // `buildAllowedScopes`, so no device approval can carry one. The
      // change that publishes them owns this, and `content:read` alongside a
      // wildcard is the case it has to answer.
      return null;
    default: {
      // Compile-time exhaustiveness, on the same reasoning as `isTypeScope`
      // in the shared package: a kind added to the union stops this
      // compiling until someone decides how breadth works on it, rather than
      // inheriting whichever arm happens to sit last. The runtime arm unions
      // the literal, which preserves it; whether the projection underneath
      // narrows on some key is a question the new kind's own arm answers, as
      // the content arm above does.
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
    case "profile":
      return verbFrom((op) => profilePermissionCovers(maps.profile, key, op));
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
    case "profile":
      return key === GLOBAL_TYPE_WILDCARD
        ? `profile:${verb}`
        : `profile.${key}:${verb}`;
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
 * Whether the resolvers may reason about a key: whether its subtree root, if
 * it has one, is a literal identifier rather than a second pattern. That
 * admits the global wildcard, every key with no subtree root at all, and a
 * subtree wildcard whose root ends in no further wildcard.
 *
 * **Not a grammar check, and it does not claim to be one.** `a..b`, `a.` and
 * `u_1..x` all pass it and none is a well-formed identifier. So does
 * `a-b*c`, which `routes/edge-types.ts` registers as a real edge type
 * because it skips the identifier check for any id holding a hyphen.
 * Admitting them changes nothing, because a key with no subtree root is
 * reached by exact match alone: it answers for itself and for nothing else,
 * so it can neither raise another key nor be raised by one. `*` is the lone
 * exception and needs no clause of its own: `subtreeWildcardRoot("*")` is
 * null, so it takes that branch while matching everything, and all three
 * resolvers reach it as the root of the prefix tree rather than by exact
 * match.
 *
 * **What has to be excluded is the shape whose key-level answer differs from
 * its answer at every concrete id.** The sufficiency argument in the module
 * docblock assumes the keys form a prefix tree over concrete ids, and a key
 * whose subtree root is ITSELF a pattern breaks that. `isValidTypePattern`
 * puts a type wildcard's root through a charset holding no asterisk, so
 * `core.*.*:write` is refused outright. The edge axis has no pattern
 * validator, so `edge.*.*:write` parses, and `subtreeWildcardRoot("*.*")` is
 * `"*"`, a root that string-matches the global KEY while matching no ordinary
 * edge type. Such an entry answers for `edge.*` at the key level and reaches
 * nothing but the ids that carry a whole-segment asterisk themselves, which
 * is precisely the divergence the argument rules out.
 *
 * **This is not only about the global root, and a check written against that
 * one instance is not enough.** The same collision happens at every level of
 * the key tree: `subtreeWildcardRoot("user.*.*")` is `"user.*"`, which
 * matches the key `user.*` exactly as `"*"` matches `*`. So
 * `edge.user.*:write` merged with `edge.user.*.*:write` loses the wildcard
 * too, and that victim is not contrived: `resolveEdgePermission` says in its
 * own docblock that `edge.user.*` is the only expression reaching a space's
 * runtime-registered relation edges short of the global wildcard.
 *
 * It cost a real narrowing: `edge.*:write` merged with `edge.*.*:write`
 * dropped the wildcard carrying write on every edge type on the instance,
 * because the malformed sibling appeared to confer it. Reachable through
 * operator-configured permission bundles, whose only filter is
 * `isValidScope`.
 *
 * A key like that can neither be shown redundant nor stand as the reason
 * another entry is. Both halves are needed and the second is the one that
 * fixes the case above: the victim there is `edge.*`, whose own key is
 * resolvable, so refusing only unresolvable CANDIDATES leaves it dropped. It
 * is carried through untouched and kept out of the map a candidate is
 * measured against.
 *
 * **Refusing every key that carries an asterisk anywhere was itself an
 * escalation, and that is why this is drawn at the subtree root.** Two
 * further shapes carry one without colliding with anything, and neither is
 * inert: a concrete key holding an asterisk (`a-b*c`), and a subtree wildcard
 * whose root holds one without being a pattern (`a-b*.*`). Both PIN.
 * {@link intersectDeviceScopes} projects both sides' maps without the keys it
 * may not resolve through, so dropping a pin removed a restriction, and the
 * wildcard above it then answered for that id at a wider verb than either
 * side conferred: `["edge.*:write", "edge.a-b*c:read"]` on both sides was
 * issued `edge.*:write` alone, which reaches write on `a-b*c` where the pin
 * says read. The mirror cost as much in the other direction, dropping a pin
 * only one side named and taking away the read the other side reached that id
 * at. The shape refused here loses far less, but not nothing, which is what
 * the next passage is about.
 *
 * **A residue is accepted rather than unnoticed, and it runs in both
 * directions.** A refused key is `R.*` for an `R` that itself ends in `.*`,
 * and the ids it reaches are `R` and `R.<anything>`. Every one of them
 * carries a whole-segment asterisk somewhere, not necessarily first: `*.*`
 * reaches `*.a-b`, and `user.*.*` reaches `user.*.q-x`. So the residue is a
 * statement about that whole family rather than about the global root,
 * exactly as the collision above is.
 *
 * At such an id the refused key is a pin like any other, and dropping it
 * costs what dropping a pin always costs. Where a broader key survives, the
 * id is answered at the broader verb, above what either side conferred:
 * `["edge.*:write", "edge.*.*:read"]` on both sides is issued
 * `edge.*:write`, which reaches write on `*.a-b` where both sides say read.
 * Where no broader key survives, the id loses the access both sides
 * conferred: `["edge.*.*:read"]` on both sides is issued nothing at all.
 * Narrowing is far the commoner of the two, because a side naming the
 * refused key alone leaves nothing to fall back to.
 *
 * Neither direction is hypothetical. `routes/edge-types.ts` registers
 * `*.a-b` and `user.*.q-x`, because it skips the identifier check for any id
 * holding a hyphen, and `bundlePublishedScopes` admits `edge.*.*:read` into
 * an operator-configured bundle on `isValidScope` alone.
 *
 * It is taken as a trade rather than defended as correct. What the refusal
 * removes is a token over every ordinary edge type on the instance; what it
 * costs is confined to ids that themselves carry a whole-segment asterisk,
 * which exist only through the registration hole. Closing that hole, and
 * adding the edge pattern validator whose absence lets the key parse at all,
 * removes both halves. Until then the residue is pinned by its own named
 * test beside the ones for the collision, rather than left to be
 * rediscovered.
 */
function keyIsResolvable(key: string): boolean {
  const root = subtreeWildcardRoot(key);
  if (root === null) return true;
  return root !== GLOBAL_TYPE_WILDCARD && subtreeWildcardRoot(root) === null;
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
    if (!keyIsResolvable(candidate.key)) continue;

    // Taking the candidate out BEFORE resolving is the whole rule. Left in,
    // it resolves its own key to its own verb and every entry reads as
    // redundant.
    const without = surviving.filter((entry) => entry !== candidate);
    // A key the resolvers may not reason about stays in `surviving` and out
    // of the remainder: it is emitted, and it never justifies a drop.
    const remainder = project(
      without
        .filter(
          (entry) => entry.kind === "literal" || keyIsResolvable(entry.key),
        )
        .map(renderEntry),
    );

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

/**
 * The scopes a device is issued a token for: what it asked for, bounded by
 * what the grant it is polling against still confers.
 *
 * **The sibling of the merge, taking the minimum where that takes the
 * maximum**, and it exists for the same reason: the literals are a precedence
 * structure rather than a set, so neither end of this can be computed on
 * them. A device request is no longer the same thing as the grant record.
 * An approval merges into a standing grant rather than replacing it, so the
 * record can hold the browser's own consent for the same client and user,
 * and minting from the record would hand a CLI the web app's access, with a
 * refresh token wherever the browser had once asked to stay signed in.
 *
 * **What the literal-level filter got wrong.** Testing each requested scope
 * with `grantCoversScope(record, scope)` reads as an intersection and is not
 * one, because coverage is not reflexive on a pinned set: an exact type id
 * outranks a wildcard spanning it, so `["core.*:write", "core.note:read"]`
 * does not cover `core.*:write`, a literal it contains. A device asking for
 * a wildcard alongside a narrower pin was issued the pin alone. The user
 * approved both, the grant reached both, and the client was handed a
 * narrower `scope` string rather than an error.
 *
 * **So this walks the union of both sides' keys and takes the lower verb.**
 * Every (axis, key) either side names is resolved against BOTH whole maps
 * with the resolver the request path uses, and the result is written out at
 * the lesser of the two answers. Resolving each key against the whole
 * opposing map is what makes a wildcard on one side answer for a key pinned
 * on the other.
 *
 * **Walking the union rather than the request alone is the whole correctness
 * argument.** A request-only walk loses the grant's pins. Request `*:write`
 * against a grant of `core.note:read` visits only the key `*`, where the
 * grant resolves to `none`, so the key drops and the device is issued
 * nothing, though the grant plainly reaches read on notes and the device
 * plainly asked for it. The union walk visits `core.note` as well, resolves
 * it to `write` through the request's own wildcard and to `read` on the
 * grant, and issues `core.note:read`, which is the true intersection.
 *
 * **Dropping a key at `none` cannot escalate anything beneath it.** An id
 * whose highest-precedence key drops falls through to a broader surviving
 * key, and a broader key can only resolve non-`none` on a side that has some
 * key matching it, and matching is transitive along the prefix tree, so that
 * is a key matching the id too. So the side that answered `none` at the
 * narrow key answers `none` at every key above it as well, and the broader
 * entry drops with it. Unlike the merge, `none` is reached here on ordinary
 * input rather than being unreachable, which is exactly how a request the
 * grant does not reach comes back empty.
 *
 * **The verb-less families intersect by plain membership.** A capability, an
 * OIDC literal and a literal this build cannot parse are each granted by
 * being named and by nothing else, so each appears in the result only if
 * both sides named it. `offline_access` is the load-bearing one: the route
 * reads it back off this list to decide whether a refresh token is minted at
 * all, so a browser's `offline_access` must not reach a CLI that never asked
 * for it, and a CLI's must not survive a grant that no longer carries it.
 *
 * **A key the prune may not reason about is not one this may resolve
 * through either.** {@link keyIsResolvable} describes the shape: a key whose
 * subtree root is itself a pattern, so it string-matches a broader key while
 * reaching no ordinary id, which the edge axis admits for want of a pattern
 * validator. Both sides' maps are projected without it and it is never
 * emitted. Leaving it in would let a grant holding only `edge.*.*:read`,
 * which reaches no ordinary edge type, answer for the key `edge.*` and issue
 * a token reaching every edge type on the instance.
 *
 * **The boundary is drawn at the subtree root because a key carrying an
 * asterisk anywhere else is a pin, and dropping a pin here is an escalation
 * rather than a simplification.** This list is what the token is minted
 * from, so a pin dropped from it is a restriction dropped, and the wildcard
 * above answers in its place at a wider verb than either side conferred.
 * Such a key is resolved and emitted like any other.
 *
 * **The refused shape does have ids beneath it, and the cost of removing it
 * falls there, in both directions.** Those are the ids carrying a
 * whole-segment asterisk of their own — `*.a-b` beneath `*.*`, `user.*.q-x`
 * beneath `user.*.*` — and at each of them this issues above both sides
 * where a broader key survives and below both sides where none does. So the
 * removal is a trade rather than a free move, and {@link keyIsResolvable}
 * carries the cases, the reachability, and why the trade is taken.
 *
 * **The issued list is canonical rather than verbatim, and that is visible
 * to the client.** It is written at the verb each key resolves to and pruned
 * to one entry per key it confers, so it can name a pin the device never
 * spelled (`core.note:read` in the walk above), and it can spell a request
 * the record already canonicalized upward differently from how the client
 * sent it. RFC 6749 §5.1 provides for exactly this, and the route returns
 * the result as its `scope`, so a narrowing stays visible rather than
 * silent. A client comparing the returned string to its request for equality
 * rather than reading it will see a difference.
 */
export function intersectDeviceScopes(
  requested: readonly string[],
  granted: readonly string[],
): string[] {
  const requestedMaps = project(resolvableScopes(requested));
  const grantedMaps = project(resolvableScopes(granted));
  const requestedLiterals = new Set(membershipScopes(requested));
  const grantedLiterals = new Set(membershipScopes(granted));

  const issued: MergedEntry[] = [];
  const emitted = new Set<string>();

  for (const scope of [...requested, ...granted]) {
    const parsed = parseScope(scope);
    const breadth = parsed ? breadthKey(parsed) : null;

    if (!breadth) {
      // Membership is the whole algebra here, so the intersection is plain
      // set intersection. Both sides are tested rather than only the grant,
      // so a literal the grant holds and this device never asked for is not
      // issued on the strength of appearing in the walk.
      if (!requestedLiterals.has(scope) || !grantedLiterals.has(scope)) {
        continue;
      }
      const id = `literal:${scope}`;
      if (emitted.has(id)) continue;
      emitted.add(id);
      issued.push({ kind: "literal", scope });
      continue;
    }

    if (!keyIsResolvable(breadth.key)) continue;

    const id = `${breadth.axis}:${breadth.key}`;
    if (emitted.has(id)) continue;
    emitted.add(id);

    const verb = lowerVerb(
      resolveOn(breadth.axis, breadth.key, requestedMaps),
      resolveOn(breadth.axis, breadth.key, grantedMaps),
    );
    // Reached whenever one side does not reach the other's key at all, which
    // is the ordinary case for a grant narrower than the request.
    if (verb === "none") continue;
    issued.push({
      kind: "breadth",
      axis: breadth.axis,
      key: breadth.key,
      verb,
    });
  }

  return pruneRedundantEntries(issued).map(renderEntry);
}

/** The scopes of one side that carry a key the resolvers can reason about. */
function resolvableScopes(scopes: readonly string[]): string[] {
  return scopes.filter((scope) => {
    const parsed = parseScope(scope);
    const breadth = parsed ? breadthKey(parsed) : null;
    return breadth !== null && keyIsResolvable(breadth.key);
  });
}

/** The scopes of one side whose whole algebra is membership. */
function membershipScopes(scopes: readonly string[]): string[] {
  return scopes.filter((scope) => {
    const parsed = parseScope(scope);
    return parsed === null || breadthKey(parsed) === null;
  });
}
