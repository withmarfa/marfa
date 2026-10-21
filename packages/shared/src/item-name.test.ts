import { expect, it } from "vitest";
import { ALL_TYPES } from "./type-registry.js";
import { itemName } from "./item-name.js";

it("names every built-in type through its display hints", () => {
  const fields: Record<string, string> = {
    "core.bookmark": "title",
    "core.entity": "name",
    "core.entity.person": "name",
    "core.entity.place": "name",
    "core.event": "title",
    "core.file": "title",
    "core.file.audio": "title",
    "core.file.image": "title",
    "core.file.video": "title",
    "core.highlight": "text",
    "core.media": "title",
    "core.media.album": "title",
    "core.media.article": "title",
    "core.media.book": "title",
    "core.media.episode": "title",
    "core.media.film": "title",
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
