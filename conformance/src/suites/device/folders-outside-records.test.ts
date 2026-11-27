import { afterEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { join, relative } from "node:path";
import { copyLiveReplay } from "../../device/marfa-answers.js";
import { refusalLine } from "../../device/cli-adapter.js";
import type { Outcome } from "../../device/protocol.js";
import {
  detachImage,
  detachImageAtCleanup,
  tempFolder,
} from "../../utils/temp-folder.js";
import { ON_MACOS } from "../../utils/platform.js";
import { openBindingFolder } from "./binding-folders.shared.js";
import { scriptFolderWrites } from "./folders.shared.js";
import { folderHarness, type FolderHarness } from "./harness.js";

let harness: FolderHarness | undefined;
afterEach(async () => {
  await harness?.stop();
  harness = undefined;
});

const NOTE = "01a00000-0000-7000-8000-0000000000e1";
const SAVE = "as the server has it\nthe person's edit\n";
const EDIT = "as read\nedited after the pull\n";

/** A folder holding `Note.md`, written by a pull and pushed so that no write
 *  waits unsent, and the items the server holds for it. */
async function noteFolder(name: string) {
  harness = await folderHarness(name, {
    items: {
      "core.note": [
        {
          item: {
            id: NOTE,
            version: 1,
            properties: { title: "Note", body: "as read\n" },
          },
        },
      ],
    },
    events: [copyLiveReplay("1", [])],
  });
  const items = scriptFolderWrites(harness);
  expect((await harness.folder.pull()).ok).toBe(true);
  const pushed = await harness.folder.push();
  expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
  return { harness, items };
}

type Identity = [bigint, bigint];

function identity(path: string): Identity {
  const found = statSync(path, { bigint: true });
  return [found.dev, found.ino];
}

const reserved = (id: string) => `.marfa-kept-${id}.tmp`;

/** What a release from v0.0.86 to v0.0.108 recorded in a folder's store when
 *  a take-in from another folder stopped: the person's save under its
 *  reserved name in `dir`, named as `place`. Answers the save's full path. */
function stoppedTakeIn(
  harness: FolderHarness,
  dir: string,
  place: string,
): string {
  const id = randomUUID().replaceAll("-", "");
  const kept = join(dir, reserved(id));
  writeFileSync(kept, SAVE);
  const pair = ([device, inode]: Identity) => `[${device},${inode}]`;
  const [device, inode] = identity(kept);
  // The hash of no bytes the file holds, so the file reads as the person's.
  const value =
    `{"dir":${JSON.stringify(place)},"dir_at":${pair(identity(dir))},` +
    `"aside":${JSON.stringify(place)},"aside_at":${pair(identity(dir))},` +
    `"displacement":{"id":"${id}","kind":"withdraw","target":"Recovery.md",` +
    `"kept":"${reserved(id)}",` +
    `"read":{"device":${device},"inode":${inode},"hash":"0000000000000000"}}}`;
  const db = new DatabaseSync(harness.folder.store);
  try {
    db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)").run(
      `folder_displaced:${id}`,
      value,
    );
  } finally {
    db.close();
  }
  return kept;
}

/** Every file under `dir` but the folder's own store, by path and bytes. */
function files(dir: string): Record<string, string> {
  const found: Record<string, string> = {};
  for (const entry of readdirSync(dir, {
    recursive: true,
    withFileTypes: true,
  })) {
    const path = join(entry.parentPath, entry.name);
    const named = relative(dir, path);
    if (named === ".marfa" || named.startsWith(".marfa/")) continue;
    if (entry.isFile()) found[named] = readFileSync(path, "base64");
  }
  return found;
}

/** The store's tables a pass would change, row by row. */
function store(harness: FolderHarness): string {
  const db = new DatabaseSync(harness.folder.store);
  try {
    return JSON.stringify(
      ["meta", "folder_files", "folder_journal", "queue"].map((table) =>
        db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all(),
      ),
    );
  } finally {
    db.close();
  }
}

const writes = (harness: FolderHarness) =>
  harness.server.requests.filter((request) => request.method !== "GET");

/** Asserts `outcome` is the refusal that names `kept`, the file it came
 *  from and `folders remove`. */
function refusedNaming(
  outcome: Outcome<unknown>,
  kept: string,
  from: string,
  dir: string,
  command = "scan",
): void {
  expect(outcome.ok, `${command}: ${JSON.stringify(outcome)}`).toBe(false);
  if (outcome.ok) return;
  const { code, raw } = outcome.refusal;
  expect(code, `${command}: ${raw}`).toBe("store");
  expect(raw, command).toContain(kept);
  expect(raw, command).toContain(from);
  expect(raw, command).toContain(`marfa folders remove ${dir}`);
}

