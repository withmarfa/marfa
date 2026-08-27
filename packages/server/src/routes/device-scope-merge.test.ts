import { describe, it, expect } from "vitest";
import {
  grantCoversScope,
  isValidScope,
  parseScope,
  subtreeWildcardRoot,
} from "@withmarfa/shared";
import { mergeDeviceApprovalScopes } from "./device-scope-merge.js";

/**
 * Pure-function tests for the device-approval merge.
 *
 * The two named cases in the first block are the reason this was rewritten,
 * and each is a merge that a previous implementation got wrong in a different
 * direction. They are written against `grantCoversScope` rather than against
 * a literal array because the literals are not the property: what a record
 * confers is, and two different arrays can confer the same thing. An array
 * assertion here would have passed for one of the broken implementations.
 */

/** The verb a record effectively confers on one concrete point. */
function verb(scopes: readonly string[], point: string): string {
  if (grantCoversScope(scopes, `${point}:write`)) return "write";
  if (grantCoversScope(scopes, `${point}:read`)) return "read";
  return "none";
}

/**
 * The (axis, key) an emitted scope occupies, mirroring `breadthKey` in the
 * module. Restated here rather than exported on purpose: the counters below
 * exist to measure what the prune did, and a helper handed to them by the
 * module under test would agree with it by construction.
 */
function emittedKey(scope: string): { axis: string; key: string } | null {
  const parsed = parseScope(scope);
  if (!parsed || parsed.operation === "none") return null;
  if (parsed.kind === "type") return { axis: "type", key: parsed.typePattern };
  if (parsed.kind === "edge")
    return parsed.edgeType ? { axis: "edge", key: parsed.edgeType } : null;
  if (parsed.kind === "metadata")
    return { axis: "metadata", key: parsed.subresource ?? "*" };
  return null;
}

/**
 * Mirrors `keyIsWellFormed`: no asterisk outside a subtree-root position.
 * The prune leaves anything else where it found it.
 */
function wellFormed(key: string): boolean {
  return key === "*" || !(subtreeWildcardRoot(key) ?? key).includes("*");
}

/**
 * How many entries the merge emits before the prune runs: one per distinct
 * (axis, key) either side names, plus one per membership literal. Counting
 * spelled scopes instead measured the merge's own collapse of two verbs onto
 * one key, which cleared its threshold tenfold with the prune deleted.
 */
function mergedEntryCount(
  standing: readonly string[],
  approved: readonly string[],
): number {
  const ids = new Set<string>();
  for (const scope of [...standing, ...approved]) {
    const key = emittedKey(scope);
    ids.add(key ? `${key.axis}:${key.key}` : `literal:${scope}`);
  }
  return ids.size;
}

describe("mergeDeviceApprovalScopes, the two cases it exists for", () => {
  // A plain set union narrows here. `core.note:read` appended beneath a
  // standing `core.*:write` outranks the wildcard and pins notes to read,
  // taking away a write the user never unticked.
  it("does not narrow: a literal cannot pin down the wildcard above it", () => {
    const merged = mergeDeviceApprovalScopes(
      ["core.*:write"],
      ["core.note:read"],
    );
    expect(verb(merged, "core.note")).toBe("write");
    expect(verb(merged, "core.task")).toBe("write");
  });

  // The traced defect. The merge names `core.note` because the approval
  // spelled it, and resolves it to `write` because the standing wildcard
  // confers that, so the record grew an explicit write grant the client
  // never asked for, saying nothing the entry above it did not already say.
  it("collapses a key the standing grant already confers to one entry", () => {
    expect(
      mergeDeviceApprovalScopes(["core.*:write"], ["core.note:read"]),
    ).toEqual(["core.*:write"]);
  });

  // Sequential elimination, in the one shape that separates it from a pass
  // that resolves each candidate against the whole list. Both entries resolve
  // their own key to `read` while both are present, so a prune that does not
  // take the candidate out before resolving drops both and leaves nothing
  // conferring read on notes. Taking `core.note:read` out first is what
  // exposes that `core.*` resolves against the remainder to `none`.
  it("keeps the wildcard when its own redundant child is dropped", () => {
    const merged = mergeDeviceApprovalScopes(
      ["core.*:read"],
      ["core.note:read"],
    );
    expect(merged).toEqual(["core.*:read"]);
    expect(verb(merged, "core.note")).toBe("read");
    expect(verb(merged, "core.other")).toBe("read");
  });

  // The pin, which is the entry the prune must never take. `core.note:read`
  // beneath `core.*:write` is not redundant. It is the only thing holding
  // notes down to read, and dropping it would escalate exactly the way the
  // coverage-append merge did.
  it("keeps a pin: both entries survive where the child holds a type down", () => {
    const merged = mergeDeviceApprovalScopes(
      ["core.*:read"],
      ["core.*:write", "core.note:read"],
    );
    expect(merged).toEqual(["core.*:write", "core.note:read"]);
    expect(verb(merged, "core.note")).toBe("read");
    expect(verb(merged, "core.task")).toBe("write");
  });

  // Appending only what the set does not already cover escalates here. The
  // `core.note:read` pin is skipped because the standing wildcard covers it,
  // so the record becomes `core.*:read core.*:write` and confers write on
  // notes, which neither input conferred.
  it("does not escalate: a skipped pin must not confer what neither side did", () => {
    const standing = ["core.*:read"];
    const approved = ["core.*:write", "core.note:read"];
    expect(verb(standing, "core.note")).toBe("read");
    expect(verb(approved, "core.note")).toBe("read");

    const merged = mergeDeviceApprovalScopes(standing, approved);
    expect(verb(merged, "core.note")).toBe("read");
    // The rest of the namespace genuinely was widened, so a merge that
    // simply refused to widen anything would also pass the line above.
    expect(verb(merged, "core.task")).toBe("write");
  });
});

