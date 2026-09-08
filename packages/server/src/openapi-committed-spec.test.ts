/**
 * The committed `openapi.json` is what the routes currently say.
 *
 * **Nothing checked this, and the drift it allows is silent in both
 * directions.** The spec is generated from the route definitions and committed
 * at the repository root, where the docs site and every external consumer read
 * it. A route description edited without regenerating leaves the published file
 * describing a door that no longer behaves that way; a regeneration that does
 * not land leaves the same gap with the edit apparently done.
 *
 * The second half is not hypothetical. `generate:openapi` writes to **stdout**,
 * so regenerating means `... > openapi.json` and a run without the redirect
 * prints the whole spec and changes nothing — while exiting 0, which reads as
 * success. That happened twice in one sitting during the one-permission-model
 * change, and the false claims it left were caught by eye rather than by
 * anything here.
 *
 * Compared as parsed JSON rather than as text, so the failure is about content
 * and not about a trailing newline. The generator is deterministic — a plain
 * `JSON.stringify(spec, null, 2)` over route definitions — so any difference at
 * all is real drift.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { buildPublishedOpenAPISpec } from "./openapi-published.js";

const COMMITTED = new URL("../../../openapi.json", import.meta.url);

describe("the committed OpenAPI spec", () => {
  it("matches what the route definitions produce", async () => {
    const generated = await buildPublishedOpenAPISpec();
    const committed: unknown = JSON.parse(readFileSync(COMMITTED, "utf8"));

    // Paths first, and named individually. The whole-document comparison below
    // is the assertion that matters, but its diff on a large spec is unreadable
    // — this one says which door moved.
    const pathsOf = (spec: unknown): string[] =>
      Object.keys(
        (spec as { paths?: Record<string, unknown> }).paths ?? {},
      ).sort();
    expect(pathsOf(committed)).toEqual(pathsOf(generated));

    expect(committed).toEqual(generated);
  });

  it("is not empty, so the comparison above cannot pass on nothing", async () => {
    const generated = await buildPublishedOpenAPISpec();
    const paths =
      (generated as { paths?: Record<string, unknown> }).paths ?? {};
    expect(Object.keys(paths).length).toBeGreaterThan(50);
  });
});
