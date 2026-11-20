import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HeldCommand } from "../../device/cli-adapter.js";
import { folderHarness, type FolderHarness } from "./harness.js";
import {
  lastReport,
  put,
  scriptFolderWrites,
  sentCreates,
  sentTitles,
} from "./folders.shared.js";

/**
 * A person can pause one directory's sync and let it go on, without removing
 * the folder it follows.
 */

const SEED = "01a00000-0000-7000-8000-00000000b0a1";
const WAIT = { timeout: 30_000, interval: 100 };

let harness: FolderHarness | undefined;
const held: HeldCommand[] = [];

afterEach(async () => {
  for (const command of held.splice(0)) await command.stop();
  await harness?.stop();
  harness = undefined;
});

/** A folder holding one item the server has, in step with a quiet directory. */
async function seeded(label: string): Promise<FolderHarness> {
  const made = await folderHarness(label, {
    items: {
      "core.note": [
        { item: { id: SEED, properties: { title: "Seed", body: "seed\n" } } },
      ],
    },
  });
  scriptFolderWrites(made);
  return made;
}

function reasons(text: string): string {
  return text.replace(/\s+/g, " ");
}

describe("a paused directory", () => {
  it("is paused and resumed by a command that says so, and says that nothing changed when the directory was already as asked", async () => {
    harness = await seeded("pause-commands");
    const { folder } = harness;

    // The witness: a directory that was never paused is not paused, and
    // resuming it changes nothing.
    expect((await folder.status()).ok && (await folder.status())).toMatchObject(
      {
        value: { sync_paused: false },
      },
    );
    expect(await folder.resume()).toEqual({
      ok: true,
      value: { dir: expect.any(String), paused: false, changed: false },
    });

    expect(await folder.pause()).toEqual({
      ok: true,
      value: { dir: expect.any(String), paused: true, changed: true },
    });
    expect(await folder.pause()).toEqual({
      ok: true,
      value: { dir: expect.any(String), paused: true, changed: false },
    });
    const again = await folder
      .device()
      .rootText(["folders", "pause", harness.dir]);
    expect(again.ok && reasons(again.value)).toContain("already paused");

    expect(await folder.resume()).toEqual({
      ok: true,
      value: { dir: expect.any(String), paused: false, changed: true },
    });
    expect(await folder.resume()).toEqual({
      ok: true,
      value: { dir: expect.any(String), paused: false, changed: false },
    });
  });

  it("refuses a push, a send-only push and a pull, naming resume, and leaves the directory and the server as they were", async () => {
    harness = await seeded("pause-refuses");
    put(harness, "Before.md", "before\n");
    // The witness: the same push and pull, unpaused, send and write.
    expect((await harness.folder.push()).ok).toBe(true);
    expect(sentTitles(harness)).toEqual(["Before"]);
    expect(existsSync(join(harness.dir, "Seed.md"))).toBe(true);

    expect((await harness.folder.pause()).ok).toBe(true);
    put(harness, "During.md", "during\n");
    const requests = harness.server.requests.length;
    const before = readFileSync(join(harness.dir, "Seed.md"), "utf8");
    for (const refused of [
      await harness.folder.push(),
      await harness.folder.pushSendOnly(),
      await harness.folder.pull(),
    ]) {
      expect(refused.ok).toBe(false);
      expect(JSON.stringify(refused)).toContain("folders resume");
    }
    expect(sentTitles(harness), "a paused push sent a file").toEqual([
      "Before",
    ]);
    expect(readFileSync(join(harness.dir, "Seed.md"), "utf8")).toBe(before);
    expect(
      harness.server.requests
        .slice(requests)
        .filter((request) => request.method !== "GET"),
      "a refused command wrote to the server",
    ).toEqual([]);
  });

  it("sends on resume what changed in the directory and writes what changed on the server while it was paused", async () => {
    harness = await seeded("pause-resume-syncs");
    expect((await harness.folder.pull()).ok).toBe(true);
    expect((await harness.folder.pause()).ok).toBe(true);
    put(harness, "During.md", "during\n");
    expect((await harness.folder.push()).ok).toBe(false);
    expect(sentTitles(harness)).toEqual([]);

    expect((await harness.folder.resume()).ok).toBe(true);
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    expect(sentTitles(harness)).toEqual(["During"]);
    expect(sentCreates(harness)).toHaveLength(1);
  });

  it("shows in its status and in the list of folders, and reports to the server that its sync is paused", async () => {
    harness = await seeded("pause-shown");
    expect((await harness.folder.push()).ok).toBe(true);
    const listed = await harness.folder.list();
    expect(listed.ok && listed.value.map((entry) => entry.paused)).toEqual([
      false,
    ]);
    const quiet = await harness.folder.statusText();
    expect(quiet.ok && reasons(quiet.value)).not.toContain("paused");
    expect(
      lastReport(harness).problems.map((problem) => problem.code),
    ).not.toContain("paused");

    expect((await harness.folder.pause()).ok).toBe(true);
    const status = await harness.folder.status();
    expect(status.ok && status.value.sync_paused).toBe(true);
    const text = await harness.folder.statusText();
    expect(text.ok && reasons(text.value)).toContain("sync paused");
    expect(text.ok && reasons(text.value)).toContain("folders resume");
    const after = await harness.folder.list();
    expect(after.ok && after.value.map((entry) => entry.paused)).toEqual([
      true,
    ]);
    const listText = await harness.folder
      .device()
      .rootText(["folders", "list"]);
    expect(listText.ok && listText.value).toContain("(paused)");
    expect(lastReport(harness).problems).toEqual([
      { code: "paused", count: 1 },
    ]);

    expect((await harness.folder.resume()).ok).toBe(true);
    expect(lastReport(harness).problems).toEqual([]);
    const resumed = await harness.folder.status();
    expect(resumed.ok && resumed.value.sync_paused).toBe(false);
  });

  it("does not move the last success a report carries", async () => {
    harness = await seeded("pause-last-success");
    expect((await harness.folder.push()).ok).toBe(true);
    const stamp = (
      lastReport(harness) as unknown as { last_success_at: string | null }
    ).last_success_at;
    expect(stamp, "the witness: a push before the pause succeeded").not.toBe(
      null,
    );
    expect((await harness.folder.pause()).ok).toBe(true);
    expect(
      (lastReport(harness) as unknown as { last_success_at: string | null })
        .last_success_at,
    ).toBe(stamp);
  });

  it("refuses a watch of the directory, naming resume, and watches it again once resumed", async () => {
    harness = await seeded("pause-watch-refused");
    expect((await harness.folder.pause()).ok).toBe(true);
    const refused = harness.folder.watch();
    held.push(refused);
    await vi.waitFor(
      () =>
        expect(refused.running(), refused.stdout + refused.stderr).toBe(false),
      WAIT,
    );
    expect(refused.stdout + refused.stderr).toContain("folders resume");
    expect(existsSync(join(harness.dir, "Seed.md"))).toBe(false);

    // The witness: resumed, the same watch runs and writes the item's file.
    expect((await harness.folder.resume()).ok).toBe(true);
    const watching = harness.folder.watch();
    held.push(watching);
    await vi.waitFor(
      () =>
        expect(
          existsSync(join(harness!.dir, "Seed.md")),
          watching.stdout + watching.stderr,
        ).toBe(true),
      WAIT,
    );
    expect(watching.running()).toBe(true);
  });

  it("keeps a running watch of the directory going while it is paused, says so, and syncs a change once it is resumed", async () => {
    harness = await seeded("pause-watch-stays");
    const watching = harness.folder.watch();
    held.push(watching);
    await vi.waitFor(
      () =>
        expect(
          existsSync(join(harness!.dir, "Seed.md")),
          watching.stdout + watching.stderr,
        ).toBe(true),
      WAIT,
    );

    expect((await harness.folder.pause()).ok).toBe(true);
    await vi.waitFor(
      () => expect(reasons(watching.stdout + watching.stderr)).toContain("paused"),
      WAIT,
    );
    put(harness, "During.md", "during\n");
    await new Promise((settled) => setTimeout(settled, 3_000));
    expect(watching.running(), watching.stdout + watching.stderr).toBe(true);
    expect(sentTitles(harness), "a paused watch sent a file").toEqual([]);

    expect((await harness.folder.resume()).ok).toBe(true);
    await vi.waitFor(
      () =>
        expect(sentTitles(harness!), watching.stdout + watching.stderr).toEqual(
          ["During"],
        ),
      WAIT,
    );
    expect(watching.running()).toBe(true);
  });
});