describe("mergeDeviceApprovalScopes, record stability", () => {
  // The measured symptom of the literal-level merge: coverage is not
  // reflexive on a pinned set, so `core.*:write` failed its own coverage test
  // and was re-appended on every login. Five repeats took the array from two
  // entries to seven.
  //
  // The client keeps sending its original request while the record has been
  // canonicalized upward, so the two spellings of `core.note` differ from the
  // second login onward. That divergence is the whole test: repeating a
  // request the record already spells identically would pass under a merge
  // that de-duplicates on the literal instead of on the key it lands on.
  it("does not grow the record when the same request repeats against a canonicalized record", () => {
    const approved = ["core.note:read", "openid"];
    let record = mergeDeviceApprovalScopes(["core.*:write"], approved);
    expect(record).toEqual(["core.*:write", "openid"]);
    const first = [...record];
    for (let i = 0; i < 5; i++) {
      record = mergeDeviceApprovalScopes(record, approved);
      expect(record).toEqual(first);
    }
  });

  // The measured shape behind the ticket: a standing `*:write` and forty-five
  // logins each naming one further concrete type at `:read` took the record to
  // forty-six entries, every added one already conferred by the wildcard and
  // every one written at `:write` though the client only ever asked `:read`.
  // Nothing here is a repeat, so record stability cannot come from
  // de-duplicating a spelling: each login names a key the record has never
  // held, and the entry is dropped because the record already confers it.
  it("does not grow the record when a CLI signs in again and again under a wildcard", () => {
    const types = Array.from(
      { length: 45 },
      (_, i) => `user.thing-${String(i)}`,
    );
    // Precondition: each of these has to reach the item-type axis. A scope the
    // grammar refuses would be carried through the literal arm untouched, and
    // the record would grow for a reason this test is not about.
    for (const type of types) {
      expect(parseScope(`${type}:read`)?.kind).toBe("type");
    }

    let record = ["*:write"];
    for (const type of types) {
      record = mergeDeviceApprovalScopes(record, [`${type}:read`]);
      expect(verb(record, type)).toBe("write");
    }

    expect(record).toEqual(["*:write"]);
    expect(record).toHaveLength(1);
  });

  it("is idempotent: re-merging an approval already absorbed changes nothing", () => {
    const standing = ["core.*:read", "edge.parent-of:write", "metadata:read"];
    const approved = ["core.*:write", "core.note:read", "offline_access"];
    const once = mergeDeviceApprovalScopes(standing, approved);
    expect(mergeDeviceApprovalScopes(once, approved)).toEqual(once);
  });

  // The order is the client's: `auth-pages.ts` splits the request string
  // verbatim, so the same approval can arrive in any order.
  it("gives the same effective grant however the approval is ordered", () => {
    const standing = ["core.*:read"];
    const approved = ["core.*:write", "core.note:read", "core.task:write"];
    const forward = mergeDeviceApprovalScopes(standing, approved);
    const backward = mergeDeviceApprovalScopes(
      standing,
      [...approved].reverse(),
    );
    for (const point of ["core.note", "core.task", "core.other"]) {
      expect(verb(backward, point)).toBe(verb(forward, point));
    }
    // Not vacuous: the pin and the wildcard resolve to different verbs, so
    // an order-sensitive merge would disagree on at least one of these.
    expect(verb(forward, "core.note")).toBe("read");
    expect(verb(forward, "core.task")).toBe("write");
  });

  it("returns the standing grant unchanged when the approval adds nothing", () => {
    const standing = ["core.*:write", "core.note:read", "openid"];
    expect(mergeDeviceApprovalScopes(standing, [])).toEqual(standing);
  });
});

/**
 * The axes `scopesToTypePermissions` does not represent. Item types are the
 * axis the defect was found on; these are the four families that projection
 * drops, and a scope silently dropped by the merge is a narrowing.
 */
