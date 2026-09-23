import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { unreadTopLevelKeys } from "./schema-validation.js";

const typesRoot = resolve(import.meta.dirname, "..");

function filesIn(dir: string): { file: string; data: unknown }[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((file) => ({
      file,
      data: JSON.parse(readFileSync(join(dir, file), "utf-8")) as unknown,
    }));
}

const fieldsOf = (issues: { field: string }[]) => issues.map((i) => i.field);

describe("unreadTopLevelKeys", () => {
  const type = {
    id: "user.recipe",
    version: 1,
    fields: { title: { type: "string" } },
    required: ["title"],
  };
  const edge = { id: "cites", cardinality: "many-to-many" };

  it("passes a type schema carrying only keys the validator reads", () => {
    expect(unreadTopLevelKeys(type, "type")).toEqual([]);
  });

  it("refuses a top-level key the type validator does not read", () => {
    expect(
      fieldsOf(unreadTopLevelKeys({ ...type, _deferred: true }, "type")),
    ).toEqual(["_deferred"]);
  });

  it("passes an edge schema carrying only keys the validator reads", () => {
    expect(unreadTopLevelKeys(edge, "edge")).toEqual([]);
  });

  it("refuses a top-level key the edge validator does not read", () => {
    // `fields` is a type schema's key, not an edge schema's.
    expect(
      fieldsOf(unreadTopLevelKeys({ ...edge, fields: {} }, "edge")),
    ).toEqual(["fields"]);
  });

  it("finds no unread key in any in-tree file", () => {
    const families: { dir: string; kind: "type" | "edge" }[] = [
      { dir: join(typesRoot, "core"), kind: "type" },
      { dir: join(typesRoot, "connectors"), kind: "type" },
      { dir: join(typesRoot, "core", "system"), kind: "type" },
      { dir: join(typesRoot, "core", "edges"), kind: "edge" },
    ];
    for (const { dir, kind } of families) {
      const files = filesIn(dir);
      expect(files.length, dir).toBeGreaterThan(0);
      for (const { file, data } of files) {
        expect(fieldsOf(unreadTopLevelKeys(data, kind)), file).toEqual([]);
      }
    }
  });
});
