/**
 * Write `openapi.json` at the repository root from the route definitions.
 *
 * Run through the root's `pnpm generate`. The file is written here rather
 * than printed, so no hand step stands between the routes and the committed
 * document. The path is resolved from this file so the command works from
 * any directory.
 *
 * The assembly lives in `src/openapi-published.ts` so the committed document
 * and the tests that guard it share one code path.
 */

import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { buildPublishedOpenAPISpec } from "../src/openapi-published.js";

const target = fileURLToPath(new URL("../../../openapi.json", import.meta.url));

await writeFile(
  target,
  `${JSON.stringify(await buildPublishedOpenAPISpec(), null, 2)}\n`,
);
console.log(`openapi.json written from the routes`);
