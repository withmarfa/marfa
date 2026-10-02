import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { SETTING_NAMES } from "./config.js";

const SRC = resolve(import.meta.dirname);
const REPO = resolve(SRC, "../../..");

/**
 * The files outside `config.ts` that may touch the environment, and why.
 * None of them is the server: each is a test that switches itself on, runs
 * itself under another zone, or stubs the process.
 */
const ENVIRONMENT_EXCEPTIONS: Record<string, string> = {
  "enrichment/ocr.real.test.ts":
    "opts into downloading the real OCR model, a test's own switch",
  "enrichment/extract.test.ts":
    "opts into downloading the real OCR model, a test's own switch",
  "events/expand-recurrence.test.ts": "runs under another TZ",
  "instrumentation.test.ts":
    "stubs process.exit to watch a bad setting stop the preload",
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

/**
 * The members of `process` a module may touch. Anything else, `env` above
 * all, and any use of `process` that is not one of these members (passed
 * along, aliased, destructured), counts as reaching for the environment.
 */
const PROCESS_MEMBERS = new Set([
  "stdout",
  "stderr",
  "exit",
  "exitCode",
  "on",
  "off",
  "once",
  "cwd",
  "chdir",
  "pid",
  "platform",
  "hrtime",
  "memoryUsage",
  "uptime",
  "nextTick",
]);

const PROCESS_MODULE = /^(node:)?process$/;

/** The names the global object goes by; a bare one is fine, its `process` is not. */
const GLOBAL_OBJECTS = new Set(["globalThis", "global"]);

/** Allowed only as a plain statement: each returns `process` itself. */
const LISTENER_MEMBERS = new Set(["on", "once", "off"]);

/** The member a property or string-keyed element access reads, and off what. */
function memberRead(
  node: ts.Node,
): { object: ts.Expression; member: string } | undefined {
  if (ts.isPropertyAccessExpression(node)) {
    return { object: node.expression, member: node.name.text };
  }
  if (
    ts.isElementAccessExpression(node) &&
    ts.isStringLiteralLike(node.argumentExpression)
  ) {
    return { object: node.expression, member: node.argumentExpression.text };
  }
  return undefined;
}

/** A wrapper that changes nothing about the value: parentheses, a cast, a `!`. */
function isOuterExpression(node: ts.Node): boolean {
  return (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isTypeAssertionExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isSatisfiesExpression(node)
  );
}

function unwrap(node: ts.Expression): ts.Expression {
  let inner = node;
  while (
    ts.isParenthesizedExpression(inner) ||
    ts.isAsExpression(inner) ||
    ts.isTypeAssertionExpression(inner) ||
    ts.isNonNullExpression(inner) ||
    ts.isSatisfiesExpression(inner)
  ) {
    inner = inner.expression;
  }
  return inner;
}

/** Whether a declaration in this scope binds the name `process`. */
function bindsProcess(name: ts.BindingName | undefined): boolean {
  if (name === undefined) return false;
  if (ts.isIdentifier(name)) return name.text === "process";
  return name.elements.some(
    (element) => !ts.isOmittedExpression(element) && bindsProcess(element.name),
  );
}

function declaresProcess(scope: ts.Node): boolean {
  if (ts.isFunctionLike(scope)) {
    return scope.parameters.some((p) => bindsProcess(p.name));
  }
  if (ts.isCatchClause(scope)) {
    return bindsProcess(scope.variableDeclaration?.name);
  }
  if (
    (ts.isForStatement(scope) ||
      ts.isForOfStatement(scope) ||
      ts.isForInStatement(scope)) &&
    scope.initializer !== undefined &&
    ts.isVariableDeclarationList(scope.initializer)
  ) {
    return scope.initializer.declarations.some((d) => bindsProcess(d.name));
  }
  if (ts.isBlock(scope) || ts.isSourceFile(scope) || ts.isModuleBlock(scope)) {
    return scope.statements.some(
      (statement) =>
        (ts.isVariableStatement(statement) &&
          statement.declarationList.declarations.some((d) =>
            bindsProcess(d.name),
          )) ||
        ((ts.isFunctionDeclaration(statement) ||
          ts.isClassDeclaration(statement)) &&
          statement.name?.text === "process"),
    );
  }
  return false;
}

/** The global `process`, not a declaration's name or a local of that name. */
function isGlobalProcess(node: ts.Node): boolean {
  if (ts.isIdentifier(node)) {
    if (node.text !== "process") return false;
    const parent = node.parent;
    if (
      (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
      (ts.isPropertyAssignment(parent) && parent.name === node) ||
      (ts.isBindingElement(parent) && parent.propertyName === node) ||
      (ts.isQualifiedName(parent) && parent.right === node) ||
      ((ts.isParameter(parent) ||
        ts.isVariableDeclaration(parent) ||
        ts.isBindingElement(parent) ||
        ts.isPropertySignature(parent) ||
        ts.isPropertyDeclaration(parent) ||
        ts.isMethodDeclaration(parent) ||
        ts.isFunctionDeclaration(parent) ||
        ts.isClassDeclaration(parent)) &&
        parent.name === node)
    ) {
      return false;
    }
    for (let scope: ts.Node = parent; ; scope = scope.parent) {
      if (ts.isTypeQueryNode(scope)) return false;
      if (declaresProcess(scope)) return false;
      if (ts.isSourceFile(scope)) return true;
    }
  }
  const read = memberRead(node);
  if (read?.member !== "process") return false;
  const object = unwrap(read.object);
  return ts.isIdentifier(object) && GLOBAL_OBJECTS.has(object.text);
}

/** The member read straight off a reference, if one is. */
function memberAfter(reference: ts.Node): ts.Node | undefined {
  let outer = reference;
  while (isOuterExpression(outer.parent)) outer = outer.parent;
  const read = memberRead(outer.parent);
  return read?.object === outer ? outer.parent : undefined;
}

/** Whether a use of `process` is one of the allowed members, and only that. */
function isAllowedUse(reference: ts.Node): boolean {
  const access = memberAfter(reference);
  const member = access === undefined ? undefined : memberRead(access)?.member;
  if (access === undefined || member === undefined) return false;
  if (!PROCESS_MEMBERS.has(member)) return false;
  if (!LISTENER_MEMBERS.has(member)) return true;
  const call = access.parent;
  return (
    ts.isCallExpression(call) &&
    call.expression === access &&
    ts.isExpressionStatement(call.parent)
  );
}

/**
 * `process` taken out of the global object by destructuring, in a
 * declaration or an assignment. Taking a `process` field out of anything
 * else is ordinary: a connector's request body carries one.
 */
function destructuresProcess(node: ts.Node): boolean {
  const named = (name: ts.Node | undefined) =>
    name !== undefined &&
    (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) &&
    name.text === "process";
  const isGlobalObject = (source: ts.Expression | undefined) => {
    if (source === undefined) return false;
    const inner = unwrap(source);
    return ts.isIdentifier(inner) && GLOBAL_OBJECTS.has(inner.text);
  };
  if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
    const declaration = node.parent.parent;
    return (
      named(node.propertyName ?? node.name) &&
      (ts.isVariableDeclaration(declaration) || ts.isParameter(declaration)) &&
      isGlobalObject(declaration.initializer)
    );
  }
  if (
    (ts.isShorthandPropertyAssignment(node) || ts.isPropertyAssignment(node)) &&
    named(node.name)
  ) {
    let pattern: ts.Node = node.parent;
    while (isOuterExpression(pattern.parent)) pattern = pattern.parent;
    const assignment = pattern.parent;
    return (
      ts.isBinaryExpression(assignment) &&
      assignment.left === pattern &&
      assignment.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      isGlobalObject(assignment.right)
    );
  }
  return false;
}

/** Names bound to `createRequire(...)`, whose calls load a module. */
function requireAliases(file: ts.SourceFile): Set<string> {
  const names = new Set(["require"]);
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined &&
      isCreateRequire(node.initializer)
    ) {
      names.add(node.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return names;
}

function isCreateRequire(node: ts.Expression): boolean {
  const call = unwrap(node);
  return (
    ts.isCallExpression(call) &&
    ts.isIdentifier(call.expression) &&
    call.expression.text === "createRequire"
  );
}

/** Whether the file, comments and strings aside, can reach the environment. */
function readsEnvironment(text: string): boolean {
  const file = ts.createSourceFile("x.ts", text, ts.ScriptTarget.Latest, true);
  const loaders = requireAliases(file);
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    const moduleName =
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
        ? node.moduleSpecifier.text
        : ts.isCallExpression(node) &&
            (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
              isCreateRequire(node.expression) ||
              (ts.isIdentifier(unwrap(node.expression)) &&
                loaders.has(
                  (unwrap(node.expression) as ts.Identifier).text,
                ))) &&
            node.arguments[0] !== undefined &&
            ts.isStringLiteralLike(node.arguments[0])
          ? node.arguments[0].text
          : undefined;
    if (
      (moduleName !== undefined && PROCESS_MODULE.test(moduleName)) ||
      (isGlobalProcess(node) && !isAllowedUse(node)) ||
      // A `.process` off any other object is judged only by what is read
      // from it, since a connector's own `process` field is an ordinary
      // string.
      (memberRead(node)?.member === "process" &&
        memberAfter(node) !== undefined &&
        !isAllowedUse(node)) ||
      destructuresProcess(node)
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
      "const a = (process as any).env;",
      "const a = (process).env;",
      "const a = process!.env;",
      "const p = process;\np.env;",
      "let env; ({ env } = process);",
      "function f(p = process) { return p.env; }",
      'const a = globalThis["process"].env;',
      'const m = await import("node:process");',
      'const m = require("process");',
      'const a = Reflect.get(process, "env");',
      "const a = global.process.env;",
      "const a = foo.process.env;",
      "const a = (window as any).process.env;",
      "const { process } = globalThis;",
      "const { process: p } = global;",
      "let p; ({ process: p } = globalThis);",
      'const a = process.on("x", f).env;',
      'const e = process.once("x", f);',
      'const m = createRequire(import.meta.url)("node:process");',
      'const r = createRequire(import.meta.url);\nconst m = r("process");',
    ]) {
      expect(readsEnvironment(spelling), spelling).toBe(true);
    }
    for (const spelling of [
      "// process.env.X\nconst a = 1;",
      'const a = "process.env";',
      "process.stdout.write('x');",
      "function hold(process: string) { return process.length; }",
      "const f = { process: 1 }.process;",
      "type T = typeof process;",
      "const g = globalThis;",
      'process.on("SIGTERM", stop);',
      "const same = hold.process === fence.process;",
      'const { process } = c.req.valid("json");',
      'const r = createRequire(import.meta.url);\nconst m = r("node:fs");',
    ]) {
      expect(readsEnvironment(spelling), spelling).toBe(false);
    }
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
