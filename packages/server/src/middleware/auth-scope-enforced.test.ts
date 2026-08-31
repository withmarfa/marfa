/**
 * The `scope_enforced` guarantee: OAuth-derived synthetic keys are held to
 * their granted scopes on the data plane — the `admin` / `space_admin` role
 * bypass does NOT apply to them. Ordinary API keys keep the bypass. These are
 * pure unit tests of `checkTypeAccess` / `computeTypeFilter` against the flag.
 */
import { describe, it, expect } from "vitest";
import type { ApiKey } from "@withmarfa/shared";
import { checkTypeAccess, computeTypeFilter } from "./auth.js";

function fakeKey(over: Partial<ApiKey>): ApiKey {
  return {
    id: "k1",
    space_id: "space-1",
    label: "test",
    source: "test",
    role: "space_admin",
    default_tier: "library",
    is_platform: false,
    type_permissions: {},
    extension_permissions: {},
    edge_permissions: {},
    metadata_permissions: {},
    created_at: "2026-01-01T00:00:00.000Z",
    last_used_at: null,
    ...over,
  };
}

describe("role bypass vs scope_enforced", () => {
  it("a space_admin API key bypasses type_permissions (read + write)", () => {
    const key = fakeKey({ role: "space_admin", type_permissions: {} });
    expect(() => {
      checkTypeAccess(key, "user.ticket", "write");
    }).not.toThrow();
    expect(() => {
      checkTypeAccess(key, "user.ticket", "read");
    }).not.toThrow();
    // `allowed: undefined` = "no filter, all types visible". The pair is
    // always returned; it is the `allowed` half that carries the bypass.
    expect(computeTypeFilter(key).allowed).toBeUndefined();
  });

  it("an admin API key bypasses too", () => {
    const key = fakeKey({ role: "instance_admin", type_permissions: {} });
    expect(() => {
      checkTypeAccess(key, "user.ticket", "write");
    }).not.toThrow();
    expect(computeTypeFilter(key).allowed).toBeUndefined();
  });

  it("a space_admin OAuth token (scope_enforced) does NOT bypass", () => {
    const key = fakeKey({
      role: "space_admin",
      scope_enforced: true,
      type_permissions: {},
    });
    expect(() => {
      checkTypeAccess(key, "user.ticket", "write");
    }).toThrow();
    expect(() => {
      checkTypeAccess(key, "user.ticket", "read");
    }).toThrow();
    // Empty scopes → empty allowed_types → storage denies (no rows).
    expect(computeTypeFilter(key).allowed).toEqual([]);
  });

  it("a scope_enforced token with the global * wildcard reaches any type", () => {
    const writeKey = fakeKey({
      role: "member",
      scope_enforced: true,
      type_permissions: { "*": "write" },
    });
    // The keystone: a runtime user.* type the static registry never lists.
    expect(() => {
      checkTypeAccess(writeKey, "user.ticket.task", "write");
    }).not.toThrow();

    const readKey = fakeKey({
      role: "member",
      scope_enforced: true,
      type_permissions: { "*": "read" },
    });
    expect(computeTypeFilter(readKey).allowed).toEqual(["*"]);
    // read granted, write denied
    expect(() => {
      checkTypeAccess(readKey, "user.ticket", "read");
    }).not.toThrow();
    expect(() => {
      checkTypeAccess(readKey, "user.ticket", "write");
    }).toThrow();
  });

  it("a scope_enforced token with a namespace wildcard reaches that namespace only", () => {
    const key = fakeKey({
      role: "member",
      scope_enforced: true,
      type_permissions: { "user.*": "write" },
    });
    expect(() => {
      checkTypeAccess(key, "user.ticket", "write");
    }).not.toThrow();
    // A different namespace is not covered.
    expect(() => {
      checkTypeAccess(key, "core.note", "write");
    }).toThrow();
    expect(computeTypeFilter(key).allowed).toEqual(["user.*"]);
  });
});
