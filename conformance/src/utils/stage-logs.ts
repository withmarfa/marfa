import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { FRESH_SERVER_LOGS } from "./fresh-server.js";
import { redactSetupProof } from "./target.js";

/**
 * Copies what a state directory's servers wrote, each file with the setup
 * proof taken out, into a folder a workflow may upload. The originals hold
 * the live code and ticket of an instance with no owner, and an artifact is
 * read by anyone with access to the run. Returns the files it wrote.
 */
export function stageLogs(state: string, to: string): string[] {
  const names = ["server.log", "server.stderr"];
  const kept = join(state, FRESH_SERVER_LOGS);
  if (existsSync(kept)) {
    for (const entry of readdirSync(kept, { recursive: true })) {
      names.push(join(FRESH_SERVER_LOGS, String(entry)));
    }
  }
  const written: string[] = [];
  for (const name of names) {
    const source = join(state, name);
    if (!existsSync(source) || !statSync(source).isFile()) continue;
    const target = join(to, name);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, redactSetupProof(readFileSync(source, "utf8")));
    written.push(name);
  }
  return written;
}
