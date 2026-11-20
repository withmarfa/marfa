import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  bindingFolderHarness,
  folderTold,
  type BindingFolderHarness,
} from "./binding-folders.shared.js";
import { EdgeDoor, scriptFolderWrites, sentTitles } from "./folders.shared.js";

/**
 * A watch's passes counted over a fixed time on the engine's manual clock,
 * where the server cannot be reached and where it answers.
 */

const made: BindingFolderHarness[] = [];
afterEach(async () => {
  for (const harness of made.splice(0).reverse()) await harness.stop();
});

const SECOND = 1_000;

async function watched(label: string) {
  const edges = new EdgeDoor();
  const harness = await bindingFolderHarness(label, {
    settings: { query: { types: ["core.note"] } },
    events: [edges.stream()],
  });
  made.push(harness);
  scriptFolderWrites(harness, { edges });
  const synced = await harness.bound.sync();
  expect(synced.ok, JSON.stringify(synced)).toBe(true);
  return harness;
}

/** Moves the clock a second at a time, letting the watch take each step. */
async function seconds(
  harness: BindingFolderHarness,
  count: number,
): Promise<void> {
  for (let second = 0; second < count; second += 1) {
    await harness.device.clock.advance(SECOND);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function passes(harness: BindingFolderHarness): Promise<number> {
  return harness.device.hooks.reached("folder-pass-start");
}

it("spaces passes that keep failing by a wait that doubles to five minutes, and runs one soon after a change on disk", async () => {
  const harness = await watched("binding-folder-backoff");
  await harness.server.offline();
  writeFileSync(
    join(harness.dir, "Waiting.md"),
    "---\ntitle: Waiting\n---\nfor a server that cannot be reached\n",
  );
  const watch = await harness.bound.watch();
  await folderTold(watch, "watching");
  const from = await passes(harness);
  await seconds(harness, 590);
  const failing = (await passes(harness)) - from;
  // The witness: the passes ran, and found the server cannot be reached.
  expect(failing).toBeGreaterThanOrEqual(2);
  // One second doubling to five minutes allows ten passes in 590 seconds.
  expect(failing).toBeLessThanOrEqual(12);
  writeFileSync(join(harness.dir, "Changed.md"), "a change on disk\n");
  await vi.waitFor(
    async () => {
      await seconds(harness, 1);
      expect(await passes(harness)).toBeGreaterThan(from + failing);
    },
    { timeout: 10_000, interval: 10 },
  );
  expect(watch.isOver).toBe(false);
});

it("leaves a folder at rest with no pass but its full pass, and sends a change on disk within seconds", async () => {
  const harness = await watched("binding-folder-at-rest");
  const watch = await harness.bound.watch();
  await folderTold(watch, "watching");
  await seconds(harness, 5);
  const from = await passes(harness);
  await seconds(harness, 590);
  expect((await passes(harness)) - from).toBeLessThanOrEqual(1);
  writeFileSync(
    join(harness.dir, "Sent.md"),
    "---\ntitle: Sent\n---\nwritten while watched\n",
  );
  await vi.waitFor(
    async () => {
      await seconds(harness, 1);
      expect(sentTitles(harness)).toEqual(["Sent"]);
    },
    { timeout: 10_000, interval: 10 },
  );
  expect(watch.isOver).toBe(false);
});
