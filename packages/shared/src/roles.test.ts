import { describe, it, expect } from "vitest";
import {
  MARFA_ROLES,
  ROLE_RANK,
  canGrantRole,
  isMarfaRole,
  parseMarfaRole,
} from "./types.js";

describe("ROLE_RANK", () => {
  it("ranks every role", () => {
    for (const role of MARFA_ROLES) {
      expect(typeof ROLE_RANK[role]).toBe("number");
    }
  });

  it("orders admin above space_admin above member", () => {
    expect(ROLE_RANK.admin).toBeGreaterThan(ROLE_RANK.space_admin);
    expect(ROLE_RANK.space_admin).toBeGreaterThan(ROLE_RANK.member);
  });

  it("matches the descending order MARFA_ROLES is declared in", () => {
    const ranks = MARFA_ROLES.map((r) => ROLE_RANK[r]);
    expect(ranks).toEqual([...ranks].sort((a, b) => b - a));
  });
});

describe("canGrantRole", () => {
  it("permits granting a role at or below the granter's own", () => {
    expect(canGrantRole("admin", "admin")).toBe(true);
    expect(canGrantRole("admin", "space_admin")).toBe(true);
    expect(canGrantRole("admin", "member")).toBe(true);
    expect(canGrantRole("space_admin", "space_admin")).toBe(true);
    expect(canGrantRole("space_admin", "member")).toBe(true);
    expect(canGrantRole("member", "member")).toBe(true);
  });

  it("refuses granting a role above the granter's own", () => {
    expect(canGrantRole("space_admin", "admin")).toBe(false);
    expect(canGrantRole("member", "admin")).toBe(false);
    expect(canGrantRole("member", "space_admin")).toBe(false);
  });
});

describe("isMarfaRole", () => {
  it("accepts every declared role", () => {
    for (const role of MARFA_ROLES) {
      expect(isMarfaRole(role)).toBe(true);
    }
  });

  it("refuses a retired role rather than translating it", () => {
    // `tenant_admin` and `workspace_admin` were both this column's value
    // once. Recognizing either here would keep a retired word working and
    // hide a database that was never migrated, which is exactly how one of
    // them survived a rename and locked every account holder out.
    expect(isMarfaRole("tenant_admin")).toBe(false);
    expect(isMarfaRole("workspace_admin")).toBe(false);
  });

  it("refuses values that are not strings at all", () => {
    for (const value of [undefined, null, 0, 1, {}, [], true]) {
      expect(isMarfaRole(value)).toBe(false);
    }
  });
});

describe("parseMarfaRole", () => {
  it("returns a recognized role unchanged", () => {
    for (const role of MARFA_ROLES) {
      expect(parseMarfaRole(role)).toBe(role);
    }
  });

  it("falls back to the least authority by default", () => {
    expect(parseMarfaRole("tenant_admin")).toBe("member");
    expect(parseMarfaRole(undefined)).toBe("member");
  });

  it("honors an explicit fallback", () => {
    expect(parseMarfaRole("tenant_admin", "space_admin")).toBe("space_admin");
  });

  it("never throws, because callers are row projections", () => {
    // A parse that threw would take out every list query touching one bad
    // row, turning a single mis-migrated record into an outage.
    expect(() => parseMarfaRole(Symbol("nope"))).not.toThrow();
  });

  it("produces a role every rank lookup can answer", () => {
    // The failure this guards is not a refusal but a silent `undefined`:
    // `ROLE_RANK[stale]` is undefined, and `undefined < 2` is false, so a
    // rank comparison admits what it meant to refuse.
    expect(ROLE_RANK[parseMarfaRole("tenant_admin")]).toBeTypeOf("number");
    expect(canGrantRole(parseMarfaRole("tenant_admin"), "member")).toBe(true);
  });
});
