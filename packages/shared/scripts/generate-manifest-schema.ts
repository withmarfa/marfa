#!/usr/bin/env tsx
/**
 * Codegen for the Integration manifest JSON Schema artifact.
 *
 * Reads the canonical Zod schema from
 * `packages/shared/src/integration-manifest.ts`, runs it through Zod 4's
 * built-in `z.toJSONSchema` in its input view, and writes the result to
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

// The INPUT view, which is what a manifest author writes.
//
// Zod's default is the output view, where a field carrying `.default()` is
// required because the parsed value always has it. That is true of the
// parse result and false of the document: the platform accepts a manifest
// with no `runs_on` and resolves it to "server", while an output-view
// artifact tells a third party the field is mandatory. The two published
// surfaces then disagree about the same contract.
//
// This was already wrong before `runs_on` existed — `echo_ttl_seconds` and
// `lag_window_seconds` have carried `.default(60)` and been listed as
// required since the block was written, so the artifact has always
// over-stated what an author must supply. Fixing it here rather than
// leaving one more instance of it is the same correction the rest of this
// change is making: a published surface states what is true.
const json = z.toJSONSchema(IntegrationManifestSchema, { io: "input" });

const outputPath = resolve(
  __dirname,
  "..",
  "..",
  "types",
  "integration-manifest-schema.json",
);

writeFileSync(outputPath, JSON.stringify(json, null, 2) + "\n", "utf8");

console.log(`Wrote Integration manifest JSON Schema → ${outputPath}`);
