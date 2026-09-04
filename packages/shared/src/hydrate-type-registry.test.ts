import { afterEach, describe, expect, it } from "vitest";
import type { TypeSchema } from "@withmarfa/types";
import { hydrateTypeRegistry } from "./hydrate-type-registry.js";
import {
  MAX_RESOLUTION_DEPTH,
  PLATFORM_TIERS,
  SYSTEM_TYPE_IDS,
  TYPE_REGISTRY,
  classifyNamespace,
  getTypeSchema,
  hasBoundedLifecycle,
  listTypes,
  softDeleteState,
  unregisterTypeSchema,
  validateProperties,
  validateTransition,
} from "./type-registry.js";
import {
  PLATFORM_TIERS as tiersFromPackageRoot,
  hasBoundedLifecycle as boundedLifecycleFromPackageRoot,
} from "./index.js";
import { ErrorCode, MarfaError } from "./errors.js";

// A space of its own per file: the registry is a module-level singleton, so a
// leftover registration is visible to every other test in the process.
const SPACE = "01a02000-0000-7000-8000-0000000000f1";

const registered: string[] = [];

afterEach(() => {
  // Reverse order so a child is gone before the parent whose removal would
  // otherwise walk it.
  for (const id of registered.splice(0).reverse()) {
    unregisterTypeSchema(id, SPACE);
  }
});

function hydrate(payload: readonly TypeSchema[]) {
  const result = hydrateTypeRegistry(payload, { spaceId: SPACE });
  registered.push(...result.registered);
  return result;
}

