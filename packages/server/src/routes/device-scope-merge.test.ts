import { describe, it, expect } from "vitest";
import { grantCoversScope } from "@withmarfa/shared";
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
    expect(record).toEqual(["core.*:write", "core.note:write", "openid"]);
    const first = [...record];
    for (let i = 0; i < 5; i++) {
      record = mergeDeviceApprovalScopes(record, approved);
      expect(record).toEqual(first);
    }
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
  // What separates them is the record: a union leaves `metadata.types:read`
  // sitting under a `metadata:write` that already grants writing types, and
  // `/auth/security` is read as a statement of what the grant confers. So the
  // emitted literal is the assertion here, deliberately, and it is the only
  // place in this file where the array rather than its meaning is the point.
  it("writes the metadata record at the verb it actually confers", () => {
    expect(
      mergeDeviceApprovalScopes(["metadata:write"], ["metadata.types:read"]),
    ).toEqual(["metadata:write", "metadata.types:write"]);
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
