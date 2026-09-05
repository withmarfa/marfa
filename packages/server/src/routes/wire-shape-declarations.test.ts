/**
 * `_schemas.ts` says each wire shape is declared once. This is what makes
 * that true.
 *
 * It was not true. `EdgeSchema` was declared there and declared again in
 * `edges.ts`, field-identically, under a header claiming centralization --
 * and the header is precisely what persuades the next person that adding a
 * field in one place is enough. It is not: the `_schemas.ts` copy hydrates
 * an item's inline `edges` block and the `edges.ts` copy answers `/edges`,
 * so a field added to one produces a specification where an edge read
 * through an item has a different shape from the same edge read directly,
 * and a generated client believes whichever it was pointed at. Both are
 * valid Zod, nothing compares them, so the drift is silent.
 *
 * Two more were found the same way once this was looked for: `VersionSchema`
 * in `items-versions.ts` and `QuotaSchema` in `admin.ts` and `spaces.ts`.
 * Three instances of one defect is what a rule nothing checks looks like.
 *
 * Two questions are asked, because a redeclaration can be caught by either
 * and neither catches both:
 *
 *   - **Same name.** A route file declaring `EdgeSchema` when `_schemas.ts`
 *     exports one. Catches a copy that has already drifted, which a
 *     field comparison no longer sees.
 *   - **Same fields.** A route file declaring the identical field set under
 *     a different name. Catches a copy made by renaming, which a name
 *     comparison never sees.
 *
 * What neither catches is a partial overlap -- a shape that shares most of
 * a centralized one but not all of it. That is a judgement about whether
 * two things are the same shape, and a test cannot make it.
 *
 * **And neither compares one route file against another**, which is the
 * larger gap and worth stating plainly because it is counter-intuitive:
 * `QuotaSchema`, one of the three defects this file was written for, lived
 * in `admin.ts` and `spaces.ts` and in neither case in `_schemas.ts`. This
 * guard would have been silent on it. It became detectable only once
 * somebody had already centralized it, so what is held here is the
 * *staying* centralized, not the *becoming* it. Three names are declared in
 * more than one route file today, and `_schemas.ts` records why each is left
 * where it is. Closing any of them is a change to those files rather than to
 * this one.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROUTES_DIR = resolve(dirname(fileURLToPath(import.meta.url)));
const SHARED_FILE = "_schemas.ts";

interface Declaration {
  name: string;
  /** Top-level keys of the object literal, sorted. */
  fields: string[];
}

/**
 * Every `const <Name>Schema = z.object({ ... })` in a source, with the keys
 * of the literal.
 *
 * Keys are read at brace depth one inside the literal, so a nested object or
 * a `z.record(z.string(), ...)` argument does not contribute its own keys.
 * Formatting is Prettier's, which is what makes a line-oriented read of this
 * sound; the failure mode of a miss is a declaration this does not see,
 * never one it invents.
 */
