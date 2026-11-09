import { expect } from "vitest";
import {
  contractSettingName,
  serverProgram,
} from "../../scripts/marfa-server.js";
import type { RefusedBoot } from "./fresh-server.js";

/** The text a refused boot logged as its reason, from the log's own line. */
export function refusalText(refused: RefusedBoot): string {
  for (const line of refused.output.split("\n")) {
    try {
      const entry = JSON.parse(line) as { message?: string; error?: string };
      if (entry.message === "Failed to start server") {
        return String(entry.error);
      }
    } catch {
      // Not a log line.
    }
  }
  throw new Error(`the server logged no refusal:\n${refused.output}`);
}

/** Whether the server got as far as listening, which is the one thing a
 *  refused boot must not do. */
export function listened(refused: RefusedBoot): boolean {
  return refused.output.includes("Marfa server listening");
}

/** The TypeScript server's line, with each setting under the contract's name.
 *  The text after `(got` is a value and is left as it is. */
function underContractNames(line: string): string {
  const at = line.indexOf(" (got ");
  const head = at < 0 ? line : line.slice(0, at);
  const tail = at < 0 ? "" : line.slice(at);
  return head.replace(/\b[A-Z][A-Z0-9_]*\b/g, contractSettingName) + tail;
}

/** The lines of a refusal over settings, one per setting, as the log has
 *  them: what follows the heading. */
export function settingLines(refused: RefusedBoot): string[] {
  const [heading, ...lines] = refusalText(refused).split("\n");
  expect(heading).toBe("The server cannot start; fix these settings:");
  const trimmed = lines.map((line) => line.trim());
  return serverProgram() === undefined
    ? trimmed.map(underContractNames)
    : trimmed;
}
