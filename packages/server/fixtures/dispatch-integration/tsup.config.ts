/**
 * Deliberately identical to an integration's own tsup config, field for
 * field. The fixture exists to prove a bundling property, so a fixture
 * bundled any other way proves something about that other way instead.
 *
 * The `external` clause is the load-bearing line. It keeps
 * `@withmarfa/runtime-sdk` and `@withmarfa/shared` as bare specifiers in
 * the emitted `dist/local.js`, so the image has to resolve them upward to
 * the server's copies in `/app/node_modules` rather than the fixture
 * carrying its own. Inline them here and the fixture would still dispatch
 * — against a second registry that no server bundle ever reads, which is
 * exactly the failure the check exists to catch.
 */
import { defineConfig } from "tsup";

export default defineConfig({
  entry: { local: "src/local.ts" },
  format: ["esm"],
  target: "node20",
  dts: false,
  clean: true,
  external: ["@withmarfa/runtime-sdk", "@withmarfa/shared"],
});
