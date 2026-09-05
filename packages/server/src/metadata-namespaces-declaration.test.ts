/**
 * One spelling of the reserved namespace across the workspace, held by
 * search rather than by memory.
 *
 * `RUNTIME_NAMESPACE` and the predicate beneath it are one rule: the
 * predicate decides whether a write to a namespace is visible to a client
 * at all, and it derives from that string. Anything that writes the
 * namespace, or grants reach over it, has to name the same string, so
 * every site spelling it independently is somewhere the two can separate.
 * Three had, and nothing was red — the predicate had just been
 * single-sourced while the constant it reads was not, which is the same
 * drift one level down.
 *
 * This scans rather than asserting a list of known sites, because a list
 * only holds while somebody remembers to extend it. A fourth copy added
 * next month fails here on its own.
 *
 * **Scope is the whole workspace, not the server.** The copies were all in
 * one package, but the reason they are a problem is not: a manifest in
 * another package naming a namespace this one no longer reserves is the
 * same failure wearing different clothes.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGES_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * The value of every string literal in the source, comments skipped.
 *
 * Values rather than a pattern over the raw text, because "a quote, the
 * name, the same quote" is not the same question as "a literal whose
 * value is the name" — and the difference is not academic. Comments across
 * the workspace name the namespace in markdown code spans, backtick name
 * backtick, and a route description carries one of those *inside* a
 * double-quoted string. Both look exactly like a template-literal
 * declaration to a pattern and neither declares anything. Matching the raw
 * text reports sixteen files, of which three are real.
 *
 * Strings are walked rather than skipped so a comment opener inside one (a
 * `//` in a URL) cannot truncate the line and hide a declaration after it.
 * A regex literal containing a lone quote would confuse this; nothing in
 * the tree has one, and the failure would name the file.
 */
function stringLiteralValues(source: string): string[] {
  const values: string[] = [];
  let i = 0;
  while (i < source.length) {
    const here = source[i];
    const next = source[i + 1];
    if (here === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") i += 1;
      continue;
    }
    if (here === "/" && next === "*") {
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/"))
        i += 1;
      i += 2;
      continue;
    }
    if (here === '"' || here === "'" || here === "`") {
      i += 1;
      let value = "";
      while (i < source.length && source[i] !== here) {
        if (source[i] === "\\") {
          value += source.slice(i, i + 2);
          i += 2;
          continue;
        }
        value += source.slice(i, i + 1);
        i += 1;
      }
      i += 1;
      values.push(value);
      continue;
    }
    i += 1;
  }
  return values;
}

/**
 * The reserved namespace, or a subtree of it, written out in full.
 *
 * Anchored, so a longer string merely mentioning the namespace has not
 * declared it: a route's OpenAPI description explaining what the namespace
 * is grants nothing and cannot drift into granting the wrong thing. The
 * optional tail catches a subtree spelled out instead of derived, which is
 * how the idempotency window was written.
 */
const RESERVED_VALUE = /^connection\.runtime(\.[a-z_.]+)?$/;

function declaresReservedNamespace(source: string): boolean {
  return stringLiteralValues(source).some((v) => RESERVED_VALUE.test(v));
}

/**
 * Sites allowed to spell the namespace, each with the reason it is not the
 * drift this guard is about.
 *
 * A row is matched on exact path, and the assertion is an equality rather
 * than a subset, so a row naming a file that no longer spells the
 * namespace fails too. An exemption nothing matches is dead configuration,
 * and the shape it rots into is one that silently covers a copy nobody
 * decided about.
 */
const ALLOWED: readonly { path: string; reason: string }[] = [
  {
    path: "server/src/metadata-namespaces.ts",
    reason:
      "The definition. Everything else imports from here, and the predicate " +
      "that decides what a client hears is derived from it in the same file.",
  },
  {
    path: "sync-manifest/src/manifest.ts",
    reason:
      "An integration manifest requesting the grant, not a declaration of " +
      "the namespace. It cannot drift into naming the wrong one, because " +
      "`buildExtensionPermissions` grants the reserved namespace write " +
      "unconditionally after merging whatever the manifest declared — a " +
      "manifest that named something else would simply be redundant rather " +
      "than wrong. This package depends only on `@withmarfa/shared` and " +
      "cannot reach the server's constant.",
  },
  {
    path: "server/src/routes/fixtures/google-calendar-manifest.ts",
    reason:
      "A hand-maintained copy of a published manifest, standing in for the " +
      "real one in tests. It has to say what that manifest says, so it " +
      "spells the string the manifest spells rather than importing ours.",
  },
  {
    path: "server/fixtures/dispatch-integration/src/local.ts",
    reason:
      "A fixture integration's own manifest, same reasoning as the Google " +
      "Calendar fixture: it stands in for third-party text and is not ours " +
      "to single-source.",
  },
];

