/**
 * The union of every symbol a package's source modules export, and what its
 * root offers.
 *
 * Source rather than `dist`, because the built declaration only carries the
 * root's surface — the question here is what the modules behind it export,
 * which is only visible before bundling.
 *
 * Test files are excluded. A test module's exports are fixtures and helpers
 * and nobody expects them on a package root.
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

const ROOT_MODULE = "index.ts";

function exportedNames(file: string): string[] {
  const program = ts.createProgram([file], {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    skipLibCheck: true,
  });
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(file);
  if (!source) throw new Error(`could not load ${file}`);
  const symbol = checker.getSymbolAtLocation(source);
  // A module with no exports has no module symbol, which is a legitimate
  // shape for a file of side effects.
  if (!symbol) return [];
  return checker.getExportsOfModule(symbol).map((s) => s.getName());
}

export interface PackageExportSurfaces {
  /** Every name exported by a non-test module other than the root. */
  moduleExports: string[];
  /** What the package root offers. */
  rootExports: string[];
}

/** Read both surfaces from a package's `src` directory. */
export function readPackageExportSurfaces(
  srcDir: string,
): PackageExportSurfaces {
  const rootPath = join(srcDir, ROOT_MODULE);
  const rootExports = exportedNames(rootPath);

  const modules = new Set<string>();
  for (const entry of readdirSync(srcDir)) {
    if (!entry.endsWith(".ts")) continue;
    if (entry.endsWith(".test.ts")) continue;
    if (entry === ROOT_MODULE) continue;
    for (const name of exportedNames(join(srcDir, entry))) modules.add(name);
  }

  return {
    moduleExports: [...modules].sort(),
    rootExports: rootExports.sort(),
  };
}
