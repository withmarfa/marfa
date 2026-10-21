import { describe, expect, it } from "vitest";
import { scopesAreNarrower } from "./consent-scopes.js";

describe("the owner grant ceiling", () => {
  it.each([
    [["core.*:write"], ["core.note:read"], true],
    [["core.note:read"], ["core.note:write"], false],
    [["edge.*:write"], ["edge.user.related:read"], true],
    [["metadata:write"], ["metadata.types:read"], true],
    [["profile:write"], ["profile.name:read"], true],
    [["profile:write"], ["profile.email:write"], false],
    [["keys.manage", "audit.read"], ["audit.read"], true],
    [["email", "openid"], ["openid"], true],
    [["content:write"], ["core.note:read"], true],
    [["content:write"], ["*:read"], false],
    [["*:write", "core.*:read"], ["*:write"], false],
    [["*:write", "core.*:read"], ["*:write", "core.*:read"], true],
    [["edge.*:write", "edge.user.*:read"], ["edge.*:write"], false],
    [["core.note:write"], [], true],
    [["core.note:write"], ["unknown:scope"], false],
  ] as const)("compares %j to %j", (held, wanted, expected) => {
    expect(scopesAreNarrower(held, wanted)).toBe(expected);
  });
});
