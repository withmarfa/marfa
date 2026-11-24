import { createHash } from "node:crypto";
import { expect } from "vitest";
import type { RefusedBoot } from "./fresh-server.js";
import { groupOf, signalGroup } from "./server-process.js";
import { isRunning, onCleanup } from "./temp-folder.js";

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

/** The hash of an empty file. */
export const EMPTY_FILE = createHash("sha256").update("").digest("hex");

/**
 * The database file is byte for byte what it was, and the log beside it holds
 * nothing: opening a database in write-ahead mode makes an empty log and an
 * index of it even when the open is refused, and neither is a change to what
 * the database holds.
 */
export function expectDatabaseUnchanged(refused: RefusedBoot): void {
  expect(refused.after.db).toBe(refused.before.db);
  expect(["absent", EMPTY_FILE]).toContain(refused.after.wal);
}

/**
 * Stops the server started on `state` with `bootUnclaimedServer` if the run is
 * interrupted before the fixture stopped it. The server leads its own process
 * group, which its pid file names; a pid file the fixture already removed, or
 * one naming a process that has ended, stops nothing.
 */
export function stopServerAtCleanup(state: string): void {
  onCleanup(() => {
    let group: number;
    try {
      group = groupOf(state);
    } catch {
      return;
    }
    if (!isRunning(group)) return;
    signalGroup(group, "SIGTERM");
    const deadline = Date.now() + 5_000;
    while (isRunning(group) && Date.now() < deadline) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
    if (isRunning(group)) signalGroup(group, "SIGKILL");
  });
}
