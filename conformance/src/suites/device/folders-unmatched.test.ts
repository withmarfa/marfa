import { execFile } from "node:child_process";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  copyItemEvent,
  copyLiveReplay,
  copyReplay,
  wireItem,
} from "../../device/marfa-answers.js";
import type { FolderDoor } from "../../device/folder-door.js";
import { keychainEnv } from "../../utils/keychain.js";
import { openBindingFolder } from "./binding-folders.shared.js";
import { untilHeld } from "./binding.shared.js";
import { folderHarness, requireBinary, type FolderHarness } from "./harness.js";
import {
  EdgeDoor,
  isContentWrite,
  read,
  scriptFolderWrites,
  sentUpdates,
  withFault,
} from "./folders.shared.js";

const execute = promisify(execFile);

/**
 * "A folder's unmatched files can be listed and removed after confirmation."
 *
 * An unmatched file is one the folder keeps because its item left the query
 * by a retype. Three items start out in the folder and are retyped out of the
 * query at the next catch-up, so each file is unmatched; the cases then make
 * some of them ones that must stay.
 */

const started: FolderHarness[] = [];
afterEach(async () => {
  for (const made of started.splice(0)) await made.stop();
});

const note = (n: number) => ({
  id: `01a00000-0000-7000-8000-00000000090${String(n)}`,
  properties: { title: `Note ${String(n)}`, body: `body ${String(n)}\n` },
});

interface Made {
  harness: FolderHarness;
  edges: EdgeDoor;
  door: ReturnType<typeof scriptFolderWrites>;
}

/** A folder holding `count` notes, each written as a file and then retyped out of its query. */
async function unmatchedFolder(label: string, count = 3): Promise<Made> {
  const items = Array.from({ length: count }, (_, at) => note(at + 1));
  const harness = await folderHarness(label, {
    items: { "core.note": items.map((item) => ({ item })) },
    events: [
      copyReplay(
        String(count + 1),
        items.map((item, at) =>
          copyItemEvent(
            String(at + 2),
            "item.updated",
            wireItem({ ...item, type: "core.bookmark", version: 2 }),
          ),
        ),
      ),
      copyLiveReplay(String(count + 1), []),
    ],
  });
  started.push(harness);
  const edges = new EdgeDoor();
  const door = scriptFolderWrites(harness, {
    edges,
    door: (made: FolderDoor) => {
      for (const item of items) {
        made.rows.set(item.id, {
          properties: item.properties,
          type: "core.bookmark",
          source_id: null,
          version: 2,
        });
      }
    },
  });
  const pulled = await harness.folder.pull();
  expect(pulled.ok && pulled.value.written, JSON.stringify(pulled)).toBe(count);
  const pushed = await harness.folder.push();
  expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
  expect(
    pushed.ok && pushed.value.pull?.unmatched,
    "the retype did not leave the files unmatched, so nothing below is about them",
  ).toBe(count);
  return { harness, edges, door };
}

/** The paths the door holds an `in-folder` placement for. */
function placedPaths(edges: EdgeDoor): string[] {
  return [...edges.edges.values()]
    .filter((edge) => edge.edge_type === "in-folder")
    .map((edge) => String((edge.properties as Record<string, unknown>).path))
    .sort();
}

/**
 * Deletes `Note 2.md` by hand, the witness that the folder sends a delete for
 * a file a person deleted, and scans past the rename grace. Answers the items
 * whose delete is queued.
 */
async function deletedPastTheGrace(
  made: FolderHarness,
): Promise<Array<string | null>> {
  rmSync(join(made.dir, "Note 2.md"));
  const graceStarted = Date.now();
  let deleted: Array<string | null> = [];
  await vi.waitFor(
    async () => {
      expect((await made.folder.scan()).ok).toBe(true);
      const queue = await made.folder.device().queue();
      expect(queue.ok).toBe(true);
      if (!queue.ok) return;
      deleted = queue.value
        .filter((row) => row.kind === "delete_item")
        .map((row) => row.item_id);
      expect(
        (Date.now() - graceStarted) / 1000,
        "the rename grace has not run out, so a missing file would not be a delete yet",
      ).toBeGreaterThan(6);
      expect(deleted).toContain(note(2).id);
    },
    { timeout: 25_000, interval: 1_000 },
  );
  return deleted;
}

/** The folder's status of the file at `path`. */
async function statusOf(made: FolderHarness, path: string) {
  const status = await made.folder.status();
  expect(status.ok, JSON.stringify(status)).toBe(true);
  if (!status.ok) return [];
  return status.value.files.filter((file) => file.path === path);
}

/** Every file in the directory outside `.marfa`. */
function files(made: FolderHarness): string[] {
  return readdirSync(made.dir)
    .filter((name) => name !== ".marfa")
    .sort();
}

/**
 * Runs `folders unmatched --remove` at a terminal. When it asks, `between`
 * runs on the folder, as the person does while the question is open, and the
 * answer is typed.
 */
