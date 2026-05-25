// Post-build: inline @withmarfa/types declarations into dist/index.d.ts.
//
// tsup's noExternal bundles @withmarfa/types into the JS output, but its dts
// emitter leaves the import/re-export of "@withmarfa/types" intact. Because
// @withmarfa/types is `private` and never published, npm consumers of
// @withmarfa/shared resolve those declarations to `any` under skipLibCheck.
//
// This script reads the pre-built @withmarfa/types dist/index.d.ts, strips its
// trailing export clause, and splices its declarations into the shared
// package's dist/index.d.ts in place of the "@withmarfa/types" import. The
// re-export clause is rewritten to drop the `from '@withmarfa/types'` suffix.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const sharedDts = resolve(here, "../dist/index.d.ts");
const typesDts = resolve(here, "../../types/dist/index.d.ts");

const sharedContent = readFileSync(sharedDts, "utf8");
const typesContent = readFileSync(typesDts, "utf8");

const EXTERNAL = "@withmarfa/types";

if (!sharedContent.includes(EXTERNAL)) {
  console.log(`[inline-types-dts] ${sharedDts} already inlined, nothing to do`);
  process.exit(0);
}

// Strip the trailing `export { ... };` clause from the types dist so only the
// bare declarations remain.
const typesDeclarations = typesContent
  .replace(/\nexport \{[\s\S]*?\};\s*$/m, "\n")
  .trimEnd();

// Match the single "import { ... } from '@withmarfa/types';" line.
const importRe = /^import \{([^}]+)\} from ['"]@withmarfa\/types['"];\s*$/m;
// Match the single "export { ... } from '@withmarfa/types';" line.
const reexportRe = /^export \{([^}]+)\} from ['"]@withmarfa\/types['"];\s*$/m;

const importMatch = sharedContent.match(importRe);
const reexportMatch = sharedContent.match(reexportRe);

if (!importMatch || !reexportMatch) {
  console.error(
    `[inline-types-dts] expected both an import and an export from '${EXTERNAL}' in ${sharedDts}; aborting`,
  );
  process.exit(1);
}

// Remove the import line entirely — declarations will be spliced in at the top.
// Rewrite the re-export to a bare `export { ... };`. The types we splice in
// are already declared at the top of the file, so this becomes a local
// re-export of those declarations.
let rewritten = sharedContent
  .replace(importRe, "")
  .replace(reexportRe, `export {${reexportMatch[1]}};`);

rewritten = `${typesDeclarations}\n\n${rewritten.replace(/^\s*\n/, "")}`;

if (rewritten.includes(EXTERNAL)) {
  console.error(
    `[inline-types-dts] ${sharedDts} still references '${EXTERNAL}' after rewrite; aborting`,
  );
  process.exit(1);
}

writeFileSync(sharedDts, rewritten);
console.log(
  `[inline-types-dts] inlined ${EXTERNAL} declarations into ${sharedDts}`,
);
