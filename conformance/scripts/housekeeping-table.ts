import { readFileSync, writeFileSync } from "node:fs";
import { HOUSEKEEPING_JOBS } from "../../packages/server/src/housekeeping/metadata.js";
import { withHousekeepingTable } from "../src/utils/housekeeping-table.js";

const chapter = new URL("../spec/housekeeping.md", import.meta.url);
writeFileSync(
  chapter,
  withHousekeepingTable(
    readFileSync(chapter, "utf8"),
    Object.values(HOUSEKEEPING_JOBS),
  ),
);