async function atTerminal(
  made: FolderHarness,
  answer: string,
  between: Array<["delete", string] | ["append", string, string]> = [],
): Promise<{ output: string }> {
  const script = String.raw`
import errno, json, os, pty, select, signal, sys, time
answer = sys.argv[1]
actions = json.loads(sys.argv[2])
pid, master = pty.fork()
if pid == 0:
    os.execv(sys.argv[3], sys.argv[3:])
output = b""
answered = False
finished = False
try:
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        if not select.select([master], [], [], 0.1)[0]:
            continue
        try:
            chunk = os.read(master, 65536)
        except OSError as error:
            if error.errno == errno.EIO:
                break
            raise
        if not chunk:
            break
        output += chunk
        sys.stdout.buffer.write(chunk)
        sys.stdout.buffer.flush()
        if not answered and b"Remove them? [y/N]" in output:
            for action in actions:
                if action[0] == "delete":
                    os.remove(action[1])
                else:
                    with open(action[1], "a") as handle:
                        handle.write(action[2])
            os.write(master, (answer + "\n").encode())
            answered = True
    else:
        raise RuntimeError("terminal command did not finish")
    _, status = os.waitpid(pid, 0)
    finished = True
    sys.exit(os.waitstatus_to_exitcode(status))
finally:
    if not finished:
        os.kill(pid, signal.SIGKILL)
        os.waitpid(pid, 0)
    os.close(master)
`;
  const actions = between.map((action) =>
    action[0] === "delete"
      ? ["delete", join(made.dir, action[1])]
      : ["append", join(made.dir, action[1]), action[2]],
  );
  const { stdout } = await execute(
    "python3",
    [
      "-I",
      "-c",
      script,
      answer,
      JSON.stringify(actions),
      requireBinary(),
      "folders",
      "unmatched",
      made.dir,
      "--remove",
    ],
    {
      env: {
        ...process.env,
        ...keychainEnv(),
        MARFA_FOLDER_REGISTRY: made.registry,
      },
    },
  );
  return { output: stdout };
}

