import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  bindingFolderHarness,
  type BindingFolderHarness,
} from "./binding-folders.shared.js";
import { scriptFolderWrites } from "./folders.shared.js";

/**
 * "A folder judges a drop of new files by how fast it arrives": the files sent
 * in the last ten minutes count with those a scan finds, on the clock the
 * device waits by.
 */

const made: BindingFolderHarness[] = [];
afterEach(async () => {
  for (const harness of made.splice(0).reverse()) await harness.stop();
});

const MINUTE = 60_000;

const note = (name: string): string => `---\ntitle: ${name}\n---\nbody\n`;

/** An empty folder past its first sync, at the default threshold. */
async function prepared(label: string): Promise<BindingFolderHarness> {
  const harness = await bindingFolderHarness(label, {
    settings: {
      query: { types: ["core.note"] },
      defaults: { type: "core.note" },
    },
  });
  made.push(harness);
  scriptFolderWrites(harness);
  const synced = await harness.bound.sync();
  expect(synced.ok, JSON.stringify(synced)).toBe(true);
  expect((await harness.bound.testOpen()).ok).toBe(true);
  return harness;
}

/** `count` new notes, named `<prefix>-<n>.md`. */
function copy(harness: BindingFolderHarness, prefix: string, count: number) {
  for (let n = 0; n < count; n += 1)
    writeFileSync(
      join(harness.dir, `${prefix}-${String(n)}.md`),
      note(`${prefix} ${String(n)}`),
    );
}

async function scanned(harness: BindingFolderHarness) {
  const scan = await harness.bound.testScan();
  expect(scan.ok, JSON.stringify(scan)).toBe(true);
  if (!scan.ok) throw new Error("scan refused");
  return scan.value;
}

describe("a drop of new files judged by its rate", () => {
  it("never holds a note saved every four minutes, however many there are", async () => {
    const harness = await prepared("binding-additions-slow-notes");
    for (let n = 0; n < 65; n += 1) {
      copy(harness, `note-${String(n)}`, 1);
      const scan = await scanned(harness);
      expect(
        [scan.created, scan.pausedAdditions],
        `note ${String(n)} was held`,
      ).toEqual([1, 0]);
      await harness.device.clock.advance(4 * MINUTE);
    }
    expect((await harness.bound.testClose()).ok).toBe(true);
  }, 120_000);

  it("holds a large copy that arrives in two bursts with an edit's scan between", async () => {
    const harness = await prepared("binding-additions-two-bursts");
    copy(harness, "first", 30);
    const first = await scanned(harness);
    expect([first.created, first.pausedAdditions]).toEqual([30, 0]);
    // A scan that takes in no new file must not end the drop.
    writeFileSync(join(harness.dir, "first-0.md"), note("first 0 edited"));
    const edit = await scanned(harness);
    expect(edit.created).toBe(0);
    await harness.device.clock.advance(3 * MINUTE);
    copy(harness, "second", 30);
    const second = await scanned(harness);
    expect(
      [second.created, second.pausedAdditions],
      "a copy in two bursts was sent in two pieces",
    ).toEqual([0, 30]);
    expect((await harness.bound.testClose()).ok).toBe(true);
  }, 120_000);

  it("sends the same two bursts when they are more than ten minutes apart", async () => {
    const harness = await prepared("binding-additions-two-drops");
    copy(harness, "first", 30);
    expect((await scanned(harness)).created).toBe(30);
    await harness.device.clock.advance(11 * MINUTE);
    copy(harness, "second", 30);
    const second = await scanned(harness);
    expect([second.created, second.pausedAdditions]).toEqual([30, 0]);
    expect((await harness.bound.testClose()).ok).toBe(true);
  }, 120_000);
});
