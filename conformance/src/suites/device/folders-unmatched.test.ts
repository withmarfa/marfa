import { execFile } from "node:child_process";
import { appendFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  copyItemEvent,
  copyLiveReplay,
  copyReplay,
  wireItem,
} from "../../device/marfa-answers.js";
import type { FolderDoor } from "../../device/folder-door.js";
import { keychainEnv } from "../../utils/keychain.js";
import { folderHarness, requireBinary, type FolderHarness } from "./harness.js";
import {
  EdgeDoor,
  isContentWrite,
  read,
  scriptFolderWrites,
  sentUpdates,
} from "./folders.shared.js";

const execute = promisify(execFile);

/**
 * "A folder's unmatched files can be listed and removed after confirmation."
 *
 * An unmatched file is one the folder keeps because its item left the search
 * by a retype. Three items start out in the folder and are retyped out of the
 * search at the next catch-up, so each file is unmatched; the cases then make
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

/** A folder holding `count` notes, each written as a file and then retyped out of its search. */
async function unmatchedFolder(label: string, count = 3): Promise<Made> {
  const items = Array.from({ length: count }, (_, at) => note(at + 1));
  const harness = await folderHarness(label, {
    rows: { "core.note": items.map((item) => ({ item })) },
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

  it.each(["yes", "no"])(
    "asks at a terminal before removing, and obeys %s",
    async (answer) => {
      const { harness: made } = await unmatchedFolder(
        `unmatched-terminal-${answer}`,
        2,
      );
      const { output } = await atTerminal(made, answer);
      expect(output).toContain("Remove them? [y/N]");
      expect(output).toContain("Note 1.md");
      if (answer === "yes") {
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

  it("is refused while a watch holds the folder, and while the first sync waits", async () => {
    const { harness: made } = await unmatchedFolder("unmatched-held");
    const watched = made.folder.watch();
    try {
      await new Promise((resolve) => setTimeout(resolve, 750));
      const refused = await made.folder.removeUnmatched({ yes: true });
      expect(refused.ok).toBe(false);
      if (!refused.ok) expect(refused.refusal.code).toBe("reading_handle");
      expect(files(made)).toEqual(["Note 1.md", "Note 2.md", "Note 3.md"]);
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
