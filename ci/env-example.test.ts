/**
 * `.env.example` names the server's start-only settings, the ones the
 * contract tables under "Start-only settings", and nothing else. The server's
 * own tests hold that table to the settings it declares, so a setting added,
 * renamed or dropped there reaches this file through the table.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");

/** The setting names a settings file lists, commented out or not. */
function listed(text: string): string[] {
  return [...text.matchAll(/^#?\s*([A-Z][A-Z0-9_]*)=/gm)].map(
    (match) => match[1] ?? "",
  );
}

/** The names in the first column of the start-only settings table. */
function tabled(instance: string): string[] {
  const section = instance
    .split("\n## Start-only settings\n")[1]
    ?.split("\n## ")[0];
  return [...(section ?? "").matchAll(/^\| `([A-Z][A-Z0-9_]*)`/gm)].map(
    (match) => match[1] ?? "",
  );
}

describe(".env.example", () => {
  const instance = readFileSync(
    resolve(root, "conformance/spec/instance.md"),
    "utf8",
  );
  const example = readFileSync(resolve(root, ".env.example"), "utf8");

  it("lists every start-only setting the contract tables, each once, and nothing else", () => {
    const names = listed(example);
    // The witness: both readers find settings, so an empty answer below
    // would mean neither did.
    expect(tabled(instance)).toContain("MARFA_PORT");
    expect(names).toContain("MARFA_PORT");
    expect(new Set(names).size, "a name listed twice").toBe(names.length);
    expect([...names].sort()).toEqual([...tabled(instance)].sort());
  });

  it("is held to the table by a name missing, a name added and a name listed twice", () => {
    const table = tabled(instance);
    const without = listed(example.replace(/^# MARFA_PORT=.*$/m, ""));
    expect([...without].sort()).not.toEqual([...table].sort());
    const extra = listed(`${example}\n# MARFA_UNHEARD_OF=1\n`);
    expect([...extra].sort()).not.toEqual([...table].sort());
    const twice = listed(`${example}\n# MARFA_PORT=1\n`);
    expect(new Set(twice).size).not.toBe(twice.length);
  });
});