describe("mergeDeviceApprovalScopes, the axes beyond item types", () => {
  // Edge types resolve by the same exact-then-longest-wildcard precedence, so
  // they pin identically. Handling only item types would leave the same
  // defect standing one axis over.
  it("does not narrow the edge axis", () => {
    const merged = mergeDeviceApprovalScopes(
      ["edge.*:write"],
      ["edge.parent-of:read"],
    );
    expect(grantCoversScope(merged, "edge.parent-of:write")).toBe(true);
    expect(grantCoversScope(merged, "edge.other:write")).toBe(true);
  });

  it("does not escalate the edge axis", () => {
    const standing = ["edge.*:read"];
    const approved = ["edge.*:write", "edge.parent-of:read"];
    expect(grantCoversScope(approved, "edge.parent-of:write")).toBe(false);
    const merged = mergeDeviceApprovalScopes(standing, approved);
    expect(grantCoversScope(merged, "edge.parent-of:write")).toBe(false);
    expect(grantCoversScope(merged, "edge.other:write")).toBe(true);
  });

  // REGRESSION: the prune deleted a live grant here, and this is the shape
  // the sufficiency argument does not cover. The edge axis has no pattern
  // validator, so `edge.*.*:write` parses where `core.*.*:write` is refused,
  // and its root is `*`, a string that matches the global KEY while matching
  // no concrete edge type. The malformed entry therefore answered for
  // `edge.*` at the key level while conferring nothing at any id, and the
  // wildcard carrying write on every edge type on the instance was dropped as
  // redundant. Reachable through operator-configured permission bundles,
  // whose only filter is `isValidScope`.
  //
  // Refusing only malformed CANDIDATES does not fix it: the entry deleted
  // here is `edge.*`, whose own key is well-formed. What fixes it is keeping
  // a malformed key out of the map a candidate is measured against.
  it("does not drop a wildcard on the say-so of a malformed sibling key", () => {
    // Preconditions. The grammar hole is real, it is this axis alone, and the
    // malformed literal genuinely confers nothing concrete.
    expect(isValidScope("edge.*.*:write")).toBe(true);
    expect(isValidScope("core.*.*:write")).toBe(false);
    expect(grantCoversScope(["edge.*.*:write"], "edge.parent-of:write")).toBe(
      false,
    );
    expect(grantCoversScope(["edge.*:write"], "edge.parent-of:write")).toBe(
      true,
    );

    const merged = mergeDeviceApprovalScopes(
      ["edge.*:write"],
      ["edge.*.*:write"],
    );
    expect(grantCoversScope(merged, "edge.parent-of:write")).toBe(true);
    expect(grantCoversScope(merged, "edge.other:write")).toBe(true);
    expect(merged).toContain("edge.*:write");
    // Carried rather than deleted: a key the prune cannot reason about is
    // left where it was, on the same reasoning as an unparseable literal.
    expect(merged).toContain("edge.*.*:write");

    // Order does not rescue it either.
    expect(
      mergeDeviceApprovalScopes(["edge.*.*:write"], ["edge.*:write"]),
    ).toContain("edge.*:write");
  });

  // The same collision at a nested root, which is the general form. A guard
  // written against the one literal `*.*` passes every assertion above and
  // leaves this live: `subtreeWildcardRoot("user.*.*")` is `"user.*"`, which
  // matches the key `user.*` exactly as `"*"` matches `*`. Those two shapes
  // are the whole of what a malformed key can answer for.
  //
  // The victim is not contrived. `resolveEdgePermission` says in its own
  // docblock that `edge.user.*` is the only expression reaching a space's
  // runtime-registered relation edges short of the global wildcard, so this
  // is a grant a space cannot express any other way.
  it("does not drop a namespace wildcard on the say-so of a malformed child", () => {
    expect(isValidScope("edge.user.*.*:write")).toBe(true);
    expect(subtreeWildcardRoot("user.*.*")).toBe("user.*");
    expect(
      grantCoversScope(["edge.user.*.*:write"], "edge.user.blocks:write"),
    ).toBe(false);
    expect(
      grantCoversScope(["edge.user.*:write"], "edge.user.blocks:write"),
    ).toBe(true);

    const merged = mergeDeviceApprovalScopes(
      ["edge.user.*:write"],
      ["edge.user.*.*:write"],
    );
    expect(grantCoversScope(merged, "edge.user.blocks:write")).toBe(true);
    expect(grantCoversScope(merged, "edge.user:write")).toBe(true);
    expect(merged).toContain("edge.user.*:write");
    expect(merged).toContain("edge.user.*.*:write");

    expect(
      mergeDeviceApprovalScopes(["edge.user.*.*:write"], ["edge.user.*:write"]),
    ).toContain("edge.user.*:write");
  });

  it("carries the metadata axis through and raises its verb", () => {
    const merged = mergeDeviceApprovalScopes(
      ["metadata.types:read"],
      ["metadata.types:write"],
    );
    expect(grantCoversScope(merged, "metadata.types:write")).toBe(true);
    const kept = mergeDeviceApprovalScopes(
      ["metadata:write"],
      ["core.note:read"],
    );
    expect(grantCoversScope(kept, "metadata.types:write")).toBe(true);
  });

  // Metadata sub-resources fall through to the namespace wildcard rather than
  // being pinned by it, so a literal union of this axis confers exactly what
  // the effective merge does and no coverage probe can tell the two apart.
  // What separates them is the record, and `/auth/security` is read as a
  // statement of what the grant confers. `metadata.types` under a
  // `metadata:write` that already grants writing types says nothing, at
  // either verb, so it goes. The emitted literal is the assertion here,
  // deliberately, and it is the only place in this file where the array
  // rather than its meaning is the point.
  it("writes the metadata record as one entry per key it confers", () => {
    expect(
      mergeDeviceApprovalScopes(["metadata:write"], ["metadata.types:read"]),
    ).toEqual(["metadata:write"]);
    // The verb still moves where the key is load-bearing: nothing above
    // `metadata.types` here, so it is emitted rather than dropped.
    expect(
      mergeDeviceApprovalScopes(["metadata.types:read"], ["core.note:read"]),
    ).toEqual(["metadata.types:read", "core.note:read"]);
  });

  // Membership is the whole algebra for the two verb-less families. A
  // capability is granted by naming it and by nothing else, so the merge must
  // carry it and must not invent one.
  it("unions capability and OIDC literals and invents neither", () => {
    const merged = mergeDeviceApprovalScopes(
      ["capability.webhooks", "offline_access"],
      ["capability.keys", "openid"],
    );
    expect(merged).toContain("capability.webhooks");
    expect(merged).toContain("capability.keys");
    expect(merged).toContain("offline_access");
    expect(merged).toContain("openid");
    expect(grantCoversScope(merged, "capability.app_grants")).toBe(false);
  });

  // A wildcard reaching an administrative surface is the fail-open the
  // capability kind exists to remove, and a merge is a place it could be
  // reintroduced: `capability.webhooks` parses with a `typePattern`, so
  // classifying it onto the item-type axis compiles, and the global wildcard
  // on the other side then resolves it. The capability is destroyed either
  // way, since what gets emitted is `capability.webhooks:write`, which is not
  // a literal the grammar admits. The pairing is what this asserts: the
  // capability survives the merge, and nothing beside it reaches another one.
  it("does not project a capability onto the item-type axis", () => {
    const merged = mergeDeviceApprovalScopes(
      ["capability.webhooks"],
      ["*:write"],
    );
    expect(merged).toContain("capability.webhooks");
    expect(merged).not.toContain("capability.webhooks:write");
    expect(grantCoversScope(merged, "capability.keys")).toBe(false);
  });

  // Both sides carrying a literal the grammar has stopped understanding is
  // not a narrowing, and dropping it would be one.
  it("carries a literal this build cannot parse", () => {
    expect(
      mergeDeviceApprovalScopes(
        ["a-scope-from-a-later-build"],
        ["core.note:read"],
      ),
    ).toContain("a-scope-from-a-later-build");
    expect(
      mergeDeviceApprovalScopes(
        ["core.note:read"],
        ["a-scope-from-a-later-build"],
      ),
    ).toContain("a-scope-from-a-later-build");
  });
});

