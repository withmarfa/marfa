/**
 * Every operation that answers an `Item` derives its `read_only`.
 *
 * The field is required on `Item` but derived, never stored, so a new route
 * that answers rows as storage returns them leaves it out, and only a fixture
 * reading that route would notice. This walks the published document for
 * every operation whose answers hold an `Item`, finds the handler registered
 * for it, and holds the handler, or a function in its own file that it calls,
 * to one of the ways the field is derived.
 */
import ts from "typescript";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const DOCUMENT = join(SRC, "..", "..", "..", "openapi.json");

/** The calls that derive `read_only`, as `_read-only.ts` and the stream
 *  frames do. */
const DERIVES = /\b(withReadOnly|oneWithReadOnly)\(|connectors\.readOnly\(/;

interface Document {
  paths: Record<string, Record<string, unknown>>;
  components: { schemas: Record<string, unknown> };
}

function sourceFiles(dir = SRC): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    if (!name.endsWith(".ts") || name.endsWith(".test.ts")) return [];
    return [relative(SRC, path)];
  });
}

/** The operationId of every operation whose answers hold an `Item`. */
function operationsAnsweringItems(doc: Document): string[] {
  const memo = new Map<string, boolean>();
  const holds = (node: unknown, seen: Set<string>): boolean => {
    if (typeof node !== "object" || node === null) return false;
    const ref = (node as { $ref?: unknown }).$ref;
    if (typeof ref === "string") {
      const name = ref.split("/").at(-1) ?? "";
      if (name === "Item") return true;
      if (seen.has(name)) return false;
      const known = memo.get(name);
      if (known !== undefined) return known;
      seen.add(name);
      const found = holds(doc.components.schemas[name], seen);
      seen.delete(name);
      memo.set(name, found);
      return found;
    }
    return Object.values(node).some((value) => holds(value, seen));
  };
  return Object.values(doc.paths).flatMap((operations) =>
    Object.values(operations).flatMap((operation) => {
      const { operationId, responses } = operation as {
        operationId?: string;
        responses?: unknown;
      };
      return operationId !== undefined && holds(responses, new Set())
        ? [operationId]
        : [];
    }),
  );
}

interface Parsed {
  file: string;
  source: ts.SourceFile;
}

function parse(file: string): Parsed {
  return {
    file,
    source: ts.createSourceFile(
      file,
      readFileSync(join(SRC, file), "utf8"),
      ts.ScriptTarget.Latest,
      true,
    ),
  };
}

function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node);
  node.forEachChild((child) => {
    walk(child, visit);
  });
}

/** The variable each `createRoute({ operationId })` is held in. */
function routeVariables(files: Parsed[]): Map<string, string> {
  const found = new Map<string, string>();
  for (const { source } of files) {
    walk(source, (node) => {
      if (
        !ts.isVariableDeclaration(node) ||
        !ts.isIdentifier(node.name) ||
        node.initializer === undefined ||
        !ts.isCallExpression(node.initializer) ||
        node.initializer.expression.getText() !== "createRoute"
      ) {
        return;
      }
      const config = node.initializer.arguments[0];
      if (config === undefined || !ts.isObjectLiteralExpression(config)) return;
      for (const property of config.properties) {
        if (
          ts.isPropertyAssignment(property) &&
          property.name.getText() === "operationId" &&
          ts.isStringLiteral(property.initializer)
        ) {
          found.set(property.initializer.text, node.name.text);
        }
      }
    });
  }
  return found;
}

/** Whether `node` is the route variable, or a call that wraps it, such as
 *  `snapshotReadRoute(storage, route)`. */
function names(node: ts.Node | undefined, route: string): boolean {
  if (node === undefined) return false;
  if (ts.isIdentifier(node)) return node.text === route;
  return (
    ts.isCallExpression(node) &&
    node.arguments.some((arg) => ts.isIdentifier(arg) && arg.text === route)
  );
}

/**
 * Routes declared with `openAPIRegistry.registerPath` and served by a plain
 * handler, so no `openapi()` call names them, with the files that build what
 * they send. Each file must derive the field.
 */
const REGISTERED_PATHS: Record<string, readonly string[]> = {
  // The event stream and the copy stream build their frames apart.
  eventStreamRoute: ["routes/events.ts", "routes/events-copy.ts"],
};

/** The handler text registered for a route variable, with the text of every
 *  function in the handler's file that it calls by name. */
function handlerText(files: Parsed[], route: string): string | null {
  for (const { source } of files) {
    let handler: ts.Node | undefined;
    walk(source, (node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "openapi" &&
        names(node.arguments[0], route)
      ) {
        handler = node.arguments[1];
      }
    });
    if (handler === undefined) continue;
    const local = new Map<string, string>();
    walk(source, (node) => {
      if (ts.isFunctionDeclaration(node) && node.name) {
        local.set(node.name.text, node.getText());
      }
    });
    const called = new Set<string>();
    walk(handler, (node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        called.add(node.expression.text);
      }
    });
    return [
      handler.getText(),
      ...[...called].flatMap((name) => local.get(name) ?? []),
    ].join("\n");
  }
  return null;
}

describe("read_only on every operation that answers an item", () => {
  const doc = JSON.parse(readFileSync(DOCUMENT, "utf8")) as Document;
  const files = sourceFiles().map(parse);
  const routes = routeVariables(files);
  const operations = operationsAnsweringItems(doc);

  it("finds the operations that answer an item", () => {
    expect(operations).toContain("getItem");
    expect(operations).toContain("streamEvents");
  });

  it.each(operations)("%s derives read_only in its handler", (operation) => {
    const route = routes.get(operation);
    expect(route, `the createRoute for ${operation}`).toBeDefined();
    const registered = REGISTERED_PATHS[route ?? ""];
    if (registered) {
      for (const file of registered) {
        expect(
          readFileSync(join(SRC, file), "utf8"),
          `${file}, which builds what ${operation} sends`,
        ).toMatch(DERIVES);
      }
      return;
    }
    const text = handlerText(files, route ?? "");
    expect(text, `the handler registered for ${route ?? ""}`).not.toBeNull();
    expect(text).toMatch(DERIVES);
  });

  it("names only routes no openapi() call registers", () => {
    for (const route of Object.keys(REGISTERED_PATHS)) {
      expect(handlerText(files, route), route).toBeNull();
    }
  });
});
