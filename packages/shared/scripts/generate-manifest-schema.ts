#!/usr/bin/env tsx
/**
 * Codegen for the Integration manifest JSON Schema artifact.
 *
 * Reads the canonical Zod schema from
 * `packages/shared/src/integration-manifest.ts`, runs it through Zod 4's
 * built-in `z.toJSONSchema`, and writes the result to
 * `packages/types/integration-manifest-schema.json`.
 *
 * Wired into `packages/shared/package.json`'s `prebuild` so a fresh
 * `pnpm build` keeps the artifact in sync with the source. The drift test
 * in `integration-manifest.test.ts` re-runs the conversion in-memory and
 * byte-compares against the committed file. Determinism is guaranteed by:
 *   - Pinning Zod through workspace resolution (`zod: ^4.3.6` resolves to
 *     a single hoisted version per pnpm-lock).
 *   - Using `JSON.stringify(..., null, 2)` with a trailing newline.
 *   - Not invoking any other JSON Schema converter — Zod's output is the
 *     single source of truth.
 *
 * If a Zod minor bump shifts JSON Schema output (e.g. a new `minimum`
 * default surfaces), the drift test catches it on the bump PR; the fix
 * is to re-run codegen and commit the delta.
 */
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { IntegrationManifestSchema } from "../src/integration-manifest.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const json = z.toJSONSchema(IntegrationManifestSchema);

const outputPath = resolve(
  __dirname,
  "..",
  "..",
  "types",
  "integration-manifest-schema.json",
);

writeFileSync(outputPath, JSON.stringify(json, null, 2) + "\n", "utf8");

console.log(`Wrote Integration manifest JSON Schema → ${outputPath}`);
