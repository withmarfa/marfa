import { describe, it, expect } from "vitest";
import { MARFA_ROLES, ROLE_RANK, canGrantRole } from "./types.js";

describe("ROLE_RANK", () => {
  it("ranks every role", () => {
    for (const role of MARFA_ROLES) {
      expect(typeof ROLE_RANK[role]).toBe("number");
    }
  });

  it("orders admin above tenant_admin above member", () => {
    expect(ROLE_RANK.admin).toBeGreaterThan(ROLE_RANK.tenant_admin);
    expect(ROLE_RANK.tenant_admin).toBeGreaterThan(ROLE_RANK.member);
  });

  it("matches the descending order MARFA_ROLES is declared in", () => {
    const ranks = MARFA_ROLES.map((r) => ROLE_RANK[r]);
    expect(ranks).toEqual([...ranks].sort((a, b) => b - a));
  });
});

describe("canGrantRole", () => {
  it("permits granting a role at or below the granter's own", () => {
    expect(canGrantRole("admin", "admin")).toBe(true);
    expect(canGrantRole("admin", "tenant_admin")).toBe(true);
    expect(canGrantRole("admin", "member")).toBe(true);
    expect(canGrantRole("tenant_admin", "tenant_admin")).toBe(true);
    expect(canGrantRole("tenant_admin", "member")).toBe(true);
    expect(canGrantRole("member", "member")).toBe(true);
  });

  it("refuses granting a role above the granter's own", () => {
    expect(canGrantRole("tenant_admin", "admin")).toBe(false);
    expect(canGrantRole("member", "admin")).toBe(false);
    expect(canGrantRole("member", "tenant_admin")).toBe(false);
  });
});
