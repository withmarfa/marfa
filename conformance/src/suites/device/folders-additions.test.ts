import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, afterEach, vi } from "vitest";
import { folderHarness } from "./harness.js";
import type { FolderHarness } from "./harness.js";
import type { FolderSettings, HeldCommand } from "../../device/cli-adapter.js";
import {
  edit,
  put,
  scriptFolderWrites,
  sentCreates,
  sentTitles,
  sentUpdates,
} from "./folders.shared.js";

/**
 * "A folder asks before taking in a large drop of new files": a scan that
 * would create more than `addition_threshold.files` items and more than
 * `addition_threshold.fraction` of the folder's files holds the new files
 * back until the person confirms them.
 */

const made: FolderHarness[] = [];
const held: HeldCommand[] = [];

afterEach(async () => {
  for (const command of held.splice(0)) await command.stop();
  for (const harness of made.splice(0).reverse()) await harness.stop();
});

const WAIT = { timeout: 30_000, interval: 100 };

const tight: FolderSettings = {
  query: { types: ["core.note"] },
  defaults: { type: "core.note" },
  addition_threshold: { files: 2, fraction: 0.25 },
};

const note = (n: number | string): string =>
  `---\ntitle: Note ${String(n)}\n---\nbody\n`;

/** Six notes pushed, so the folder is past its first sync and holds six files. */
async function six(
  label: string,
  settings?: FolderSettings,
): Promise<FolderHarness> {
  const harness = await folderHarness(label, settings ? { settings } : {});
  made.push(harness);
  scriptFolderWrites(harness);
  for (let n = 0; n < 6; n += 1) put(harness, `note-${String(n)}.md`, note(n));
  expect((await harness.folder.push()).ok).toBe(true);
  expect(sentCreates(harness)).toHaveLength(6);
  return harness;
}

/** A drop of `count` new notes, named `drop-<n>.md`. */
function drop(harness: FolderHarness, count: number, from = 0): void {
  for (let n = from; n < from + count; n += 1)
    put(harness, `drop-${String(n)}.md`, note(`drop ${String(n)}`));
}

const sent = (harness: FolderHarness): number => sentCreates(harness).length;

