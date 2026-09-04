/**
 * The tier gate and the delete door have to agree about what a platform
 * record is.
 *
 * `system.*` rows carry no tier and live in a bounded lifecycle whose
 * terminal state is `revoked` rather than `trashed`. Two doors decide that
 * separately: `assertTierApplicable` refuses a caller-supplied tier, and
 * `softDeleteState` chooses the state a delete puts the row into. They asked
 * different questions — one the seeded set, the other the set **or** the
 * reserved-root name test — so a type named into `system.` that this build
 * did not seed accepted a tier from a client and was then deleted into the
 * lifecycle that has no room for one.
 *
 * The invariant below is the agreement itself rather than either half. A test
 * that pinned only the widened gate would go green on a change that widened
 * the delete door instead, and leave the pair disagreeing in the other
 * direction.
 */
import { describe, it, expect } from "vitest";
import {
  SYSTEM_TYPE_IDS,
  softDeleteState,
  hasBoundedLifecycle,
} from "@withmarfa/shared";
import { assertTierApplicable } from "./_tier-rules.js";

/** Did the gate refuse a caller-supplied tier for this type? */
function refusesTier(type: string): boolean {
  try {
    assertTierApplicable(type, "feed");
    return false;
  } catch {
    return true;
  }
}

describe("the tier gate and the soft-delete state", () => {
  // A reserved-root name this build does not seed. The whole defect lives in
  // the gap between the two questions, and every seeded type answers both the
  // same way, so a case drawn from the seeded set cannot reach it.
  const UNSEEDED_SYSTEM_TYPE = "system.not_a_seeded_type";

  it("agree on a reserved-root type this build did not seed", () => {
    expect(
      SYSTEM_TYPE_IDS.has(UNSEEDED_SYSTEM_TYPE),
      "the fixture was seeded after all, so it no longer reaches the gap between the two questions",
    ).toBe(false);

    expect(
      softDeleteState(UNSEEDED_SYSTEM_TYPE),
      "the delete door does not put this type into the bounded lifecycle, so the fixture is not exercising the disagreement",
    ).toBe("revoked");

    expect(
      refusesTier(UNSEEDED_SYSTEM_TYPE),
      "a delete puts this type into the bounded lifecycle's terminal state, and the tier gate still accepted a caller-supplied tier for it, so the two doors disagree about whether it is a platform record",
    ).toBe(true);
  });

  it("agree across the seeded types and ordinary types alike", () => {
    const cases = [
      ...SYSTEM_TYPE_IDS,
      UNSEEDED_SYSTEM_TYPE,
      "core.note",
      "app.thing",
    ];
    // The floor: a loop over an empty set asserts nothing, and the seeded set
    // is read at runtime rather than written down here.
    expect(cases.length).toBeGreaterThan(3);
    for (const type of cases) {
      expect(
        refusesTier(type),
        `${type}: the tier gate and the delete door answer differently about whether this is a platform record`,
      ).toBe(softDeleteState(type) === "revoked");
      // And both follow the one predicate rather than agreeing by luck.
      expect(refusesTier(type)).toBe(hasBoundedLifecycle(type));
    }
  });

  it("still ignores a write that supplies no tier at all", () => {
    // The early return the gate has always had. Without this, widening the
    // predicate would be indistinguishable from refusing every system write.
    expect(refusesTier2(undefined)).toBe(false);
  });
});

/** A write with no tier, which the gate returns from before it looks at type. */
function refusesTier2(tier: unknown): boolean {
  try {
    assertTierApplicable("system.connection", tier);
    return false;
  } catch {
    return true;
  }
}