/**
 * The property both broken implementations violated, in both directions.
 *
 * Probes are concrete points (a real type id, a real edge type, a real
 * metadata sub-resource, a membership literal) and never patterns. Coverage
 * of a pattern is a statement about every point beneath it, and a pointwise
 * maximum can satisfy such a statement when neither input does: standing
 * `core.*:write core.note:read` and approved `core.note:write` together
 * confer `core.*:write`, which is the merge working rather than an
 * escalation. Probing with patterns reports that as a violation, so the
 * property has to be stated where it is actually meant.
 *
 * Seeded, and sized to run in well under a second. The exhaustive sweep that
 * established this ran eight million probe checks offline; what belongs in a
 * suite is a bounded sample that still fails loudly if the algebra regresses.
 */
describe("mergeDeviceApprovalScopes, monotonicity over random grants", () => {
  const VOCAB = [
    "*:read",
    "*:write",
    "core.*:read",
    "core.*:write",
    "core.media.*:read",
    "core.media.*:write",
    "core.note:read",
    "core.note:write",
    "core.media.book:read",
    "core.media.book:write",
    "core.task:write",
    "edge.*:read",
    "edge.*:write",
    "edge.user.*:read",
    "edge.user.*:write",
    "edge.parent-of:read",
    "edge.parent-of:write",
    "metadata:read",
    "metadata:write",
    "metadata.types:read",
    "metadata.types:write",
    "openid",
    "offline_access",
    "capability.webhooks",
    "capability.keys",
    "a-scope-from-a-later-build",
  ];

  const PROBES: string[] = [];
  for (const t of [
    "core.note",
    "core.task",
    "core.media",
    "core.media.book",
    "zz.thing",
    "user.custom",
  ]) {
    PROBES.push(`${t}:read`, `${t}:write`);
  }
  for (const e of ["parent-of", "user", "user.blocks", "other"]) {
    PROBES.push(`edge.${e}:read`, `edge.${e}:write`);
  }
  for (const m of ["types", "other"]) {
    PROBES.push(`metadata.${m}:read`, `metadata.${m}:write`);
  }
  PROBES.push(
    "openid",
    "offline_access",
    "capability.webhooks",
    "capability.keys",
    "capability.app_grants",
    "a-scope-from-a-later-build",
  );

  /** Deterministic LCG, so a failure is reproducible rather than flaky. */
  function makeRng(seed: number): () => number {
    let state = seed;
    return () => {
      state = (state * 1103515245 + 12345) & 0x7fffffff;
      return state / 0x7fffffff;
    };
  }

  it("confers everything either side conferred, and nothing neither did", () => {
    const rng = makeRng(20260827);
    const randomGrant = (): string[] => {
      const n = Math.floor(rng() * 5);
      const out: string[] = [];
      for (let i = 0; i < n; i++) {
        out.push(VOCAB[Math.floor(rng() * VOCAB.length)]!);
      }
      return out;
    };

    // Guards against a sample that never exercises the interesting shapes:
    // if nothing in the run ever widened or ever pinned, a merge that
    // returned `standing` unchanged would pass this test.
    let sawWidening = 0;
    let sawPin = 0;

    for (let round = 0; round < 1500; round++) {
      const standing = randomGrant();
      const approved = randomGrant();
      const merged = mergeDeviceApprovalScopes(standing, approved);

      for (const probe of PROBES) {
        const inStanding = grantCoversScope(standing, probe);
        const inApproved = grantCoversScope(approved, probe);
        const inMerged = grantCoversScope(merged, probe);

        if (inStanding || inApproved) {
          // Narrowing. The whole reason the device merge exists.
          expect({ standing, approved, merged, probe, inMerged }).toEqual({
            standing,
            approved,
            merged,
            probe,
            inMerged: true,
          });
          if (!inStanding) sawWidening++;
        } else {
          // Escalation. The direction the coverage-append merge got wrong.
          expect({ standing, approved, merged, probe, inMerged }).toEqual({
            standing,
            approved,
            merged,
            probe,
            inMerged: false,
          });
        }
      }

      if (
        grantCoversScope(standing, "core.task:write") &&
        !grantCoversScope(standing, "core.note:write")
      ) {
        sawPin++;
      }
    }

    expect(sawWidening).toBeGreaterThan(100);
    expect(sawPin).toBeGreaterThan(10);
  });
});

