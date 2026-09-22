/**
 * Write `openapi.json` at the repository root from the route definitions.
 *
 * Run through the root's `pnpm generate`, which is the command that writes
 * what the document generates. It grows a leg per generated client as those
 * land.
 *
 * The file is written here rather than printed for a redirect to catch: a
 * redirect is a hand step, and a hand step is a way for the committed
 * document and the routes to differ. The path is resolved from this file so
 * the command works from any directory.
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
