import { afterEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { copyLiveReplay } from "../../device/marfa-answers.js";
import {
  detachImage,
  detachImageAtCleanup,
  tempFolder,
} from "../../utils/temp-folder.js";
import { ON_MACOS } from "../../utils/platform.js";
import { scriptFolderWrites } from "./folders.shared.js";
import { folderHarness, type FolderHarness } from "./harness.js";

let harness: FolderHarness | undefined;
afterEach(async () => {
  await harness?.stop();
  harness = undefined;
});

const SAVE = "as the server has it\nthe person's edit\n";

/** A folder holding `Note.md`, written by a pull. */
async function noteFolder(name: string): Promise<FolderHarness> {
  harness = await folderHarness(name, {
    items: {
      "core.note": [
        {
          item: {
            id: "01a00000-0000-7000-8000-0000000000d1",
            version: 1,
            properties: { title: "Note", body: "as read\n" },
          },
        },
      ],
    },
    events: [copyLiveReplay("1", [])],
  });
  scriptFolderWrites(harness);
  expect((await harness.folder.pull()).ok).toBe(true);
  return harness;
}

type Identity = [bigint, bigint];

function identity(path: string): Identity {
  const found = statSync(path, { bigint: true });
  return [found.dev, found.ino];
}

/** What an earlier release recorded in a folder's store as a take-in from
 *  another folder stopped, with the file it took moved aside. */
interface TakeIn {
  id: string;
  kind: "withdraw" | "exchange";
  dir: string;
  dirAt: Identity;
  aside: string;
  asideAt: Identity;
  target: string;
  kept: string;
  read: Identity;
  waiting?: string;
  /** Recorded as a file kept because a program might still write to it. */
  retained?: boolean;
  /** Recorded with no kind, so the record does not read. */
  unreadable?: boolean;
}

const reserved = (id: string) => `.marfa-kept-${id}.tmp`;
const newId = () => randomUUID().replaceAll("-", "");

/** A take-in that stopped with the person's save under its reserved name in
 *  `source`, as that release recorded it. */
function stoppedTakeIn(source: string): TakeIn {
  const id = newId();
  writeFileSync(join(source, reserved(id)), SAVE);
  return {
    id,
    kind: "withdraw",
    dir: source,
    dirAt: identity(source),
    aside: source,
    asideAt: identity(source),
    target: "Recovery.md",
    kept: reserved(id),
    read: identity(join(source, reserved(id))),
  };
}

function record(harness: FolderHarness, row: TakeIn): void {
  const pair = ([device, inode]: Identity) => `[${device},${inode}]`;
  // The hash of no bytes the file holds, so the file reads as the person's.
  const object = ([device, inode]: Identity) =>
    `{"device":${device},"inode":${inode},"hash":"0000000000000000"}`;
  const ours =
    row.waiting === undefined
      ? ""
      : `"ours":[${JSON.stringify(row.waiting)},${object(row.read)}],`;
  // Set aside long ago, where no program could be told from one writing.
  const kept = row.retained ? `,"since":0,"writers":"unknown"` : "";
  const value =
    `{"dir":${JSON.stringify(row.dir)},"dir_at":${pair(row.dirAt)},` +
    `"aside":${JSON.stringify(row.aside)},"aside_at":${pair(row.asideAt)},` +
    `"${row.retained ? "retained" : "displacement"}":{"id":"${row.id}",` +
    (row.unreadable ? "" : `"kind":"${row.kind}",`) +
    `"target":${JSON.stringify(row.target)},"kept":${JSON.stringify(row.kept)},` +
    `${ours}"read":${object(row.read)}${kept}}}`;
  const db = new DatabaseSync(harness.folder.store);
  try {
    db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)").run(
      `folder_${row.retained ? "retained" : "displaced"}:${row.id}`,
      value,
    );
  } finally {
    db.close();
  }
}

async function scan(harness: FolderHarness): Promise<void> {
  const scanned = await harness.folder.scan();
  expect(scanned.ok, JSON.stringify(scanned)).toBe(true);
}

async function keptPaths(harness: FolderHarness): Promise<string[]> {
  const kept = await harness.folder.kept();
  expect(kept.ok, JSON.stringify(kept)).toBe(true);
  return kept.ok ? kept.value.kept.map((file) => file.path) : [];
}

async function heldAsKept(harness: FolderHarness, path: string) {
  const status = await harness.folder.status();
  expect(status.ok, JSON.stringify(status)).toBe(true);
  return status.ok
    ? status.value.files.filter(
        (file) =>
          file.path === path && file.status === "held" && file.flag === "kept",
      )
    : [];
}

/** Asserts the owner's discard deletes and forgets nothing for `kept`,
 *  and says how to end its record. */
async function discardKeeps(harness: FolderHarness, kept: string) {
  const discarded = await harness.folder.discardKept();
  expect(discarded.ok, JSON.stringify(discarded)).toBe(true);
  if (!discarded.ok) return;
  expect(discarded.value.discarded).toEqual([]);
  expect(
    discarded.value.forgotten,
    "the record was forgotten, and the save it names may be on a volume not mounted",
  ).toEqual([]);
  expect(discarded.value.kept.map((file) => file.path)).toEqual([kept]);
  expect(discarded.value.kept[0]?.reason).toContain("marfa folders remove");
}

