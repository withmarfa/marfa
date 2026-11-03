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
import type { FolderSettings } from "../../device/cli-adapter.js";
import { StreamFeed } from "../../device/scripted-server.js";
import {
  bindingFolderHarness,
  folderTold,
  type BindingFolderHarness,
} from "./binding-folders.shared.js";
import { heldBy, untilHeld } from "./binding.shared.js";
import {
  EdgeDoor,
  scriptFolderChanges,
  scriptFolderWrites,
  settingsFile,
} from "./folders.shared.js";

const made: BindingFolderHarness[] = [];
afterEach(async () => {
  for (const harness of made.splice(0).reverse()) await harness.stop();
});

async function prepared(
  label: string,
  files: Record<string, string> = {},
  more: FolderSettings = {},
) {
  const edges = new EdgeDoor();
  const feed = new StreamFeed();
  let watching = false;
  const held = heldBy(feed);
  const harness = await bindingFolderHarness(label, {
    files,
    settings: {
      query: { types: ["core.note"] },
      removal_threshold: { files: 100, fraction: 1 },
      ...more,
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

  it.each([
    {
      named: "ten minutes where the folder names none",
      more: {},
      seconds: 600,
    },
    {
      named: "the folder's own interval",
      more: { full_pass_interval_seconds: 120 },
      seconds: 120,
    },
  ])(
    "performs a full first pass and the first pass past $named",
    async ({ more, seconds }) => {
      const harness = await prepared("binding-periodic-scan", {}, more);
      const { device } = harness;
      await startFirstPass(harness);
      await untilHeld(device, "folder-pass-ended");
      expect(await device.hooks.reached("folder-full-scan")).toBe(1);
      await nextTurn(harness);
      await device.clock.advance(seconds * 1000 - 1);
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
    },
  );

  it("decides a delete it could not tell from a move in a quick pass once the registry can be read, with no full pass", async () => {
    const harness = await prepared("binding-kept-look", {
      "note.md": "original\n",
    });
    const { bound, device } = harness;
    const deletes = () =>
      harness.server.requests.filter(
        (request) =>
          request.method === "DELETE" && request.pathname.startsWith("/items/"),
      ).length;
    const listed = readFileSync(harness.registry);
    const watch = await bound.watch();
    await folderTold(watch, "watching");
    // Let the first full pass end, then the file go while another folder the
    // file may have moved to cannot be told.
    const run = async (ms: number) => {
      for (let left = ms; left > 0; left -= 1_000) {
        await device.clock.advance(Math.min(1_000, left));
        await vi.waitFor(
          async () => {
            expect((await device.clock.waits()).length).toBeGreaterThan(0);
          },
          { timeout: 10_000, interval: 5 },
        );
      }
    };
    await run(2_000);
    writeFileSync(harness.registry, "not a registry");
    unlinkSync(join(harness.dir, "note.md"));
    await run(30_000);
    expect(
      deletes(),
      "the witness: a delete that may be a move to a folder that cannot be read was sent",
    ).toBe(0);

    writeFileSync(harness.registry, listed);
    await run(65_000);
    // The clock has stood since: only a request already on its way can land.
    await vi.waitFor(
      () => {
        expect(
          deletes(),
          "the delete waited for the full pass, ten minutes off, instead of a quick pass a minute after the last look",
        ).toBe(1);
      },
      { timeout: 5_000, interval: 10 },
    );
  });

  it("keeps each folder's own interval where two folders of one machine are watched at once", async () => {
    const own = await prepared(
      "binding-two-intervals-own",
      {},
      { full_pass_interval_seconds: 120 },
    );
    const named = await prepared("binding-two-intervals-default");
    const both = [own, named];
    for (const harness of both) {
      await startFirstPass(harness);
      await untilHeld(harness.device, "folder-pass-ended");
      expect(await harness.device.hooks.reached("folder-full-scan")).toBe(1);
      await nextTurn(harness);
    }
    // Two minutes on, each watch hears one write on its own clock.
    for (const harness of both) {
      await harness.device.clock.advance(120_000);
      writeFileSync(join(harness.dir, "wake.md"), "two minutes on\n");
      await harness.device.hooks.release("folder-watch-turn");
      await untilHeld(harness.device, "folder-pass-ended");
    }
    expect(
      await own.device.hooks.reached("folder-full-scan"),
      "the folder that names two minutes took no full pass",
    ).toBe(2);
    expect(
      await named.device.hooks.reached("folder-full-scan"),
      "the folder that names none took a full pass at the other's interval",
    ).toBe(1);
    expect(await named.device.hooks.reached("folder-quick-scan")).toBe(1);
    for (const harness of both) {
      await harness.device.hooks.release("folder-pass-ended");
    }
  });

  it("takes an interval edited in the settings file at the next pass of the running watch", async () => {
    const harness = await prepared(
      "binding-interval-changed",
      {},
      { full_pass_interval_seconds: 3_600 },
    );
    const { device, dir } = harness;
    const sent = scriptFolderChanges(harness);
    await startFirstPass(harness);
    await untilHeld(device, "folder-pass-ended");
    expect(await device.hooks.reached("folder-full-scan")).toBe(1);

    // The witness: two minutes on, an hour-long interval leaves the pass quick.
    await nextTurn(harness);
    await device.clock.advance(120_000);
    writeFileSync(join(dir, "wake.md"), "two minutes on\n");
    await device.hooks.release("folder-watch-turn");
    await untilHeld(device, "folder-pass-ended");
    expect(await device.hooks.reached("folder-full-scan")).toBe(1);
    expect(await device.hooks.reached("folder-quick-scan")).toBe(1);

    await nextTurn(harness);
    const settings = settingsFile(harness);
    writeFileSync(
      settings,
      readFileSync(settings, "utf8").replace(
        /full_pass_interval_seconds: 3600/,
        "full_pass_interval_seconds: 120",
      ),
    );
    await device.clock.advance(5_000);
    await device.hooks.release("folder-watch-turn");
    await untilHeld(device, "folder-pass-ended");
    expect(sent, "the edited interval was not sent").toHaveLength(1);
    expect(sent[0]?.full_pass_interval_seconds).toBe(120);

    await nextTurn(harness);
    await device.clock.advance(5_000);
    writeFileSync(join(dir, "wake.md"), "past the new interval\n");
    await device.hooks.release("folder-watch-turn");
    await untilHeld(device, "folder-pass-ended");
    expect(
      await device.hooks.reached("folder-full-scan"),
      "the watch went on at the interval it started with",
    ).toBe(2);
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

  it("renders no file on a quick or full pass of a quiet folder, and renders one after an edit", async () => {
    const harness = await prepared("binding-quiet-pass", {
      "first.md": "---\ntitle: First\n---\nfirst words\n",
      "second.md": "---\ntitle: Second\n---\nsecond words\n",
    });
    const { device, dir } = harness;
    const contents = () =>
      Object.fromEntries(
        notesIn(dir).map((name) => [name, readFileSync(join(dir, name))]),
      );
    await startFirstPass(harness);
    await untilHeld(device, "folder-pass-ended");
    // A pull's own writes come back to the next pass, which can render once
    // more before the folder is quiet.
    let rendered = await device.hooks.reached("folder-render");
    for (let pass = 0; pass < 3; pass += 1) {
      await nextPass(harness);
      const now = await device.hooks.reached("folder-render");
      if (now === rendered) break;
      rendered = now;
    }
    const before = contents();

    await nextPass(harness);
    expect(await device.hooks.reached("folder-quick-scan")).toBeGreaterThan(0);
    expect(
      await device.hooks.reached("folder-render"),
      "a quick pass of a quiet folder rendered a file",
    ).toBe(rendered);

    await nextTurn(harness);
    await device.clock.advance(600_000);
    const settings = settingsFile(harness);
    writeFileSync(settings, readFileSync(settings));
    await device.hooks.release("folder-watch-turn");
    await untilHeld(device, "folder-pass-ended");
    expect(await device.hooks.reached("folder-full-scan")).toBe(2);
    expect(
      await device.hooks.reached("folder-render"),
      "a full pass of a quiet folder rendered a file",
    ).toBe(rendered);
    expect(contents()).toEqual(before);

    // The witness: the same pass after an edit renders.
    await nextTurn(harness);
    await device.clock.advance(5_000);
    const edited = readFileSync(join(dir, "first.md"), "utf8").replace(
      "first words",
      "edited words",
    );
    writeFileSync(join(dir, "first.md"), edited);
    await device.hooks.release("folder-watch-turn");
    await untilHeld(device, "folder-pass-ended");
    expect(await device.hooks.reached("folder-render")).toBeGreaterThan(
      rendered,
    );
    await device.hooks.release("folder-pass-ended");
  });

  it("renders only the file an edit changes, and every file once an hour", async () => {
    const names = ["one", "two", "three", "four", "five", "six"];
    const harness = await prepared(
      "binding-selective-render",
      Object.fromEntries(
        names.map((name) => [
          `${name}.md`,
          `---\ntitle: ${name}\n---\nwords\n`,
        ]),
      ),
    );
    const { device, dir } = harness;
    await startFirstPass(harness);
    await untilHeld(device, "folder-pass-ended");
    // The witness: the first pull of a watch renders every file.
    let rendered = await device.hooks.reached("folder-render");
    expect(rendered).toBeGreaterThanOrEqual(names.length);
    const quiet = async () => {
      for (let pass = 0; pass < 4; pass += 1) {
        await nextPass(harness);
        const now = await device.hooks.reached("folder-render");
        expect(
          now - rendered,
          "a pass rendered a file no change reached",
        ).toBeLessThanOrEqual(1);
        if (now === rendered) return;
        rendered = now;
      }
      throw new Error("four passes after one edit each rendered a file");
    };
    await quiet();

    await nextTurn(harness);
    await device.clock.advance(5_000);
    writeFileSync(
      join(dir, "one.md"),
      readFileSync(join(dir, "one.md"), "utf8").replace("words", "edited"),
    );
    await device.hooks.release("folder-watch-turn");
    await untilHeld(device, "folder-pass-ended");
    const edited = await device.hooks.reached("folder-render");
    expect(edited - rendered).toBe(1);
    rendered = edited;
    await quiet();
    const contents = Object.fromEntries(
      notesIn(dir).map((name) => [name, readFileSync(join(dir, name), "utf8")]),
    );

    await nextTurn(harness);
    await device.clock.advance(3_600_000);
    const settings = settingsFile(harness);
    writeFileSync(settings, readFileSync(settings));
    await device.hooks.release("folder-watch-turn");
    await untilHeld(device, "folder-pass-ended");
    expect(
      (await device.hooks.reached("folder-render")) - rendered,
      "the hourly pass rendered every file",
    ).toBe(names.length);
    expect(await device.hooks.reached("folder-render-missed")).toBe(0);
    expect(
      Object.fromEntries(
        notesIn(dir).map((name) => [
          name,
          readFileSync(join(dir, name), "utf8"),
        ]),
      ),
    ).toEqual(contents);
    await device.hooks.release("folder-pass-ended");
  });

  it("rewrites at the hourly render a file the choice of files to render left out", async () => {
    const harness = await prepared("binding-selective-missed", {
      "one.md": "---\ntitle: one\n---\nwords\n",
      "two.md": "---\ntitle: two\n---\nwords\n",
    });
    const { device, dir } = harness;
    await startFirstPass(harness);
    await untilHeld(device, "folder-pass-ended");
    for (let pass = 0; pass < 3; pass += 1) {
      const before = await device.hooks.reached("folder-render");
      await nextPass(harness);
      if ((await device.hooks.reached("folder-render")) === before) break;
    }

    await device.hooks.fail("folder-selection-narrow");
    await nextTurn(harness);
    await device.clock.advance(5_000);
    writeFileSync(
      join(dir, "one.md"),
      readFileSync(join(dir, "one.md"), "utf8").replace("words", "edited"),
    );
    await device.hooks.release("folder-watch-turn");
    await untilHeld(device, "folder-pass-ended");
    await nextPass(harness);
    await nextPass(harness);
    await device.hooks.fail("folder-selection-narrow", false);
    const left = readFileSync(join(dir, "one.md"), "utf8");
    expect(await device.hooks.reached("folder-render-missed")).toBe(0);

    await nextTurn(harness);
    await device.clock.advance(3_600_000);
    const settings = settingsFile(harness);
    writeFileSync(settings, readFileSync(settings));
    await device.hooks.release("folder-watch-turn");
    await untilHeld(device, "folder-pass-ended");
    expect(await device.hooks.reached("folder-render-missed")).toBe(1);
    expect(readFileSync(join(dir, "one.md"), "utf8")).not.toBe(left);
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
    for (let tick = 1; tick <= 24; tick += 1) {
      // Any duplicated notification is received only after this clock move,
      // so it cannot masquerade as a change observed at the previous instant.
      await device.hooks.hold("folder-file-changed");
      await device.clock.advance(200);
      writeFileSync(join(harness.dir, "busy.md"), `change ${String(tick)}\n`);
      await device.hooks.release("folder-watch-turn");
      await untilHeld(device, "folder-file-changed");
      await device.hooks.hold("folder-watch-turn");
      await device.hooks.release("folder-file-changed");
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
    // The ceiling is reached. A write is received as several notifications,
    // and one an earlier write left, that no pass can find anything at, may
    // start the pass before this write's own is received.
    await device.hooks.hold("folder-file-changed");
    await device.clock.advance(200);
    writeFileSync(join(harness.dir, "busy.md"), "change 25\n");
    await device.hooks.release("folder-watch-turn");
    await vi.waitFor(
      async () => {
        if ((await device.hooks.waiting("folder-file-changed")) > 0) {
          await device.hooks.release("folder-file-changed");
        }
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
