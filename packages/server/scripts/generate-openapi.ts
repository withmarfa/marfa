/**
 * Generate the OpenAPI spec from route definitions.
 *
 * Usage: pnpm --filter @withmarfa/server run generate:openapi
 *
 * Outputs the OpenAPI JSON to stdout. Redirect to a file:
 *   pnpm --filter @withmarfa/server run generate:openapi > openapi.json
 *
 * The assembly lives in `src/openapi-published.ts` so the committed spec and
 * the tests that guard it share one code path.
 */

import { buildPublishedOpenAPISpec } from "../src/openapi-published.js";

console.log(JSON.stringify(await buildPublishedOpenAPISpec(), null, 2));
