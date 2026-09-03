import { afterEach, describe, expect, it } from "vitest";
import type { TypeSchema } from "@withmarfa/types";
import { hydrateTypeRegistry } from "./hydrate-type-registry.js";
import {
  getTypeSchema,
  listTypes,
  unregisterTypeSchema,
  validateProperties,
} from "./type-registry.js";
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
});
