/**
 * Read every publishable package's export surface off the built tree.
 *
 * A package is publishable when its `package.json` does not say
 * `"private": true`, which is the same test the release workflow makes.
 * Deriving the set rather than listing it means a new published package is
 * locked the day it appears instead of the day somebody remembers to add it
 * here.
 *
 * Every entry point counts, not just the root, so that adding a subpath
 * export does not quietly widen the surface without widening the lock. An
 * entry point that names no type
 * declarations is an error rather than a skip: dropping one silently
 * leaves a smaller surface that still hashes consistently and passes
 * forever, which is the failure this whole file is built against.
 *
 * A surface is the exported names and the declaration emitted for each,
 * because a name on its own says nothing about what a consumer compiles
 * against: a union that gains a member, a function that gains a parameter
 * and an interface that changes a field type all move the contract and no
 * name at all.
 *
 * This reads `dist`, so the tree has to have been built. Every lane that
 * runs the suite builds first, and a missing declaration is reported as
 * such rather than silently read as an empty surface — an empty surface
 * would hash consistently and pass forever.
 */
import { readFileSync, existsSync, readdirSync, realpathSync } from "node:fs";
import { resolve, join, sep } from "node:path";
import ts from "typescript";
import type { PackageSurface, SurfaceExport } from "./published-surface.js";

interface PackageJson {
  name?: string;
  private?: boolean;
  exports?: Record<string, unknown>;
}

/**
 * Every `types` an entry condition names, at any depth.
 *
 * Conditions nest: `{"import": {"types": "...", "default": "..."}}` is as
 * ordinary as the flat form, and reading only a top-level `types` would
 * find nothing in it and report nothing about it.
 */
function typesIn(entry: unknown): string[] {
  if (entry === null || typeof entry !== "object") return [];
  const out: string[] = [];
  for (const [key, value] of Object.entries(entry as Record<string, unknown>)) {
    if (key === "types" && typeof value === "string") out.push(value);
    else out.push(...typesIn(value));
  }
  return out;
}

/** One entry point: the subpath consumers import, and the file it types. */
interface EntryPoint {
  subpath: string;
  file: string;
}

/**
 * The declaration files a package's `exports` map points at, each paired
 * with the subpath that reaches it.
 *
 * The subpath is carried rather than discarded because it is half the
 * contract. A name is only importable through the subpath that exports
 * it, so renaming `"./auth"` to `"./authentication"` breaks every
 * consumer while leaving the file, the names and the declarations
 * untouched. Recording the file alone would hash that change to nothing.
 */
function entryDeclarations(
  pkgDir: string,
  pkg: PackageJson,
  pkgName: string,
): EntryPoint[] {
  const out: EntryPoint[] = [];
  for (const [subpath, entry] of Object.entries(pkg.exports ?? {})) {
    // `null` is how an exports map blocks a subpath. It offers nothing, so
    // there is nothing to record and nothing to complain about.
    if (entry === null) continue;
    // A target naming a JSON file has no type surface by construction;
    // `"./package.json": "./package.json"` is the common one.
    if (typeof entry === "string" && entry.endsWith(".json")) continue;

    const types = typesIn(entry);
    if (types.length === 0) {
      throw new Error(
        `${pkgName}: the "${subpath}" entry point offers a module and names no type declarations, so its surface would go unrecorded while the rest of the package still hashed and passed. Give it a "types" condition, or stop exporting it.`,
      );
    }
    for (const t of types) out.push({ subpath, file: resolve(pkgDir, t) });
  }
  return out;
}

/**
 * Whether a file sits inside a directory, with the file's path resolved
 * through any symlink. The directory is resolved by the caller, once,
 * rather than here on every comparison.
 *
 * The compiler reports a resolved path for anything it reached through
 * an import and the path it was handed for the entry point itself, so a
 * checkout under a symlinked directory can have the two disagree. When
 * they disagree every file looks external, the walk collapses to root
 * declarations, and nothing reports it — a smaller surface that still
 * hashes consistently and passes forever.
 */
const REAL_PATHS = new Map<string, string>();

