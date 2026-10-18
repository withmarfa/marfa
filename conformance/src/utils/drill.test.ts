/**
 * The restore drill's pure piece and the replica line it relies on, held
 * here because the drill itself runs only in its own job: the comparison
 * must be able to say "different", and the shipped Litestream configuration
 * must keep the replica under the prefix the drill sets, or the drill would
 * replicate beside another instance's replica.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { same } from "./drill.js";

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

describe("the shipped Litestream configuration", () => {
  it("keeps the one replica at db under the server's own S3_PREFIX", () => {
    const replicaPaths = readFileSync(SHIPPED, "utf8")
      .split("\n")
      .filter((line) => /^\s+path: /.test(line))
      .map((line) => line.trim());
    expect(replicaPaths).toEqual(["path: ${S3_PREFIX}/db"]);
  });
});