/**
 * The prune, over a fixed enumeration rather than a random corpus.
 *
 * Fixed because the shapes that matter here are structural and few: a
 * wildcard over a pin, a wildcard over a redundant child, two wildcards at
 * different depths. A random corpus is green whenever it failed to generate
 * one of them. Every ordered pair of grants drawn from the
 * vocabulary below, at sizes zero, one and two, is enumerated, so admitting
 * the fixture is a question about the vocabulary and not about a seed.
 *
 * **Probes are concrete ids and never patterns.** Coverage of a pattern is a
 * statement about every id beneath it, which is the fail-open question the
 * resolver exists to refuse, and it is satisfied by a record that confers
 * nothing at all inside the subtree. A pattern probe passes against a prune
 * that has deleted the entry holding the subtree up. This is the single most
 * likely way this test gets written wrong.
 *
 * **Known gap, and it is a gap in the testing rather than in the argument.**
 * Both sides are capped at two scopes, so a record built by a chain of merges
 * is never fed back in, and repeated application is what the function is for.
 * The named tests above cover the repeats that have actually bitten, the
 * idempotence case and the forty-five-login case, but not an arbitrary chain
 * over this vocabulary. Every removal is resolution-preserving against the
 * set current when it is taken, so safety composes step by step and a chain
 * cannot reach a state a single step could not; widening the enumeration
 * would be worth doing if that argument ever stops holding.
 */
