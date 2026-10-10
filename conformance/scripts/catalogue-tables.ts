/**
 * Write the catalogues into the contract's chapters from the server's own
 * definitions, so the chapters cannot differ from what the server ships:
 *
 *   tsx scripts/catalogue-tables.ts
 *
 * `ci/catalogue-tables.test.ts` fails when a chapter differs from what this
 * writes. Like the repository's other generators, this one reads the server
 * by path; nothing under `src/suites/` may.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  CATALOGUES,
  CATALOGUE_CHAPTER,
  withTable,
} from "../src/utils/catalogue-tables.js";
import { catalogueTables } from "./catalogue-sources.js";

const tables = catalogueTables();

for (const name of CATALOGUES) {
  const chapter = fileURLToPath(
    new URL(`../spec/${CATALOGUE_CHAPTER[name]}`, import.meta.url),
  );
  writeFileSync(
    chapter,
    withTable(readFileSync(chapter, "utf8"), name, tables[name]),
  );
}
