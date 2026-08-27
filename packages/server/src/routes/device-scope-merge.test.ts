import { describe, it, expect } from "vitest";
import { grantCoversScope, parseScope } from "@withmarfa/shared";
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
  it("writes the metadata record at the verb it actually confers", () => {
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
  it("leaves no entry the rest of the record already confers", () => {
    let entriesChecked = 0;
    let sawPrune = 0;

    for (const standing of GRANTS) {
      for (const approved of GRANTS) {
        const pruned = mergeDeviceApprovalScopes(standing, approved);
        const before = read(pruned);

        for (let i = 0; i < pruned.length; i++) {
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

        // The merge before the prune names one entry per key either side
        // spelled, so a pair naming a covered key is one the prune acted on.
        const spelled = new Set(
          [...standing, ...approved].filter((s) => s !== UNPARSEABLE),
        );
        if (spelled.size > pruned.length) sawPrune++;
      }
    }

    expect(entriesChecked).toBeGreaterThan(10_000);
    expect(sawPrune).toBeGreaterThan(100);
  });
});