/** Every non-test TypeScript source in the workspace, workspace-relative. */
function workspaceSources(): { path: string; content: string }[] {
  const found: { path: string; content: string }[] = [];
  const skip = new Set(["node_modules", "dist", "build", ".turbo"]);
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      if (skip.has(name)) continue;
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!name.endsWith(".ts") || name.endsWith(".test.ts")) continue;
      found.push({
        path: relative(PACKAGES_ROOT, full).split(sep).join("/"),
        content: readFileSync(full, "utf-8"),
      });
    }
  };
  walk(PACKAGES_ROOT);
  return found;
}

describe("declaresReservedNamespace", () => {
  it("finds the namespace spelled as a literal", () => {
    expect(declaresReservedNamespace('const ns = "connection.runtime";')).toBe(
      true,
    );
  });

  it("finds a subtree spelled in full rather than derived", () => {
    // How the idempotency window was written: the parent was spelled
    // independently and this was spelled independently of that, so the
    // pair could separate from each other as well as from the constant.
    expect(
      declaresReservedNamespace('const w = "connection.runtime.idempotency";'),
    ).toBe(true);
  });

  it("does not find a namespace built from the constant", () => {
    expect(
      declaresReservedNamespace(
        "const w = `${RUNTIME_NAMESPACE}.idempotency`;",
      ),
    ).toBe(false);
  });

  it("does not find the namespace named in a line comment", () => {
    expect(
      declaresReservedNamespace("// `connection.runtime` is reserved.\n"),
    ).toBe(false);
  });

  it("does not find the namespace named in a block comment", () => {
    expect(
      declaresReservedNamespace("/** Reads `connection.runtime` state. */\n"),
    ).toBe(false);
  });

  it("does not find the namespace named in prose inside a longer string", () => {
    expect(
      declaresReservedNamespace(
        'const d = "reserved namespaces such as `connection.runtime` carry constraints";',
      ),
    ).toBe(false);
  });

  it("does not confuse a namespace that starts with the same letters", () => {
    expect(
      declaresReservedNamespace('const ns = "connection.runtimefoo";'),
    ).toBe(false);
  });

  it("still finds a declaration on a line whose string carries a comment opener", () => {
    // A naive strip cuts this line at the `//` in the URL and reports the
    // file clean. The declaration after it is the one that matters.
    expect(
      declaresReservedNamespace(
        'const u = "https://api.example.com"; const ns = "connection.runtime";',
      ),
    ).toBe(true);
  });
});

describe("the reserved namespace is declared once", () => {
  const declaring = workspaceSources()
    .filter((f) => declaresReservedNamespace(f.content))
    .map((f) => f.path)
    .sort();

  it("finds sources to scan at all", () => {
    // A scanner that walks the wrong root reports nothing and passes,
    // which is indistinguishable from a clean tree. This is the control.
    expect(workspaceSources().length).toBeGreaterThan(100);
  });

  it("is spelled only where spelling it is not the drift", () => {
    const allowed = ALLOWED.map((a) => a.path).sort();
    expect(
      declaring,
      `Every site below spells "connection.runtime" as a literal. Exactly one ` +
        `should: packages/server/src/metadata-namespaces.ts, which defines it and ` +
        `derives the predicate that decides whether a write to it reaches a client. ` +
        `A second spelling is a place the two can separate with nothing red — which ` +
        `is how three of them arrived. Import RUNTIME_NAMESPACE instead, and build a ` +
        `subtree from it (\`\${RUNTIME_NAMESPACE}.idempotency\`) rather than writing ` +
        `it out. If the site genuinely cannot import — third-party manifest text, a ` +
        `package that cannot depend on the server — add it to ALLOWED with the reason.`,
    ).toEqual(allowed);
  });
});
