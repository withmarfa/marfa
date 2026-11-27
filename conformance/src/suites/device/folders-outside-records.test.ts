import { afterEach, describe, expect, it } from "vitest";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { copyLiveReplay } from "../../device/marfa-answers.js";
import type { FlaggedFile } from "../../device/cli-adapter.js";
import {
  detachImage,
  detachImageAtCleanup,
  tempFolder,
} from "../../utils/temp-folder.js";
import { ON_MACOS } from "../../utils/platform.js";
import { openBindingFolder } from "./binding-folders.shared.js";
import { scriptFolderWrites, withFault } from "./folders.shared.js";
import { folderHarness, type FolderHarness } from "./harness.js";

let harness: FolderHarness | undefined;
afterEach(async () => {
  delete process.env.MARFA_TEST_FAULT;
  await harness?.stop();
  harness = undefined;
});

const SAVE = "as the server has it\nthe person's edit\n";
const OUTSIDE = "outside this folder";

/** A folder holding `Note.md`, written by a pull. */
async function noteFolder(name: string): Promise<FolderHarness> {
  harness = await folderHarness(name, {
    items: {
      "core.note": [
        {
          item: {
            id: "01a00000-0000-7000-8000-0000000000e1",
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

const reserved = (id: string) => `.marfa-kept-${id}.tmp`;
const newId = () => randomUUID().replaceAll("-", "");

/** What an earlier release recorded in a folder's store as a take-in from
 *  another folder stopped: the person's save under its reserved name in
 *  `dir`, named as `place`. Answers the save's full path. */
function stoppedTakeIn(
  harness: FolderHarness,
  dir: string,
  place: string,
): string {
  const id = newId();
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

function records(harness: FolderHarness, kind: string): number {
  const db = new DatabaseSync(harness.folder.store);
  try {
    const row = db
      .prepare("SELECT count(*) AS n FROM meta WHERE key LIKE ?")
      .get(`folder_${kind}:%`) as { n: number };
    return row.n;
  } finally {
    db.close();
  }
}

/** The reasons `flagged` reports `path` kept for. */
const keptFor = (flagged: FlaggedFile[], path: string) =>
  flagged
    .filter((file) => file.flag === "kept" && file.path === path)
    .map((file) => file.reason);

/** Asserts `flagged` reports `path` once, as a file outside the folder that
 *  came from `from`. */
function reportedOutside(flagged: FlaggedFile[], path: string, from: string) {
  const reasons = keptFor(flagged, path);
  expect(reasons, JSON.stringify(flagged)).toHaveLength(1);
  expect(reasons[0]).toContain(from);
  expect(reasons[0]).toContain(OUTSIDE);
}

async function scanned(harness: FolderHarness): Promise<FlaggedFile[]> {
  const scan = await harness.folder.scan();
  expect(scan.ok, JSON.stringify(scan)).toBe(true);
  return scan.ok ? scan.value.flagged : [];
}

async function pulled(harness: FolderHarness): Promise<FlaggedFile[]> {
  const pull = await harness.folder.pull();
  expect(pull.ok, JSON.stringify(pull)).toBe(true);
  return pull.ok ? pull.value.flagged : [];
}

describe("a record that names a directory outside the folder", () => {
  it("leaves a file a record keeps in a directory outside the folder, and reports it at every scan and pull", async () => {
    const harness = await noteFolder("outside-records-displaced");
    const source = join(tempFolder("marfa-outside-"), "Source");
    mkdirSync(source);
    const kept = stoppedTakeIn(harness, source, source);
    // The witness: the same record in a directory in the folder settles.
    mkdirSync(join(harness.dir, "Projects"));
    const inside = stoppedTakeIn(
      harness,
      join(harness.dir, "Projects"),
      "Projects",
    );
    const from = join(source, "Recovery.md");

    for (let pass = 0; pass < 3; pass += 1)
      reportedOutside(await scanned(harness), kept, from);
    reportedOutside(await pulled(harness), kept, from);

    expect(existsSync(inside), "the record in the folder did not settle").toBe(
      false,
    );
    expect(
      readFileSync(join(harness.dir, "Projects/Recovery.md"), "utf8"),
    ).toBe(SAVE);
    expect(readFileSync(kept, "utf8")).toBe(SAVE);
    expect(existsSync(from), "a file was put back outside the folder").toBe(
      false,
    );
    expect(records(harness, "displaced")).toBe(1);
  });

  it("keeps reporting a record outside the folder whose directory is gone, where a full scan ends one in the folder", async () => {
    const harness = await noteFolder("outside-records-gone");
    const source = join(tempFolder("marfa-outside-"), "Source");
    mkdirSync(source);
    const kept = stoppedTakeIn(harness, source, source);
    renameSync(kept, join(source, "..", "moved.tmp"));
    rmdirSync(source);
    mkdirSync(join(harness.dir, "Gone"));
    const inside = stoppedTakeIn(harness, join(harness.dir, "Gone"), "Gone");
    renameSync(inside, join(harness.dir, "..", "moved-inside.tmp"));
    rmdirSync(join(harness.dir, "Gone"));
    const from = join(source, "Recovery.md");

    const first = await scanned(harness);
    reportedOutside(first, kept, from);
    // The witness: a full scan reports the record in the folder once and ends it.
    expect(keptFor(first, `Gone/${inside.split("/").pop()}`)).toHaveLength(1);
    const second = await scanned(harness);
    reportedOutside(second, kept, from);
    expect(keptFor(second, `Gone/${inside.split("/").pop()}`)).toEqual([]);
    expect(records(harness, "displaced")).toBe(1);
  });

  it.each([
    "in the folder",
    "outside the folder",
    "in the folder under a record whose source is outside it",
  ] as const)(
    "lists a file kept %s, and leaves it through folders kept --discard and a binding only where its record names a directory outside the folder",
    async (where) => {
      const outside = where !== "in the folder";
      const short = { "in the folder": "in", "outside the folder": "out" };
      const harness = await noteFolder(
        `outside-records-kept-${short[where as keyof typeof short] ?? "mixed"}`,
      );
      // A program holds the note open as a pull replaces it, and Marfa cannot
      // tell whether it writes to it, so the old file is kept, unchanged.
      const program = openSync(join(harness.dir, "Note.md"), "a");
      try {
        writeSync(program, "first half\n");
        const pushed = await withFault("writers-unknown", () =>
          harness.folder.push(),
        );
        expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
      } finally {
        closeSync(program);
      }
      const [name] = readdirSync(harness.dir).filter((file) =>
        file.startsWith(".marfa-kept-"),
      );
      expect(name).toBeDefined();
      let kept = name!;
      let full = join(harness.dir, name!);
      let from = "Note.md";
      if (outside) {
        // As a take-in from another folder recorded it, a week and a day ago,
        // with the file set aside there or, in a mixed record, in the root.
        const source = join(tempFolder("marfa-outside-"), "Source");
        mkdirSync(source);
        let aside = "";
        if (where === "outside the folder") {
          renameSync(full, join(source, name!));
          kept = full = join(source, name!);
          aside = source;
        }
        from = join(source, "Note.md");
        const since = Math.floor(Date.now() / 1000) - 8 * 24 * 60 * 60;
        const db = new DatabaseSync(harness.folder.store);
        try {
          db.prepare(
            "UPDATE meta SET value = json_set(value, '$.dir', ?, '$.aside', ?, '$.retained.since', CAST(? AS INTEGER)) WHERE key LIKE 'folder_retained:%'",
          ).run(source, aside, since);
        } finally {
          db.close();
        }
        reportedOutside(await scanned(harness), kept, from);
        reportedOutside(await pulled(harness), kept, from);
      }
      const listed = await harness.folder.kept();
      expect(listed.ok, JSON.stringify(listed)).toBe(true);
      if (!listed.ok) return;
      expect(listed.value.kept).toEqual([
        expect.objectContaining({ path: kept, from }),
      ]);
      const [file] = listed.value.kept;
      if (outside) {
        expect(file?.writers).toBe("none");
        expect(file?.until, "a date was given to delete it").toBeUndefined();
        expect(file?.reason).toContain(OUTSIDE);
        expect(file?.reason).toContain(from);
      } else {
        expect(file?.until).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      }
      const bytes = readFileSync(full);

      const discarded = await harness.folder.discardKept();
      expect(discarded.ok, JSON.stringify(discarded)).toBe(true);
      if (!discarded.ok) return;
      if (!outside) {
        // The witness: the same file in the folder is deleted.
        expect(discarded.value.discarded).toEqual([kept]);
        expect(discarded.value.kept).toEqual([]);
        expect(existsSync(join(harness.dir, kept))).toBe(false);
        return;
      }
      expect(discarded.value.discarded).toEqual([]);
      expect(discarded.value.put_back).toEqual([]);
      expect(discarded.value.kept).toEqual([file]);
      const bound = await openBindingFolder(harness);
      try {
        const viaBinding = await bound.bound.discardKept();
        expect(viaBinding.ok, JSON.stringify(viaBinding)).toBe(true);
        if (!viaBinding.ok) return;
        expect(viaBinding.value.discarded).toEqual([]);
        expect(viaBinding.value.putBack).toEqual([]);
        expect(viaBinding.value.kept).toEqual([
          expect.objectContaining({
            path: kept,
            from,
            writers: "not_looked",
            reason: file?.reason,
          }),
        ]);
      } finally {
        await bound.device.close();
      }
      expect(readFileSync(full)).toEqual(bytes);
      expect(existsSync(from)).toBe(false);
      expect(records(harness, "retained")).toBe(1);
    },
  );

  it.each(["in the folder", "outside the folder"] as const)(
    "lists a file kept %s under a record it cannot read, and deletes it through folders kept --discard only where the record names no directory outside the folder",
    async (where) => {
      const harness = await noteFolder(
        `outside-records-unread-${where === "in the folder" ? "in" : "out"}`,
      );
      const program = openSync(join(harness.dir, "Note.md"), "a");
      try {
        writeSync(program, "first half\n");
        const pushed = await withFault("writers-unknown", () =>
          harness.folder.push(),
        );
        expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
      } finally {
        closeSync(program);
      }
      const [name] = readdirSync(harness.dir).filter((file) =>
        file.startsWith(".marfa-kept-"),
      );
      expect(name).toBeDefined();
      let kept = name!;
      let full = join(harness.dir, name!);
      let from = "Note.md";
      let place = "";
      if (where === "outside the folder") {
        const source = join(tempFolder("marfa-outside-"), "Source");
        mkdirSync(source);
        renameSync(full, join(source, name!));
        kept = full = join(source, name!);
        from = join(source, "Note.md");
        place = source;
      }
      // A `since` that is not a number, so the record does not read.
      const db = new DatabaseSync(harness.folder.store);
      try {
        db.prepare(
          "UPDATE meta SET value = json_set(value, '$.dir', ?, '$.aside', ?, '$.retained.since', 'soon') WHERE key LIKE 'folder_retained:%'",
        ).run(place, place);
      } finally {
        db.close();
      }

      const listed = await harness.folder.kept();
      expect(listed.ok, JSON.stringify(listed)).toBe(true);
      if (!listed.ok) return;
      expect(listed.value.kept).toEqual([
        expect.objectContaining({ path: kept, from }),
      ]);
      const [file] = listed.value.kept;
      if (where === "in the folder") {
        expect(file?.reason).toBe("Marfa could not read its record");
      } else {
        expect(file?.reason).toMatch(/^Marfa could not read its record/);
        expect(file?.reason).toContain(from);
        expect(file?.reason).toContain(OUTSIDE);
      }
      const discarded = await harness.folder.discardKept();
      expect(discarded.ok, JSON.stringify(discarded)).toBe(true);
      if (!discarded.ok) return;
      if (where === "in the folder") {
        // The witness: the same file in the folder is deleted.
        expect(discarded.value.discarded).toEqual([kept]);
        expect(existsSync(full)).toBe(false);
        return;
      }
      expect(discarded.value.discarded).toEqual([]);
      expect(discarded.value.kept).toEqual([file]);
      expect(existsSync(full)).toBe(true);
      expect(records(harness, "retained")).toBe(1);
    },
  );

  describe("another volume at the directory a record names", ON_MACOS, () => {
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
      "puts back or removes nothing, and keeps the record, where another volume at the directory a record outside the folder names %s its reserved name",
      async (holds) => {
        const harness = await noteFolder("outside-records-volume");
        const scratch = tempFolder("marfa-outside-volume-");
        const mount = join(scratch, "Source");
        mkdirSync(mount);
        const first = image(scratch, "first");
        const second = image(scratch, "second");
        attach(first, mount);
        const recorded = identity(mount);
        const kept = stoppedTakeIn(harness, mount, mount);
        const name = kept.split("/").pop()!;
        const from = join(mount, "Recovery.md");
        reportedOutside(await scanned(harness), kept, from);
        detachImage(mount);
        // The second volume often takes the device number the first released,
        // so its root can match the record's device and inode both.
        attach(second, mount);
        expect(
          identity(mount)[1],
          "the two volumes' roots have different inodes",
        ).toBe(recorded[1]);
        if (holds === "holds") writeFileSync(kept, "the other volume's file\n");

        reportedOutside(await scanned(harness), kept, from);
        reportedOutside(await scanned(harness), kept, from);
        reportedOutside(await pulled(harness), kept, from);

        expect(existsSync(from), "a file was put back on another volume").toBe(
          false,
        );
        expect(existsSync(kept)).toBe(holds === "holds");
        if (holds === "holds")
          expect(readFileSync(kept, "utf8")).toBe("the other volume's file\n");
        expect(records(harness, "displaced")).toBe(1);

        detachImage(mount);
        const back = join(scratch, "First");
        mkdirSync(back);
        attach(first, back);
        expect(readFileSync(join(back, name), "utf8")).toBe(SAVE);
        expect(existsSync(join(back, "Recovery.md"))).toBe(false);
      },
    );
  });
});
