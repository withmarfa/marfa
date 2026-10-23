import {
  existsSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StreamFeed } from "../../device/scripted-server.js";
import {
  bindingFolderHarness,
  folderTold,
  type BindingFolderHarness,
} from "./binding-folders.shared.js";
import { heldBy, untilHeld } from "./binding.shared.js";
import {
  EdgeDoor,
  scriptFolderWrites,
  settingsFile,
} from "./folders.shared.js";

const made: BindingFolderHarness[] = [];
afterEach(async () => {
  for (const harness of made.splice(0).reverse()) await harness.stop();
});

async function prepared(label: string, files: Record<string, string> = {}) {
  const edges = new EdgeDoor();
  const feed = new StreamFeed();
  let watching = false;
  const held = heldBy(feed);
  const harness = await bindingFolderHarness(label, {
    files,
    settings: {
      search: { types: ["core.note"] },
      removal_threshold: { files: 100, fraction: 1 },
    },
    events: [
      (request) =>
        watching
          ? typeof held === "function"
            ? held(request)
            : held
          : edges.stream()(request),
    ],
  });
  made.push(harness);
  const rows = scriptFolderWrites(harness, { edges });
  const synced = await harness.bound.sync();
  expect(synced.ok, JSON.stringify(synced)).toBe(true);
  watching = true;
  return { ...harness, served: rows };
}

/** The clock stays fixed from the first pass's start through its completion. */
async function startFirstPass(harness: BindingFolderHarness) {
  const { bound, device } = harness;
  await device.hooks.hold("folder-pass-start");
  await device.hooks.hold("folder-pass-ended");
  await device.hooks.hold("folder-file-changed");
  const watch = await bound.watch();
  await folderTold(watch, "watching");
  // A settled settings-file notification starts this pass independently of
  // the ceiling under test and introduces no additional scanned file.
  const settings = settingsFile(harness);
  writeFileSync(settings, readFileSync(settings));
  await untilHeld(device, "folder-file-changed");
  await device.clock.advance(250);
  await device.hooks.release("folder-file-changed");
  await vi.waitFor(
    async () => {
      expect(
        await device.hooks.waiting("folder-pass-start"),
        "the initial pass did not start after its wake settled",
      ).toBe(1);
    },
    { timeout: 10_000, interval: 10 },
  );
  await device.hooks.release("folder-pass-start");
  return watch;
}

/** Stops between passes before receiving another filesystem notification. */
async function nextTurn(harness: BindingFolderHarness) {
  const { device } = harness;
  await device.hooks.hold("folder-watch-turn");
  await device.hooks.release("folder-pass-ended");
  await untilHeld(device, "folder-watch-turn");
  await device.hooks.hold("folder-pass-ended");
}

/** Runs one more pass, past the rename grace, and holds it at its end. */
async function nextPass(harness: BindingFolderHarness) {
  const { device } = harness;
  await nextTurn(harness);
  await device.clock.advance(5_000);
  const settings = settingsFile(harness);
  writeFileSync(settings, readFileSync(settings));
  await device.hooks.release("folder-watch-turn");
  await untilHeld(device, "folder-pass-ended");
}

function notesIn(dir: string): string[] {
  return readdirSync(dir)
    .filter((name) => name !== ".marfa")
    .sort();
}

