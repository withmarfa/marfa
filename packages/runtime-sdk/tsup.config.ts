import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "cloudflare/index": "src/cloudflare/index.ts",
  },
  format: ["esm"],
  dts: true,
  clean: true,
  target: "es2022",
});