describe("mergeDeviceApprovalScopes, the prune over a fixed enumeration", () => {
  const VOCAB = [
    "*:write",
    "core.*:read",
    "core.*:write",
    "core.media.*:read",
    "core.note:read",
    "core.note:write",
    "core.media.book:write",
    "edge.*:write",
    "edge.user.*:read",
    "edge.parent-of:read",
    "metadata:write",
    "metadata.types:read",
    "capability.webhooks",
    "openid",
  ];

  /** The scope in the vocabulary this build is meant not to understand. */
  const UNPARSEABLE = "a-scope-from-a-later-build";

  /**
   * Concrete points, on all three breadth axes. Each subtree in the
   * vocabulary needs at least one id inside it that no narrower vocabulary
   * key reaches: `core.other` under `core.*`, `core.media.photo` under
   * `core.media.*`, `other.thing` under the global wildcard, `user.blocks`
   * under `edge.user.*`, `edge.other` under `edge.*`, `metadata.other` under
   * the metadata wildcard. Without one, dropping the entry that governs that
   * subtree changes nothing any probe can see, and clause (b) passes on a
   * record that is not minimal.
   */
  const TYPE_POINTS = [
    "core.note",
    "core.task",
    "core.other",
    "core.media",
    "core.media.book",
    "core.media.photo",
    "user.thing",
    "other.thing",
  ];
  const EDGE_POINTS = ["parent-of", "user", "user.blocks", "other"];
  const METADATA_POINTS = ["types", "other"];

  const POINTS = [
    ...TYPE_POINTS,
    ...EDGE_POINTS.map((e) => `edge.${e}`),
    ...METADATA_POINTS.map((m) => `metadata.${m}`),
  ];

  /** The verb-less families, where membership is the whole question. */
  const MEMBERSHIP = [
    "openid",
    "offline_access",
    "capability.webhooks",
    "capability.keys",
    UNPARSEABLE,
  ];

  const RANK: Record<string, number> = { none: 0, read: 1, write: 2 };
  const higherVerb = (a: string, b: string): string =>
    RANK[a]! >= RANK[b]! ? a : b;

  /** Every ordered pair of grants of size 0, 1 and 2. */
  const GRANTS: string[][] = [[]];
  const POOL = [...VOCAB, UNPARSEABLE];
  for (let i = 0; i < POOL.length; i++) {
    GRANTS.push([POOL[i]!]);
    for (let j = i + 1; j < POOL.length; j++) {
      GRANTS.push([POOL[i]!, POOL[j]!]);
    }
  }

  /** Resolutions of one grant over every probe, computed once per grant. */
  interface Reading {
    verbs: string[];
    holds: boolean[];
  }
  const read = (scopes: readonly string[]): Reading => ({
    verbs: POINTS.map((p) => verb(scopes, p)),
    holds: MEMBERSHIP.map((m) => grantCoversScope(scopes, m)),
  });
  const READINGS = new Map<string[], Reading>(
    GRANTS.map((g) => [g, read(g)] as const),
  );

  // Assert the fixture is the shape the two clauses assume, rather than
  // trusting it. A vocabulary entry the grammar refuses would be carried
  // through the literal arm and never reach the prune at all, and a probe
  // carrying a wildcard would silently turn clause (a) into the pattern
  // question this test exists to avoid asking.
  it("is built on scopes and probes of the shape the clauses assume", () => {
    for (const scope of VOCAB) {
      expect({ scope, parsed: parseScope(scope) !== null }).toEqual({
        scope,
        parsed: true,
      });
    }
    expect(parseScope(UNPARSEABLE)).toBeNull();

    // The literal family has to be genuinely represented, or the mutation
    // that prunes it has nothing to break.
    expect(parseScope("capability.webhooks")?.kind).toBe("capability");
    expect(parseScope("openid")?.kind).toBe("oidc");

    // Concrete, on every axis. A probe with a `*` in it is a pattern.
    for (const point of POINTS) {
      expect({ point, wildcard: point.includes("*") }).toEqual({
        point,
        wildcard: false,
      });
      expect({ point, parses: parseScope(`${point}:read`) !== null }).toEqual({
        point,
        parses: true,
      });
    }

    expect(GRANTS.length).toBeGreaterThan(100);
  });

  // (a) The merge's contract is unmoved. What the record confers at every
  // concrete id is the greater of what the two sides confer there, before the
  // prune and after it.
  it("confers exactly what the merge conferred, at every concrete id", () => {
    let checked = 0;
    let sawWidening = 0;
    let sawPin = 0;

    for (const standing of GRANTS) {
      const s = READINGS.get(standing)!;
      for (const approved of GRANTS) {
        const a = READINGS.get(approved)!;
        const pruned = mergeDeviceApprovalScopes(standing, approved);

        POINTS.forEach((point, i) => {
          const want = higherVerb(s.verbs[i]!, a.verbs[i]!);
          const got = verb(pruned, point);
          checked++;
          if (got !== want) {
            // Built only on failure: the loop runs a few hundred thousand
            // times and the context is what makes a failure readable.
            expect({ standing, approved, pruned, point, got }).toEqual({
              standing,
              approved,
              pruned,
              point,
              got: want,
            });
          }
          if (want !== s.verbs[i]!) sawWidening++;
        });

        MEMBERSHIP.forEach((literal, i) => {
          const want = s.holds[i]! || a.holds[i]!;
          const got = grantCoversScope(pruned, literal);
          checked++;
          if (got !== want) {
            expect({ standing, approved, pruned, literal, got }).toEqual({
              standing,
              approved,
              pruned,
              literal,
              got: want,
            });
          }
        });

        // A concrete key surviving beneath a broader wildcard at a lower
        // verb is the pin the prune must never take.
        if (
          pruned.includes("core.note:read") &&
          pruned.some((e) => e === "core.*:write" || e === "*:write")
        ) {
          sawPin++;
        }
      }
    }

    // Not vacuous: the enumeration has to reach the shapes it claims to.
    expect(checked).toBeGreaterThan(100_000);
    expect(sawWidening).toBeGreaterThan(1000);
    expect(sawPin).toBeGreaterThan(10);
  });

  // (b) Nothing redundant survives. Removing any remaining entry has to
  // change what the record confers at some concrete id, or at some literal.
  //
  // Stated over well-formed keys, which is the set the prune acts on. A key
  // outside the prefix tree the sufficiency argument assumes is inert at
  // every concrete id, so no probe can see it go, and the prune deliberately
  // never takes it. Asserting minimality over one would demand exactly the
  // deletion that caused the edge-axis narrowing above.
  it("leaves no entry the rest of the record already confers", () => {
    let entriesChecked = 0;
    let dropped = 0;

    for (const standing of GRANTS) {
      for (const approved of GRANTS) {
        const pruned = mergeDeviceApprovalScopes(standing, approved);
        const before = read(pruned);

        for (let i = 0; i < pruned.length; i++) {
          const key = emittedKey(pruned[i]!);
          if (key && !wellFormed(key.key)) continue;

          const reduced = pruned.filter((_, j) => j !== i);
          entriesChecked++;
          const changed =
            POINTS.some((p, k) => verb(reduced, p) !== before.verbs[k]!) ||
            MEMBERSHIP.some(
              (m, k) => grantCoversScope(reduced, m) !== before.holds[k]!,
            );
          if (!changed) {
            expect({
              standing,
              approved,
              pruned,
              redundant: pruned[i],
            }).toEqual({
              standing,
              approved,
              pruned,
              redundant: null,
            });
          }
        }

        dropped += mergedEntryCount(standing, approved) - pruned.length;
      }
    }

    // Not vacuous, and specifically not vacuous against a prune that does
    // nothing: `dropped` counts entries the prune removed, so a no-op scores
    // zero. The previous counter compared spelled scopes against the pruned
    // length, which measured the merge's key collapse and stayed well over
    // its threshold with the prune gone.
    expect(entriesChecked).toBeGreaterThan(10_000);
    expect(dropped).toBeGreaterThan(100);
  });
});

