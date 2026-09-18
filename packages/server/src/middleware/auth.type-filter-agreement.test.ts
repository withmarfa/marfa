/**
 * The list filter and the point check answer the same question, and this file
 * asks them both about the same concrete ids.
 *
 * `checkTypeAccess` honours a `"none"` entry exactly. The filter for a list
 * read could not express one, so it approximated, and every approximation
 * available leaked in one direction or the other. The three shapes below are
 * the three ways that happened; they are one root cause rather than three
 * bugs, which is why they are pinned together in one file rather than beside
 * whichever compiler each of them reached.
 *
 * **Agreement is asserted per id, not per shape.** A test that only checked
 * "the excluded type is absent" passes on a filter that returns nothing at
 * all, which is the fail-closed direction and still wrong. Each case names a
 * type that must survive as well as one that must not.
 */
import { describe, it, expect, afterAll } from "vitest";
import {
  GLOBAL_TYPE_WILDCARD,
  registerTypeSchema,
  resolveTypePermission,
  unregisterTypeSchema,
} from "@withmarfa/shared";
import type { ApiKey, TypePermission } from "@withmarfa/shared";
import { matchesTypeFilter } from "@withmarfa/shared";
import { checkTypeAccess, computeTypeFilter } from "./auth.js";

const SECRET = "user.secret";
const DIARY = "user.diary";
const ORPHAN = "user.orphaned_widget";

function memberKey(type_permissions: Record<string, TypePermission>): ApiKey {
  return {
    id: "k1",
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

/** What the point check says, as a boolean, for one concrete id. */
function pointCheckAdmits(key: ApiKey, type: string): boolean {
  try {
    checkTypeAccess(key, type, "read");
    return true;
  } catch {
    return false;
  }
}

/**
 * What the list filter says, for the same id. Reads the filter through
 * `matchesTypeFilter`, the predicate `routes/events.ts` and
 * `routes/occurrences.ts` both apply to the same value — so this asserts over
 * a shipped decision rather than over a re-implementation of one.
 */
function filterAdmits(key: ApiKey, type: string): boolean {
  return matchesTypeFilter(type, computeTypeFilter(key));
}

function expectAgreement(key: ApiKey, ids: string[]): void {
  for (const id of ids) {
    expect({ id, filter: filterAdmits(key, id) }).toEqual({
      id,
      filter: pointCheckAdmits(key, id),
    });
  }
}

describe("the list filter and the point check agree", () => {
  it("under a global wildcard with an exact exclusion", () => {
    const perms: Record<string, TypePermission> = {
      [GLOBAL_TYPE_WILDCARD]: "read",
      "system.credential": "none",
    };
    // Precondition: the resolver really does read this map the way the case
    // needs, so a passing assertion below cannot be vacuous.
    expect(resolveTypePermission("system.credential", perms)).toBe("none");
    expect(resolveTypePermission("core.note", perms)).toBe("read");

    expectAgreement(memberKey(perms), [
      "core.note",
      "system.credential",
      "system.activity",
    ]);
  });

  it("under a subtree wildcard with an exclusion nested beneath it", () => {
    // Instance 2. The grant carries no global wildcard, so the filter passed
    // `["user.*"]` straight through — which matches `user.secret`, the one id
    // the map exists to withhold. Mintable through POST /keys today.
    registerTypeSchema({ id: SECRET, version: 1, fields: {} });
    registerTypeSchema({ id: DIARY, version: 1, fields: {} });

    const perms: Record<string, TypePermission> = {
      "user.*": "read",
      [SECRET]: "none",
    };
    expect(resolveTypePermission(SECRET, perms)).toBe("none");
    expect(resolveTypePermission(DIARY, perms)).toBe("read");

    // `user.diary` is the half that makes this discriminating: a filter that
    // withheld the whole subtree would satisfy the exclusion and still be
    // wrong.
    expectAgreement(memberKey(perms), [SECRET, DIARY]);
  });

  it("for a type the registry no longer names", () => {
    // Instance 3, the mirror. `DELETE /types/{id}?force=true` drops the
    // registration and deliberately keeps the rows, so an enumeration over
    // the registry cannot name this id — and a filter built by enumerating
    // dropped it from every listing while the point check still served it.
    const perms: Record<string, TypePermission> = {
      [GLOBAL_TYPE_WILDCARD]: "read",
      "system.credential": "none",
    };
    // The type is never registered, which is exactly the orphan's state:
    // rows exist, the registry does not name it.
    expect(resolveTypePermission(ORPHAN, perms)).toBe("read");

    expectAgreement(memberKey(perms), [ORPHAN, "core.note"]);
  });
});

afterAll(() => {
  unregisterTypeSchema(SECRET);
  unregisterTypeSchema(DIARY);
});
