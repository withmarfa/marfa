import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  target: "node20",
  // Inline @withmarfa/types into the JS bundle: the server's production
  // install carries this package's dependencies and not its devDependencies,
  // which is where the types package sits.
  noExternal: ["@withmarfa/types"],
});