function realPath(filePath: string): string {
  const cached = REAL_PATHS.get(filePath);
  if (cached !== undefined) return cached;
  let resolved: string;
  try {
    resolved = realpathSync(filePath);
  } catch {
    resolved = filePath;
  }
  REAL_PATHS.set(filePath, resolved);
  return resolved;
}

function isInside(filePath: string, dir: string): boolean {
  const real = realPath(filePath);
  return real.startsWith(dir.endsWith(sep) ? dir : dir + sep);
}

/** Follow `export { x } from "..."` and `export *` back to what they name. */
function resolveAlias(checker: ts.TypeChecker, symbol: ts.Symbol): ts.Symbol {
  return symbol.flags & ts.SymbolFlags.Alias
    ? checker.getAliasedSymbol(symbol)
    : symbol;
}

/**
 * Render a declaration without its comments.
 *
 * The compiler's printer rather than the source text, because `getText`
 * drops only the trivia in front of a node: a comment on an interface
 * FIELD sits inside the declaration and would be hashed with it, so
 * rewording one would report a changed contract and send somebody to the
 * generator. That is the reflexive regeneration this guard cannot afford.
 * Printing also normalizes indentation, so how the emitter happened to lay
 * the file out does not reach the digest either.
 */
const PRINTER = ts.createPrinter({ removeComments: true });

function declarationText(declaration: ts.Node): string {
  const printed = PRINTER.printNode(
    ts.EmitHint.Unspecified,
    declaration,
    declaration.getSourceFile(),
  );
  // The keyword lives on the enclosing declaration list, not on the
  // declaration a symbol points at, and the printer emits only what it is
  // handed. So `const X: string` and `let X: string` printed identically,
  // and widening a binding — which breaks any consumer relying on it
  // being fixed — moved no hash at all.
  //
  // The keyword is prefixed rather than the whole statement printed,
  // because one statement can declare several exports and printing it for
  // each would hash a sibling's text into every one of them.
  if (ts.isVariableDeclaration(declaration)) {
    const flags = ts.getCombinedNodeFlags(declaration);
    const keyword =
      flags & ts.NodeFlags.Let
        ? "let"
        : flags & ts.NodeFlags.Const
          ? "const"
          : "var";
    return `${keyword} ${printed}`;
  }
  return printed;
}

/**
 * The symbols a declaration names in type position.
 *
 * Type references, heritage clauses, `typeof` queries and `import("...")`
 * types. Walking every identifier instead would resolve property names to
 * their own declarations and fold each one into the text a second time,
 * which inflates the digest without telling it anything new.
 */
function referencedSymbols(
  checker: ts.TypeChecker,
  declaration: ts.Node,
): ts.Symbol[] {
  const found: ts.Symbol[] = [];
  const visit = (node: ts.Node): void => {
    const named = ts.isTypeReferenceNode(node)
      ? node.typeName
      : ts.isExpressionWithTypeArguments(node)
        ? node.expression
        : ts.isTypeQueryNode(node)
          ? node.exprName
          : ts.isImportTypeNode(node)
            ? node.qualifier
            : undefined;
    if (named) {
      const symbol = checker.getSymbolAtLocation(named);
      if (symbol) found.push(resolveAlias(checker, symbol));
    }
    ts.forEachChild(node, visit);
  };
  visit(declaration);
  return found;
}

/**
 * Everything a consumer compiles against when it uses one export.
 *
 * The export's own declaration, plus the declarations of anything it names
 * that the package emits itself. An exported interface whose field is typed
 * by a helper declared beside it and never exported still shows that
 * helper's shape to a consumer, so a change to it is a change to this
 * export.
 *
 * The walk stops at declarations the package does not emit. What a package
 * re-exports from a dependency is covered — its text is the declaration a
 * consumer sees — but a dependency's private internals are not expanded
 * into this package's hash, because expanding them would move this hash
 * for changes this package does not expose.
 *
 * Texts are sorted and JSON-encoded so the digest depends neither on the
 * order the walk reached them nor on a separator a declaration could
 * itself contain. The visited set is per export, so two exports sharing a
 * helper each carry it rather than the first one reached claiming it.
 */
