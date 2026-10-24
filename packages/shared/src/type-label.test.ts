import { expect, it } from "vitest";
import { labelFromId, labelledTypeDefinition } from "./type-label.js";

// The same table as `LABELS` in core/marfa-core/src/wire.rs.
const LABELS: [string, string][] = [
  ["acme.list-member", "List Member"],
  ["parent-of", "Parent Of"],
  ["about", "About"],
  ["a.b.snake_case_name", "Snake Case Name"],
  ["acme.2nd-pass", "2nd Pass"],
  ["acme.v2--draft", "V2  Draft"],
];

it.each(LABELS)("makes the label of %s", (id, label) => {
  expect(labelFromId(id)).toBe(label);
});

it("labels a definition that names none or an empty one, and keeps a label it names", () => {
  expect(
    labelledTypeDefinition<{ id: string; label?: string }>({
      id: "acme.list-member",
    }).label,
  ).toBe("List Member");
  expect(
    labelledTypeDefinition({ id: "acme.list-member", label: "" }).label,
  ).toBe("List Member");
  expect(
    labelledTypeDefinition({ id: "acme.list-member", label: "Members" }).label,
  ).toBe("Members");
});
