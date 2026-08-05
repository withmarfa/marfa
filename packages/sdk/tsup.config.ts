import { defineConfig } from "tsup";

export default defineConfig({
  // Separate entry points so each subpath tree-shakes independently of the
  // data root. Headless consumers (CLI, MCP, sync agent) that only need the
  // root path don't pull the auth subpath; browser apps that need OAuth pull
  // ./auth but never ./auth/node, which is the only entry touching node:fs
  // (the shared ~/.marfa credential store).
  entry: [
    "src/index.ts",
    "src/auth/index.ts",
    "src/auth/node/index.ts",
    "src/replica/index.ts",
  ],
  format: ["esm"],
  // Optional peer: bundling it would defeat the point of the subpath.
  external: ["@tanstack/db"],
  dts: true,
  clean: true,
  target: "node20",
});
