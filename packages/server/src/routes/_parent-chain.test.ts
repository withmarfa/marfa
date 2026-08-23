/**
 * The registration doors used to hold a copy each of this walk and of the
 * depth it stops at, so the archive restore could have started accepting
 * chains `POST /types` refuses without anything failing. They share it now,
 * and nothing here covered the walk itself: the cap, the cycle check and
 * the space scoping were all untested at both doors.
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import {
  getResolvedFields,
  registerTypeSchema,
  unregisterTypeSchema,
} from "@withmarfa/shared";
import { MAX_INHERITANCE_DEPTH, assertParentChain } from "./_parent-chain.js";

const SPACE = "space-parent-chain-test";
const OTHER_SPACE = "space-parent-chain-other";

/** `acme.a0` has no parent; each `acme.aN` inherits from `acme.a(N-1)`. */
const CHAIN_LENGTH = MAX_INHERITANCE_DEPTH + 1;
const link = (n: number): string => `acme.a${String(n)}`;

/** Distinguishable phrasing, so a case cannot pass on the wrong rejection. */
const MESSAGES = {
  tooDeep: (maxDepth: number) => `too-deep:${String(maxDepth)}`,
  circular: () => "circular",
  unknownParent: (parentId: string) => `unknown:${parentId}`,
};

beforeAll(() => {
  for (let n = 0; n < CHAIN_LENGTH; n++) {
    registerTypeSchema(
      {
        id: link(n),
        version: 1,
        ...(n > 0 ? { parent: link(n - 1) } : {}),
        fields: {},
      },
      SPACE,
    );
  }
});

afterAll(() => {
  for (let n = 0; n < CHAIN_LENGTH; n++) unregisterTypeSchema(link(n), SPACE);
});

describe("the depth a registered chain may reach", () => {
  it("accepts a chain of exactly the maximum depth", () => {
    // Walking from `a9` reaches `a0` on the tenth step, and `a0` terminates.
    expect(() => {
      assertParentChain(
        "acme.new",
        link(MAX_INHERITANCE_DEPTH - 1),
        SPACE,
        MESSAGES,
      );
    }).not.toThrow();
  });

  it("refuses a chain one level deeper, naming the cap", () => {
    expect(() => {
      assertParentChain(
        "acme.new",
        link(MAX_INHERITANCE_DEPTH),
        SPACE,
        MESSAGES,
      );
    }).toThrow(`too-deep:${String(MAX_INHERITANCE_DEPTH)}`);
  });
});

describe("a chain that reaches back to the type being registered", () => {
  it("reports a cycle when the loop closes inside the depth bound", () => {
    // `a5` is five steps up from `a9`, well inside the depth bound. Depth is
    // checked first, so a loop that only closes past the cap reports as too
    // deep instead, which is what both doors did before this was shared.
    expect(() => {
      assertParentChain(link(5), link(9), SPACE, MESSAGES);
    }).toThrow("circular");
  });

  it("reports a cycle when a type names itself as its parent", () => {
    expect(() => {
      assertParentChain(link(3), link(3), SPACE, MESSAGES);
    }).toThrow("circular");
  });
});

describe("a parent that does not resolve", () => {
  it("names the ancestor that could not be found", () => {
    expect(() => {
      assertParentChain("acme.new", "acme.absent", SPACE, MESSAGES);
    }).toThrow("unknown:acme.absent");
  });

  it("names the first unresolvable ancestor, not the parent given", () => {
    registerTypeSchema(
      { id: "acme.orphan", version: 1, parent: "acme.absent", fields: {} },
      SPACE,
    );
    try {
      expect(() => {
        assertParentChain("acme.new", "acme.orphan", SPACE, MESSAGES);
      }).toThrow("unknown:acme.absent");
    } finally {
      unregisterTypeSchema("acme.orphan", SPACE);
    }
  });
});

describe("the space a parent resolves in", () => {
  it("does not see a type registered by another space", () => {
    expect(() => {
      assertParentChain("acme.new", link(0), OTHER_SPACE, MESSAGES);
    }).toThrow(`unknown:${link(0)}`);
  });
});

describe("the registration cap against the registry's own backstop", () => {
  it("leaves the deepest legally registered type resolvable on the read path", () => {
    // The registry caps its resolution walks far above this, so that hitting
    // that bound means a cycle got past this check rather than that a real
    // hierarchy grew too tall. Raise this cap above it and every read of a
    // legally registered deep type throws instead.
    //
    // The worst case is a type registered on top of the deepest legal parent,
    // so the walk covers one more node than the cap itself.
    const deepest = "acme.deepest";
    registerTypeSchema(
      {
        id: deepest,
        version: 1,
        parent: link(MAX_INHERITANCE_DEPTH - 1),
        fields: { own: { type: "string", description: "Own field" } },
      },
      SPACE,
    );
    try {
      const fields = getResolvedFields(deepest, SPACE);
      // Asserting the result, not just the absence of a throw: an unknown
      // type resolves to `undefined` without throwing, so `not.toThrow()`
      // alone would pass against a type that never registered.
      expect(fields).toBeDefined();
      expect(fields).toHaveProperty("own");
    } finally {
      unregisterTypeSchema(deepest, SPACE);
    }
  });
});
