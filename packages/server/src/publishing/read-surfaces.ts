/**
 * Read every publishable package's export surface off the built tree.
 *
 * A package is publishable when its `package.json` does not say
 * `"private": true`, which is the same test the publish workflow makes by
 * having a step per package. Deriving the set rather than listing it means
 * a new published package is locked the day it appears instead of the day
 * somebody remembers to add it here.
 *
 * Every entry point counts, not just the root. `@withmarfa/sdk` exposes
 * four, and a consumer importing `@withmarfa/sdk/auth` is holding a
 * contract as real as the root's.
 *
 * This reads `dist`, so the tree has to have been built. Every lane that
 * runs the suite builds first, and a missing declaration is reported as
 * such rather than silently read as an empty surface — an empty surface
 * would hash consistently and pass forever.
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";
import ts from "typescript";
import type { PackageSurface } from "./published-surface.js";

interface PackageJson {
  name?: string;
  version?: string;
  private?: boolean;
  exports?: Record<string, { types?: string } | string>;
}

/** The declaration files a package's `exports` map points at. */
function entryDeclarations(pkgDir: string, pkg: PackageJson): string[] {
  const out: string[] = [];
  for (const entry of Object.values(pkg.exports ?? {})) {
    const types = typeof entry === "string" ? undefined : entry.types;
    if (types) out.push(resolve(pkgDir, types));
  }
  return out;
}

/**
 * The exported names of one declaration file, types included.
 *
 * The compiler's own view rather than a parse of the text: a re-export
 * through `export *` contributes its names here and would be invisible to
 * anything reading the file's own statements, and `export *` is how three
 * of these packages assemble their root.
 */
function exportNamesOf(dtsPath: string): string[] {
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
  return checker.getExportsOfModule(symbol).map((s) => s.getName());
}

/** Every publishable package's surface, read from `packagesDir`. */
export function readPublishedSurfaces(packagesDir: string): PackageSurface[] {
  const surfaces: PackageSurface[] = [];

  for (const dir of readdirSync(packagesDir)) {
    const pkgPath = join(packagesDir, dir, "package.json");
    if (!existsSync(pkgPath)) continue;
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as PackageJson;
    if (pkg.private === true) continue;
    if (!pkg.name || !pkg.version) continue;

    const declarations = entryDeclarations(join(packagesDir, dir), pkg);
    if (declarations.length === 0) {
      throw new Error(
        `${pkg.name} is publishable and its exports map names no type declarations; the lock would record an empty surface`,
      );
    }

    const names = new Set<string>();
    for (const dts of declarations) {
      if (!existsSync(dts)) {
        throw new Error(
          `${pkg.name}: ${dts} is missing. Run \`pnpm build\` before reading published surfaces — an unbuilt tree would lock an empty surface and pass forever.`,
        );
      }
      for (const n of exportNamesOf(dts)) names.add(n);
    }

    surfaces.push({
      name: pkg.name,
      version: pkg.version,
      exportNames: [...names].sort(),
    });
  }

  return surfaces;
}
