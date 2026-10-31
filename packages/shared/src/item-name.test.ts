import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { ALL_TYPES } from "./type-registry.js";
import { itemName } from "./item-name.js";

interface DisplayHints {
  title_field?: string;
  body_field?: string;
}

interface Shared {
  types: { id: string; parent?: string; display_hints?: DisplayHints }[];
  cases: {
    description: string;
    type: string;
    properties: Record<string, unknown>;
    name: string | null;
  }[];
}

// The cases the core's own name is held to, so the two cannot drift.
const SHARED = JSON.parse(
  readFileSync(
    new URL("../../../conformance/fixtures/item-display.json", import.meta.url),
    "utf8",
  ),
) as Shared;

it("names every built-in type through its display hints", () => {
  const fields: Record<string, string> = {
    "core.bookmark": "title",
    "core.collection": "title",
    "core.entity": "name",
    "core.entity.person": "name",
    "core.entity.place": "name",
    "core.event": "title",
    "core.file": "title",
    "core.file.audio": "title",
    "core.file.image": "title",
    "core.file.video": "title",
    "core.file.webpage": "title",
    "core.highlight": "text",
    "core.media": "title",
    "core.media.album": "title",
    "core.media.article": "title",
    "core.media.book": "title",
    "core.media.episode": "title",
    "core.media.film": "title",
    "core.media.game": "title",
    "core.media.series": "title",
    "core.media.song": "title",
    "core.message": "body",
    "core.note": "title",
    "core.task": "title",
  };
  expect(Object.keys(fields).sort()).toEqual(ALL_TYPES.map((t) => t.id).sort());
  for (const type of ALL_TYPES) {
    expect(
      itemName(
        { [fields[type.id]!]: "  A name\nPrivate second line" },
        type.display_hints,
      ),
      type.id,
    ).toBe("A name");
  }
});

it("uses custom hints and a bounded fallback with blank or untidy input", () => {
  expect(
    itemName(
      { heading: " Custom ", title: "Other" },
      { title_field: "heading" },
    ),
  ).toBe("Custom");
  expect(
    itemName(
      { heading: "\r\n \t", text: "\n First\t line \r\nSecret" },
      { title_field: "heading" },
    ),
  ).toBe("First line");
  expect(itemName({ body: "\nBody name\nSecret" })).toBe("Body name");
  expect(
    itemName({ title: {}, name: 17, body: [], filename: " document.pdf " }),
  ).toBe("document.pdf");
  expect(itemName({ url: "https://example.test/" })).toBe(
    "https://example.test/",
  );
  expect(itemName({ title: "  " })).toBe("Untitled");
  expect(itemName({ title: "😀".repeat(121) })).toBe("😀".repeat(119) + "…");
});

it("names every case the core is held to as the core does, and Untitled where the core answers none", () => {
  const types = new Map<
    string,
    { parent?: string; display_hints?: DisplayHints }
  >([...ALL_TYPES, ...SHARED.types].map((type) => [type.id, type]));
  // Each hint from the nearest type in the chain that declares it.
  const nearest = (id: string, hint: keyof DisplayHints) => {
    for (let at = types.get(id); at; at = types.get(at.parent ?? "")) {
      const value = at.display_hints?.[hint];
      if (value !== undefined) return value;
    }
    return undefined;
  };
  expect(SHARED.cases.length).toBeGreaterThan(0);
  for (const { description, type, properties, name } of SHARED.cases) {
    const hints: DisplayHints = {};
    const title = nearest(type, "title_field");
    const body = nearest(type, "body_field");
    if (title !== undefined) hints.title_field = title;
    if (body !== undefined) hints.body_field = body;
    expect(itemName(properties, hints), description).toBe(name ?? "Untitled");
  }
});
