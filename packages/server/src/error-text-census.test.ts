/**
 * Every place that turns a caught error into text goes through
 * `error-text.ts`.
 *
 * **A census, because the failure it prevents is silent.** A failed query's
 * message carries the values it was bound to, and `err.message` or
 * `String(err)` copies them into whatever the text is sent to. Nothing about
 * such a line looks wrong, and a test of one sink says nothing of the next
 * file's. So the server's source is read for the three forms the code has used
 * to do it, and each has to be spelled `errorMessage(err)` or
 * `reportableError(err)` instead.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const SERVER_SRC = dirname(fileURLToPath(import.meta.url));
const MODULE = resolve(SERVER_SRC, "error-text.ts");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith(".ts") && !path.endsWith(".test.ts") ? [path] : [];
  });
}

/** The names a source file binds to a caught value: a `catch (x)`, or the first parameter of a `.catch(...)` callback. */
function caughtNames(file: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (
      ts.isCatchClause(node) &&
      node.variableDeclaration &&
      ts.isIdentifier(node.variableDeclaration.name)
    ) {
      names.add(node.variableDeclaration.name.text);
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "catch"
    ) {
      const callback = node.arguments[0];
      const first =
        callback &&
        (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))
          ? callback.parameters[0]
          : undefined;
      if (first && ts.isIdentifier(first.name)) names.add(first.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return names;
}

/** What a source text does by hand that `error-text.ts` does once, as "line: form". */
function handWrittenErrorText(source: string): string[] {
  const file = ts.createSourceFile(
    "probe.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const caught = caughtNames(file);
  const found: string[] = [];
  const at = (node: ts.Node, form: string): void => {
    const { line } = file.getLineAndCharacterOfPosition(node.getStart(file));
    found.push(`${String(line + 1)}: ${form}`);
  };
  const visit = (node: ts.Node): void => {
    // `x instanceof Error ? x.message : ...`
    if (
      ts.isConditionalExpression(node) &&
      ts.isBinaryExpression(node.condition) &&
      node.condition.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword &&
      ts.isIdentifier(node.condition.right) &&
      node.condition.right.text === "Error" &&
      ts.isPropertyAccessExpression(node.whenTrue) &&
      node.whenTrue.name.text === "message" &&
      node.whenTrue.expression.getText(file) ===
        node.condition.left.getText(file)
    ) {
      at(node, "reads the message by hand: use errorMessage");
    }
    // `String(x)` of a caught value, outside the `new Error(String(x))` that
    // re-wraps something that was not an error.
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "String" &&
      node.arguments.length === 1 &&
      ts.isIdentifier(node.arguments[0]!) &&
      caught.has(node.arguments[0].text) &&
      !(
        ts.isNewExpression(node.parent) &&
        node.parent.expression.getText(file) === "Error"
      )
    ) {
      at(node, "stringifies a caught value: use errorMessage");
    }
    // `console.warn("...", x)` of a caught value, which prints its fields.
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.expression.getText(file) === "console" &&
      node.arguments.some((a) => ts.isIdentifier(a) && caught.has(a.text))
    ) {
      at(node, "prints a caught value whole: use reportableError");
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

describe("how the server turns a caught error into text", () => {
  it("never does it by hand outside error-text.ts", () => {
    const offenders = sourceFiles(SERVER_SRC)
      .filter((path) => path !== MODULE)
      .flatMap((path) =>
        handWrittenErrorText(readFileSync(path, "utf8")).map(
          (finding) => `${relative(SERVER_SRC, path)}:${finding}`,
        ),
      );
    expect(offenders).toEqual([]);
  });

  it("would see each form, which is what makes the case above a measurement", () => {
    const source = [
      "try { run(); } catch (err) {",
      "  log('x', { error: err instanceof Error ? err.message : String(err) });",
      "  log('y', { error: `${String(err)}` });",
      "  console.warn('z', err);",
      "}",
      "work().catch((reason) => log('w', { error: String(reason) }));",
    ].join("\n");
    const found = handWrittenErrorText(source);
    expect(found.map((f) => f.split(":")[0])).toEqual([
      "2",
      "2",
      "3",
      "4",
      "6",
    ]);
  });

  it("leaves the forms that carry no values alone", () => {
    const source = [
      "try { run(); } catch (err) {",
      "  throw err instanceof Error ? err : new Error(String(err));",
      "}",
      "log('a', { count: String(total), error: errorMessage(failure) });",
      "const text = String(lastReplayedId);",
    ].join("\n");
    expect(handWrittenErrorText(source)).toEqual([]);
  });
});
