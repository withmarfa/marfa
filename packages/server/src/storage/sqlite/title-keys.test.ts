import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  MAX_NAME_UNITS,
  foldName,
  titleFieldIn,
  titleKeyFrom,
  trimName,
} from "./title-keys.js";

interface Shared {
  cases: { about: string; name: string; folded: string }[];
}

// The cases the core's `names::folded` is held to in
// `core/marfa-core/src/names.rs`, so the two cannot drift: a title key the
// server writes has to be the one the core asks for.
const SHARED = JSON.parse(
  readFileSync(
    new URL(
      "../../../../../conformance/fixtures/name-fold.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as Shared;

describe("the fold of a name", () => {
  it.each(SHARED.cases)("folds $about as the core does", ({ name, folded }) => {
    expect(foldName(name)).toBe(folded);
  });

  it("trims what Unicode calls white space and nothing else", () => {
    expect(trimName("\u0085\u00a0\u2028 a b \u3000")).toBe("a b");
    const edge = "\ufeff\u200ba\u200b\ufeff";
    expect(trimName(edge)).toBe(edge);
    expect(trimName("   ")).toBe("");
  });

  it("trims a long run of white space in one pass", () => {
    const run = " ".repeat(200_000);
    expect(trimName(`${run}a${run}b${run}`)).toBe(`a${run}b`);
  });
});

describe("the property a type is titled by", () => {
  const types: Record<
    string,
    { parent?: string; display_hints?: { title_field?: string } }
  > = {
    "user.base": { display_hints: { title_field: "name" } },
    "user.child": { parent: "user.base" },
    "user.own": {
      parent: "user.base",
      display_hints: { title_field: "label" },
    },
    "user.plain": {},
    "user.orphan": { parent: "user.gone" },
    "user.loop-a": { parent: "user.loop-b" },
    "user.loop-b": { parent: "user.loop-a" },
  };
  const lookup = (id: string) => types[id];

  it.each([
    ["user.base", "name"],
    ["user.child", "name"],
    ["user.own", "label"],
    ["user.plain", "title"],
    ["user.orphan", "title"],
    ["user.loop-a", "title"],
    ["user.unregistered", "title"],
  ])("titles %s by %s", (type, field) => {
    expect(titleFieldIn(type, lookup)).toBe(field);
  });
});

describe("the key of an item", () => {
  it("is the folded title, and none for a system type or a title with no text", () => {
    expect(titleKeyFrom("core.note", "title", { title: " Ada " })).toBe("ada");
    expect(titleKeyFrom("system.connection", "title", { title: "Ada" })).toBe(
      null,
    );
    expect(titleKeyFrom("core.note", "title", { title: 4 })).toBe(null);
    expect(titleKeyFrom("core.note", "title", { title: "\u00a0" })).toBe(null);
    expect(titleKeyFrom("core.note", "title", {})).toBe(null);
    expect(titleKeyFrom("core.note", "name", { title: "Ada" })).toBe(null);
  });

  it("is none for a title past the cap, counted without the white space around it", () => {
    const at = "z".repeat(MAX_NAME_UNITS);
    expect(titleKeyFrom("core.note", "title", { title: ` ${at} ` })).toBe(at);
    expect(titleKeyFrom("core.note", "title", { title: `${at}z` })).toBe(null);
  });
});
