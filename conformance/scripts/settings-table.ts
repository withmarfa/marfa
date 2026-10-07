/**
 * Write the settings table into the instance chapter from the server's
 * settings schema, so the chapter cannot differ from what the server reads:
 *
 *   tsx scripts/settings-table.ts
 *
 * `ci/settings-table.test.ts` fails when the chapter differs from what this
 * writes. Like the repository's other generators, this one reads the server
 * by path; nothing under `src/suites/` may.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describeSettings } from "../../packages/server/src/config.js";
import { withSettingsTable } from "../src/utils/settings-table.js";

const CHAPTER = fileURLToPath(new URL("../spec/instance.md", import.meta.url));

writeFileSync(
  CHAPTER,
  withSettingsTable(readFileSync(CHAPTER, "utf8"), describeSettings()),
);
