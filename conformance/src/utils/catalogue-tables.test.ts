import { describe, expect, it } from "vitest";
import {
  edgeTypesTable,
  eventTypesTable,
  permissionsTable,
  renderTable,
  tableEnd,
  tableStart,
  typesTable,
  withTable,
  type EdgeTypeRow,
  type TypeRow,
} from "./catalogue-tables.js";

const ENTITY: TypeRow = {
  id: "core.entity",
  family: "core",
  required: ["name"],
  description: "A non-person entity — a company, band.",
};
const PERSON: TypeRow = {
  id: "core.entity.person",
  family: "core",
  parent: "core.entity",
  required: ["name"],
};
const FOLDER: TypeRow = {
  id: "system.folder",
  family: "system",
  required: [],
  description: "Bounded to active | revoked.",
};

describe("the table of shipped types", () => {
  it("lists core types before system types, each by identifier", () => {
    const table = typesTable([FOLDER, PERSON, ENTITY]);
    const ids = table.split("\n").map((line) => line.split("|")[1]?.trim());
    expect(ids.slice(2)).toEqual([
      "`core.entity`",
      "`core.entity.person`",
      "`system.folder`",
    ]);
  });

  it("names a missing parent, required property or description as None", () => {
    const row = typesTable([FOLDER]).split("\n")[2] ?? "";
    expect(row).toMatch(/\| None\s+\| None\s+\|/);
    expect(typesTable([PERSON]).split("\n")[2]).toMatch(/\| None\s+\|$/);
  });

  it("writes the source's em dash as a colon and escapes a pipe", () => {
    const table = typesTable([ENTITY, FOLDER]);
    expect(table).not.toContain("—");
    expect(table).toContain("A non-person entity: a company, band.");
    expect(table).toContain("active \\| revoked");
  });
});

describe("the table of shipped edge types", () => {
  const PARENT: EdgeTypeRow = {
    id: "parent-of",
    reverseName: "child-of",
    cardinality: "one-to-many",
    cascadeOnDelete: "cascade",
    sourceTypes: ["*"],
    targetTypes: ["*"],
  };
  const CONTAINED: EdgeTypeRow = {
    id: "in-collection",
    cardinality: "many-to-many",
    cascadeOnDelete: "orphan",
    sourceTypes: ["core.note", "core.task"],
    targetTypes: ["role:container"],
  };

  it("says what each end may be and what a delete does", () => {
    const [, , ...rows] = edgeTypesTable([PARENT, CONTAINED]).split("\n");
    expect(rows[0]).toContain("`in-collection`");
    expect(rows[0]).toContain("`core.note`, `core.task`");
    expect(rows[0]).toContain("Any type with the role `container`");
    expect(rows[0]).toContain("| None ");
    expect(rows[1]).toContain("`child-of`");
    expect(rows[1]).toContain("cascade");
    expect(rows[1]).toContain("Any type");
  });
});

describe("the table of permissions", () => {
  it("refuses a list that differs from the wording it holds, in either direction", () => {
    const all = permissionsTable([
      "audit.read",
      "blobs.manage",
      "config.manage",
      "connectors.manage",
      "grants.manage",
      "instance.maintain",
      "instance.read",
      "items.purge",
      "keys.manage",
      "keys.mint",
      "schema.write",
      "webhooks.manage",
    ]);
    expect(all.split("\n")).toHaveLength(14);
    expect(() => permissionsTable(["audit.read"])).toThrow(
      /wording for no permission/,
    );
    expect(() => permissionsTable(["audit.read", "new.thing"])).toThrow(
      /no wording for \["new.thing"\]/,
    );
  });
});

describe("the table of event types", () => {
  it("marks the events a webhook may name and refuses a name it has no wording for", () => {
    expect(() =>
      eventTypesTable([{ name: "item.new", webhook: true }]),
    ).toThrow(/no wording for \["item.new"\]/);
    expect(() =>
      eventTypesTable([{ name: "item.created", webhook: true }]),
    ).toThrow(/wording for no event/);
  });
});

describe("a table in a chapter", () => {
  const table = renderTable(["A", "B"], [["x", "y"]]);

  it("replaces what sits between its markers and nothing else", () => {
    const chapter = `# T\n\n${tableStart("types")}\nold\n${tableEnd("types")}\n\n${tableStart("permissions")}\nkept\n${tableEnd("permissions")}\n`;
    const written = withTable(chapter, "types", table);
    expect(written).toContain(`${tableStart("types")}\n\n${table}\n\n`);
    expect(written).not.toContain("old");
    expect(written).toContain("kept");
    expect(withTable(written, "types", table)).toBe(written);
  });

  it("refuses a chapter without the markers, or with them out of order", () => {
    expect(() => withTable("# T\n", "types", table)).toThrow(/needs/);
    expect(() =>
      withTable(`${tableEnd("types")}\n${tableStart("types")}`, "types", table),
    ).toThrow(/needs/);
  });
});
