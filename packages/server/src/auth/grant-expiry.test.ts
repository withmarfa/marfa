import { expect, it } from "vitest";
import { grantExpiresAt } from "./grant-expiry.js";
it("uses last use, falls back to approval, and disables the boundary at zero", () => {
  const grant = { grantedAt: "2024-02-28T23:00:00.000Z", lastUsedAt: null };
  expect(grantExpiresAt(grant, 1)).toBe("2024-02-29T23:00:00.000Z");
  expect(
    grantExpiresAt({ ...grant, lastUsedAt: "2024-03-30T23:00:00.000Z" }, 1),
  ).toBe("2024-03-31T23:00:00.000Z");
  expect(grantExpiresAt(grant, 0)).toBeNull();
});
