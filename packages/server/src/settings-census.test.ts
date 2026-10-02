import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { SETTING_NAMES } from "./config.js";

const SRC = resolve(import.meta.dirname);
const REPO = resolve(SRC, "../../..");

/**
 * The files outside `config.ts` that may touch the environment, and why.
 * None of them is the server: each is a test that switches itself on or
 * runs itself under another zone.
 */
const ENVIRONMENT_EXCEPTIONS: Record<string, string> = {
  "enrichment/ocr.real.test.ts":
    "opts into downloading the real OCR model, a test's own switch",
  "enrichment/extract.test.ts":
    "opts into downloading the real OCR model, a test's own switch",
  "events/expand-recurrence.test.ts": "runs under another TZ",
};

/** Names in the docs that look like settings and are not the server's. */
const NOT_SERVER_SETTINGS: Record<string, string> = {
  MARFA_FOLDER_REGISTRY: "the device's folder registry, read by the binary",
  MARFA_API_KEY: "the credential a client or the conformance run holds",
};

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

/** Whether the file's code, comments and strings aside, reads `process.env`. */
function readsEnvironment(text: string): boolean {
  const file = ts.createSourceFile("x.ts", text, ts.ScriptTarget.Latest);
  const isProcess = (node: ts.Node) =>
    (ts.isIdentifier(node) && node.text === "process") ||
    (ts.isPropertyAccessExpression(node) && node.name.text === "process");
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (
      (ts.isPropertyAccessExpression(node) &&
        isProcess(node.expression) &&
        node.name.text === "env") ||
      (ts.isElementAccessExpression(node) &&
        isProcess(node.expression) &&
        ts.isStringLiteralLike(node.argumentExpression) &&
        node.argumentExpression.text === "env") ||
      (ts.isVariableDeclaration(node) &&
        ts.isObjectBindingPattern(node.name) &&
        node.initializer !== undefined &&
        isProcess(node.initializer)) ||
      ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier !== undefined &&
        ts.isStringLiteral(node.moduleSpecifier) &&
        /^(node:)?process$/.test(node.moduleSpecifier.text))
    ) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

describe("the settings census", () => {
  it("reads the environment in config.ts and nowhere else in the server", () => {
    const readers = sourceFiles(SRC)
      .filter((file) => readsEnvironment(readFileSync(file, "utf8")))
      .map((file) => relative(SRC, file));
    // The witness: the scanner finds the one module that does read it.
    expect(readers).toContain("config.ts");
    expect(readers.filter((f) => f !== "config.ts").sort()).toEqual(
      Object.keys(ENVIRONMENT_EXCEPTIONS).sort(),
    );
  });

  it("finds a read however it is spelled", () => {
    for (const spelling of [
      "const a = process.env.X;",
      'const a = process["env"];',
      "const { env } = process;",
      "const a = globalThis.process.env.X;",
      'import { env } from "node:process";',
    ]) {
      expect(readsEnvironment(spelling), spelling).toBe(true);
    }
    expect(readsEnvironment("// process.env.X\nconst a = 1;")).toBe(false);
  });

  it("lists every setting in .env.example, and nothing else", () => {
    const text = readFileSync(join(REPO, ".env.example"), "utf8");
    const named = [...text.matchAll(/^#?\s*([A-Z][A-Z0-9_]*)=/gm)].map(
      (m) => m[1],
    );
    expect(new Set(named).size, "a name listed twice").toBe(named.length);
    expect([...named].sort()).toEqual([...SETTING_NAMES].sort());
  });

  it("has every setting the docs name", () => {
    const specDir = join(REPO, "conformance/spec");
    const docs = [
      "README.md",
      "AGENTS.md",
      "deploy/README.md",
      ...readdirSync(specDir)
        .filter((f) => f.endsWith(".md"))
        .map((f) => `conformance/spec/${f}`),
    ];
    const promised = new Set<string>();
    for (const doc of docs) {
      const text = readFileSync(join(REPO, doc), "utf8");
      for (const m of text.matchAll(
        /`([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)(=[^`]*)?`/g,
      )) {
        promised.add(m[1] ?? "");
      }
    }
    // The witness: the docs do name settings.
    expect(promised).toContain("MARFA_AUTH_SECRET");
    const missing = [...promised].filter(
      (name) => !SETTING_NAMES.includes(name) && !(name in NOT_SERVER_SETTINGS),
    );
    expect(missing).toEqual([]);
  });
});
