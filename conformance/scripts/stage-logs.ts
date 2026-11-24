/**
 * Stage the server logs of a run for upload, with the setup proof taken out:
 *
 *   tsx scripts/stage-logs.ts --state <dir> --to <dir>
 *
 * Run before `marfa:down`, which clears the state directory, and upload the
 * folder it fills, never the state directory itself.
 */
import { resolve } from "node:path";
import { stageLogs } from "../src/utils/stage-logs.js";

function argument(name: string): string {
  const at = process.argv.indexOf(name);
  const value = at === -1 ? undefined : process.argv[at + 1];
  if (value === undefined || value.startsWith("--")) {
    console.error(`${name} needs a folder`);
    process.exit(2);
  }
  return resolve(value);
}

const written = stageLogs(argument("--state"), argument("--to"));
console.log(`staged ${String(written.length)} log files without setup proof`);
