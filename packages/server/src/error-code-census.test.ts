import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { ErrorCode } from "@withmarfa/shared";

const SRC = resolve(import.meta.dirname);
const REPO = resolve(SRC, "../../..");

/**
 * Every code the server sends is a row in `conformance/spec/errors.md`, and
 * every row names a code the server sends.
 *
 * The server's own list of codes is the `ErrorCode` enum, which every
 * `MarfaError` is built from. The error handler's `internal_error` answer is
 * not in it, because nothing throws it: it is what an error nothing named
 * becomes. So a code is sent when it is a member of the enum or is written as
 * `error: { code: "..." }` in the server's source, and this census reads
 * both.
 */

/** The codes no door answers, and why the chapter has no row for each. */
const NEVER_ANSWERED: Record<string, string> = {
  duplicate_source:
    "the storage layer's refusal of a second row under one natural key, which every door resolves first and an archive restore counts as a duplicate",
};

/**
 * The codes the published document does not declare, each on a door it does
 * not publish. A code that appears in the document is not listed, so an entry
 * that goes stale fails.
 */
const UNPUBLISHED_DOORS: Record<string, string> = {
  duplicate_source: "no door answers it (above)",
  invalid_client: "the device consent page, `GET /auth/device/consent`",
  oauth_grant_not_found: "the grants door, `DELETE /auth/grants/{id}`",
  inbound_unavailable: "an inbound webhook address",
  request_timeout: "an inbound webhook address",
};

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")
      ? [path]
      : [];
  });
}

/** The codes written as `error: { code: "x" }` in a file's source. */
function literalCodes(file: string): string[] {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isPropertyAssignment(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "error" &&
      ts.isObjectLiteralExpression(node.initializer)
    ) {
      for (const member of node.initializer.properties) {
        if (
          ts.isPropertyAssignment(member) &&
          ts.isIdentifier(member.name) &&
          member.name.text === "code"
        ) {
          const value = ts.isAsExpression(member.initializer)
            ? member.initializer.expression
            : member.initializer;
          if (ts.isStringLiteralLike(value)) found.push(value.text);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

function codesSent(): Map<string, string> {
  const sent = new Map<string, string>();
  for (const code of Object.values(ErrorCode)) {
    sent.set(code, "the ErrorCode enum");
  }
  for (const file of sourceFiles(SRC)) {
    for (const code of literalCodes(file)) {
      if (!sent.has(code)) sent.set(code, relative(SRC, file));
    }
  }
  return sent;
}

const ERRORS_CHAPTER = readFileSync(
  join(REPO, "conformance/spec/errors.md"),
  "utf8",
);

/** The code of each row of the chapter's table. */
function rowsOf(chapter: string): string[] {
  return [...chapter.matchAll(/^\| `([a-z_]+)`\s*\|/gm)].map((m) => m[1]!);
}

/** The codes sent that the table has no row for. */
function withoutRow(sent: Iterable<string>, chapter: string): string[] {
  const rows = new Set(rowsOf(chapter));
  return [...sent].filter((code) => !rows.has(code)).sort();
}

/** Every value of a `code` enum anywhere in the published document. */
function declaredCodes(): Set<string> {
  const document: unknown = JSON.parse(
    readFileSync(join(REPO, "openapi.json"), "utf8"),
  );
  const declared = new Set<string>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry);
    } else if (value !== null && typeof value === "object") {
      const record = value as Record<string, unknown>;
      const code = record.code as { enum?: unknown } | undefined;
      if (Array.isArray(code?.enum)) {
        for (const name of code.enum) declared.add(String(name));
      }
      for (const entry of Object.values(record)) visit(entry);
    }
  };
  visit(document);
  return declared;
}

describe("the codes the server sends and the error chapter", () => {
  const sent = codesSent();
  const answered = [...sent.keys()].filter((code) => !(code in NEVER_ANSWERED));

  it("reads the codes the server sends, the one outside the enum included", () => {
    // The control for the checks below: a read that found nothing would pass
    // them all.
    expect(sent.size).toBeGreaterThan(60);
    expect(sent.get("internal_error")).toBe("middleware/error-handler.ts");
    expect(sent.get("background_job_running")).toBe("the ErrorCode enum");
    expect(rowsOf(ERRORS_CHAPTER).length).toBeGreaterThan(50);
  });

  it("has a row in errors.md for every code the server answers with", () => {
    expect(withoutRow(answered, ERRORS_CHAPTER)).toEqual([]);
  });

  it("fails when a code is sent that the table does not list", () => {
    // The witness: the same read over the chapter with one row taken out
    // names that code, so the check above can fail.
    const row = /^\| `idempotency_key_in_flight`.*\n/m;
    expect(ERRORS_CHAPTER).toMatch(row);
    const without = ERRORS_CHAPTER.replace(row, "");
    expect(withoutRow(answered, without)).toEqual([
      "idempotency_key_in_flight",
    ]);
    const unknown = `${ERRORS_CHAPTER}\n| \`not_a_code\` | 400 | x | y |\n`;
    expect(rowsOf(unknown)).toContain("not_a_code");
    expect(withoutRow([...answered, "not_sent_yet"], ERRORS_CHAPTER)).toEqual([
      "not_sent_yet",
    ]);
  });

  it("has no row for a code the server does not send", () => {
    const rows = rowsOf(ERRORS_CHAPTER);
    expect(rows.filter((code) => !sent.has(code))).toEqual([]);
    expect(rows.filter((code) => code in NEVER_ANSWERED)).toEqual([]);
  });

  it("declares every code answered in the published document, but for those on doors it does not publish", () => {
    const declared = declaredCodes();
    expect(declared.size).toBeGreaterThan(50);
    expect(
      answered.filter(
        (code) => !declared.has(code) && !(code in UNPUBLISHED_DOORS),
      ),
    ).toEqual([]);
    // An entry that has since been declared is stale.
    expect(
      Object.keys(UNPUBLISHED_DOORS).filter((c) => declared.has(c)),
    ).toEqual([]);
    expect(declared.has("internal_error")).toBe(true);
  });

  it("lists as never answered only a code whose one thrower is absorbed", () => {
    // `duplicate_source` is thrown by the item store and read by the archive
    // restore, which counts it as a duplicate. A third site that reached it
    // could answer it, and this is where that is noticed.
    const sites = sourceFiles(SRC)
      .filter((file) =>
        readFileSync(file, "utf8").includes("ErrorCode.DUPLICATE_SOURCE"),
      )
      .map((file) => relative(SRC, file))
      .sort();
    expect(Object.keys(NEVER_ANSWERED)).toEqual(["duplicate_source"]);
    expect(sites).toEqual([
      "routes/restore-archive.ts",
      "storage/sqlite/item-store.ts",
    ]);
  });
});
