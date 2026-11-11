/**
 * The restore drill's pure piece, held here because the drill itself runs
 * only in its own job: the comparison must be able to say "different".
 */
import { describe, it, expect } from "vitest";
import { same } from "./drill.js";

describe("same", () => {
  it("tells same from different, for the values the drill compares", () => {
    expect(same("a", "a")).toBe(true);
    expect(same("a", "b")).toBe(false);
    expect(same(22, 22)).toBe(true);
    expect(same(22, 33)).toBe(false);
    expect(same({ x: "1", y: "2" }, { x: "1", y: "2" })).toBe(true);
    expect(same({ x: "1", y: "2" }, { x: "1", y: "3" })).toBe(false);
    expect(same({ x: "1" }, { x: "1", y: "2" })).toBe(false);
  });
});
