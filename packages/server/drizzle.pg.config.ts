import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/storage/pg/schema.ts",
  out: "./drizzle/pg",
});
