import { expect } from "vitest";
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

/** The lines of a refusal over settings, one per setting, as the log has
 *  them: what follows the heading. */
export function settingLines(refused: RefusedBoot): string[] {
  const [heading, ...lines] = refusalText(refused).split("\n");
  expect(heading).toBe("The server cannot start; fix these settings:");
  return lines.map((line) => line.trim());
}