describe("a folder's unmatched files", () => {
  it("lists them, and says which removing would keep", async () => {
    const { harness: made } = await unmatchedFolder("unmatched-list");
    // Changed and read, so an edit waits to be sent.
    appendFileSync(join(made.dir, "Note 3.md"), "changed and scanned\n");
    expect((await made.folder.scan()).ok).toBe(true);
    // Changed on disk, not yet read by a scan.
    appendFileSync(join(made.dir, "Note 2.md"), "changed by hand\n");
    const bytes = files(made).map((name) => read(made, name));

    const listed = await made.folder.unmatched();
    expect(listed.ok, JSON.stringify(listed)).toBe(true);
    if (!listed.ok) return;
    expect(listed.value.unmatched.map((file) => file.path)).toEqual([
      "Note 1.md",
      "Note 2.md",
      "Note 3.md",
    ]);
    expect(listed.value.unmatched.map((file) => file.item_id)).toEqual([
      note(1).id,
      note(2).id,
      note(3).id,
    ]);
    const [removable, changed, waiting] = listed.value.unmatched;
    expect(
      removable?.kept,
      "a file the folder wrote and nothing waits on was reported as one removal would keep",
    ).toBeUndefined();
    expect(changed?.kept).toMatch(/differ from what the folder wrote/);
    expect(waiting?.kept).toMatch(/waits to be sent/);

    expect(
      files(made).map((name) => read(made, name)),
      "listing changed a file",
    ).toEqual(bytes);
    const status = await made.folder.status();
    expect(status.ok && status.value.files.map((file) => file.status)).toEqual([
      "unmatched",
      "waiting",
      "waiting",
    ]);
  });

  it("lists beside a running watch, which holds the folder", async () => {
    const { harness: made } = await unmatchedFolder("unmatched-list-watch");
    const watched = made.folder.watch();
    try {
      await new Promise((resolve) => setTimeout(resolve, 750));
      expect(watched.running()).toBe(true);
      const listed = await made.folder.unmatched();
      expect(listed.ok, JSON.stringify(listed)).toBe(true);
      expect(listed.ok && listed.value.unmatched).toHaveLength(3);
    } finally {
      await watched.stop();
    }
  });

  it("removes the files it may with --yes, ends their placements, and keeps the rest and says why", async () => {
    const {
      harness: made,
      edges,
      door,
    } = await unmatchedFolder("unmatched-yes");
    appendFileSync(join(made.dir, "Note 3.md"), "changed and scanned\n");
    expect((await made.folder.scan()).ok).toBe(true);
    // Changed after the scan, so no scan has read these bytes.
    appendFileSync(join(made.dir, "Note 2.md"), "changed by hand\n");
    const kept = [read(made, "Note 2.md"), read(made, "Note 3.md")];
    expect(placedPaths(edges)).toEqual(["Note 1.md", "Note 2.md", "Note 3.md"]);

    const removed = await made.folder.removeUnmatched({ yes: true });
    expect(removed.ok, JSON.stringify(removed)).toBe(true);
    if (!removed.ok) return;
    expect(removed.value.declined).toBe(false);
    expect(removed.value.removed.map((file) => file.path)).toEqual([
      "Note 1.md",
    ]);
    expect(removed.value.ended).toBe(1);
    expect(
      existsSync(join(made.dir, "Note 1.md")),
      "the unmatched file the folder wrote was not removed",
    ).toBe(false);
    expect(
      [read(made, "Note 2.md"), read(made, "Note 3.md")],
      "a file the person changed was touched",
    ).toEqual(kept);
    expect(removed.value.kept.map((file) => file.path).sort()).toEqual([
      "Note 2.md",
      "Note 3.md",
    ]);
    for (const file of removed.value.kept) {
      expect(
        file.kept,
        `${file.path} was kept without saying why`,
      ).toBeTruthy();
    }

    // The placement ends at the next push, and nothing else about the item changes.
    const pushed = await made.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    expect(
      placedPaths(edges),
      "the removed file's placement stayed on the server, or the kept files' ended",
    ).toEqual(["Note 2.md", "Note 3.md"]);
    expect(door.get(note(1).id)?.version, "the item was changed").toBe(2);
    expect(sentUpdates(made).map((sent) => sent.id)).not.toContain(note(1).id);
    expect(
      existsSync(join(made.dir, "Note 1.md")),
      "the next push wrote the removed file again",
    ).toBe(false);
    const listed = await made.folder.unmatched();
    expect(
      listed.ok && listed.value.unmatched.map((file) => file.path),
    ).toEqual(["Note 2.md", "Note 3.md"]);
  });

  it("keeps a file as the folder wrote it while a write to its item waits to be sent, and removes it once sent", async () => {
    const { harness: made } = await unmatchedFolder("unmatched-waiting", 2);
    const tagged = await made.folder
      .device()
      .addTag(note(1).id, "queued-elsewhere");
    expect(tagged.ok, JSON.stringify(tagged)).toBe(true);
    const bytes = read(made, "Note 1.md");

    const listed = await made.folder.unmatched();
    expect(listed.ok && listed.value.unmatched[0]?.kept).toMatch(
      /waits to be sent/,
    );
    const removed = await made.folder.removeUnmatched({ yes: true });
    expect(removed.ok, JSON.stringify(removed)).toBe(true);
    if (!removed.ok) return;
    expect(removed.value.removed.map((file) => file.path)).toEqual([
      "Note 2.md",
    ]);
    expect(removed.value.kept.map((file) => file.path)).toEqual(["Note 1.md"]);
    expect(
      read(made, "Note 1.md"),
      "the file of an item with a write waiting was removed or changed",
    ).toBe(bytes);

    // The witness: once the write is sent, nothing waits and the same file goes.
    expect((await made.folder.device().drain()).ok).toBe(true);
    const later = await made.folder.removeUnmatched({ yes: true });
    expect(later.ok && later.value.removed.map((file) => file.path)).toEqual([
      "Note 1.md",
    ]);
  });

  it("refuses to remove anything without a terminal and without --yes", async () => {
    const { harness: made } = await unmatchedFolder("unmatched-no-terminal");
    const writes = made.server.requests.filter(isContentWrite).length;
    const refused = await made.folder.removeUnmatched();
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.refusal.code).toBe("usage");
    expect(files(made)).toEqual(["Note 1.md", "Note 2.md", "Note 3.md"]);
    const queue = await made.folder.device().queue();
    expect(
      queue.ok && queue.value.filter((row) => row.kind === "delete_edge"),
      "a refused removal queued the end of a placement",
    ).toEqual([]);
    expect(made.server.requests.filter(isContentWrite)).toHaveLength(writes);

    // The witness: the same folder with --yes removes them.
    const removed = await made.folder.removeUnmatched({ yes: true });
    expect(removed.ok && removed.value.removed).toHaveLength(3);
    expect(files(made)).toEqual([]);
  });

  it.each(["yes", "Y", "no"])(
    "asks at a terminal before removing, and obeys %s",
    async (answer) => {
      const { harness: made } = await unmatchedFolder(
        `unmatched-terminal-${answer}`,
        2,
      );
      const { output } = await atTerminal(made, answer);
      expect(output).toContain("Remove them? [y/N]");
      expect(output).toContain("Note 1.md");
      if (answer !== "no") {
        expect(files(made)).toEqual([]);
        expect(output).toContain("2 file(s) removed");
      } else {
        expect(
          files(made),
          "a file was removed after the answer was no",
        ).toEqual(["Note 1.md", "Note 2.md"]);
        expect(output).toContain("nothing was removed");
      }
    },
  );

  it("goes on with the rest where a file was deleted or changed by hand while it asked", async () => {
    const { harness: made } = await unmatchedFolder("unmatched-race", 4);
    const { output } = await atTerminal(made, "y", [
      ["delete", "Note 2.md"],
      ["append", "Note 3.md", "changed while it asked\n"],
    ]);
    expect(output).toContain("2 file(s) removed");
    expect(output).toContain("Note 2.md is kept");
    expect(output).toContain("Note 3.md is kept");
    expect(
      files(made),
      "the files left alone were not exactly the one changed by hand",
    ).toEqual(["Note 3.md"]);
    expect(read(made, "Note 3.md")).toContain("changed while it asked");
  });

  it("keeps a file saved just as its removal reached it, and the next push places it again", async () => {
    const { harness: made, edges } = await unmatchedFolder(
      "unmatched-last-look",
      2,
    );
    // The fault saves into each file after its check passed and its
    // placement ended, just before it would go.
    const removed = await withFault("save-before-last-look", () =>
      made.folder.removeUnmatched({ yes: true }),
    );
    expect(removed.ok, JSON.stringify(removed)).toBe(true);
    if (!removed.ok) return;
    expect(removed.value.removed).toEqual([]);
    expect(removed.value.ended).toBe(0);
    expect(removed.value.kept.map((file) => file.path)).toEqual([
      "Note 1.md",
      "Note 2.md",
    ]);
    expect(
      [read(made, "Note 1.md"), read(made, "Note 2.md")],
      "a file the person saved as it was being removed was taken away",
    ).toEqual([
      expect.stringContaining("saved meanwhile"),
      expect.stringContaining("saved meanwhile"),
    ]);

    const pushed = await made.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    expect(
      placedPaths(edges),
      "a file kept with the person's save in it lost its item's placement",
    ).toEqual(["Note 1.md", "Note 2.md"]);
  });

  it.each([
    "crash-before-take-away",
    "crash-after-withdraw",
    "crash-after-take-away",
  ])(
    "never deletes the item of a file whose removal stopped at %s, as it does one deleted by hand",
    async (point) => {
      const { harness: made, door } = await unmatchedFolder(
        `unmatched-stopped-${point}`,
        2,
      );
      await expect(
        withFault(`${point}=Note 1.md`, () =>
          made.folder.removeUnmatched({ yes: true }),
        ),
        "the removal did not stop where the fault asks, so nothing below is about a stopped one",
      ).rejects.toThrow(/crashing at .*Note 1\.md/);
      // The witness: the same folder sends a delete for a file a person deleted.
      rmSync(join(made.dir, "Note 2.md"));
      const graceStarted = Date.now();
      await vi.waitFor(
        async () => {
          expect((await made.folder.scan()).ok).toBe(true);
          const queue = await made.folder.device().queue();
          expect(queue.ok).toBe(true);
          if (!queue.ok) return;
          const deleted = queue.value
            .filter((row) => row.kind === "delete_item")
            .map((row) => row.item_id);
          expect(
            (Date.now() - graceStarted) / 1000,
            "the rename grace has not run out, so a missing file would not be a delete yet",
          ).toBeGreaterThan(6);
          expect(deleted).toEqual([note(2).id]);
        },
        { timeout: 25_000, interval: 1_000 },
      );
      const pushed = await made.folder.push();
      expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
      expect(door.get(note(1).id)?.version, "the item was changed").toBe(2);
      expect(sentUpdates(made).map((sent) => sent.id)).not.toContain(
        note(1).id,
      );
    },
  );

  it("never deletes the item of a file whose removal failed after the file left its path, as it does one deleted by hand", async () => {
    const { harness: made, door } = await unmatchedFolder(
      "unmatched-failed-aside",
      2,
    );
    // Kept by the removal, so it stays bound for the witness below.
    appendFileSync(join(made.dir, "Note 2.md"), "changed by hand\n");
    const removed = await withFault("withdraw-look-refused=Note 1.md", () =>
      made.folder.removeUnmatched({ yes: true }),
    );
    expect(removed.ok, JSON.stringify(removed)).toBe(true);
    if (!removed.ok) return;
    expect(
      removed.value.kept.map((file) => file.path).sort(),
      "the removal did not fail where the fault asks, so nothing below is about a failed one",
    ).toEqual(["Note 1.md", "Note 2.md"]);
    expect(existsSync(join(made.dir, "Note 1.md"))).toBe(false);
    // The witness: the same folder sends a delete for a file a person deleted.
    rmSync(join(made.dir, "Note 2.md"));
    const graceStarted = Date.now();
    await vi.waitFor(
      async () => {
        expect((await made.folder.scan()).ok).toBe(true);
        const queue = await made.folder.device().queue();
        expect(queue.ok).toBe(true);
        if (!queue.ok) return;
        const deleted = queue.value
          .filter((row) => row.kind === "delete_item")
          .map((row) => row.item_id);
        expect(
          (Date.now() - graceStarted) / 1000,
          "the rename grace has not run out, so a missing file would not be a delete yet",
        ).toBeGreaterThan(6);
        expect(deleted).toEqual([note(2).id]);
      },
      { timeout: 25_000, interval: 1_000 },
    );
    const pushed = await made.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    expect(door.get(note(1).id)?.version, "the item was changed").toBe(2);
  });

  it("holds the binding of a file whose removal stopped where another file took its path, and never deletes its item", async () => {
    const { harness: made, door } = await unmatchedFolder(
      "unmatched-stopped-replaced",
      2,
    );
    await expect(
      withFault("crash-before-take-away=Note 1.md", () =>
        made.folder.removeUnmatched({ yes: true }),
      ),
      "the removal did not stop where the fault asks, so nothing below is about a stopped one",
    ).rejects.toThrow(/crashing at .*Note 1\.md/);
    rmSync(join(made.dir, "Note 1.md"));
    writeFileSync(join(made.dir, "Note 1.md"), "another file\n");
    // The witness: the same folder sends a delete for a file a person deleted.
    rmSync(join(made.dir, "Note 2.md"));
    const graceStarted = Date.now();
    await vi.waitFor(
      async () => {
        expect((await made.folder.scan()).ok).toBe(true);
        const queue = await made.folder.device().queue();
        expect(queue.ok).toBe(true);
        if (!queue.ok) return;
        expect(
          (Date.now() - graceStarted) / 1000,
          "the rename grace has not run out, so a missing file would not be a delete yet",
        ).toBeGreaterThan(6);
        expect(
          queue.value
            .filter((row) => row.kind === "delete_item")
            .map((row) => row.item_id),
        ).toEqual([note(2).id]);
      },
      { timeout: 25_000, interval: 1_000 },
    );
    const status = await made.folder.status();
    expect(status.ok, JSON.stringify(status)).toBe(true);
    if (!status.ok) return;
    expect(
      status.value.files.filter((file) => file.path === "Note 1.md"),
    ).toEqual([
      expect.objectContaining({
        item_id: note(1).id,
        status: "held",
        flag: "removing",
        reason: expect.stringMatching(/another file is at its path/),
      }),
    ]);
    const pushed = await made.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    expect(door.get(note(1).id)?.version, "the item was changed").toBe(2);
  });

  it("keeps the binding of a file an editor replaced as its removal went, and never deletes its item once it is gone", async () => {
    const { harness: made, door } = await unmatchedFolder(
      "unmatched-editor-replaced",
      2,
    );
    // Kept by the removal, so it stays bound for the witness below.
    appendFileSync(join(made.dir, "Note 2.md"), "changed by hand\n");
    const removed = await withFault("save-after-last-look=Note 1.md", () =>
      made.folder.removeUnmatched({ yes: true }),
    );
    expect(removed.ok, JSON.stringify(removed)).toBe(true);
    if (!removed.ok) return;
    expect(removed.value.removed).toEqual([]);
    expect(
      read(made, "Note 1.md"),
      "the editor's save was not at the path, so nothing below is about it",
    ).toContain("saved after the last look");
    expect(await statusOf(made, "Note 1.md")).toEqual([
      expect.objectContaining({
        item_id: note(1).id,
        status: "held",
        flag: "removing",
      }),
    ]);

    rmSync(join(made.dir, "Note 1.md"));
    expect(
      await deletedPastTheGrace(made),
      "the item of a file an editor replaced as its removal went was deleted",
    ).toEqual([note(2).id]);
    const pushed = await made.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    expect(door.get(note(1).id)?.version, "the item was changed").toBe(2);
  });

  it("never removes a file put at the path after its removal was recorded, and holds it", async () => {
    const { harness: made, door } = await unmatchedFolder(
      "unmatched-replaced-after-record",
      2,
    );
    const path = join(made.dir, "Note 1.md");
    const point = "folder-take-away-recorded";
    const bound = await openBindingFolder(made);
    try {
      await bound.device.hooks.hold(point);
      const removing = bound.bound.removeUnmatched(["Note 1.md"]);
      await untilHeld(bound.device, point);
      // The same bytes under another inode and birth time.
      copyFileSync(path, `${path}.copy`);
      renameSync(`${path}.copy`, path);
      await bound.device.hooks.release(point);
      const removed = await removing;
      expect(removed.ok, JSON.stringify(removed)).toBe(true);
      if (!removed.ok) return;
      expect(removed.value.removed).toEqual([]);
    } finally {
      await bound.device.close();
    }
    expect(
      existsSync(path),
      "a file put at the path after the removal was recorded was removed",
    ).toBe(true);
    expect(await statusOf(made, "Note 1.md")).toEqual([
      expect.objectContaining({
        item_id: note(1).id,
        status: "held",
        flag: "removing",
      }),
    ]);
    // The witness: the same folder removes an unmatched file it may.
    const witness = await made.folder.removeUnmatched({ yes: true });
    expect(witness.ok, JSON.stringify(witness)).toBe(true);
    expect(
      witness.ok && witness.value.removed.map((file) => file.path),
    ).toEqual(["Note 2.md"]);
    expect(existsSync(path), "the held file was removed").toBe(true);
    const pushed = await made.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    expect(door.get(note(1).id)?.version, "the item was changed").toBe(2);
  });

  it("lists a file held for a stopped removal with why, and never takes it away", async () => {
    const { harness: made, door } = await unmatchedFolder(
      "unmatched-stopped-held-listed",
      2,
    );
    await expect(
      withFault("crash-before-take-away=Note 1.md", () =>
        made.folder.removeUnmatched({ yes: true }),
      ),
      "the removal did not stop where the fault asks, so nothing below is about a stopped one",
    ).rejects.toThrow(/crashing at .*Note 1\.md/);
    const path = join(made.dir, "Note 1.md");
    copyFileSync(path, `${path}.copy`);
    renameSync(`${path}.copy`, path);
    expect((await made.folder.scan()).ok).toBe(true);
    expect(
      await statusOf(made, "Note 1.md"),
      "the copy is not held, so nothing below is about a held file",
    ).toEqual([expect.objectContaining({ status: "held", flag: "removing" })]);

    const listed = await made.folder.unmatched();
    expect(listed.ok, JSON.stringify(listed)).toBe(true);
    if (!listed.ok) return;
    expect(
      listed.value.unmatched.filter((file) => file.path === "Note 1.md"),
    ).toEqual([
      expect.objectContaining({
        item_id: note(1).id,
        kept: expect.stringMatching(/another file is at its path/),
        removing: expect.stringMatching(/another file is at its path/),
      }),
    ]);
    const removed = await made.folder.removeUnmatched({ yes: true });
    expect(removed.ok, JSON.stringify(removed)).toBe(true);
    if (!removed.ok) return;
    expect(
      removed.value.removed.map((file) => file.path),
      "the witness: the same command removes an unmatched file it may",
    ).toEqual(["Note 2.md"]);
    expect(
      existsSync(path),
      "a file held for a stopped removal was removed",
    ).toBe(true);
    expect(removed.value.settled).toEqual([]);
    expect(await statusOf(made, "Note 1.md")).toEqual([
      expect.objectContaining({ status: "held", flag: "removing" }),
    ]);
    const pushed = await made.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    expect(door.get(note(1).id)?.version, "the item was changed").toBe(2);
  });

  it("holds the binding of a file whose removal stopped while another directory has its directory's name, and keeps it once the directory is back", async () => {
    // New files outside the query's states are unmatched where they are made.
    const made = await folderHarness("unmatched-stopped-directory-away", {
      settings: { query: { types: ["core.note"], state: ["active"] } },
    });
    started.push(made);
    scriptFolderWrites(made, { edges: new EdgeDoor() });
    const archived = (title: string) =>
      `---\ntitle: ${title}\nstate: archived\n---\nwritten as archived\n`;
    mkdirSync(join(made.dir, "sub"));
    writeFileSync(join(made.dir, "sub", "Shelved.md"), archived("Shelved"));
    writeFileSync(join(made.dir, "witness.md"), archived("Witness"));
    const pushed = await made.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    const listed = await made.folder.unmatched();
    expect(listed.ok, JSON.stringify(listed)).toBe(true);
    if (!listed.ok) return;
    expect(
      listed.value.unmatched.map((file) => [file.path, file.kept]),
      "the files are not removable unmatched files, so nothing below is about them",
    ).toEqual([
      ["sub/Shelved.md", undefined],
      ["witness.md", undefined],
    ]);
    const shelved = listed.value.unmatched[0]!.item_id!;
    const witness = listed.value.unmatched[1]!.item_id!;
    await expect(
      withFault("crash-before-take-away=Shelved.md", () =>
        made.folder.removeUnmatched({ yes: true }),
      ),
      "the removal did not stop where the fault asks, so nothing below is about a stopped one",
    ).rejects.toThrow(/crashing at .*Shelved\.md/);
    expect(
      existsSync(join(made.dir, "witness.md")),
      "the witness was taken away before the stop",
    ).toBe(true);
    const away = join(made.dir, "..", "sub moved away");
    renameSync(join(made.dir, "sub"), away);
    mkdirSync(join(made.dir, "sub"));

    // The witness: the same folder sends a delete for a file a person deleted.
    rmSync(join(made.dir, "witness.md"));
    const graceStarted = Date.now();
    await vi.waitFor(
      async () => {
        expect((await made.folder.scan()).ok).toBe(true);
        const queue = await made.folder.device().queue();
        expect(queue.ok).toBe(true);
        if (!queue.ok) return;
        expect(
          (Date.now() - graceStarted) / 1000,
          "the rename grace has not run out, so a missing file would not be a delete yet",
        ).toBeGreaterThan(6);
        expect(
          queue.value
            .filter((row) => row.kind === "delete_item")
            .map((row) => row.item_id),
          "the item of a file whose directory was moved aside was deleted",
        ).toEqual([witness]);
      },
      { timeout: 25_000, interval: 1_000 },
    );
    expect(await statusOf(made, "sub/Shelved.md")).toEqual([
      expect.objectContaining({
        item_id: shelved,
        status: "held",
        flag: "removing",
        reason: expect.stringMatching(/cannot tell where the file is/),
      }),
    ]);
    const unmatched = await made.folder.unmatched();
    expect(unmatched.ok, JSON.stringify(unmatched)).toBe(true);
    if (!unmatched.ok) return;
    expect(
      unmatched.value.unmatched.filter(
        (file) => file.path === "sub/Shelved.md",
      ),
    ).toEqual([
      expect.objectContaining({
        item_id: shelved,
        kept: expect.stringMatching(/Put back the directory/),
        removing: expect.stringMatching(/Put back the directory/),
      }),
    ]);
    const bound = await openBindingFolder(made);
    try {
      const named = await bound.bound.removeUnmatched(["sub/Shelved.md"]);
      expect(named.ok, JSON.stringify(named)).toBe(true);
      if (!named.ok) return;
      expect(
        named.value.settled,
        "a removal was ended while its directory was away",
      ).toEqual([]);
      expect(named.value.kept).toEqual([
        expect.objectContaining({
          path: "sub/Shelved.md",
          reason: expect.stringMatching(/Put back the directory/),
        }),
      ]);
    } finally {
      await bound.device.close();
    }
    expect(
      (await statusOf(made, "sub/Shelved.md")).map((file) => file.flag),
    ).toEqual(["removing"]);

    rmSync(join(made.dir, "sub"), { recursive: true });
    renameSync(away, join(made.dir, "sub"));
    expect((await made.folder.scan()).ok).toBe(true);
    expect(
      (await statusOf(made, "sub/Shelved.md")).map((file) => file.status),
      "the file back as it was is still held",
    ).not.toContain("held");
    const back = await made.folder.unmatched();
    expect(
      back.ok &&
        back.value.unmatched.filter((file) => file.path === "sub/Shelved.md"),
      "the file back as it was lost its binding",
    ).toEqual([expect.objectContaining({ item_id: shelved })]);
    const queue = await made.folder.device().queue();
    expect(
      queue.ok &&
        queue.value
          .filter(
            (row) =>
              row.item_id === shelved &&
              (row.kind === "update_item" || row.kind === "delete_item"),
          )
          .map((row) => row.kind),
      "an update or delete of the item of the file back as it was was queued",
    ).toEqual([]);
  });

  it("sends nothing a scan read at the path of a stopped removal once the file it removed is back", async () => {
    const { harness: made, door } = await unmatchedFolder(
      "unmatched-stopped-scan-read",
      2,
    );
    await expect(
      withFault("crash-before-take-away=Note 1.md", () =>
        made.folder.removeUnmatched({ yes: true }),
      ),
      "the removal did not stop where the fault asks, so nothing below is about a stopped one",
    ).rejects.toThrow(/crashing at .*Note 1\.md/);
    const path = join(made.dir, "Note 1.md");
    const original = join(made.dir, "..", "Note 1 original.md");
    const text = read(made, "Note 1.md");
    renameSync(path, original);
    writeFileSync(path, `${text}replaced while the removal was stopped\n`);
    // The witness: the same scan sends an edit of a bound file.
    appendFileSync(join(made.dir, "Note 2.md"), "edited by hand\n");
    const point = `folder-scan-read-inode:${String(statSync(path).ino)}`;
    const bound = await openBindingFolder(made);
    try {
      expect((await bound.bound.testOpen()).ok).toBe(true);
      await bound.device.hooks.hold(point);
      const scanning = bound.bound.testScan();
      await untilHeld(bound.device, point);
      renameSync(original, path);
      await bound.device.hooks.release(point);
      const scanned = await scanning;
      expect(scanned.ok, JSON.stringify(scanned)).toBe(true);
      expect((await bound.bound.testScan()).ok).toBe(true);
      expect((await bound.bound.testClose()).ok).toBe(true);
    } finally {
      await bound.device.close();
    }

    const queue = await made.folder.device().queue();
    expect(queue.ok, JSON.stringify(queue)).toBe(true);
    if (!queue.ok) return;
    const updated = queue.value
      .filter((row) => row.kind === "update_item")
      .map((row) => row.item_id);
    expect(
      updated,
      "the witness: an edit of a bound file was not queued",
    ).toContain(note(2).id);
    expect(
      updated,
      "what the scan read at the path of a stopped removal was queued",
    ).not.toContain(note(1).id);
    const pushed = await made.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    expect(door.get(note(1).id)?.version, "the item was changed").toBe(2);
  });

  it.each(["the same", "different"] as const)(
    "judges the file at a stopped removal's path by its birth time too, which is %s",
    async (birth) => {
      const { harness: made, door } = await unmatchedFolder(
        `unmatched-stopped-birth-${birth === "the same" ? "same" : "shifted"}`,
        2,
      );
      const fault =
        birth === "the same"
          ? "crash-before-take-away=Note 1.md"
          : "taken-born-shifted=Note 1.md,crash-before-take-away=Note 1.md";
      await expect(
        withFault(fault, () => made.folder.removeUnmatched({ yes: true })),
        "the removal did not stop where the fault asks, so nothing below is about a stopped one",
      ).rejects.toThrow(/crashing at .*Note 1\.md/);
      expect((await made.folder.scan()).ok).toBe(true);
      const another = (await statusOf(made, "Note 1.md")).filter(
        (file) =>
          file.status === "held" &&
          /another file is at its path/.test(file.reason ?? ""),
      );
      // A recorded birth time the file does not have is a reused inode.
      expect(another.length, `birth time ${birth}`).toBe(
        birth === "the same" ? 0 : 1,
      );
      expect(existsSync(join(made.dir, "Note 1.md"))).toBe(true);
      const pushed = await made.folder.push();
      expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
      expect(door.get(note(1).id)?.version, "the item was changed").toBe(2);
    },
  );

  it("lists a stopped removal whose record it cannot read once its file is gone, and ends it with --remove, keeping the item", async () => {
    const { harness: made, door } = await unmatchedFolder(
      "unmatched-stopped-unread",
      2,
    );
    await expect(
      withFault("crash-before-take-away=Note 1.md", () =>
        made.folder.removeUnmatched({ yes: true }),
      ),
      "the removal did not stop where the fault asks, so nothing below is about a stopped one",
    ).rejects.toThrow(/crashing at .*Note 1\.md/);
    const db = new DatabaseSync(made.folder.store);
    try {
      expect(
        db
          .prepare(
            "UPDATE meta SET value = 'unreadable' WHERE key LIKE 'folder_taken:%'",
          )
          .run().changes,
        "no record of the stopped removal, so nothing below is about it",
      ).toBe(1);
    } finally {
      db.close();
    }
    rmSync(join(made.dir, "Note 1.md"));
    expect(
      await deletedPastTheGrace(made),
      "the item of a file whose removal record does not read was deleted",
    ).toEqual([note(2).id]);
    expect(await statusOf(made, "Note 1.md")).toEqual([
      expect.objectContaining({
        status: "held",
        flag: "removing",
        reason: expect.stringMatching(/cannot read its record/),
      }),
    ]);
    const listed = await made.folder.unmatched();
    expect(listed.ok, JSON.stringify(listed)).toBe(true);
    if (!listed.ok) return;
    expect(listed.value.unmatched).toEqual([
      expect.objectContaining({
        path: "Note 1.md",
        item_id: note(1).id,
        removing: expect.stringMatching(/--remove/),
      }),
    ]);

    const removed = await made.folder.removeUnmatched({ yes: true });
    expect(removed.ok, JSON.stringify(removed)).toBe(true);
    if (!removed.ok) return;
    expect(removed.value.settled).toEqual([
      expect.objectContaining({ path: "Note 1.md", item_id: note(1).id }),
    ]);
    expect(await statusOf(made, "Note 1.md")).toEqual([]);
    const after = await made.folder.unmatched();
    expect(after.ok && after.value.unmatched).toEqual([]);
    const queue = await made.folder.device().queue();
    expect(
      queue.ok &&
        queue.value
          .filter((row) => row.kind === "delete_item")
          .map((row) => row.item_id),
    ).toEqual([note(2).id]);
    const pushed = await made.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    expect(door.get(note(1).id)?.version, "the item was changed").toBe(2);
  });

  it("removes through a binding the unmatched files it may, and keeps the rest and says why", async () => {
    const { harness: made, edges } = await unmatchedFolder("unmatched-binding");
    appendFileSync(join(made.dir, "Note 2.md"), "changed by hand\n");
    const changed = read(made, "Note 2.md");
    const bound = await openBindingFolder(made);
    try {
      const removed = await bound.bound.removeUnmatched([
        "Note 1.md",
        "Note 2.md",
      ]);
      expect(removed.ok, JSON.stringify(removed)).toBe(true);
      if (!removed.ok) return;
      expect(removed.value.removed).toEqual([
        { path: "Note 1.md", itemId: note(1).id },
      ]);
      expect(removed.value.ended).toBe(1);
      expect(removed.value.kept).toEqual([
        {
          path: "Note 2.md",
          itemId: note(2).id,
          reason: expect.stringMatching(/differ from what the folder wrote/),
        },
      ]);
    } finally {
      await bound.device.close();
    }
    expect(files(made)).toEqual(["Note 2.md", "Note 3.md"]);
    expect(read(made, "Note 2.md")).toBe(changed);
    const pushed = await made.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    expect(placedPaths(edges)).toEqual(["Note 2.md", "Note 3.md"]);
  });

  it("takes away a new file whose item the query's states do not hold, as it takes any, and ends its record", async () => {
    const made = await folderHarness("unmatched-new-outside-state", {
      settings: { query: { types: ["core.note"], state: ["active"] } },
    });
    started.push(made);
    const edges = new EdgeDoor();
    scriptFolderWrites(made, { edges });
    writeFileSync(
      join(made.dir, "shelved.md"),
      "---\ntitle: Shelved\nstate: archived\n---\nwritten as archived\n",
    );
    const pushed = await made.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    expect(pushed.ok && pushed.value.pull?.unmatched).toBe(1);
    const listed = await made.folder.unmatched();
    expect(listed.ok, JSON.stringify(listed)).toBe(true);
    if (!listed.ok) return;
    expect(listed.value.unmatched.map((file) => file.path)).toEqual([
      "shelved.md",
    ]);
    expect(
      listed.value.unmatched[0]?.kept,
      "a new file outside the query's states was reported as one removal would keep",
    ).toBeUndefined();
    const removed = await made.folder.removeUnmatched({ yes: true });
    expect(removed.ok, JSON.stringify(removed)).toBe(true);
    if (!removed.ok) return;
    expect(removed.value.removed.map((file) => file.path)).toEqual([
      "shelved.md",
    ]);
    expect(removed.value.kept).toEqual([]);
    expect(existsSync(join(made.dir, "shelved.md"))).toBe(false);
    // Its record is over: the item is neither counted nor listed again.
    const later = await made.folder.pull();
    expect(later.ok && later.value.unmatched, JSON.stringify(later)).toBe(0);
  });

  it("takes files away from a folder a watch holds, and is refused while the first sync waits", async () => {
    const { harness: made } = await unmatchedFolder("unmatched-held");
    const watched = made.folder.watch();
    try {
      await vi.waitFor(() => expect(watched.stderr).toContain("watching"), {
        timeout: 30_000,
        interval: 100,
      });
      const removed = await made.folder.removeUnmatched({ yes: true });
      expect(removed.ok, JSON.stringify(removed)).toBe(true);
      expect(files(made)).toEqual([]);
      // The watch let the folder go for the removal, and goes on.
      expect(watched.running(), watched.stderr).toBe(true);
      expect(watched.stdout).toContain('"code":"handed_over"');
    } finally {
      await watched.stop();
    }

    const first = await folderHarness("unmatched-first-sync", {
      confirm: false,
      hydrate: false,
      files: { "mine.md": "---\ntitle: Mine\n---\nbody\n" },
    });
    started.push(first);
    const waiting = await first.folder.removeUnmatched({ yes: true });
    expect(waiting.ok).toBe(false);
    if (!waiting.ok) expect(waiting.refusal.code).toBe("first_sync_waiting");
  });
});