function declarationsIn(source: string): Declaration[] {
  const found: Declaration[] = [];
  const opener = /(?:export )?const (\w+) = z\.object\(\{/g;
  let match: RegExpExecArray | null;
  while ((match = opener.exec(source)) !== null) {
    const name = match[1];
    if (name === undefined) continue;
    let depth = 1;
    let i = opener.lastIndex;
    const fields: string[] = [];
    let lineStart = i;
    while (i < source.length && depth > 0) {
      const ch = source[i];
      if (ch === "{" || ch === "(" || ch === "[") depth += 1;
      else if (ch === "}" || ch === ")" || ch === "]") depth -= 1;
      else if (ch === "\n") lineStart = i + 1;
      if (depth === 1 && ch === ":") {
        const line = source.slice(lineStart, i);
        const key = /^\s*(\w+)$/.exec(line);
        if (key?.[1] !== undefined) fields.push(key[1]);
      }
      i += 1;
    }
    found.push({ name, fields: fields.sort() });
  }
  return found;
}

function routeSources(): { file: string; declarations: Declaration[] }[] {
  return readdirSync(ROUTES_DIR)
    .filter(
      (f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && f !== SHARED_FILE,
    )
    .map((file) => ({
      file,
      declarations: declarationsIn(
        readFileSync(join(ROUTES_DIR, file), "utf-8"),
      ),
    }));
}

describe("declarationsIn", () => {
  it("reads a schema's top-level field names", () => {
    expect(
      declarationsIn(
        "const EdgeSchema = z.object({\n  id: z.string(),\n  version: z.number(),\n});",
      ),
    ).toEqual([{ name: "EdgeSchema", fields: ["id", "version"] }]);
  });

  it("does not count keys of a nested object as the schema's own", () => {
    // `EdgeConflictSchema` nests an `error` object. Counting `code` and
    // `status` as its fields would make it look like a different shape than
    // it is, and could collide with something unrelated.
    expect(
      declarationsIn(
        "const A = z.object({\n  error: z.object({\n    code: z.string(),\n  }),\n  edge: EdgeSchema,\n});",
      ),
    ).toEqual([{ name: "A", fields: ["edge", "error"] }]);
  });

  it("reads an exported declaration as well as a local one", () => {
    expect(
      declarationsIn("export const S = z.object({\n  id: z.string(),\n});").map(
        (d) => d.name,
      ),
    ).toEqual(["S"]);
  });

  it("finds every declaration in a file, not only the first", () => {
    expect(
      declarationsIn(
        "const A = z.object({\n  a: z.string(),\n});\nconst B = z.object({\n  b: z.string(),\n});",
      ).map((d) => d.name),
    ).toEqual(["A", "B"]);
  });
});

describe("each wire shape is declared once", () => {
  const shared = declarationsIn(
    readFileSync(join(ROUTES_DIR, SHARED_FILE), "utf-8"),
  );
  const routes = routeSources();

  it("finds the centralized schemas and the declarations to check", () => {
    // The control. A scan that reads neither side passes every check below
    // while proving nothing, which reads exactly like a clean route layer.
    //
    // **Counted in declarations, not in files.** A parser that opens all 86
    // route files and returns nothing from each of them satisfies a count of
    // files completely, and every check below then holds over an empty list.
    // The unit tests above would catch a parser that broke on any input; they
    // would not catch one that works on the synthetic strings they pass it
    // and fails on the real files -- a Prettier configuration change, or a
    // route adopting a declaration form the regex does not know. The
    // declarations are what the checks below iterate, so they are what has to
    // be non-empty.
    expect(shared.map((d) => d.name)).toContain("EdgeSchema");
    expect(routes.some((r) => r.file === "edges.ts")).toBe(true);
    const declarations = routes.flatMap((r) => r.declarations);
    expect(declarations.length).toBeGreaterThan(50);
  });

  it("no route file redeclares a centralized schema by name", () => {
    const sharedNames = new Set(shared.map((d) => d.name));
    const offenders = routes.flatMap((r) =>
      r.declarations
        .filter((d) => sharedNames.has(d.name))
        .map((d) => `${r.file} declares ${d.name}, which _schemas.ts exports`),
    );
    expect(
      offenders,
      `Import it from ./_schemas.js and delete the local copy. Nothing compares ` +
        `two declarations of one shape, and both are valid Zod, so the drift is a ` +
        `client that cannot find a field the API returns -- or one generated ` +
        `without it, since the specification would carry both shapes.`,
    ).toEqual([]);
  });

  it("no route file redeclares a centralized shape under another name", () => {
    const byFields = new Map(
      shared
        .filter((d) => d.fields.length > 0)
        .map((d) => [d.fields.join(","), d.name]),
    );
    const offenders = routes.flatMap((r) =>
      r.declarations.flatMap((d) => {
        const key = d.fields.join(",");
        const centralized = d.fields.length > 0 ? byFields.get(key) : undefined;
        return centralized === undefined
          ? []
          : [
              `${r.file} declares ${d.name} with the same fields as ` +
                `_schemas.ts's ${centralized} (${key})`,
            ];
      }),
    );
    expect(
      offenders,
      `A copy made by renaming is the same copy. If the two really are ` +
        `different shapes that happen to agree today, they will not stay ` +
        `agreeing, and the specification will say they do.`,
    ).toEqual([]);
  });
});
