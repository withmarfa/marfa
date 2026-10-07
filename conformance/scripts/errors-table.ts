/**
 * Write the table of codes into the errors chapter from the server's code
 * table, so the chapter cannot differ from what the server answers:
 *
 *   tsx scripts/errors-table.ts
 *
 * `ci/errors-table.test.ts` fails when the chapter differs from what this
 * writes. Like the repository's other generators, this one reads the server
 * by path; nothing under `src/suites/` may.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ERROR_CODES } from "../../packages/shared/src/errors.js";
import { errorRows, withErrorsTable } from "../src/utils/errors-table.js";

const CHAPTER = fileURLToPath(new URL("../spec/errors.md", import.meta.url));

writeFileSync(
  CHAPTER,
  withErrorsTable(readFileSync(CHAPTER, "utf8"), errorRows(ERROR_CODES)),
);