describe("a take-in an earlier release stopped in another folder's directory", () => {
  it.each([
    "as the take-in wrote it",
    "kept while a program might write to it",
    "a record that does not read",
    "an exchange",
    "a replace with a new file waiting",
    "its reserved name in another directory",
    "a reserved name its ID does not give",
    "a path outside its directory",
  ] as const)(
    "keeps and lists a record of a stopped take-in in another folder's directory, and puts back, removes or forgets nothing for it (%s)",
    async (shape) => {
      const harness = await noteFolder("take-in-recovery-shape");
      const scratch = tempFolder("marfa-take-in-");
      const source = join(scratch, "Source");
      mkdirSync(source);
      const row = stoppedTakeIn(source);
      if (shape === "kept while a program might write to it")
        row.retained = true;
      if (shape === "a record that does not read") row.unreadable = true;
      if (shape === "an exchange") row.kind = "exchange";
      if (shape === "a replace with a new file waiting")
        row.waiting = reserved(newId());
      if (shape === "its reserved name in another directory") {
        const aside = join(scratch, "Aside");
        mkdirSync(aside);
        renameSync(join(source, row.kept), join(aside, row.kept));
        row.aside = aside;
        row.asideAt = identity(aside);
      }
      if (shape === "a reserved name its ID does not give") {
        const other = reserved(newId());
        renameSync(join(source, row.kept), join(source, other));
        row.kept = other;
      }
      if (shape === "a path outside its directory")
        row.target = "../Recovery.md";
      const kept = join(row.aside, row.kept);
      record(harness, row);

      await scan(harness);
      await scan(harness);

      const putBack = [
        join(source, "Recovery.md"),
        join(scratch, "Recovery.md"),
      ].filter((path) => existsSync(path));
      expect(putBack, "a file was put back for the record").toEqual([]);
      expect(readFileSync(kept, "utf8")).toBe(SAVE);
      expect(
        await keptPaths(harness),
        "the record was not listed, so nothing shows the save is there",
      ).toEqual([kept]);
      expect(await heldAsKept(harness, kept)).toHaveLength(1);

      await discardKeeps(harness, kept);
      expect(readFileSync(kept, "utf8"), "the owner's discard deleted it").toBe(
        SAVE,
      );

      rmSync(kept);
      await discardKeeps(harness, kept);
      expect(await heldAsKept(harness, kept)).toHaveLength(1);
    },
  );

  describe("another volume at the recorded path", ON_MACOS, () => {
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

    it.each(["holds", "does not hold"] as const)(
      "puts back, removes or forgets nothing, and keeps the record, where another volume at a stopped take-in's directory %s its reserved name",
      async (holds) => {
        const harness = await noteFolder("take-in-recovery-volume");
        const scratch = tempFolder("marfa-take-in-volume-");
        const mount = join(scratch, "Source");
        mkdirSync(mount);
        const first = image(scratch, "first");
        const second = image(scratch, "second");
        attach(first, mount);

        const row = stoppedTakeIn(mount);
        record(harness, row);
        const kept = join(mount, row.kept);
        // The witness: in the volume recorded, the record is kept and listed.
        await scan(harness);
        expect(existsSync(join(mount, "Recovery.md"))).toBe(false);
        expect(await keptPaths(harness)).toEqual([kept]);
        detachImage(mount);
        // Occupy the device number the first volume released.
        const filler = join(scratch, "filler");
        mkdirSync(filler);
        attach(image(scratch, "filler"), filler);
        attach(second, mount);
        const now = identity(mount);
        expect(
          now[1],
          "the two volumes' roots have different inodes, so nothing below is about a match on the inode alone",
        ).toBe(row.dirAt[1]);
        expect(
          now[0],
          "the second volume has the first one's device number",
        ).not.toBe(row.dirAt[0]);
        if (holds === "holds") writeFileSync(kept, "the other volume's file\n");

        await scan(harness);
        await scan(harness);

        expect(
          existsSync(join(mount, "Recovery.md")),
          "a file was put back on another volume",
        ).toBe(false);
        expect(existsSync(kept)).toBe(holds === "holds");
        if (holds === "holds")
          expect(readFileSync(kept, "utf8")).toBe("the other volume's file\n");
        expect(
          await keptPaths(harness),
          "the record was forgotten, though the save is on the volume that was at its path",
        ).toEqual([kept]);
        expect(await heldAsKept(harness, kept)).toHaveLength(1);
        await discardKeeps(harness, kept);
        expect(existsSync(kept)).toBe(holds === "holds");

        detachImage(mount);
        const back = join(scratch, "First");
        mkdirSync(back);
        attach(first, back);
        expect(readFileSync(join(back, row.kept), "utf8")).toBe(SAVE);
        expect(existsSync(join(back, "Recovery.md"))).toBe(false);
      },
    );
  });
});
