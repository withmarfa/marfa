import { describe, expect, it } from "vitest";
import { firstReachBeyondCredential } from "./mint-clamp.js";

describe("profile mint refusal scopes", () => {
  it("reports email read when the bounded wildcard lacks that authority", () => {
    expect(
      firstReachBeyondCredential(
        { profile_permissions: { name: "write", avatar: "write" } },
        { profile_permissions: { "*": "write" } },
      ),
    ).toBe("profile.email:read");
  });

  it("reports the effective wildcard write above an explicit read", () => {
    expect(
      firstReachBeyondCredential(
        { profile_permissions: { name: "read" } },
        { profile_permissions: { "*": "write", name: "read" } },
      ),
    ).toBe("profile.name:write");
  });

  it("accepts a wildcard covered by all effective field operations", () => {
    expect(
      firstReachBeyondCredential(
        {
          profile_permissions: {
            name: "write",
            email: "read",
            avatar: "write",
          },
        },
        { profile_permissions: { "*": "write", name: "read" } },
      ),
    ).toBeNull();
  });
});
