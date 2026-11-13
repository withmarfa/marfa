import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

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

/** Rows the server titles that neither the glossary nor the CLI names yet. */
const NOT_YET_IN_GLOSSARY = ["core.*"];

/**
 * The words the server's approval pages use, read from the source that holds
 * them: the title of each level, of each named power and of each row that is
 * not one item type, keyed as the glossary keys them.
 */
function serverWords(): {
  levels: Map<string, string>;
  powers: Map<string, string>;
  rows: Map<string, string>;
} {
  const source = readFileSync(
    new URL("../core/marfa-server/src/http/pages/words.rs", import.meta.url),
    "utf8",
  );
  const levels = new Map(
    Array.from(
      source.matchAll(/Level::(None|Read|Write) => "([^"]*)"/g),
      (match): [string, string] => [match[1]!.toLowerCase(), match[2]!],
    ),
  );
  const powers = new Map(
    Array.from(
      source.matchAll(/\(\s*"([a-z.]+)",\s*PowerWords \{\s*title: "([^"]*)"/g),
      (match): [string, string] => [match[1]!, match[2]!],
    ),
  );
  const rows = new Map(
    Array.from(
      source.matchAll(/\(Reach::\w+, ("[^"]*"|_)\) => Some\("([^"]*)"\)/g),
      (match): [string, string] => [
        match[1] === "_" ? "content" : match[1]!.slice(1, -1),
        match[2]!,
      ],
    ),
  );
  return { levels, powers, rows };
}

describe("the words access is read in", () => {
  const glossary = glossaryTables();

  it("are three levels and twelve powers in the glossary", () => {
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
    const server = serverWords();
    expect(server.levels).toHaveLength(3);
    expect(server.powers).toHaveLength(12);
    expect(glossary.levels).toEqual(
      glossary.levels.map(([level]) => [level, server.levels.get(level)]),
    );
    expect(glossary.rows).toEqual(
      glossary.rows.map(([pattern]) => [pattern, server.rows.get(pattern)]),
    );
    expect(glossary.powers).toEqual(
      glossary.powers.map(([permission]) => [
        permission,
        server.powers.get(permission),
      ]),
    );
  });

  it("name every row the server titles apart from an item type", () => {
    const named = new Set(glossary.rows.map(([pattern]) => pattern));
    expect(
      [...serverWords().rows.keys()].filter((pattern) => !named.has(pattern)),
    ).toEqual(NOT_YET_IN_GLOSSARY);
  });
});
