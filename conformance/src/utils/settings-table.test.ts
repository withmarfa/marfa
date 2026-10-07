import { describe, expect, it } from "vitest";
import {
  TABLE_END,
  TABLE_START,
  allowedValues,
  defaultText,
  renderTable,
  withSettingsTable,
  type SettingRow,
} from "./settings-table.js";

const PORT: SettingRow = {
  name: "PORT",
  rule: { kind: "count", min: 1, max: 65_535 },
  default: 8600,
  description: "The port the server listens on.",
};
const WAIT: SettingRow = {
  name: "WAIT_MS",
  rule: { kind: "count", min: 0, unit: "ms" },
  default: 5000,
  description: "How long a write waits.",
};
const SALT: SettingRow = {
  name: "SALT",
  rule: { kind: "secret" },
  defaultNote: "None. Required in production.",
  description: "The salt.",
};

describe("the settings table", () => {
  it("states a bounded and an unbounded whole number in words", () => {
    expect(allowedValues(PORT.rule)).toBe("Whole number, 1 to 65535");
    expect(allowedValues(WAIT.rule)).toBe(
      "Whole number of milliseconds, 0 or more",
    );
  });

  it("states a default with its unit, and no default as None", () => {
    expect(defaultText(WAIT)).toBe("`5000` ms");
    expect(
      defaultText({ ...PORT, default: undefined, rule: { kind: "text" } }),
    ).toBe("None");
  });

  it("states no value for a secret, only the note", () => {
    expect(defaultText(SALT)).toBe("None. Required in production.");
  });

  it("pads every column to its widest cell, as Prettier does", () => {
    const lines = renderTable([PORT, WAIT]).split("\n");
    expect(lines).toHaveLength(4);
    expect(new Set(lines.map((line) => line.length)).size).toBe(1);
    expect(lines[1]).toMatch(/^\| -+ \| -+ \| -+ \| -+ \|$/);
  });

  it("escapes a pipe so it stays inside its cell", () => {
    const table = renderTable([{ ...PORT, description: "A | B." }]);
    expect(table).toContain("A \\| B.");
  });

  it("replaces what sits between the markers and nothing else", () => {
    const chapter = `# Chapter\n\nBefore.\n\n${TABLE_START}\n\nstale\n\n${TABLE_END}\n\nAfter.\n`;
    const written = withSettingsTable(chapter, [PORT]);
    expect(written).toContain("`PORT`");
    expect(written).not.toContain("stale");
    expect(written.startsWith("# Chapter\n\nBefore.\n\n")).toBe(true);
    expect(written.endsWith(`${TABLE_END}\n\nAfter.\n`)).toBe(true);
    expect(withSettingsTable(written, [PORT])).toBe(written);
  });

  it("refuses a chapter that has no place for the table", () => {
    expect(() => withSettingsTable("# Chapter\n", [PORT])).toThrow(TABLE_START);
    expect(() =>
      withSettingsTable(`${TABLE_END}\n${TABLE_START}\n`, [PORT]),
    ).toThrow(TABLE_END);
  });
});