describe("folder clock and scan boundaries", () => {
  it("defers a missing file until the five-second rename grace ends", async () => {
    const harness = await prepared("binding-delete-grace", {
      "note.md": "original\n",
    });
    const { bound, device } = harness;
    expect((await bound.testOpen()).ok).toBe(true);
    unlinkSync(join(harness.dir, "note.md"));
    const first = await bound.testScan();
    expect(first.ok && [first.value.missing, first.value.deleted]).toEqual([
      1, 0,
    ]);
    await device.clock.advance(4_999);
    const before = await bound.testScan();
    expect(before.ok && before.value.deleted).toBe(0);
    await device.clock.advance(1);
    const after = await bound.testScan();
    expect(after.ok && after.value.deleted).toBe(1);
    expect((await bound.testClose()).ok).toBe(true);
  });

  it("counts a file whose create the server has not answered waiting, and unchanged once it has", async () => {
    const harness = await prepared("binding-scan-waiting");
    const { bound, dir } = harness;
    expect((await bound.testOpen()).ok).toBe(true);
    writeFileSync(join(dir, "note.md"), "original\n");
    const created = await bound.testScan();
    expect(
      created.ok && [created.value.created, created.value.waiting],
    ).toEqual([1, 0]);
    const waiting = await bound.testScan();
    expect(
      waiting.ok && [waiting.value.unchanged, waiting.value.waiting],
    ).toEqual([0, 1]);
    // The witness: once the create is sent, the same file is unchanged.
    const sent = await bound.testDrain();
    expect(sent.ok, JSON.stringify(sent)).toBe(true);
    const settled = await bound.testScan();
    expect(
      settled.ok && [settled.value.unchanged, settled.value.waiting],
    ).toEqual([1, 0]);
    expect((await bound.testClose()).ok).toBe(true);
  });

  it("performs a full first pass and the first pass past sixty seconds", async () => {
    const harness = await prepared("binding-periodic-scan");
    const { device } = harness;
    await startFirstPass(harness);
    await untilHeld(device, "folder-pass-ended");
    expect(await device.hooks.reached("folder-full-scan")).toBe(1);
    await nextTurn(harness);
    await device.clock.advance(59_999);
    writeFileSync(join(harness.dir, "wake.md"), "before the boundary\n");
    await device.hooks.release("folder-watch-turn");
    // inotify can report an earlier access before the write notification;
    // either wake may legitimately finish this due pass.
    await untilHeld(device, "folder-pass-ended");
    expect(await device.hooks.reached("folder-full-scan")).toBe(1);
    expect(await device.hooks.reached("folder-quick-scan")).toBe(1);

    await nextTurn(harness);
    // Every wake is due after this interval, even if a filesystem reports
    // the preceding pass's changes before this write.
    await device.clock.advance(5_000);
    writeFileSync(join(harness.dir, "wake.md"), "after the boundary\n");
    await device.hooks.release("folder-watch-turn");
    await untilHeld(device, "folder-pass-ended");
    expect(await device.hooks.reached("folder-full-scan")).toBe(2);
    expect(await device.hooks.reached("folder-quick-scan")).toBe(1);
    await device.hooks.release("folder-pass-ended");
  });

  it("reads a save made during a scan on a subsequent pass", async () => {
    const harness = await prepared("binding-scan-race", {
      "note.md": "first body\n",
    });
    const { device, served } = harness;
    const path = join(harness.dir, "note.md");
    const before = readFileSync(path, "utf8");
    await device.hooks.hold("folder-scan-read");
    await startFirstPass(harness);
    await untilHeld(device, "folder-scan-read");
    writeFileSync(
      path,
      before.replace("first body", "later body with more bytes"),
    );
    await device.hooks.release("folder-scan-read");
    await untilHeld(device, "folder-pass-ended");
    await nextTurn(harness);
    await device.clock.advance(5_000);
    // A separate file supplies a wake without changing the raced file's stat.
    writeFileSync(join(harness.dir, "wake.md"), "wake the next pass\n");
    await device.hooks.release("folder-watch-turn");
    await untilHeld(device, "folder-pass-ended");
    expect(await device.hooks.reached("folder-full-scan")).toBe(1);
    expect(await device.hooks.reached("folder-quick-scan")).toBe(1);
    expect(
      [...served.values()].some((row) =>
        String(row.properties.body).includes("later body with more bytes"),
      ),
    ).toBe(true);
    await device.hooks.release("folder-pass-ended");
    expect(readFileSync(path, "utf8")).toContain("later body with more bytes");
  });

  it("writes back no file moved between a watch pass's scan and its pull, and follows the move on the next pass", async () => {
    const harness = await prepared("binding-pass-moved");
    const { device, dir, served } = harness;
    writeFileSync(join(dir, "new.md"), "---\ntitle: New\n---\nwords\n");
    await device.hooks.hold("folder-pass-pull");
    await startFirstPass(harness);
    // The pass has scanned the note and sent its create.
    await untilHeld(device, "folder-pass-pull");
    expect(served.size).toBe(1);
    renameSync(join(dir, "new.md"), join(dir, "moved.md"));
    await device.hooks.release("folder-pass-pull");
    await untilHeld(device, "folder-pass-ended");
    expect(
      existsSync(join(dir, "new.md")),
      "the pull wrote a moved file back at its old path, so the note is in the folder twice",
    ).toBe(false);

    await nextPass(harness);
    expect(notesIn(dir)).toEqual(["moved.md"]);
    const id = [...served.keys()][0];
    expect(readFileSync(join(dir, "moved.md"), "utf8")).toContain(
      `marfa_id: ${id}`,
    );
    expect(served.size).toBe(1);
    await device.hooks.release("folder-pass-ended");
  });

  it("writes back no file deleted between a watch pass's scan and its pull, and sends its delete after the grace", async () => {
    const harness = await prepared("binding-pass-deleted");
    const { device, dir, served, server } = harness;
    writeFileSync(join(dir, "new.md"), "---\ntitle: New\n---\nwords\n");
    await device.hooks.hold("folder-pass-pull");
    await startFirstPass(harness);
    await untilHeld(device, "folder-pass-pull");
    const id = [...served.keys()][0];
    unlinkSync(join(dir, "new.md"));
    await device.hooks.release("folder-pass-pull");
    await untilHeld(device, "folder-pass-ended");
    expect(
      existsSync(join(dir, "new.md")),
      "the pull wrote back a file the person deleted",
    ).toBe(false);

    // The next pass journals the delete, and the one past the grace sends it.
    await nextPass(harness);
    expect(existsSync(join(dir, "new.md"))).toBe(false);
    const deletes = () =>
      server.requests.filter(
        (request) =>
          request.method === "DELETE" && request.pathname === `/items/${id}`,
      ).length;
    expect(deletes()).toBe(0);
    await nextPass(harness);
    expect(deletes()).toBe(1);
    expect(notesIn(dir)).toEqual([]);
    await device.hooks.release("folder-pass-ended");
  });

  it("starts a pass after five seconds even while filesystem changes keep arriving", async () => {
    const harness = await prepared("binding-settle-ceiling");
    const { device } = harness;
    await startFirstPass(harness);
    await untilHeld(device, "folder-pass-ended");
    const initial = await device.hooks.reached("folder-pass-start");
    await nextTurn(harness);
    await device.hooks.hold("folder-pass-start");
    for (let tick = 1; tick <= 25; tick += 1) {
      // Any duplicated notification is received only after this clock move,
      // so it cannot masquerade as a change observed at the previous instant.
      await device.hooks.hold("folder-file-changed");
      await device.clock.advance(200);
      writeFileSync(join(harness.dir, "busy.md"), `change ${String(tick)}\n`);
      await device.hooks.release("folder-watch-turn");
      await untilHeld(device, "folder-file-changed");
      await device.hooks.hold("folder-watch-turn");
      await device.hooks.release("folder-file-changed");
      if (tick < 25) {
        await vi.waitFor(
          async () => {
            const turn = await device.hooks.waiting("folder-watch-turn");
            const pass = await device.hooks.waiting("folder-pass-start");
            expect(turn + pass).toBeGreaterThan(0);
          },
          { timeout: 10_000, interval: 10 },
        );
        expect(await device.hooks.reached("folder-pass-start")).toBe(initial);
        await untilHeld(device, "folder-watch-turn");
      }
    }
    await vi.waitFor(
      async () => {
        expect(
          await device.hooks.waiting("folder-pass-start"),
          "the five-second ceiling did not start the next pass while changes remained unsettled",
        ).toBe(1);
      },
      { timeout: 10_000, interval: 10 },
    );
    expect(await device.hooks.reached("folder-pass-start")).toBe(initial + 1);
  });
});
