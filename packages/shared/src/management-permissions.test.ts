import { describe, expect, it } from "vitest";
import {
  isPermission,
  hasPermission,
  parseScope,
  requiresExplicitConsent,
  scopeCovers,
} from "./scopes.js";

const management = [
  "instance.read",
  "instance.maintain",
  "connectors.manage",
  "blobs.manage",
  "keys.manage",
] as const;

describe("management permissions", () => {
  it.each(management)("requires an explicit grant for %s", (permission) => {
    expect(isPermission(permission)).toBe(true);
    expect(parseScope(permission)?.kind).toBe("permission");
    expect(requiresExplicitConsent(permission)).toBe(true);
    expect(hasPermission([permission], permission)).toBe(true);
    for (const broad of [
      "*",
      "*:write",
      "content:write",
      "system.*:write",
      "instance.*",
      "keys.mint",
    ]) {
      expect(scopeCovers(broad, permission)).toBe(false);
      expect(hasPermission([broad], permission)).toBe(false);
    }
  });
});
