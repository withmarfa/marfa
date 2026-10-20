import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ALL_DATA_TITLE,
  LEVEL_LABELS,
} from "../packages/server/src/routes/access-model.js";
import { PERMISSION_LABELS } from "../packages/server/src/routes/permission-labels.js";
import { SCOPE_LABELS } from "../packages/server/src/routes/scope-copy.js";

/** `[key, words]` pairs from one table of GLOSSARY.md's "Access words" section. */
type Pairs = [string, string][];

function glossaryTables(): { levels: Pairs; rows: Pairs; powers: Pairs } {
  const text = readFileSync(new URL("../GLOSSARY.md", import.meta.url), "utf8");
  const section = /\n### Access words\n([\s\S]*?)\n##/.exec(text)?.[1];
  expect(section, "GLOSSARY.md has an Access words section").toBeDefined();
  const tables: Record<string, Pairs> = {};
  let current: Pairs | undefined;
  for (const line of section!.split("\n")) {
    if (!line.startsWith("|")) {
      current = undefined;
      continue;
    }
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim());
    if (cells.length !== 2 || /^-+$/.test(cells[0]!)) continue;
    if (/^(Level|Row|Power)$/.test(cells[0]!)) {
      current = tables[cells[0]!] = [];
      continue;
    }
    const key = /^`(.+)`$/.exec(cells[0]!)?.[1];
    expect(key, `a code-formatted key in "${line}"`).toBeDefined();
    current?.push([key!, cells[1]!]);
  }
  return {
    levels: tables.Level ?? [],
    rows: tables.Row ?? [],
    powers: tables.Power ?? [],
  };
}

/** `[a, b]` string pairs of a `pub const NAME: [(&str, &str); N] = [...]` in the CLI. */
function cliPairs(name: string): Pairs {
  const source = readFileSync(
    new URL("../core/marfa-cli/src/access.rs", import.meta.url),
    "utf8",
  );
  const body = new RegExp(
    `pub const ${name}: \\[\\(&str, &str\\); \\d+\\] = \\[([\\s\\S]*?)\\];`,
  ).exec(source)?.[1];
  expect(body, `access.rs declares ${name}`).toBeDefined();
  return Array.from(
    body!.matchAll(/\(\s*"([^"]*)"\s*,\s*"([^"]*)"\s*,?\s*\)/g),
    (match): [string, string] => [match[1]!, match[2]!],
  );
}

describe("the words access is read in", () => {
  const glossary = glossaryTables();

  it("are the same in the glossary, the CLI and the server", () => {
    expect(glossary.levels).toHaveLength(3);
    expect(glossary.rows.length).toBeGreaterThan(0);
    expect(glossary.powers).toHaveLength(12);
  });

  it("are the CLI's, character for character", () => {
    expect(cliPairs("LEVELS")).toEqual(glossary.levels);
    expect(cliPairs("ROWS")).toEqual(glossary.rows);
    expect(cliPairs("POWERS")).toEqual(glossary.powers);
  });

  it("are the server's, character for character", () => {
    expect(glossary.levels).toEqual(
      (["none", "read", "write"] as const).map((level) => [
        level,
        LEVEL_LABELS[level],
      ]),
    );
    expect(glossary.rows).toEqual(
      glossary.rows.map(([pattern]) => [
        pattern,
        pattern === "*" ? ALL_DATA_TITLE : SCOPE_LABELS[pattern],
      ]),
    );
    expect(glossary.powers).toEqual(
      glossary.powers.map(([permission]) => [
        permission,
        (PERMISSION_LABELS as Record<string, string>)[permission],
      ]),
    );
  });

  it("name every row the server titles apart from an item type", () => {
    const titled = Object.keys(SCOPE_LABELS).sort();
    expect(
      glossary.rows
        .map(([pattern]) => pattern)
        .filter((pattern) => pattern !== "*")
        .sort(),
    ).toEqual(titled);
  });
});
