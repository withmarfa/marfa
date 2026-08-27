/**
 * `computeTypeFilter` and an explicit `"none"` entry in `type_permissions`.
 *
 * A `"none"` entry subtracts, and the filter for a list read is assembled from
 * the granted patterns only, so a subtraction had nowhere to land: a map of
 * `{"*": "read", "system.credential": "none"}` yielded `["*"]` and the list
 * read returned exactly the rows the entry exists to withhold, while
 * `checkTypeAccess` refused the same row by id. `"none"` is a public input,
 * not a hypothetical — it is the third arm of the `z.enum` on POST /keys and
 * POST /admin/spaces/{id}/keys — so these shapes are mintable today.
 *
 * These are pure unit tests over the returned array. Asserting on a `GET /items` response instead would prove
 * nothing: the storage layer's own space fence and Postgres RLS can hide
 * system rows independently, so the route passes with the filter broken.
 *
 * The `scope_enforced` interaction is not the subject here — see
 * `auth-scope-enforced.test.ts` for the role-bypass axis.
 */
import { describe, it, expect, afterAll } from "vitest";
import {
  GLOBAL_TYPE_WILDCARD,
  listTypes,
  registerTypeSchema,
  resolveTypePermission,
  unregisterTypeSchema,
} from "@withmarfa/shared";
import type { ApiKey, TypePermission } from "@withmarfa/shared";
import { checkTypeAccess, computeTypeFilter } from "./auth.js";

const OWN_SPACE = "space-own";
const OTHER_SPACE = "space-other";
const OWN_CUSTOM = "user.own_space_widget";
const OTHER_CUSTOM = "user.other_space_widget";

// A member key: no role bypass, so the permission map is what decides.
function memberKey(
  type_permissions: Record<string, TypePermission>,
  spaceId: string = OWN_SPACE,
): ApiKey {
  return {
    id: "k1",
    space_id: spaceId,
    label: "test",
    source: "test",
    role: "member",
    default_tier: "library",
    is_platform: false,
    type_permissions,
    extension_permissions: {},
    edge_permissions: {},
    metadata_permissions: {},
    created_at: "2026-01-01T00:00:00.000Z",
    last_used_at: null,
  };
}