/**
 * The malformed-key shape, which the vocabulary above deliberately excludes.
 *
 * `edge.*.*:write` is admitted by `isValidScope` and confers nothing on any
 * concrete edge type, so it cannot appear in the enumeration that asserts
 * equality with the merge's contract: the MERGE resolves its key `*.*`
 * against the global edge key and raises `edge.*:read` to `edge.*:write`,
 * conferring a write neither side conferred. That escalation predates the
 * prune, is not what this change touches, and is tracked as its own defect
 * against the missing edge pattern validator.
 *
 * What is asserted here is the half this change is answerable for: the prune
 * never takes access away, and it still leaves nothing redundant among the
 * keys it is entitled to reason about.
 */
describe("mergeDeviceApprovalScopes, the prune against a malformed key", () => {
  /**
   * More than one, and that is the point. A single literal pins the guard at
   * the global root alone: replacing the whole of `keyIsWellFormed` with
   * `key !== "*.*"` passed a corpus built on `edge.*.*:write` by itself while
   * leaving `edge.user.*:write` merged with `edge.user.*.*:write` deleting
   * the wildcard. The collision is the same at every level of the key tree,
   * so the corpus has to carry more than one level of it.
   */
  const MALFORMED = ["edge.*.*:write", "edge.user.*.*:write"];

  const VOCAB = [
    "*:write",
    "core.*:read",
    "core.note:read",
    "edge.*:read",
    "edge.*:write",
    "edge.user.*:read",
    "edge.user.*:write",
    "edge.parent-of:read",
    "edge.parent-of:write",
    "metadata:write",
    "capability.webhooks",
  ];

  const POINTS = [
    "core.note",
    "core.other",
    "other.thing",
    "edge.parent-of",
    "edge.user",
    "edge.user.blocks",
    "edge.other",
    "metadata.types",
  ];

  /**
   * The one verb-less family this vocabulary carries. Without it the
   * minimality clause below reads a capability literal as redundant, because
   * no concrete point can see it go.
   */
  const MEMBERSHIP = ["capability.webhooks"];

  /** Grants of size one and two, each holding at least one malformed key. */
  const CARRIERS: string[][] = [];
  for (const m of MALFORMED) {
    CARRIERS.push([m]);
    for (const other of VOCAB) CARRIERS.push([m, other]);
  }
  CARRIERS.push([...MALFORMED]);

  /** Ordinary grants of size zero, one and two, drawn from the vocabulary. */
  const PLAIN: string[][] = [[]];
  for (let i = 0; i < VOCAB.length; i++) {
    PLAIN.push([VOCAB[i]!]);
    for (let j = i + 1; j < VOCAB.length; j++) {
      PLAIN.push([VOCAB[i]!, VOCAB[j]!]);
    }
  }

  /** Both orders: the prune walks candidates standing-then-approved. */
  const PAIRS: [string[], string[]][] = [];
  for (const c of CARRIERS) {
    for (const q of PLAIN) PAIRS.push([c, q], [q, c]);
  }

  it("is built on scopes the grammar admits that confer nothing", () => {
    expect(wellFormed("*")).toBe(true);
    expect(wellFormed("user.*")).toBe(true);
    expect(wellFormed("parent-of")).toBe(true);

    for (const scope of MALFORMED) {
      expect({ scope, valid: isValidScope(scope) }).toEqual({
        scope,
        valid: true,
      });
      const key = emittedKey(scope);
      expect({ scope, malformed: key ? !wellFormed(key.key) : null }).toEqual({
        scope,
        malformed: true,
      });
      // Inert: it reaches no concrete point, at either verb.
      for (const point of POINTS) {
        expect({
          scope,
          point,
          covered: grantCoversScope([scope], `${point}:write`),
        }).toEqual({ scope, point, covered: false });
      }
    }

    // The victim of the nested case has to be in the vocabulary, or the
    // enumeration cannot construct the pair that catches it.
    expect(VOCAB).toContain("edge.user.*:write");
  });

  it("never takes away what either side conferred", () => {
    let checked = 0;
    let carried = 0;

    for (const [standing, approved] of PAIRS) {
      const pruned = mergeDeviceApprovalScopes(standing, approved);

      for (const point of POINTS) {
        for (const op of ["read", "write"]) {
          const probe = `${point}:${op}`;
          checked++;
          const held =
            grantCoversScope(standing, probe) ||
            grantCoversScope(approved, probe);
          if (held && !grantCoversScope(pruned, probe)) {
            expect({
              standing,
              approved,
              pruned,
              probe,
              narrowed: true,
            }).toEqual({ standing, approved, pruned, probe, narrowed: false });
          }
        }
      }

      // Every malformed key named is carried, never deleted.
      for (const m of MALFORMED) {
        if (!standing.includes(m) && !approved.includes(m)) continue;
        carried++;
        expect({
          standing,
          approved,
          pruned,
          kept: pruned.includes(m),
        }).toEqual({ standing, approved, pruned, kept: true });
      }
    }

    expect(checked).toBeGreaterThan(10_000);
    expect(carried).toBeGreaterThan(100);
  });

  it("still leaves nothing redundant among the keys it may reason about", () => {
    let entriesChecked = 0;
    let skipped = 0;
    let dropped = 0;

    for (const [standing, approved] of PAIRS) {
      const pruned = mergeDeviceApprovalScopes(standing, approved);
      const before = POINTS.map((p) => verb(pruned, p));
      const beforeHolds = MEMBERSHIP.map((m) => grantCoversScope(pruned, m));

      for (let i = 0; i < pruned.length; i++) {
        const key = emittedKey(pruned[i]!);
        if (key && !wellFormed(key.key)) {
          skipped++;
          continue;
        }
        entriesChecked++;

        const reduced = pruned.filter((_, j) => j !== i);
        const changed =
          POINTS.some((p, k) => verb(reduced, p) !== before[k]) ||
          MEMBERSHIP.some(
            (m, k) => grantCoversScope(reduced, m) !== beforeHolds[k],
          );
        if (!changed) {
          expect({
            standing,
            approved,
            pruned,
            redundant: pruned[i],
          }).toEqual({ standing, approved, pruned, redundant: null });
        }
      }

      dropped += mergedEntryCount(standing, approved) - pruned.length;
    }

    // Not vacuous, on all three arms: entries the clause actually probed,
    // malformed entries it deliberately did not, and entries the prune
    // removed. `dropped` is zero against a prune that does nothing.
    expect(entriesChecked).toBeGreaterThan(1000);
    expect(skipped).toBeGreaterThan(100);
    expect(dropped).toBeGreaterThan(100);
  });
});
