import { expect, it } from "vitest";
import {
  labelFromId,
  labelledTypeDefinition,
  pluralFromLabel,
  pluralOf,
  withFieldLabels,
} from "./type-label.js";

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

// The same table as `PLURALS` in core/marfa-core/src/wire.rs.
const PLURALS: [string, string][] = [
  ["Note", "Notes"],
  ["Story", "Stories"],
  ["Day", "Days"],
  ["Box", "Boxes"],
  ["Church", "Churches"],
  ["Wish", "Wishes"],
  ["Address", "Addresses"],
  ["Quiz", "Quizes"],
  ["URL", "URLs"],
  ["Contact Entry", "Contact Entries"],
];

it.each(PLURALS)("makes the plural of %j", (label, plural) => {
  expect(pluralFromLabel(label)).toBe(plural);
});

it("answers the plural of a type's label unless it names one", () => {
  expect(pluralOf({ id: "acme.story" })).toBe("Stories");
  expect(pluralOf({ id: "acme.story", label: "Tale", plural: "" })).toBe(
    "Tales",
  );
  expect(pluralOf({ id: "acme.person", plural: "People" })).toBe("People");
});

it("leaves a definition's plural as it names it", () => {
  const schema: { id: string; label?: string; plural?: string } = {
    id: "acme.story",
  };
  expect(labelledTypeDefinition(schema)).toEqual({
    id: "acme.story",
    label: "Story",
  });
});

it("answers a label for every field and member, its own first", () => {
  const fields = withFieldLabels({
    due_at: { type: "datetime" },
    website: { type: "url", label: "Web Address" },
    contacts: {
      type: "array",
      items_type: "object",
      items_fields: {
        phone_number: { type: "string" },
        kind: { type: "string", label: "Kind" },
      },
    },
  });
  expect(fields).toMatchObject({
    due_at: { label: "Due At" },
    website: { label: "Web Address" },
    contacts: {
      items_fields: {
        phone_number: { label: "Phone Number" },
        kind: { label: "Kind" },
      },
    },
  });
});
