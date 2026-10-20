import { describe, expect, it } from "vitest";
import {
  scopesAwaitingCatchUp,
  scopesCoveredByCeiling,
} from "./ceiling-catchup.js";

describe("scopesCoveredByCeiling", () => {
  it("names the requested scopes a scope the ceiling already holds covers", () => {
    expect(
      scopesCoveredByCeiling(
        ["openid", "*:read"],
        ["core.note:read", "core.task:read", "*:read"],
      ),
    ).toEqual(["core.note:read", "core.task:read"]);
  });

  it("names nothing a ceiling reaches no further than", () => {
    expect(
      scopesCoveredByCeiling(["*:read"], ["core.note:write", "keys.mint"]),
    ).toEqual([]);
    expect(
      scopesCoveredByCeiling(["core.note:read"], ["core.task:read"]),
    ).toEqual([]);
  });

  it("leaves a scope already held alone, and a ceiling that tracks the live set", () => {
    expect(
      scopesCoveredByCeiling(["*:read", "core.note:read"], ["core.note:read"]),
    ).toEqual([]);
    expect(scopesCoveredByCeiling(null, ["core.note:read"])).toEqual([]);
    expect(scopesCoveredByCeiling([], ["core.note:read"])).toEqual([]);
  });

  it("is a different question from the scopes the bundles publish", () => {
    expect(
      scopesAwaitingCatchUp(["*:read"], ["core.note:read"], new Set()),
    ).toEqual([]);
  });
});
