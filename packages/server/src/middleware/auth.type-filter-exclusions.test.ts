/**
 * `computeTypeFilter` and an explicit `"none"` entry in `type_permissions`.
 *
 * A `"none"` entry subtracts, and a filter assembled from the granted
 * patterns alone has no way to express a subtraction. `"none"` is a public
 * input, not a hypothetical — it is the third arm of the `z.enum` on POST
 * /keys and POST /admin/spaces/{id}/keys — so these shapes are mintable
 * today.
 *
 * **This file asserts the shape of the returned pair, not what it admits.**
 * Whether the filter and the point check agree about a concrete id is
 * `auth.type-filter-agreement.test.ts`, which is the acceptance; these are
 * the unit assertions underneath it. Asserting on a `GET /items` response
 * instead would prove nothing either way: the storage layer's own space
 * fence can hide system rows independently, so the route
 * passes with the filter broken.
 *
 * How a sign-in's granted scopes reach this same map is not the subject
 * here; `oauth-scope-enforcement.test.ts` covers that projection.
 */
import { describe, it, expect } from "vitest";
import {
  GLOBAL_TYPE_WILDCARD,
  matchesTypeFilter,
  resolveTypePermission,
} from "@withmarfa/shared";
import type { ApiKey, TypePermission } from "@withmarfa/shared";
import { checkTypeAccess, computeTypeFilter } from "./auth.js";

const OWN_SPACE = "space-own";

// An ordinary space key: the permission map is the only thing that decides,
// because nothing bypasses it.
function spaceKey(
  type_permissions: Record<string, TypePermission>,
  spaceId: string = OWN_SPACE,
): ApiKey {
  return {
    id: "k1",
    space_id: spaceId,
    label: "test",
    source: "test",
    default_tier: "library",
    is_operator: false,
    type_permissions,
    extension_permissions: {},
    edge_permissions: {},
    metadata_permissions: {},
    created_at: "2026-01-01T00:00:00.000Z",
    last_used_at: null,
  };
}