function contractTextOf(
  checker: ts.TypeChecker,
  exported: ts.Symbol,
  pkgDir: string,
): string {
  const texts: string[] = [];
  const seen = new Set<ts.Node>();
  const queue: ts.Symbol[] = [resolveAlias(checker, exported)];

  // The queue grows while it is being walked. Iterating an array reads
  // its length on every step, so a symbol pushed below is reached by
  // this same loop rather than needing a second pass.
  for (const current of queue) {
    for (const declaration of current.getDeclarations() ?? []) {
      if (seen.has(declaration)) continue;
      seen.add(declaration);
      const file = declaration.getSourceFile();
      texts.push(declarationText(declaration));
      if (!isInside(file.fileName, pkgDir)) continue;
      for (const referenced of referencedSymbols(checker, declaration)) {
        if (referenced.flags & ts.SymbolFlags.TypeParameter) continue;
        const refDeclarations = referenced.getDeclarations() ?? [];
        // `some`, not `every`: an interface this package declares and a
        // dependency also declares is merged by the compiler, and both
        // halves are what a consumer sees.
        if (
          refDeclarations.some((d) =>
            isInside(d.getSourceFile().fileName, pkgDir),
          )
        ) {
          queue.push(referenced);
        }
      }
    }
  }

  return JSON.stringify(texts.sort());
}

/**
 * The exports of one declaration file, types included.
 *
 * The compiler's own view rather than a parse of the text, because a
 * re-exported name has to be resolved to the declaration it actually
 * names. Reading the file's own statements would record the specifier —
 * `B as BulkActionErrorEntry` — rather than the shape a consumer
 * compiles against, which collapses the surface back to names and is the
 * defect this guard exists to close. Every root export of two of these
 * packages arrives that way.
 */
function surfaceExportsOf(dtsPath: string, pkgDir: string): SurfaceExport[] {
  const program = ts.createProgram([dtsPath], {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    skipLibCheck: true,
  });
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(dtsPath);
  if (!source) throw new Error(`could not load ${dtsPath}`);
  const symbol = checker.getSymbolAtLocation(source);
  if (!symbol) throw new Error(`${dtsPath} is not a module`);
  return checker.getExportsOfModule(symbol).map((exported) => ({
    name: exported.getName(),
    declaration: contractTextOf(checker, exported, pkgDir),
  }));
}

/** Every publishable package's surface, read from `packagesDir`. */
export function readPublishedSurfaces(packagesDir: string): PackageSurface[] {
  const surfaces: PackageSurface[] = [];

  for (const dir of readdirSync(packagesDir)) {
    const pkgDir = join(packagesDir, dir);
    const pkgPath = join(pkgDir, "package.json");
    if (!existsSync(pkgPath)) continue;
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as PackageJson;
    if (pkg.private === true) continue;
    if (!pkg.name) continue;

    const pkgRoot = realPath(resolve(pkgDir));
    const entryPoints = entryDeclarations(pkgDir, pkg, pkg.name);
    if (entryPoints.length === 0) {
      throw new Error(
        `${pkg.name} is publishable and its exports map names no type declarations; the lock would record an empty surface`,
      );
    }

    // Keyed by name so a name reachable from two entry points is one
    // export, and carrying a set so two entry points exporting the same
    // name for different things is a difference the hash can see rather
    // than one of them winning.
    const exported = new Map<string, Set<string>>();
    for (const { subpath, file } of entryPoints) {
      if (!existsSync(file)) {
        throw new Error(
          `${pkg.name}: ${file} is missing. Run \`pnpm build\` before reading published surfaces — an unbuilt tree would lock an empty surface and pass forever.`,
        );
      }
      for (const e of surfaceExportsOf(file, pkgRoot)) {
        const texts = exported.get(e.name) ?? new Set<string>();
        // Paired with its subpath, so moving a name from one entry point
        // to another moves the hash even when the declaration is
        // identical. Unpaired, that move was invisible.
        texts.add(JSON.stringify([subpath, e.declaration]));
        exported.set(e.name, texts);
      }
    }

    surfaces.push({
      name: pkg.name,
      exports: [...exported].map(([name, texts]) => ({
        name,
        declaration: JSON.stringify([...texts].sort()),
      })),
    });
  }

  return surfaces;
}
