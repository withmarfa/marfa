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

  it("keeps a paused burst held after the window empties, and sends it once confirmed", async () => {
    const harness = await prepared("binding-additions-pause-waits");
    copy(harness, "first", 30);
    expect((await scanned(harness)).created).toBe(30);
    await harness.device.clock.advance(2 * MINUTE);
    copy(harness, "second", 30);
    expect((await scanned(harness)).pausedAdditions).toBe(30);
    await harness.device.clock.advance(20 * MINUTE);
    const later = await scanned(harness);
    expect(
      [later.created, later.pausedAdditions],
      "a pause let go by itself when the window emptied",
    ).toEqual([0, 30]);
    copy(harness, "third", 1);
    const joined = await scanned(harness);
    expect(
      [joined.created, joined.pausedAdditions],
      "a file that arrived during a pause was judged on its own",
    ).toEqual([0, 31]);
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

describe("a new file outside the query", () => {
  it("is held, shown in status and not counted towards the addition threshold", async () => {
    const harness = await bindingFolderHarness("binding-outside-query", {
      settings: {
        query: { types: ["core.note"], state: ["active"] },
        defaults: { type: "core.note" },
        outside_query: "hold",
        addition_threshold: { files: 2, fraction: 0.25 },
      },
    });
    made.push(harness);
    scriptFolderWrites(harness);
    expect((await harness.bound.sync()).ok).toBe(true);
    expect((await harness.bound.testOpen()).ok).toBe(true);
    for (let n = 0; n < 3; n += 1)
      writeFileSync(
        join(harness.dir, `out-${String(n)}.md`),
        `---\ntitle: Out ${String(n)}\nstate: archived\n---\nbody\n`,
      );
    const scan = await scanned(harness);
    expect(
      [scan.created, scan.heldOutside, scan.pausedAdditions],
      "files outside the query were sent or counted as a drop",
    ).toEqual([0, 3, 0]);
    const status = await harness.bound.status();
    expect(status.ok).toBe(true);
    if (!status.ok) return;
    expect(status.value.paused.outsideQuery).toBe(3);
    const flags = status.value.files.map((file) => file.flag);
    expect(flags).toEqual(["outside_query", "outside_query", "outside_query"]);
    expect((await harness.bound.testClose()).ok).toBe(true);
  }, 120_000);
});
