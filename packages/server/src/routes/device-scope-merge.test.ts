import { describe, it, expect } from "vitest";
import {
  grantCoversScope,
  isValidScope,
  parseScope,
  subtreeWildcardRoot,
} from "@withmarfa/shared";
import {
  mergeDeviceApprovalScopes,
  intersectDeviceScopes,
} from "./device-scope-merge.js";

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
 * Mirrors `keyIsResolvable`: the key's subtree root, where it has one, is a
 * literal identifier rather than a second pattern. The prune leaves anything
 * else where it found it, and the intersection resolves through nothing else.
 */
function resolvable(key: string): boolean {
  const root = subtreeWildcardRoot(key);
  return root === null || (root !== "*" && subtreeWildcardRoot(root) === null);
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

  // REGRESSION: the prune deleted a live grant here. `edge.*.*:write` used to
  // parse — the edge axis had no pattern validator where the type axis routes
  // a wildcard's root through `TYPE_ID_PREFIX` — and its root is `*`, a string
  // that matches the global KEY while matching no concrete edge type. The
  // malformed entry therefore answered for `edge.*` at the key level while
  // conferring nothing at any id, and the wildcard carrying write on every
  // edge type on the instance was dropped as redundant. It was reachable
  // through any operator-configured permission bundle, whose only filter is
  // `isValidScope`.
  //
  // **The grammar refuses it at the door now, and this case survives the
  // narrowing rather than being retired by it.** A stored grant made before
  // the narrowing still carries the literal, and the door does not reach
  // backwards. What changed is which family it belongs to: it is no longer a
  // key the resolvers reason about and refuse one gate later, it is a literal
  // they cannot parse at all — so `membershipScopes` carries it and it never
  // enters the map a candidate is measured against. That is strictly stronger
  // than what kept this green before, because it cannot answer for a key even
  // in principle.
  it("does not drop a wildcard on the say-so of a malformed sibling key", () => {
    // Preconditions. Both axes refuse the shape now, which is the fix; the
    // stored literal still confers nothing concrete, which is why the
    // wildcard beside it must survive.
    expect(isValidScope("edge.*.*:write")).toBe(false);
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
    expect(isValidScope("edge.user.*.*:write")).toBe(false);
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
          if (key && !resolvable(key.key)) continue;

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

  it("is built on scopes this build cannot parse, which a grant may still carry", () => {
    expect(resolvable("*")).toBe(true);
    expect(resolvable("user.*")).toBe(true);
    expect(resolvable("parent-of")).toBe(true);

    for (const scope of MALFORMED) {
      // **The grammar refuses these now, and the sweep below is still the
      // point.** The door does not reach backwards: a grant stored before the
      // narrowing carries the literal, and the prune still has to walk past it
      // without taking anything away.
      expect({ scope, valid: isValidScope(scope) }).toEqual({
        scope,
        valid: false,
      });
      // **It emits no key at all, where it used to emit an unresolvable one.**
      // That is the stronger of the two states rather than a weaker one: a key
      // the resolvers cannot resolve still has to be refused at a gate, and a
      // literal with no key never reaches the map a candidate is measured
      // against. The regressions above are what that protects.
      expect({ scope, key: emittedKey(scope) }).toEqual({ scope, key: null });
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
        // **Two ways an entry sits outside "the keys it may reason about",
        // and this skips both.** An unresolvable key is one. A literal that
        // emits no key at all is the other, and it is the family the narrowed
        // edge grammar moved these carriers into: the prune keeps it by
        // design, because a literal this build cannot read may be from a
        // later build rather than an older one, and dropping it would
        // silently narrow a grant across a rolling deploy.
        //
        // Such an entry is redundant by the measure below — removing it
        // changes no verb and no membership — so without this arm the sweep
        // would report the forward-compatibility carry as a defect.
        if (!key || !resolvable(key.key)) {
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

/**
 * The intersection, which is what a device is actually issued a token for.
 *
 * Same algebra as the merge and the same reason for it, with the minimum
 * taken where the merge takes the maximum. The named cases below are each a
 * shape a literal-level filter got wrong, and the property block after them
 * states the contract over concrete ids in both directions.
 */
describe("intersectDeviceScopes, the case it exists for", () => {
  // The traced defect. `grantCoversScope` is not reflexive on a pinned set,
  // so filtering the request literal by literal failed `*:write` against a
  // grant that contains it, and the device was issued the pin alone.
  it("issues a wildcard the grant reaches even where a narrower pin sits under it", () => {
    const requested = ["core.note:read", "*:write"];
    const granted = ["core.note:read", "*:write"];

    // The premise, asserted rather than assumed: this is exactly the test
    // the old filter ran, on a set holding the literal it is asked about.
    expect(grantCoversScope(granted, "*:write")).toBe(false);
    expect(grantCoversScope(granted, "core.note:read")).toBe(true);

    const issued = intersectDeviceScopes(requested, granted);
    expect(verb(issued, "core.task")).toBe("write");
    expect(verb(issued, "core.note")).toBe("read");
  });

  // The union walk. A request-only walk visits `*` alone, where the grant
  // resolves to `none`, and issues nothing, though the grant plainly
  // reaches read on notes and the device plainly asked for it.
  it("issues the grant's pin where only the request's wildcard names it", () => {
    const issued = intersectDeviceScopes(["*:write"], ["core.note:read"]);
    expect(verb(issued, "core.note")).toBe("read");
    // The rest of the request is not reached by the grant, so it goes.
    expect(verb(issued, "core.task")).toBe("none");
  });

  it("issues nothing more than the request named", () => {
    const issued = intersectDeviceScopes(["core.note:read"], ["*:write"]);
    expect(verb(issued, "core.note")).toBe("read");
    expect(verb(issued, "core.task")).toBe("none");
  });

  it("issues nothing more than the grant reaches", () => {
    const issued = intersectDeviceScopes(["*:write"], ["core.note:read"]);
    expect(verb(issued, "core.note")).toBe("read");
    expect(verb(issued, "core.note")).not.toBe("write");
  });

  // A request the grant does not reach at all comes back empty rather than
  // emitting a literal at `none`, which the grammar refuses.
  it("issues nothing where the two sides overlap nowhere", () => {
    expect(
      intersectDeviceScopes(["core.note:read"], ["core.task:write"]),
    ).toEqual([]);
    expect(intersectDeviceScopes(["core.note:read"], [])).toEqual([]);
    expect(intersectDeviceScopes([], ["core.note:read"])).toEqual([]);
  });

  it("does not raise a verb either side held lower", () => {
    const issued = intersectDeviceScopes(["core.*:write"], ["core.*:read"]);
    expect(verb(issued, "core.note")).toBe("read");
  });
});

describe("intersectDeviceScopes, the verb-less families", () => {
  // `offline_access` decides whether a refresh token is minted at all, so
  // both directions are load-bearing: a browser's must not reach a CLI that
  // never asked, and a CLI's must not survive a grant that dropped it.
  it("issues a membership literal only where both sides name it", () => {
    expect(
      intersectDeviceScopes(
        ["core.note:read", "offline_access"],
        ["core.note:read", "offline_access"],
      ),
    ).toContain("offline_access");
    expect(
      intersectDeviceScopes(
        ["core.note:read"],
        ["core.note:read", "offline_access"],
      ),
    ).not.toContain("offline_access");
    expect(
      intersectDeviceScopes(
        ["core.note:read", "offline_access"],
        ["core.note:read"],
      ),
    ).not.toContain("offline_access");
  });

  it("intersects capability and OIDC literals by membership", () => {
    const issued = intersectDeviceScopes(
      ["capability.webhooks", "capability.keys", "openid"],
      ["capability.webhooks", "openid", "profile"],
    );
    expect(issued).toContain("capability.webhooks");
    expect(issued).toContain("openid");
    expect(issued).not.toContain("capability.keys");
    expect(issued).not.toContain("profile");
  });

  // A wildcard must not reach an administrative surface, here as in the
  // merge: `capability.webhooks` parses with a `typePattern`, so classifying
  // it onto the item-type axis compiles and the global wildcard would then
  // resolve it.
  it("does not let a wildcard reach a capability the grant never named", () => {
    expect(
      intersectDeviceScopes(["*:write"], ["capability.webhooks", "*:write"]),
    ).not.toContain("capability.webhooks");
    expect(intersectDeviceScopes(["capability.webhooks"], ["*:write"])).toEqual(
      [],
    );
  });

  it("issues a literal this build cannot parse only where both sides name it", () => {
    expect(
      intersectDeviceScopes(
        ["a-scope-from-a-later-build"],
        ["a-scope-from-a-later-build"],
      ),
    ).toContain("a-scope-from-a-later-build");
    expect(
      intersectDeviceScopes(["a-scope-from-a-later-build"], ["*:write"]),
    ).toEqual([]);
  });
});

describe("intersectDeviceScopes, the edge and metadata axes", () => {
  it("intersects the edge axis by the same rule", () => {
    const issued = intersectDeviceScopes(
      ["edge.*:write"],
      ["edge.parent-of:read"],
    );
    expect(grantCoversScope(issued, "edge.parent-of:read")).toBe(true);
    expect(grantCoversScope(issued, "edge.parent-of:write")).toBe(false);
    expect(grantCoversScope(issued, "edge.other:read")).toBe(false);
  });

  it("intersects the metadata axis by the same rule", () => {
    const issued = intersectDeviceScopes(
      ["metadata:write"],
      ["metadata.types:read"],
    );
    expect(grantCoversScope(issued, "metadata.types:read")).toBe(true);
    expect(grantCoversScope(issued, "metadata.types:write")).toBe(false);
    expect(grantCoversScope(issued, "metadata.other:read")).toBe(false);
  });

  // The edge axis has no pattern validator, so `edge.*.*:read` is admitted by
  // `isValidScope` while reaching no concrete edge type. Resolving through it
  // would let a grant that confers nothing answer for the key `edge.*` and
  // mint a token reaching every edge type on the instance. Reachable through
  // operator-configured permission bundles, whose only filter is
  // `isValidScope`.
  it("does not issue a wildcard the grant only reaches through a malformed key", () => {
    expect(isValidScope("edge.*.*:read")).toBe(false);
    expect(grantCoversScope(["edge.*.*:read"], "edge.parent-of:read")).toBe(
      false,
    );

    const issued = intersectDeviceScopes(["edge.*:read"], ["edge.*.*:read"]);
    expect(grantCoversScope(issued, "edge.parent-of:read")).toBe(false);
    expect(issued).not.toContain("edge.*:read");

    // Both directions, and the nested root as well as the global one.
    expect(
      intersectDeviceScopes(["edge.*.*:read"], ["edge.*:read"]),
    ).not.toContain("edge.*:read");
    expect(
      intersectDeviceScopes(["edge.user.*:read"], ["edge.user.*.*:read"]),
    ).not.toContain("edge.user.*:read");

    // The shape that observes the escalation at a concrete id, which the
    // three above do not: each of them leaves the malformed key as the only
    // entry, so a build resolving through it still confers nothing at any
    // ordinary id. Two caveats, because a build with the guard forced open
    // does not read the way that sentence first suggests. The reverse
    // pairing above fails under it, but on prune order rather than on what
    // is conferred: the walk is `[...requested, ...granted]`, so the
    // malformed key is the first candidate, goes as redundant against
    // `edge.*`, and leaves `edge.*` with nothing to make it redundant in
    // turn. And because that assertion fails first, the one below is never
    // reached under that mutation, though on its own it fails for the reason
    // stated. Here both sides name the malformed key as well as a real one,
    // so it survives the walk on both, and `edge.*` is then issued at read on
    // the strength of a grant that reaches no edge type outside `edge.user`.
    expect(
      verb(
        intersectDeviceScopes(
          ["edge.*:read", "edge.*.*:write"],
          ["edge.user.*:read", "edge.*.*:write"],
        ),
        "edge.parent-of",
      ),
    ).toBe("none");
  });

  // **This case inverted with the narrowing, and the inversion is correct.**
  // It used to assert that such a key is never emitted: it confers nothing at
  // any concrete id, so carrying it into the issued list would tell the client
  // it was granted something that reaches nothing, and unlike the merge's
  // record, this list is what a token is minted from.
  //
  // That reasoning applied while the literal PARSED and resolved a key the
  // gates could refuse. It no longer parses, so it joins the family whose rule
  // is set intersection by membership — the one
  // `issues a literal this build cannot parse only where both sides name it`
  // states, whose fixture is named `a-scope-from-a-later-build`.
  //
  // **That rule outranks the tidiness argument above, and deliberately.** A
  // literal this build cannot read may be from a NEWER build rather than an
  // older one, and dropping it would silently narrow a grant across a rolling
  // deploy. Carrying it is safe because membership requires BOTH sides to name
  // it, so no wildcard can confer it, and it reaches no concrete id — the
  // fixture test above pins that it is inert at every point.
  //
  // So the cost is the one the old comment named, and it is now accepted: a
  // legacy literal can ride along in an issued list conferring nothing. That
  // is exactly what already happens for a later-build literal, which makes the
  // behaviour consistent rather than a new exception.
  it("issues a key the narrowed grammar refuses, as a literal it cannot parse", () => {
    const both = ["edge.*:read", "edge.*.*:read"];
    const issued = intersectDeviceScopes(both, both);
    expect(issued).toContain("edge.*:read");
    expect(issued).toContain("edge.*.*:read");
    expect(
      intersectDeviceScopes(
        ["edge.user.*:read", "edge.user.*.*:read"],
        ["edge.user.*:read", "edge.user.*.*:read"],
      ),
    ).toContain("edge.user.*.*:read");

    // The half that keeps it safe, asserted here rather than assumed from the
    // rule: one side naming it is not enough, so a grant holding it cannot
    // push it into a token the device never asked for.
    expect(
      intersectDeviceScopes(["edge.*:read"], ["edge.*:read", "edge.*.*:read"]),
    ).not.toContain("edge.*.*:read");
    // And it confers nothing wherever it lands.
    expect(grantCoversScope(issued, "edge.parent-of:read")).toBe(true);
    expect(grantCoversScope(["edge.*.*:read"], "edge.parent-of:read")).toBe(
      false,
    );
  });

  // **This documented a cost, and the narrowing removed it.** The old guard
  // refused a key `R.*` whose `R` itself ends in `.*`, and the ids beneath
  // such a key are the ones carrying a whole-segment asterisk of their own. At
  // those ids a broader key survived the refusal and answered in the dropped
  // pin's place — `edge.*.a-b` came out of the intersect at `write` where
  // neither side had conferred write. That was accepted as a trade, because
  // what the refusal removed was a token over every ordinary edge type on the
  // instance while what it cost was confined to ids reachable only through the
  // registration hole in `routes/edge-types.ts`.
  //
  // **Neither half of the trade exists now.** The literal does not parse, so
  // there is no key to refuse and nothing is dropped from a map; and it
  // confers nothing anywhere, so no broader key is left answering in its
  // place. Every probe below reads `none` — including the two that read
  // `write`, which were the widening.
  //
  // The ids are also unregisterable: the hyphen escape hatch that admitted
  // them is closed, so this describes what happens to a grant stored before
  // both changes rather than anything a deployment can still create.
  it("no longer widens an id beneath the key it used to refuse", () => {
    // The premise: the literal is refused at the door and reaches nothing.
    expect(isValidScope("edge.*.*:read")).toBe(false);
    expect(resolvable("*.*")).toBe(false);
    expect(verb(["edge.*.*:read"], "edge.*.a-b")).toBe("none");
    expect(verb(["edge.*.*:read"], "edge.parent-of")).toBe("none");

    // Above: this pair produced `write` at an id neither side conferred write
    // on. It is the widening, and it is gone.
    const above = ["edge.*:write", "edge.*.*:read"];
    expect(verb(above, "edge.*.a-b")).toBe("none");
    expect(verb(intersectDeviceScopes(above, above), "edge.*.a-b")).toBe(
      "none",
    );

    // The same one level down, so this is not a claim about the global root
    // and the asterisk is not the id's first segment.
    const nested = ["edge.user.*:write", "edge.user.*.*:read"];
    expect(verb(nested, "edge.user.*.q-x")).toBe("none");
    expect(verb(intersectDeviceScopes(nested, nested), "edge.user.*.q-x")).toBe(
      "none",
    );

    // Alone, the literal is still ISSUED — membership, both sides naming it,
    // the forward-compatibility rule — and still confers nothing at the id.
    // Carried and inert is the whole of what it now does.
    const alone = ["edge.*.*:read"];
    expect(intersectDeviceScopes(alone, alone)).toEqual(["edge.*.*:read"]);
    expect(verb(intersectDeviceScopes(alone, alone), "edge.*.a-b")).toBe(
      "none",
    );
  });

  // The escalation the guard above itself caused, and the reason it is drawn
  // at the subtree root rather than at an asterisk anywhere. A concrete edge
  // id can carry one, because `routes/edge-types.ts` skips the identifier
  // check for any id holding a hyphen, and a key like that PINS: it answers
  // for itself and for nothing else. Dropping it from both sides' maps
  // removed the restriction, and the wildcard above it answered in its place
  // at a verb neither side conferred.
  it("does not widen the wildcard above a pin whose key carries an asterisk", () => {
    const both = ["edge.*:write", "edge.a-b*c:read"];

    // The premise, asserted rather than assumed. The scope is one the grammar
    // admits, its key is exactly the class the earlier rule refused (an
    // asterisk outside a subtree-root position), and what the two sides
    // genuinely confer at that id is read.
    expect(isValidScope("edge.a-b*c:read")).toBe(false);
    // **It emits no key now**, where it used to emit `a-b*c`. The narrowed
    // grammar refuses an asterisk outside a final `.*`, so this shape is no
    // longer nameable in a request — and the registration door stopped
    // admitting such an id when the hyphen escape hatch went, so it is
    // unreachable from both directions.
    //
    // A grant stored before either change still carries it, which is why this
    // case stays. **The pin still holds**, asserted below rather than assumed:
    // that was the live question, since a literal conferring nothing would
    // have let the wildcard above it answer at a verb neither side conferred,
    // which is precisely what this test exists to catch.
    expect(emittedKey("edge.a-b*c:read")).toBeNull();
    expect("a-b*c".includes("*")).toBe(true);
    expect(subtreeWildcardRoot("a-b*c")).toBeNull();
    expect(verb(both, "edge.a-b*c")).toBe("read");

    const issued = intersectDeviceScopes(both, both);
    expect(verb(issued, "edge.a-b*c")).toBe("read");
    // The wildcard is still issued: the pin holds one id down, not the axis.
    expect(verb(issued, "edge.parent-of")).toBe("write");
  });

  it("does not widen a namespace wildcard above such a pin either", () => {
    const nested = ["edge.user.*:write", "edge.user.b*c:read"];
    expect(verb(nested, "edge.user.b*c")).toBe("read");
    expect(verb(intersectDeviceScopes(nested, nested), "edge.user.b*c")).toBe(
      "read",
    );

    // The same thing one level out. A subtree wildcard whose ROOT carries an
    // asterisk without being a pattern still reaches concrete ids, so it pins
    // them, and it is not the shape the guard refuses.
    // A subtree wildcard whose ROOT carries an asterisk. The narrowed grammar
    // refuses it — the root must be `[a-z0-9_-]+` throughout — so unlike the
    // exact-match pin above it, it no longer reaches the ids beneath it. That
    // is a narrowing of a stored grant and it fails CLOSED: `none` rather than
    // the `write` the wildcard above would have given, so nothing widens. The
    // ids it stops reaching cannot be registered either.
    const rooted = ["edge.*:write", "edge.a-b*.*:read"];
    expect(verb(rooted, "edge.a-b*.x")).toBe("none");
    expect(verb(intersectDeviceScopes(rooted, rooted), "edge.a-b*.x")).toBe(
      "none",
    );
  });

  // The mirror, and the error a hasty fix introduces: dropping such a key
  // must not take away what a legitimate request would otherwise have been
  // issued. Here the grant pins the id and the request reaches it through a
  // wildcard, so the true intersection is read, and dropping the pin from the
  // grant's map left the walk with no key naming that id at all.
  // **The mirror, and it inverted for the same reason as its siblings.** The
  // grant pins the id and the request reaches it only through a wildcard, so
  // the request never names the literal — and membership requires both sides.
  // The device therefore does not receive a literal it did not ask for, which
  // is the property that keeps the forward-compatibility carry safe.
  //
  // It reads as a loss and is not one in practice: `a-b*c` is unregisterable,
  // so no edge type exists at that id for the device to lose access to.
  it("withholds a pin the request never named, even where the grant has it", () => {
    const issued = intersectDeviceScopes(
      ["edge.*:read"],
      ["edge.user.*:read", "edge.a-b*c:read"],
    );
    expect(issued).not.toContain("edge.a-b*c:read");
    expect(verb(issued, "edge.a-b*c")).toBe("none");

    // Named by both, it is carried — the same pair, with the request naming it
    // too. That is the line between "not asked for" and "cannot be read".
    const both = ["edge.*:read", "edge.a-b*c:read"];
    expect(intersectDeviceScopes(both, both)).toContain("edge.a-b*c:read");
  });
});

/**
 * The contract, over a fixed enumeration rather than a random corpus.
 *
 * **Probes are concrete ids and never patterns.** A pointwise comparison over
 * patterns produces false alarms. Coverage of a pattern is a statement about
 * every id beneath it, and a pointwise minimum can fail such a statement
 * while being exactly right at every id, and it re-asks the fail-open
 * question the resolver exists to refuse. Both directions are stated
 * together, because a function that issues too little passes an escalation
 * check and a function that issues too much passes a narrowing check.
 *
 * Every ordered pair drawn from the vocabulary at sizes zero, one and two, so
 * admitting the fixture is a question about the vocabulary and not a seed.
 *
 * The one key the intersection refuses to resolve through is kept out of the
 * VOCABULARY deliberately, and not for want of a probe that could see it. It
 * reaches the ids carrying a whole-segment asterisk of their own, two of
 * which are probed here, and at those ids the pointwise minimum is genuinely
 * false in both directions. That is the residue `keyIsResolvable` accepts,
 * so admitting the key would make this block assert something untrue rather
 * than catch a defect. It is pinned by its own named test above instead, and
 * what is stated here is the contract that holds everywhere else.
 *
 * A key that merely CARRIES an asterisk is a different thing and belongs in
 * the vocabulary, because it reaches an ordinary id and therefore pins one,
 * and dropping a pin is what the escalation on this class turned out to be.
 * The vocabulary held none until it did.
 */
describe("intersectDeviceScopes, the pointwise minimum at every concrete id", () => {
  const VOCAB = [
    "*:read",
    "*:write",
    "core.*:read",
    "core.*:write",
    "core.media.*:read",
    "core.note:read",
    "core.note:write",
    "core.media.book:write",
    "edge.*:read",
    "edge.*:write",
    "edge.user.*:read",
    "edge.parent-of:read",
    "edge.a-b*c:read",
    "edge.a-b*.*:read",
    "metadata:write",
    "metadata.types:read",
    "capability.webhooks",
    "openid",
    "offline_access",
    "a-scope-from-a-later-build",
  ];

  /**
   * Concrete ids on all three breadth axes. Each subtree in the vocabulary
   * needs at least one id inside it that no narrower vocabulary key reaches,
   * or dropping the entry governing that subtree is invisible to every probe.
   */
  const POINTS = [
    "core.note",
    "core.task",
    "core.other",
    "core.media",
    "core.media.book",
    "core.media.photo",
    "user.thing",
    "other.thing",
    "edge.parent-of",
    "edge.user",
    "edge.user.blocks",
    "edge.other",
    // **Five asterisk-carrying ids came out of this list with the narrowed
    // edge grammar**: `edge.a-b*c`, `edge.a-b*`, `edge.a-b*.x`, `edge.*.a-b`
    // and `edge.user.*.q-x`. They were here because the registration door in
    // `routes/edge-types.ts` skipped its identifier check for any id holding a
    // hyphen, so ids like these could genuinely exist and the resolvers had to
    // answer for them.
    //
    // Both doors are shut now — that escape hatch went with the edge-type
    // identifier grammar, and the scope grammar no longer admits an asterisk
    // outside a final `.*` — so no deployment can produce one and no request
    // can name one. A probe list is a claim about ids that exist, and holding
    // these would ask the resolvers to be right about identifiers nothing can
    // create.
    //
    // What a grant STORED before those changes does with such a literal is not
    // dropped with them: it is the subject of the cases above, which assert it
    // is carried, inert, and fails closed rather than letting the wildcard
    // above it answer in its place.
    "metadata.types",
    "metadata.other",
  ];

  const MEMBERSHIP = [
    "openid",
    "offline_access",
    "profile",
    "capability.webhooks",
    "capability.keys",
    "a-scope-from-a-later-build",
  ];

  const RANK: Record<string, number> = { none: 0, read: 1, write: 2 };
  const lowerVerb = (a: string, b: string): string =>
    RANK[a]! <= RANK[b]! ? a : b;

  const GRANTS: string[][] = [[]];
  for (let i = 0; i < VOCAB.length; i++) {
    GRANTS.push([VOCAB[i]!]);
    for (let j = i + 1; j < VOCAB.length; j++) {
      GRANTS.push([VOCAB[i]!, VOCAB[j]!]);
    }
  }

  interface Reading {
    verbs: string[];
    holds: boolean[];
  }
  const read = (scopes: readonly string[]): Reading => ({
    verbs: POINTS.map((p) => verb(scopes, p)),
    holds: MEMBERSHIP.map((m) => scopes.includes(m)),
  });
  const READINGS = new Map<string[], Reading>(
    GRANTS.map((g) => [g, read(g)] as const),
  );

  // Assert the fixture is the shape the clause assumes rather than trusting
  // it. A probe that is a pattern would turn this into the pattern question
  // the block exists to avoid asking, and a vocabulary entry the grammar
  // refuses would never reach a breadth axis at all.
  //
  // A probe is a pattern when it has a subtree root or is the global
  // wildcard, and an asterisk alone does not make it one. That distinction
  // was what admitted `edge.a-b*c` and its siblings to this list, back when
  // the registration hole could produce them; they are gone from it now, and
  // the reasoning is recorded at the list itself.
  it("is built on scopes and probes of the shape the clause assumes", () => {
    for (const point of POINTS) {
      expect({ point, parses: parseScope(`${point}:read`) !== null }).toEqual({
        point,
        parses: true,
      });
      const key = emittedKey(`${point}:read`);
      expect({
        point,
        pattern: key
          ? key.key === "*" || subtreeWildcardRoot(key.key) !== null
          : null,
      }).toEqual({ point, pattern: false });
      expect({ point, resolvable: key ? resolvable(key.key) : null }).toEqual({
        point,
        resolvable: true,
      });
    }
    expect(parseScope("a-scope-from-a-later-build")).toBeNull();
    expect(GRANTS.length).toBeGreaterThan(100);
  });

  it("issues exactly the lesser of the two sides, at every concrete id", () => {
    let checked = 0;
    let sawNarrowedByGrant = 0;
    let sawNarrowedByRequest = 0;
    let sawPin = 0;

    for (const requested of GRANTS) {
      const r = READINGS.get(requested)!;
      for (const granted of GRANTS) {
        const g = READINGS.get(granted)!;
        const issued = intersectDeviceScopes(requested, granted);

        POINTS.forEach((point, i) => {
          const want = lowerVerb(r.verbs[i]!, g.verbs[i]!);
          const got = verb(issued, point);
          checked++;
          if (got !== want) {
            // Built only on failure: the loop runs a few hundred thousand
            // times and the context is what makes a failure readable.
            expect({ requested, granted, issued, point, got }).toEqual({
              requested,
              granted,
              issued,
              point,
              got: want,
            });
          }
          if (want !== r.verbs[i]!) sawNarrowedByGrant++;
          if (want !== g.verbs[i]!) sawNarrowedByRequest++;
        });

        MEMBERSHIP.forEach((literal, i) => {
          const want = r.holds[i]! && g.holds[i]!;
          const got = grantCoversScope(issued, literal);
          checked++;
          if (got !== want) {
            expect({ requested, granted, issued, literal, got }).toEqual({
              requested,
              granted,
              issued,
              literal,
              got: want,
            });
          }
        });

        // The shape the defect was found on: a wildcard issued alongside a
        // narrower literal holding one id down.
        if (
          issued.includes("core.note:read") &&
          issued.some((e) => e === "core.*:write" || e === "*:write")
        ) {
          sawPin++;
        }
      }
    }

    // Not vacuous, and specifically not vacuous against either trivial
    // implementation: returning the request unchanged scores zero on the
    // first counter, returning the grant unchanged scores zero on the second,
    // and neither reaches the pin shape.
    expect(checked).toBeGreaterThan(100_000);
    expect(sawNarrowedByGrant).toBeGreaterThan(1000);
    expect(sawNarrowedByRequest).toBeGreaterThan(1000);
    expect(sawPin).toBeGreaterThan(10);
  });

  // Every emitted scope is either one the grammar admits or one both sides
  // named verbatim, which is the whole of what the membership family can
  // contribute. Dropping the `none` guard emits `<key>:none`, which is
  // neither, and would reach a stored token's scope array.
  it("emits only literals the grammar admits or both sides named", () => {
    for (const requested of GRANTS) {
      for (const granted of GRANTS) {
        for (const scope of intersectDeviceScopes(requested, granted)) {
          const admissible =
            isValidScope(scope) ||
            (requested.includes(scope) && granted.includes(scope));
          if (!admissible) {
            expect({ requested, granted, scope, admissible }).toEqual({
              requested,
              granted,
              scope,
              admissible: true,
            });
          }
        }
      }
    }
  });
});
