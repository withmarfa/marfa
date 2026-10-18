import { describe, expect, it } from "vitest";
import { parseScope, profilePermissionCovers } from "./scopes.js";

describe("profile authority", () => {
  it("never delegates an email write, including stored and wildcard grants", () => {
    expect(parseScope("profile.email:write")).toBeNull();
    for (const perms of [{ "*": "write" }, { email: "write" }] as Record<
      string,
      "write"
    >[]) {
      expect(profilePermissionCovers(perms, "email", "write")).toBe(false);
      expect(profilePermissionCovers(perms, "email", "read")).toBe(true);
    }
    expect(profilePermissionCovers({ "*": "write" }, "name", "write")).toBe(
      true,
    );
    expect(profilePermissionCovers({ "*": "write" }, "avatar", "write")).toBe(
      true,
    );
    expect(profilePermissionCovers({ "*": "write" }, "unknown", "write")).toBe(
      false,
    );
  });
});
