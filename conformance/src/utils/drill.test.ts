/**
 * The restore drill's pure pieces, held here because the drill itself runs
 * only in its own job: the comparison must be able to say "different", and
 * the shipped Litestream configuration must have the line the drill moves,
 * or the drill would replicate beside a deployment's own replica.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { moveReplicaPath, same } from "./drill.js";

const SHIPPED = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "deploy",
  "litestream.yml",
);

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

describe("moveReplicaPath", () => {
  it("moves the shipped file's replica under the drill's prefix and nothing else", () => {
    const shipped = readFileSync(SHIPPED, "utf8");
    const moved = moveReplicaPath(shipped, "drill/abcd1234");
    expect(moved).toContain("path: drill/abcd1234/db");
    expect(moved).not.toMatch(/^\s*path: db$/m);
    // The one line, and only that line: the file otherwise reads the same.
    const changed = shipped
      .split("\n")
      .filter((line, i) => line !== moved.split("\n")[i]);
    expect(changed).toEqual([changed.find((l) => l.trim() === "path: db")]);
    expect(moved).toContain("path: ${SQLITE_PATH}");
  });

  it("refuses a file without the line it moves", () => {
    expect(() => moveReplicaPath("dbs:\n  - path: x\n", "drill/x")).toThrow(
      "no replica line",
    );
  });
});
