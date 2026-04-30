import { defineConfig } from "tsup";

export default defineConfig({
  // Two entry points so ./auth tree-shakes independently of the data
  // root. Headless consumers (CLI, MCP, sync agent) that only need the
  // root path don't pull the auth subpath; browser apps that need OAuth
  // pull both.
  entry: ["src/index.ts", "src/auth/index.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  target: "node20",
});
