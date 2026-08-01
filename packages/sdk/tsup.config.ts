import { defineConfig } from "tsup";

export default defineConfig({
  // Separate entry points so each subpath tree-shakes independently of the
  // data root. Headless consumers (CLI, MCP, sync agent) that only need the
  // root path don't pull the auth subpath; browser apps that need OAuth pull
  // ./auth but never ./auth/node, which is the only entry touching node:fs
  // (the shared ~/.marfa credential store).
  entry: ["src/index.ts", "src/auth/index.ts", "src/auth/node/index.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  target: "node20",
});
