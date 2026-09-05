import { defineConfig } from "tsup";

export default defineConfig({
  // Separate entry points so each subpath tree-shakes independently of the
  // data root. Headless consumers (CLI, MCP, sync agent) that only need the
  // root path don't pull the auth subpath; browser apps that need OAuth pull
  // ./auth but never ./auth/node, which is the only entry touching node:fs
  // (the shared ~/.marfa credential store).
  //
  // The three electron entries split for a harder reason than tree-shaking. A
  // sandboxed preload is bundled into one file and given a `require` that
  // resolves `electron` and a few builtins and nothing else, so it cannot
  // load a native addon under any circumstances. An app bundling its preload
  // against a single combined entry would pull the store — and
  // `@libsql/client` with it — into exactly that context. The renderer entry
  // is the third: a page can load neither of the other two, so what it
  // shares with them (the channel names, the bridge's type, the helper that
  // reads a refusal's class back out of a message) lives somewhere with no
  // imports at all.
  entry: [
    "src/index.ts",
    "src/auth/index.ts",
    "src/auth/node/index.ts",
    "src/replica/index.ts",
    "src/local/index.ts",
    "src/electron/index.ts",
    "src/electron/preload/index.ts",
    "src/electron/renderer/index.ts",
  ],
  format: ["esm"],
  // Optional peers: bundling one would defeat the point of the subpath, and
  // for the two the local engine takes it would also duplicate a native
  // addon and drizzle's module-level state. `electron` is not a package that
  // can be bundled at all — the host process supplies it — so the preload
  // entry has to reach it by name.
  external: ["@tanstack/db", "@libsql/client", "drizzle-orm", "electron"],
  dts: true,
  clean: true,
  target: "node20",
});
