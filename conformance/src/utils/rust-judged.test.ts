import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  missingJudged,
  RUST_JUDGED,
  withoutRustJudged,
} from "./rust-judged.js";

const ROOT = resolve(import.meta.dirname, "..", "..");
const SERVER_PROJECTS = ["correctness", "compliance", "sync", "device", "cli"];

describe("the files the Rust server judges", () => {
  it("are each a server fixture that exists, once", () => {
    expect(missingJudged(ROOT)).toEqual([]);
    expect(new Set(RUST_JUDGED).size).toBe(RUST_JUDGED.length);
    for (const path of RUST_JUDGED) {
      const [, , project = ""] = path.split("/");
      expect(path, path).toMatch(/^src\/suites\/[a-z]+\/.+\.test\.ts$/);
      expect(path, path).not.toMatch(/\.decision\.test\.ts$/);
      expect(SERVER_PROJECTS, path).toContain(project);
    }
  });

  describe("as a listed path is read", () => {
    const directory = mkdtempSync(join(tmpdir(), "marfa-rust-judged-"));
    afterAll(() => rmSync(directory, { recursive: true, force: true }));
    const present = "src/suites/compliance/present.test.ts";
    mkdirSync(dirname(join(directory, present)), { recursive: true });
    writeFileSync(join(directory, present), "export {};\n");
    const absent = "src/suites/compliance/absent.test.ts";

    it("is missing when no file has the path, and only then", () => {
      expect(missingJudged(directory, [present])).toEqual([]);
      expect(missingJudged(directory, [present, absent])).toEqual([absent]);
    });

    it("is left out of a run against the TypeScript server and kept in a run against another program", () => {
      const judged = [present, absent];
      expect(withoutRustJudged({}, judged)).toEqual(judged);
      expect(withoutRustJudged({ MARFA_SERVER_BIN: "" }, judged)).toEqual(
        judged,
      );
      expect(
        withoutRustJudged({ MARFA_SERVER_BIN: "/opt/marfa-server" }, judged),
      ).toEqual([]);
    });
  });
});