describe("computeTypeFilter — explicit no-access entries", () => {
  it("expands the global wildcard only when a 'none' entry is present", () => {
    // Two invocations over one credential shape, differing in the single
    // `"none"` entry and nothing else. One invocation would leave either
    // branch unproven: the difference IS the thing under test.
    const granted: Record<string, TypePermission> = {
      [GLOBAL_TYPE_WILDCARD]: "read",
    };
    const withExclusion: Record<string, TypePermission> = {
      [GLOBAL_TYPE_WILDCARD]: "read",
      "system.credential": "none",
    };

    // Preconditions. Without these the assertions below could hold for the
    // wrong reason — a filter that omits `system.credential` because the
    // registry never listed it proves nothing, and a `"none"` entry the
    // resolver does not honor would make the whole case vacuous.
    const registered = listTypes(OWN_SPACE).map((schema) => schema.id);
    expect(registered).toContain("system.credential");
    expect(registered).toContain("core.note");
    expect(resolveTypePermission("system.credential", withExclusion)).toBe(
      "none",
    );
    expect(resolveTypePermission("core.note", withExclusion)).toBe("read");

    const before = computeTypeFilter(memberKey(granted));
    const after = computeTypeFilter(memberKey(withExclusion));

    // Without the entry: byte-identical to what this credential shape has
    // always produced.
    expect(before).toEqual([GLOBAL_TYPE_WILDCARD]);

    // With it: the wildcard is gone, replaced by the concrete ids it stood
    // for, minus the excluded one. `toContain("core.note")` is what makes the
    // fixture discriminating — a filter left as `["*"]` fails it, whereas
    // `not.toContain("system.credential")` alone would pass on `["*"]`
    // because the literal string simply is not in that array.
    expect(after).not.toContain(GLOBAL_TYPE_WILDCARD);
    expect(after).toContain("core.note");
    expect(after).not.toContain("system.credential");
    expect(after).not.toEqual(before);

    // The divergence this exists to close: the point check already refuses
    // the type the old filter handed back in a list.
    expect(() => {
      checkTypeAccess(memberKey(withExclusion), "system.credential", "read");
    }).toThrow();
  });

  it("honors a subtree 'none' entry, not just an exact one", () => {
    const perms: Record<string, TypePermission> = {
      [GLOBAL_TYPE_WILDCARD]: "read",
      "system.*": "none",
    };
    // Precondition: the registry carries more than one system type, so
    // "no system type survives" is a real claim.
    const systemIds = listTypes(OWN_SPACE)
      .map((schema) => schema.id)
      .filter((id) => id.startsWith("system."));
    expect(systemIds.length).toBeGreaterThan(1);

    const filter = computeTypeFilter(memberKey(perms));
    expect(filter).toBeDefined();
    expect(filter).toContain("core.note");
    expect(filter?.filter((id) => id.startsWith("system."))).toEqual([]);
  });

  it("leaves a narrow grant untouched when no global wildcard is present", () => {
    const perms: Record<string, TypePermission> = {
      "core.*": "read",
      "system.credential": "none",
    };
    // The grant already excludes by omission, so there is nothing to expand
    // and the patterns pass straight through.
    expect(computeTypeFilter(memberKey(perms))).toEqual(["core.*"]);
  });

  it("never names a type belonging to another space", () => {
    registerTypeSchema({ id: OWN_CUSTOM, version: 1, fields: {} }, OWN_SPACE);
    registerTypeSchema(
      { id: OTHER_CUSTOM, version: 1, fields: {} },
      OTHER_SPACE,
    );

    // Precondition: the other space's type really is registered, so its
    // absence below is a fence and not a missing fixture.
    expect(listTypes(OTHER_SPACE).map((schema) => schema.id)).toContain(
      OTHER_CUSTOM,
    );

    const perms: Record<string, TypePermission> = {
      [GLOBAL_TYPE_WILDCARD]: "read",
      "system.credential": "none",
    };
    const filter = computeTypeFilter(memberKey(perms, OWN_SPACE));
    expect(filter).toContain(OWN_CUSTOM);
    expect(filter).not.toContain(OTHER_CUSTOM);
  });

  it("returns an empty filter when nothing at all is granted", () => {
    // Nothing lands in `patterns`, so this exits at the early return and
    // never reaches the enumeration — it pins the pre-existing path, and it
    // is NOT evidence that the new branch handles an empty result. The test
    // below is. Kept apart because one `[]` looks like the other and the two
    // arrive by different routes.
    const perms: Record<string, TypePermission> = {
      [GLOBAL_TYPE_WILDCARD]: "none",
      "core.note": "none",
    };
    expect(computeTypeFilter(memberKey(perms))).toEqual([]);
  });

  it("returns an empty filter when the enumeration excludes every registered type", () => {
    // The only way the enumeration itself can yield nothing, and the only
    // case in this file whose expected value is empty AND whose granted
    // patterns are not. Without it, no test proves the new branch can
    // return an empty array rather than falling over on one.
    const registered = listTypes(OWN_SPACE).map((schema) => schema.id);
    expect(registered.length).toBeGreaterThan(0);

    // Derived from the registry rather than hand-listing namespace roots, so
    // a newly shipped type cannot quietly leave a survivor that turns this
    // assertion into a pass for the wrong reason.
    const perms: Record<string, TypePermission> = {
      [GLOBAL_TYPE_WILDCARD]: "read",
    };
    for (const id of registered) {
      perms[id] = "none";
    }

    // Preconditions. The wildcard grant is what routes this to the
    // enumeration — `patterns` is non-empty here, which is exactly what
    // separates this case from the one above — and every id resolving to
    // `"none"` is what makes the empty result the enumeration's doing.
    expect(perms[GLOBAL_TYPE_WILDCARD]).toBe("read");
    expect(
      registered.filter((id) => resolveTypePermission(id, perms) !== "none"),
    ).toEqual([]);

    expect(computeTypeFilter(memberKey(perms))).toEqual([]);
  });
});

afterAll(() => {
  unregisterTypeSchema(OWN_CUSTOM, OWN_SPACE);
  unregisterTypeSchema(OTHER_CUSTOM, OTHER_SPACE);
});
