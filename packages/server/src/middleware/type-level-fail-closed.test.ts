/**
 * A stored type map can hold a level the API never writes (a hand-edited
 * database). The point checks then refuse the type, as the SQL compiler
 * leaves it out of every listing, so a read by id never answers what a
 * listing hides.
 */
import { describe, expect, it } from "vitest";
import type { ApiKey } from "@withmarfa/shared";
import { matchesTypeFilter } from "@withmarfa/shared";
import { checkTypePermission, computeTypeFilter, mayReadType } from "./auth.js";

function keyWith(type_permissions: Record<string, string>): ApiKey {
  return {
    id: "key-1",
    type_permissions,
    edge_permissions: {},
    permissions: [],
  } as unknown as ApiKey;
}

describe("a stored type-map level outside read, write and none", () => {
  const key = keyWith({ "*": "write", "core.note": "admin" });

  it("is refused by the read check and the write check, as the listing filter excludes it", () => {
    expect(matchesTypeFilter("core.note", computeTypeFilter(key))).toBe(false);
    expect(mayReadType(key, "core.note")).toBe(false);
    expect(() => {
      checkTypePermission(key, "core.note", "read");
    }).toThrow();
    expect(() => {
      checkTypePermission(key, "core.note", "write");
    }).toThrow();
  });

  it("leaves the types the rest of the map grants readable", () => {
    expect(mayReadType(key, "core.task")).toBe(true);
    expect(() => {
      checkTypePermission(key, "core.task", "write");
    }).not.toThrow();
  });
});