describe("a folder whose store holds a record that names a place outside it", () => {
  it("refuses every scan, pull, push, watch, status and discard by the command line and the binding, naming the record's files, and changes nothing", async () => {
    const { harness, items } = await noteFolder("outside-records-refused");
    const source = join(tempFolder("marfa-outside-"), "Source");
    mkdirSync(source);
    const kept = stoppedTakeIn(harness, source, source);
    const from = join(source, "Recovery.md");
    // An edit a push would send.
    writeFileSync(join(harness.dir, "Note.md"), EDIT);
    const inFolder = files(harness.dir);
    const outside = files(source);
    const held = store(harness);
    const served = JSON.stringify([...items]);
    const sent = writes(harness).length;

    const commands = {
      scan: () => harness.folder.scan(),
      pull: () => harness.folder.pull(),
      push: () => harness.folder.push(),
      "push --send-only": () => harness.folder.pushSendOnly(),
      hydrate: () => harness.folder.hydrate(),
      status: () => harness.folder.status(),
      "kept --discard": () => harness.folder.discardKept(),
    };
    for (const [command, run] of Object.entries(commands))
      refusedNaming(await run(), kept, from, harness.dir, command);
    const watch = harness.folder.watch();
    await watch.exited();
    expect(watch.exitCode(), watch.stderr).not.toBe(0);
    refusedNaming(
      {
        ok: false,
        refusal: {
          code: JSON.parse(refusalLine(watch.stderr)).error?.code,
          local: null,
          server: null,
          raw: watch.stderr,
        },
      },
      kept,
      from,
      harness.dir,
      "watch",
    );
    const bound = await openBindingFolder(harness);
    try {
      const calls = {
        sync: () => bound.bound.sync(),
        status: () => bound.bound.status(),
        discardKept: () => bound.bound.discardKept(),
      };
      for (const [call, run] of Object.entries(calls))
        refusedNaming(await run(), kept, from, harness.dir, `binding ${call}`);
      // A watch's scan and pull, run one at a time on a folder held open.
      expect((await bound.bound.testOpen()).ok).toBe(true);
      const passes = {
        scan: () => bound.bound.testScan(),
        pull: () => bound.bound.testPull(),
      };
      for (const [call, run] of Object.entries(passes))
        refusedNaming(await run(), kept, from, harness.dir, `binding ${call}`);
      expect((await bound.bound.testClose()).ok).toBe(true);
    } finally {
      await bound.device.close();
    }

    expect(files(harness.dir)).toEqual(inFolder);
    expect(files(source)).toEqual(outside);
    expect(existsSync(from), "a file was put back outside the folder").toBe(
      false,
    );
    expect(store(harness)).toBe(held);
    expect(JSON.stringify([...items])).toBe(served);
    expect(writes(harness).slice(sent), "a write reached the server").toEqual(
      [],
    );
  });

  it("acts on the same record when it names a place in the folder, the witness", async () => {
    const { harness, items } = await noteFolder("outside-records-witness");
    mkdirSync(join(harness.dir, "Source"));
    const kept = stoppedTakeIn(harness, join(harness.dir, "Source"), "Source");
    writeFileSync(join(harness.dir, "Note.md"), EDIT);

    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    expect(existsSync(kept), "the record in the folder did not settle").toBe(
      false,
    );
    // Admitted as a note, so it gains its ID lines above the save.
    expect(
      readFileSync(join(harness.dir, "Source/Recovery.md"), "utf8"),
    ).toMatch(new RegExp(`\\n${SAVE}$`));
    expect(items.get(NOTE)?.properties.body).toBe(EDIT);
  });

  it("is taken off its machine by folders remove, which leaves every file", async () => {
    const { harness } = await noteFolder("outside-records-remove");
    const source = join(tempFolder("marfa-outside-"), "Source");
    mkdirSync(source);
    const kept = stoppedTakeIn(harness, source, source);
    const inFolder = files(harness.dir);
    const outside = files(source);
    refusedNaming(
      await harness.folder.scan(),
      kept,
      join(source, "Recovery.md"),
      harness.dir,
    );

    const removed = await harness.folder.remove();
    expect(removed.ok, JSON.stringify(removed)).toBe(true);
    expect(existsSync(harness.folder.store)).toBe(false);
    expect(files(harness.dir)).toEqual(inFolder);
    expect(files(source)).toEqual(outside);
  });

  describe("another volume at the directory the record names", ON_MACOS, () => {
    function image(scratch: string, name: string): string {
      const path = join(scratch, `${name}.sparseimage`);
      const made = spawnSync("hdiutil", [
        "create",
        "-size",
        "16m",
        "-type",
        "SPARSE",
        "-fs",
        "APFS",
        "-volname",
        name,
        path,
      ]);
      expect(made.status, String(made.stderr)).toBe(0);
      return path;
    }

    function attach(path: string, mount: string): void {
      const attached = spawnSync("hdiutil", [
        "attach",
        path,
        "-mountpoint",
        mount,
        "-nobrowse",
        "-noautoopen",
      ]);
      expect(attached.status, String(attached.stderr)).toBe(0);
      detachImageAtCleanup(mount);
    }

    it("refuses on either volume, and changes neither volume's files", async () => {
      const { harness } = await noteFolder("outside-records-volume");
      const scratch = tempFolder("marfa-outside-volume-");
      const mount = join(scratch, "Source");
      mkdirSync(mount);
      const first = image(scratch, "first");
      const second = image(scratch, "second");
      attach(first, mount);
      const kept = stoppedTakeIn(harness, mount, mount);
      const name = kept.split("/").pop()!;
      const from = join(mount, "Recovery.md");
      const onFirst = files(mount);
      const held = store(harness);
      refusedNaming(await harness.folder.scan(), kept, from, harness.dir);
      detachImage(mount);
      // The second volume often takes the device number the first released,
      // so its root can match the record's device and inode both.
      attach(second, mount);
      writeFileSync(kept, "the other volume's file\n");
      const onSecond = files(mount);

      refusedNaming(await harness.folder.scan(), kept, from, harness.dir);
      refusedNaming(await harness.folder.pull(), kept, from, harness.dir);
      refusedNaming(await harness.folder.push(), kept, from, harness.dir);

      expect(files(mount)).toEqual(onSecond);
      expect(existsSync(from), "a file was put back on another volume").toBe(
        false,
      );
      expect(store(harness)).toBe(held);
      detachImage(mount);
      const back = join(scratch, "First");
      mkdirSync(back);
      attach(first, back);
      expect(files(back)).toEqual(onFirst);
      expect(readFileSync(join(back, name), "utf8")).toBe(SAVE);
    });
  });
});