describe("a large drop of new files", () => {
  it("is held past both default halves of the threshold and sent at them", async () => {
    // At the threshold: fifty new files, not more than fifty, go.
    const at = await six("additions-default-at");
    drop(at, 50);
    const sentAtThreshold = await at.folder.push();
    expect(
      sentAtThreshold.ok && sentAtThreshold.value.scan.paused_additions,
    ).toBe(0);
    expect(sent(at), "fifty new files were held at the default threshold").toBe(
      56,
    );

    // One past it: fifty-one is more than fifty and more than a quarter of six.
    const past = await six("additions-default-past");
    drop(past, 51);
    const pushed = await past.folder.push();
    expect(pushed.ok && pushed.value.scan.paused_additions).toBe(51);
    expect(
      sent(past),
      "a drop past the default threshold was sent without being confirmed",
    ).toBe(6);
  }, 120_000);

  it("is held, named apart from a removal in status, and its files stay on the disk", async () => {
    const harness = await six("additions-status", tight);
    drop(harness, 3);
    const pushed = await harness.folder.push();
    expect(pushed.ok && pushed.value.scan.paused_additions).toBe(3);
    expect(sent(harness)).toBe(6);
    for (let n = 0; n < 3; n += 1)
      expect(existsSync(join(harness.dir, `drop-${String(n)}.md`))).toBe(true);

    const status = await harness.folder.status();
    expect(status.ok).toBe(true);
    if (!status.ok) return;
    expect(status.value.paused).toEqual({ disk: 0, pull: 0, additions: 3 });
    const files = status.value.files.filter((file) =>
      file.path.startsWith("drop-"),
    );
    expect(files).toHaveLength(3);
    for (const file of files) {
      expect(file.status).toBe("held");
      expect(file.flag).toBe("addition");
    }

    const said = await harness.folder.pushText();
    expect(said.ok && said.value).toContain(
      "a large addition waits: 3 new file(s) held",
    );
    expect(said.ok && said.value).not.toContain("a large removal waits");
  });

  it("does not hold the edit of a bound file made in the same scan", async () => {
    const harness = await six("additions-edits-go", tight);
    drop(harness, 3);
    edit(harness, "note-0.md", "body", "an edit that goes");
    const pushed = await harness.folder.push();
    expect(pushed.ok && pushed.value.scan.paused_additions).toBe(3);
    expect(sentUpdates(harness)).toHaveLength(1);
    expect(sent(harness)).toBe(6);
  });

  it("is sent once confirmed, and not held again", async () => {
    const harness = await six("additions-confirm", tight);
    drop(harness, 3);
    expect((await harness.folder.push()).ok).toBe(true);
    expect(sent(harness)).toBe(6);

    const confirmed = await harness.folder.confirm();
    expect(confirmed.ok && confirmed.value.added).toBe(3);
    const pushed = await harness.folder.push();
    expect(pushed.ok && pushed.value.scan.paused_additions).toBe(0);
    expect(sentTitles(harness)).toEqual(
      expect.arrayContaining(["Note drop 0", "Note drop 1", "Note drop 2"]),
    );
    expect(sent(harness)).toBe(9);
    const status = await harness.folder.status();
    expect(status.ok && status.value.paused.additions).toBe(0);
  });

  it("is sent by a push told to confirm additions", async () => {
    const harness = await six("additions-push-flag", tight);
    drop(harness, 3);
    const pushed = await harness.folder.pushConfirmingAdditions();
    expect(pushed.ok && pushed.value.scan.paused_additions).toBe(0);
    expect(sent(harness)).toBe(9);
  });

  it("is let go of when the files are deleted", async () => {
    const harness = await six("additions-deleted", tight);
    drop(harness, 3);
    expect((await harness.folder.push()).ok).toBe(true);
    for (let n = 0; n < 3; n += 1)
      rmSync(join(harness.dir, `drop-${String(n)}.md`));
    const pushed = await harness.folder.push();
    expect(pushed.ok && pushed.value.scan.paused_additions).toBe(0);
    const status = await harness.folder.status();
    expect(status.ok && status.value.paused.additions).toBe(0);
    expect(sent(harness)).toBe(6);
  });

  it("is counted across pushes when it arrives a few files at a time", async () => {
    const harness = await six("additions-slow", tight);
    drop(harness, 2);
    const first = await harness.folder.push();
    expect(first.ok && first.value.scan.paused_additions).toBe(0);
    expect(sent(harness)).toBe(8);
    drop(harness, 2, 2);
    const second = await harness.folder.push();
    expect(
      second.ok && second.value.scan.paused_additions,
      "a drop copied in slowly passed the threshold without being held",
    ).toBe(2);
    expect(sent(harness)).toBe(8);
  });

  it("is judged by its count alone in a folder that holds no files", async () => {
    const harness = await folderHarness("additions-empty", { settings: tight });
    made.push(harness);
    scriptFolderWrites(harness);
    expect((await harness.folder.push()).ok).toBe(true);
    drop(harness, 3);
    const pushed = await harness.folder.push();
    expect(pushed.ok && pushed.value.scan.paused_additions).toBe(3);
    expect(sent(harness)).toBe(0);
  });

  it("is not counted in the first sync, whatever its size", async () => {
    const files: Record<string, string> = {};
    for (let n = 0; n < 6; n += 1) files[`first-${String(n)}.md`] = note(n);
    const harness = await folderHarness("additions-first-sync", {
      settings: tight,
      files,
    });
    made.push(harness);
    scriptFolderWrites(harness);
    const pushed = await harness.folder.push();
    expect(pushed.ok && pushed.value.scan.paused_additions).toBe(0);
    expect(sent(harness)).toBe(6);
  });
});

describe("a watch over a large drop", () => {
  it("says it once, keeps watching, keeps sending edits and never fails", async () => {
    const harness = await six("additions-watch", tight);
    drop(harness, 3);
    const watching = harness.folder.watchText();
    held.push(watching);
    await vi.waitFor(
      () => expect(watching.stdout).toContain("a large addition waits"),
      WAIT,
    );
    edit(harness, "note-1.md", "body", "an edit during the pause");
    await vi.waitFor(() => expect(sentUpdates(harness)).toHaveLength(1), WAIT);
    // Passes enough for a line said at every one to show more than once.
    await new Promise((resolve) => setTimeout(resolve, 4_000));
    expect(
      watching.stdout.split("a large addition waits").length - 1,
      `a watch said the same paused addition at every pass: ${watching.stdout}`,
    ).toBe(1);
    expect(watching.running(), watching.stderr).toBe(true);
    expect(sent(harness)).toBe(6);
  });

  it("goes on with the other folders when one of the folders it watches pauses", async () => {
    const harness = await six("additions-watch-every", tight);
    drop(harness, 3);
    const watching = harness.folder.watchEveryText();
    held.push(watching);
    await vi.waitFor(
      () => expect(watching.stdout).toContain("a large addition waits"),
      WAIT,
    );
    put(harness, "note-0.md", note(0).replace("body", "edited while paused"));
    await vi.waitFor(() => expect(sentUpdates(harness)).toHaveLength(1), WAIT);
    expect(watching.running(), watching.stderr).toBe(true);
    expect(sent(harness)).toBe(6);
  });
});