describe("hydrateTypeRegistry", () => {
  it("resolves a payload that lists a child before its parent", () => {
    // `GET /types` makes no ordering promise, and a space that registered
    // the child first gets it back first. What this pins is that such a
    // payload does not corrupt resolution — not that the order is what
    // saves it. Nothing here would fail if the order suddenly mattered;
    // the registration-order test below is the only place that shows.
    hydrate([
      { id: "acme.child", version: 1, parent: "acme.parent", fields: {} },
      {
        id: "acme.parent",
        version: 1,
        fields: { headline: { type: "string", required: true } },
      },
    ]);

    const missing = validateProperties("acme.child", {}, { spaceId: SPACE });
    expect(missing.success).toBe(false);

    const present = validateProperties(
      "acme.child",
      { headline: "set" },
      { spaceId: SPACE },
    );
    expect(present.success).toBe(true);
  });

  it("registers parents ahead of children", () => {
    // The only place the ordering is observable at all. Field resolution is
    // lazy, so the test above passes whether or not anything sorted the
    // payload; this is what actually holds the walk in place, and the walk is
    // what the cycle and unresolved-parent reports are computed from.
    const result = hydrate([
      { id: "acme.leaf", version: 1, parent: "acme.branch", fields: {} },
      { id: "acme.branch", version: 1, parent: "acme.root", fields: {} },
      { id: "acme.root", version: 1, fields: {} },
    ]);

    expect(result.registered).toEqual([
      "acme.root",
      "acme.branch",
      "acme.leaf",
    ]);
  });

  it("leaves the shipped vocabulary alone", () => {
    // `GET /types` returns the platform set too, and a shipped type written
    // into the overlay is listed twice, because `listTypes` concatenates the
    // two maps and deduplicates neither. The count below is what detects
    // that; a leak takes it to `before + 2`.
    //
    // Resolution is not at risk and no assertion here pretends otherwise:
    // `resolveSchema` reads the platform registry first, so an overlay entry
    // under a shipped id is unreachable whatever it contains.
    const before = listTypes(SPACE).length;

    const result = hydrate([
      { id: "core.note", version: 1, fields: {} },
      { id: "acme.own", version: 1, fields: {} },
    ]);

    expect(result.skippedPlatform).toEqual(["core.note"]);
    expect(result.registered).toEqual(["acme.own"]);
    expect(listTypes(SPACE).length).toBe(before + 1);
  });

  it("registers a closed parent chain and names its members", () => {
    // The load-bearing part is that both members come back in `cycles` AND
    // in `registered`, parent links intact: hydration does not quietly drop
    // a closed chain, which would have the client report an unknown type for
    // a type the server holds. The raise below is a sanity check rather than
    // the new thing — the registry's own suite already covers it.
    const result = hydrate([
      { id: "acme.ouro", version: 1, parent: "acme.boros", fields: {} },
      { id: "acme.boros", version: 1, parent: "acme.ouro", fields: {} },
    ]);

    expect(result.cycles.sort()).toEqual(["acme.boros", "acme.ouro"]);
    expect(result.registered.sort()).toEqual(["acme.boros", "acme.ouro"]);
    expect(getTypeSchema("acme.ouro", SPACE)).toBeDefined();

    try {
      validateProperties("acme.ouro", {}, { spaceId: SPACE });
      expect.unreachable("resolving a closed chain must raise");
    } catch (error) {
      expect(error).toBeInstanceOf(MarfaError);
      expect((error as MarfaError).code).toBe(
        ErrorCode.TYPE_CHAIN_UNRESOLVABLE,
      );
    }
  });

  it("names the type whose parent resolves nowhere, and only that type", () => {
    // The break is at `acme.orphan`. Its own child inherits the shortfall but
    // resolves as far as the graph goes, so reporting it too would be noise.
    const result = hydrate([
      { id: "acme.orphan", version: 1, parent: "acme.absent", fields: {} },
      { id: "acme.below", version: 1, parent: "acme.orphan", fields: {} },
    ]);

    expect(result.unresolvedParents).toEqual(["acme.orphan"]);
  });

  it("treats a null parent as no parent, the way every other walk does", () => {
    // The payload is JSON produced elsewhere, and `parent: null` is what a
    // permissive serializer emits for an absent optional. It resolves as a
    // root everywhere else in this package, so naming it here would send a
    // caller to refetch for ever over a break that does not exist — and
    // `unresolvedParents` is the entry the report tells callers to act on.
    const result = hydrate([
      {
        id: "acme.nulled",
        version: 1,
        parent: null,
        fields: { headline: { type: "string", required: true } },
      },
    ] as unknown as TypeSchema[]);

    expect(result.unresolvedParents).toEqual([]);
    expect(result.cycles).toEqual([]);
    // Resolution already treated it as a root; the report now agrees.
    expect(
      validateProperties("acme.nulled", {}, { spaceId: SPACE }).success,
    ).toBe(false);
    expect(
      validateProperties("acme.nulled", { headline: "set" }, { spaceId: SPACE })
        .success,
    ).toBe(true);
  });

  it("refuses a chain deeper than resolution will follow, by name", () => {
    // Listed deepest-first, which is what makes the bound reachable at all:
    // the walk only stacks a frame for an ancestor it has not placed yet, so
    // an ancestors-first payload never nests. Descendant-first is the shape
    // this helper exists to cope with, so it is also the shape that nests.
    //
    // At this depth an unbounded walk does not overflow — it accepts the
    // chain and hands back a registry whose every write then fails, because
    // `getResolvedFields` refuses the same chain at the same constant. So
    // what this pins is the refusal arriving at hydration, where a caller
    // can act on it, rather than at each write. The overflow the frame-per-
    // ancestor recursion can also produce needs a chain orders of magnitude
    // deeper than this, and the same bound is what stops it.
    const link = (n: number) => `acme.deep_${String(n)}`;
    const payload: TypeSchema[] = [];
    for (let n = MAX_RESOLUTION_DEPTH + 1; n >= 1; n -= 1) {
      payload.push({
        id: link(n),
        version: 1,
        parent: link(n - 1),
        fields: {},
      });
    }
    payload.push({ id: link(0), version: 1, fields: {} });

    const before = listTypes(SPACE).length;
    let caught: unknown;
    try {
      // Not `expect(...).toThrow()`: the code carried on the error is the
      // assertion, and a bare throw check would pass on the RangeError this
      // bound exists to replace.
      hydrateTypeRegistry(payload, { spaceId: SPACE });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(MarfaError);
    expect((caught as MarfaError).code).toBe(ErrorCode.TYPE_CHAIN_UNRESOLVABLE);
    // Ordering runs to completion before anything is registered, so a refusal
    // leaves the registry untouched rather than half-filled. Nothing to clean
    // up here, and that is the property rather than an omission.
    expect(listTypes(SPACE).length).toBe(before);
  });

  it("does not report a parent the platform registry already ships", () => {
    // The common case: a space subtypes a core type. The parent is absent
    // from the custom set by construction and resolves globally, and the
    // inherited requirement is enforced.
    const result = hydrate([
      { id: "acme.memo", version: 1, parent: "core.note", fields: {} },
    ]);

    expect(result.unresolvedParents).toEqual([]);
    expect(
      validateProperties("acme.memo", {}, { spaceId: SPACE }).success,
    ).toBe(false);
    expect(
      validateProperties("acme.memo", { body: "text" }, { spaceId: SPACE })
        .success,
    ).toBe(true);
  });

  it("drops a type the listing no longer carries", () => {
    // A refresh that only ever added left a deleted type valid locally for
    // ever: it stops appearing in the listing rather than arriving as a
    // tombstone, so nothing marked it gone. The client then accepted writes
    // against a type the server had forgotten, and a queued write refused on
    // arrival reads as permanent.
    hydrate([
      {
        id: "acme.retired",
        version: 1,
        fields: { headline: { type: "string", required: true } },
      },
    ]);
    expect(
      validateProperties(
        "acme.retired",
        { headline: "set" },
        {
          spaceId: SPACE,
        },
      ).success,
    ).toBe(true);

    // The same space, listed again after the type was deleted server-side.
    const result = hydrate([{ id: "acme.kept", version: 1, fields: {} }]);

    // The compiled schema goes with the registration. A stale cache entry
    // would keep answering `success` here with nothing left in the registry
    // to evict it, which is the half that makes the removal worth doing.
    const after = validateProperties(
      "acme.retired",
      { headline: "set" },
      { spaceId: SPACE },
    );
    expect(after.success).toBe(false);
    // Refused as an unknown type rather than on a field, which is what tells
    // a removed registration from one still present that happens to reject
    // this payload.
    expect(after.success ? [] : after.errors.map((e) => e.field)).toEqual([
      "_type",
    ]);
    expect(getTypeSchema("acme.retired", SPACE)).toBeUndefined();
    // Convergence is not a purge: what the listing still carries stays.
    expect(getTypeSchema("acme.kept", SPACE)).toBeDefined();
    expect(result.removed).toEqual(["acme.retired"]);
  });

  it("leaves another space's overlay alone when it converges", () => {
    // Removal is scoped to the bucket `spaceId` names, the same scope
    // registration has. A hydration that reached past it would evict a space
    // whose listing this payload says nothing about.
    const other = "01a02000-0000-7000-8000-0000000000f3";
    const elsewhere = hydrateTypeRegistry(
      [{ id: "acme.neighbor", version: 1, fields: {} }],
      { spaceId: other },
    );
    expect(elsewhere.registered).toEqual(["acme.neighbor"]);

    try {
      hydrate([{ id: "acme.mine", version: 1, fields: {} }]);
      expect(getTypeSchema("acme.neighbor", other)).toBeDefined();
    } finally {
      unregisterTypeSchema("acme.neighbor", other);
    }
  });

  it("gives an unshipped platform type the lifecycle its own family has", () => {
    // An instance's shipped vocabulary is seeded data, so a listing can carry
    // a `system.*` type this build never compiled in. `POST /types` refuses a
    // reserved root for every credential, platform included, so such an id is
    // necessarily platform-seeded rather than somebody's custom type — which
    // is what makes classifying it by namespace sound.
    const id = "system.unshipped_probe";
    expect(SYSTEM_TYPE_IDS.has(id)).toBe(false);

    const result = hydrate([{ id, version: 1, fields: {} }]);

    // Both rules, because they read the same classification and a fix
    // reaching only one leaves a delete putting the row into a state no
    // transition can leave. The shipped comparison is the parity claim: the
    // answer must not depend on whether this build happens to carry the type.
    expect(softDeleteState(id)).toBe("revoked");
    expect(softDeleteState(id)).toBe(softDeleteState("system.credential"));
    expect(validateTransition(id, "active", "revoked")).toBeNull();
    expect(validateTransition(id, "active", "trashed")).not.toBeNull();
    expect(validateTransition(id, "active", "archived")).not.toBeNull();
    expect(validateTransition(id, "active", "trashed")).toBe(
      validateTransition("system.credential", "active", "trashed"),
    );
    expect(result.unshippedPlatform).toEqual([id]);
  });

  it("keeps the bounded lifecycle to the system tier", () => {
    // The negative control for the test above, and the one the change needs
    // most. `hasBoundedLifecycle`'s namespace half is `isSystemType` — one
    // tier — while the tier set the platform owns has three, so widening it
    // to the set reads like tidying two spellings of the same idea into one.
    // It is not: the server gives `core.*` and `marfa.*` the canonical
    // three-state graph, so a client on the widened rule would refuse an
    // archive the server accepts and aim a delete at a state the type has no
    // transition to. Both ids sit outside `SYSTEM_TYPE_IDS` and outside this
    // build's shipped map, so the family set answers for neither and the
    // namespace test is the only thing deciding.
    for (const id of ["core.unshipped_probe", "marfa.unshipped_probe"]) {
      expect(SYSTEM_TYPE_IDS.has(id)).toBe(false);
      expect(TYPE_REGISTRY.has(id)).toBe(false);
      expect(PLATFORM_TIERS.has(classifyNamespace(id))).toBe(true);
      expect(hasBoundedLifecycle(id)).toBe(false);
      expect(softDeleteState(id)).toBe("trashed");
      expect(validateTransition(id, "active", "archived")).toBeNull();
      expect(validateTransition(id, "active", "revoked")).not.toBeNull();
    }
  });

  it("removes nothing when the payload is refused", () => {
    hydrate([{ id: "acme.standing", version: 1, fields: {} }]);

    const link = (n: number) => `acme.toodeep_${String(n)}`;
    const payload: TypeSchema[] = [];
    for (let n = MAX_RESOLUTION_DEPTH + 1; n >= 1; n -= 1) {
      payload.push({
        id: link(n),
        version: 1,
        parent: link(n - 1),
        fields: {},
      });
    }
    payload.push({ id: link(0), version: 1, fields: {} });

    expect(() => hydrateTypeRegistry(payload, { spaceId: SPACE })).toThrow(
      MarfaError,
    );

    // A refused payload names none of what the space already holds, so
    // convergence running ahead of the ordering walk would empty the space
    // and then throw. Registration is held behind the walk for the same
    // reason and has a test of its own; this is the other half.
    expect(getTypeSchema("acme.standing", SPACE)).toBeDefined();
  });

  it("names a child whose parent the listing has dropped", () => {
    hydrate([
      {
        id: "acme.stem",
        version: 1,
        fields: { headline: { type: "string", required: true } },
      },
      { id: "acme.frond", version: 1, parent: "acme.stem", fields: {} },
    ]);
    expect(
      validateProperties("acme.frond", {}, { spaceId: SPACE }).success,
    ).toBe(false);

    // The parent has left the listing; the child has not. This call is what
    // breaks the chain, so a report taken before the removals would say the
    // chain was whole and send nobody to refetch.
    const result = hydrate([
      { id: "acme.frond", version: 1, parent: "acme.stem", fields: {} },
    ]);

    expect(result.removed).toEqual(["acme.stem"]);
    expect(result.unresolvedParents).toEqual(["acme.frond"]);
    // And the shortfall the entry is warning about: the requirement the
    // removed ancestor declared is no longer enforced anywhere.
    expect(
      validateProperties("acme.frond", {}, { spaceId: SPACE }).success,
    ).toBe(true);
  });
});

describe("the package root", () => {
  // Both symbols exist for a consumer outside this package: the server
  // decides the bounded-lifecycle question at sites of its own, and asks the
  // tier set at the two registration doors. Neither can reach a symbol the
  // package entry point does not carry, and every other test in this file
  // imports straight from `./type-registry.js`, so the export could be
  // dropped and all of them would still pass. The compiler does not close
  // that gap either — it catches an export naming something that does not
  // exist, never a symbol nobody exported.
  //
  // The identity assertions are not enough on their own and are not left to
  // carry it: two absent exports are both `undefined`, so `toBe` holds
  // between them and the check passes in exactly the state it exists to
  // catch. The shape assertions are what make it fail.
  it("carries the pair the server imports", () => {
    expect(boundedLifecycleFromPackageRoot).toBeTypeOf("function");
    expect(tiersFromPackageRoot).toBeInstanceOf(Set);
    expect(boundedLifecycleFromPackageRoot).toBe(hasBoundedLifecycle);
    expect(tiersFromPackageRoot).toBe(PLATFORM_TIERS);
  });
});
