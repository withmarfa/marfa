import { describe, expect, it } from "vitest";
import { firstUncoveredExtension } from "./mint-clamp.js";

describe("extension mint ceiling", () => {
  const map = (value: Record<string, unknown>) =>
    value as Record<string, "read" | "write">;
  it.each(["unknown", "none", "", false, 0, null])(
    "does not grant stored level %j or lose its exact denial",
    (value) => {
      expect(
        firstUncoveredExtension({ named: "read" }, { named: "read" }),
      ).toBeNull();
      expect(
        firstUncoveredExtension(map({ named: value }), { named: "read" }),
      ).toBe("named");
      expect(
        firstUncoveredExtension(map({ "*": "read", named: value }), {
          "*": "read",
        }),
      ).toBe("named");
    },
  );
  it("preserves write/read coverage and refuses breadth or write escalation", () => {
    expect(
      firstUncoveredExtension({ "*": "write" }, { named: "read" }),
    ).toBeNull();
    expect(
      firstUncoveredExtension(
        { "*": "read", named: "write" },
        { named: "write" },
      ),
    ).toBeNull();
    expect(firstUncoveredExtension({ named: "write" }, { "*": "read" })).toBe(
      "*",
    );
    expect(firstUncoveredExtension({ named: "read" }, { named: "write" })).toBe(
      "named",
    );
  });
});
