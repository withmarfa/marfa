import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/storage/sqlite/schema.ts",
  out: "./drizzle/sqlite",
});