describe("computeTypeFilter — explicit no-access entries", () => {
  it("carries the exclusion beside the grant rather than approximating it", () => {
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
    // Precondition: the resolver honors the entry, so the assertions below
    // cannot hold for the wrong reason.
    expect(resolveTypePermission("system.credential", withExclusion)).toBe(
      "none",
    );
    expect(resolveTypePermission("core.note", withExclusion)).toBe("read");

    const before = computeTypeFilter(spaceKey(granted));
    const after = computeTypeFilter(spaceKey(withExclusion));

    // Without the entry: byte-identical to what this credential shape has
    // always produced.
    expect(before).toEqual({
      allowed: [GLOBAL_TYPE_WILDCARD],
      excluded: [],
    });

    // With it: the wildcard SURVIVES. That is the change — it used to be
    // enumerated into the concrete ids it stood for, which is what lost
    // types the registry does not name.
    expect(after).toEqual({
      allowed: [GLOBAL_TYPE_WILDCARD],
      excluded: ["system.credential"],
    });

    // The divergence this exists to close: the point check refuses the type
    // the filter must also withhold, and admits the one it must keep.
    expect(() => {
      checkTypeAccess(spaceKey(withExclusion), "system.credential", "read");
    }).toThrow();
    expect(matchesTypeFilter("system.credential", after)).toBe(false);
    expect(matchesTypeFilter("core.note", after)).toBe(true);
  });

  it("honors a subtree 'none' entry, not just an exact one", () => {
    const perms: Record<string, TypePermission> = {
      [GLOBAL_TYPE_WILDCARD]: "read",
      "system.*": "none",
    };
    const filter = computeTypeFilter(spaceKey(perms));
    expect(filter.excluded).toEqual(["system.*"]);
    expect(matchesTypeFilter("core.note", filter)).toBe(true);
    expect(matchesTypeFilter("system.credential", filter)).toBe(false);
    expect(matchesTypeFilter("system.activity", filter)).toBe(false);
  });

  it("subtracts an exclusion nested inside a subtree grant", () => {
    // The shape that had no representation at all: no global wildcard, so
    // the old filter passed `["user.*"]` through whole and listed the one
    // type the map exists to withhold.
    const perms: Record<string, TypePermission> = {
      "user.*": "read",
      "user.secret": "none",
    };
    const filter = computeTypeFilter(spaceKey(perms));
    expect(filter).toEqual({ allowed: ["user.*"], excluded: ["user.secret"] });
    expect(matchesTypeFilter("user.diary", filter)).toBe(true);
    expect(matchesTypeFilter("user.secret", filter)).toBe(false);
  });

  it("lets an exact grant outrank a wildcard exclusion spanning it", () => {
    // The mirror, and the case a naive "every exclusion subtracts from every
    // grant" gets backwards. `resolveTypePermission` returns on an exact key
    // before it looks at any wildcard, so this grants `user.secret` — and
    // the filter has to agree.
    const perms: Record<string, TypePermission> = {
      "user.secret": "read",
      "user.*": "none",
    };
    expect(resolveTypePermission("user.secret", perms)).toBe("read");

    const filter = computeTypeFilter(spaceKey(perms));
    expect(matchesTypeFilter("user.secret", filter)).toBe(true);
    expect(matchesTypeFilter("user.diary", filter)).toBe(false);
  });

  it("leaves a narrow grant untouched when nothing is excluded", () => {
    const perms: Record<string, TypePermission> = { "core.*": "read" };
    expect(computeTypeFilter(spaceKey(perms))).toEqual({
      allowed: ["core.*"],
      excluded: [],
    });
  });

  it("returns an empty allow-list when nothing at all is granted", () => {
    // `allowed: []` means "no items visible", not "all items" — both
    // dialects compile it to `1=0`. Distinct from `allowed: undefined`,
    // which is the no-credential case below.
    const perms: Record<string, TypePermission> = {
      [GLOBAL_TYPE_WILDCARD]: "none",
      "core.note": "none",
    };
    const filter = computeTypeFilter(spaceKey(perms));
    expect(filter.allowed).toEqual([]);
    expect(matchesTypeFilter("core.note", filter)).toBe(false);
  });

  it("subtracts a read grant at write level, so a wildcard cannot readmit it", () => {
    // The write level is what `POST /items/bulk-actions` asks for, and this
    // is the half of it that a route test cannot reach. A read grant has to
    // land in `excluded` rather than merely be left out of `allowed`,
    // because a broader write pattern spanning it would otherwise put the
    // row back.
    //
    // It needs a *ranking* difference to be observable at all: with two
    // exact patterns the subtraction compiles away to nothing and the SQL is
    // byte-identical either way, so a suite built on `{a: "read", b:
    // "write"}` proves the level and says nothing about the exclusion. The
    // wildcard beside the literal is what makes the two arms differ.
    const key = spaceKey({ "*": "write", "user.secret": "read" });

    expect(computeTypeFilter(key, "write")).toEqual({
      allowed: ["*"],
      excluded: ["user.secret"],
    });

    // And at read level the same grant is admitted, which is what says the
    // exclusion above is the level's doing rather than the pattern's.
    expect(computeTypeFilter(key, "read")).toEqual({
      allowed: ["*", "user.secret"],
      excluded: [],
    });
  });

  it("hands back a fresh object each call, never a shared one", () => {
    // These travel into storage filter objects, so a shared literal would be
    // a mutation hazard nobody would think to look for.
    const a = computeTypeFilter(undefined);
    const b = computeTypeFilter(undefined);
    expect(a).not.toBe(b);
    expect(a.excluded).not.toBe(b.excluded);
  });

  it("is independent of the space, because the space fence is not its job", () => {
    // The old filter enumerated `listTypes(space)`, so it could not name
    // another space's type — a property of the enumeration rather than a
    // security boundary. Cross-space isolation is `spaceCondition` in the
    // item store, which still applies. Pinned so the
    // removal of the enumeration is not later read as having dropped a
    // fence that lived somewhere else all along.
    const perms: Record<string, TypePermission> = {
      [GLOBAL_TYPE_WILDCARD]: "read",
      "system.credential": "none",
    };
    expect(computeTypeFilter(spaceKey(perms, "space-own"))).toEqual(
      computeTypeFilter(spaceKey(perms, "space-other")),
    );
  });
});
