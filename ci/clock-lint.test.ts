import { fileURLToPath } from "node:url";
import { ESLint, Linter } from "eslint";
import tseslint from "typescript-eslint";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));

/** What the repository's ESLint configuration says about `path`. */
async function ruleFor(path: string): Promise<unknown> {
  const eslint = new ESLint({ cwd: root });
  const config = (await eslint.calculateConfigForFile(path)) as {
    rules?: Record<string, unknown>;
  };
  return config.rules?.["no-restricted-syntax"];
}

/** The reports `no-restricted-syntax` makes on `code` under the rule `path` gets. */
async function reports(path: string, code: string): Promise<string[]> {
  const rule = await ruleFor(path);
  if (rule === undefined || (Array.isArray(rule) && rule[0] === 0)) return [];
  const messages = new Linter().verify(code, {
    languageOptions: { parser: tseslint.parser },
    rules: { "no-restricted-syntax": rule as never },
  });
  return messages.map((m) => m.message);
}

const SERVER_FILE = "packages/server/src/storage/retention.ts";

describe("the server reads the time through its clock", () => {
  it("refuses Date.now() and an argument-less new Date()", async () => {
    for (const code of [
      "const t = Date.now();",
      "const d = new Date();",
      "const f = Date.now;",
      "const s = new Date().toISOString();",
      "function f(now = new Date()) { return now; }",
      "const s = Date();",
      "const t = globalThis.Date.now();",
      "const d = new globalThis.Date();",
      "const d = globalThis.Date();",
      "const { now } = Date;",
      "const { now: read } = globalThis.Date;",
      "const t = Date['now']();",
    ]) {
      expect(await reports(SERVER_FILE, code), code).not.toEqual([]);
    }
  });

  it("allows a date built from a value, and the clock itself", async () => {
    // The witness: the same file takes the forms the rule must let through,
    // so the refusals above are the rule's.
    for (const code of [
      "const d = new Date(0);",
      "const d = new Date(value);",
      "const t = Date.parse(value);",
      "const t = Date.UTC(2030, 0, 1);",
      "const t = clock.nowMs();",
      "const { UTC } = Date;",
      "const d = new globalThis.Date(0);",
      "const t = globalThis.Date.parse(value);",
      "const { now } = clock;",
    ]) {
      expect(await reports(SERVER_FILE, code), code).toEqual([]);
    }
    expect(
      await reports("packages/server/src/clock.ts", "Date.now();"),
    ).toEqual([]);
  });

  it("leaves a test and the other packages alone", async () => {
    const code = "const t = Date.now();";
    expect(
      await reports("packages/server/src/storage/retention.test.ts", code),
    ).toEqual([]);
    expect(await reports("packages/client/src/client.ts", code)).toEqual([]);
  });
});
