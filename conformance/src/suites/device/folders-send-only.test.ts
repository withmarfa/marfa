import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  answers,
  copyItemEvent,
  copyReplay,
  wireItem,
} from "../../device/marfa-answers.js";
import { folderHarness, type FolderHarness } from "./harness.js";
import {
  isContentWrite,
  put,
  read,
  scriptFolderWrites,
  sentCreates,
  sentTitles,
  sentUpdates,
} from "./folders.shared.js";

/**
 * "A folder can send what it holds without pulling."
 *
 * Every rule here is about something a send-only run does not do, so each
 * case runs the same setup once with the flag as the witness that the thing
 * was there to be done: the plain push writes the server's item and removes
 * the trashed item's file, and the send-only run leaves the directory byte
 * for byte as it found it.
 */

let harness: FolderHarness | undefined;
let witness: FolderHarness | undefined;

afterEach(async () => {
  await harness?.stop();
  await witness?.stop();
  harness = undefined;
  witness = undefined;
});

const remote = {
  id: "01a00000-0000-7000-8000-0000000007a1",
  properties: { title: "Server note", body: "written on the server\n" },
};
const rows = { "core.note": [{ item: remote }] };
const typed = (title: string): string =>
  `---\ntitle: ${title}\n---\nwritten by hand\n`;

/** Every file under the directory outside `.marfa`, by path, with its bytes. */
function directory(made: FolderHarness, below = ""): Record<string, string> {
  const held: Record<string, string> = {};
  for (const name of readdirSync(join(made.dir, below))) {
    if (name === ".marfa") continue;
    const path = below === "" ? name : `${below}/${name}`;
    held[path] = statSync(join(made.dir, path)).isDirectory()
      ? ""
      : readFileSync(join(made.dir, path), "utf8");
    if (statSync(join(made.dir, path)).isDirectory()) {
      Object.assign(held, directory(made, path));
    }
  }
  return held;
}

/** The content writes a folder has sent, as the method and path. */
function writesSent(made: FolderHarness): string[] {
  return made.server.requests
    .filter(isContentWrite)
    .map((request) => `${request.method} ${request.pathname}`);
}

describe("a push that only sends", () => {
  it("sends a file made here and writes no file into the directory, where a push writes the server's item", async () => {
    witness = await folderHarness("send-only-witness", { rows });
    scriptFolderWrites(witness);
    put(witness, "mine.md", typed("Mine"));
    const plain = await witness.folder.push();
    expect(plain.ok, JSON.stringify(plain)).toBe(true);
    expect(
      existsSync(join(witness.dir, "Server note.md")),
      "the witness push wrote nothing, so the send-only case below shows nothing",
    ).toBe(true);

    harness = await folderHarness("send-only", { rows });
    scriptFolderWrites(harness);
    put(harness, "mine.md", typed("Mine"));
    const before = directory(harness);
    const sent = await harness.folder.pushSendOnly();
    expect(sent.ok, JSON.stringify(sent)).toBe(true);
    if (!sent.ok) return;
    expect(
      sentTitles(harness),
      "a send-only run did not send the file made here",
    ).toEqual(["Mine"]);
    expect(sent.value.scan.created).toBe(1);
    expect(sent.value.drain.answered).toBeGreaterThanOrEqual(1);
    expect(
      directory(harness),
      "a send-only run wrote into, or removed from, the directory",
    ).toEqual(before);
    expect(existsSync(join(harness.dir, "Server note.md"))).toBe(false);
  });

  it("says what it sent and that it did not pull, in JSON and in words", async () => {
    harness = await folderHarness("send-only-report", { rows });
    scriptFolderWrites(harness);
    put(harness, "mine.md", typed("Mine"));
    const sent = await harness.folder.pushSendOnly();
    expect(sent.ok, JSON.stringify(sent)).toBe(true);
    if (!sent.ok) return;
    expect(sent.value.send_only).toBe(true);
    expect(sent.value.pulled).toBe(false);
    expect(sent.value).not.toHaveProperty("pull");
    expect(sent.value).not.toHaveProperty("catch_up");
    expect(sent.value.drain.answered).toBeGreaterThanOrEqual(1);

    put(harness, "mine.md", typed("Mine") + "and more\n");
    const said = await harness.folder.pushSendOnlyText();
    expect(said.ok, JSON.stringify(said)).toBe(true);
    if (!said.ok) return;
    expect(said.value).toMatch(/answered [1-9]/);
    expect(said.value).toContain("nothing was pulled");
  });

  it("leaves what it did not pull for the next push", async () => {
    harness = await folderHarness("send-only-later", { rows });
    scriptFolderWrites(harness);
    put(harness, "mine.md", typed("Mine"));
    expect((await harness.folder.pushSendOnly()).ok).toBe(true);
    expect(existsSync(join(harness.dir, "Server note.md"))).toBe(false);

    const plain = await harness.folder.push();
    expect(plain.ok, JSON.stringify(plain)).toBe(true);
    expect(
      read(harness, "Server note.md"),
      "a push after a send-only run did not pull what the run left",
    ).toContain("written on the server");
    expect(sentCreates(harness)).toHaveLength(1);
  });

  it("removes no file whose item has left, where a push removes it", async () => {
    const departed = {
      id: "01a00000-0000-7000-8000-0000000007d1",
      properties: { title: "going", body: "body\n" },
    };
    harness = await folderHarness("send-only-departed", {
      rows: { "core.note": [{ item: departed }] },
      events: [
        copyReplay("2", [
          copyItemEvent(
            "2",
            "item.deleted",
            wireItem({ ...departed, state: "trashed" }),
          ),
        ]),
      ],
    });
    scriptFolderWrites(harness);
    expect((await harness.folder.pull()).ok).toBe(true);
    expect(existsSync(join(harness.dir, "going.md"))).toBe(true);
    const caught = await harness.folder.device().catchUp();
    expect(caught.ok ? caught.value.applied : 0).toBe(1);

    const before = directory(harness);
    const sent = await harness.folder.pushSendOnly();
    expect(sent.ok, JSON.stringify(sent)).toBe(true);
    expect(
      existsSync(join(harness.dir, "going.md")),
      "a send-only run removed the file of an item that left",
    ).toBe(true);
    expect(directory(harness)).toEqual(before);

    const plain = await harness.folder.pull();
    expect(
      plain.ok && plain.value.removed,
      "the witness: a pull removes the file the send-only run left",
    ).toBe(1);
    expect(existsSync(join(harness.dir, "going.md"))).toBe(false);
  });

  it("hydrates a copy that never was first, which writes no file, and then sends", async () => {
    harness = await folderHarness("send-only-hydrates", {
      rows,
      hydrate: false,
      files: { "mine.md": typed("Mine") },
    });
    scriptFolderWrites(harness);
    const before = directory(harness);
    const sent = await harness.folder.pushSendOnly();
    expect(sent.ok, JSON.stringify(sent)).toBe(true);
    if (!sent.ok) return;
    expect(
      sent.value.hydrated,
      "the copy was never hydrated, and the run did not hydrate it",
    ).not.toBeNull();
    expect(
      sentTitles(harness),
      "after hydrating, the run did not send the file",
    ).toEqual(["Mine"]);
    expect(directory(harness)).toEqual(before);
  });

  it("is refused while the first sync waits, before it sends anything", async () => {
    harness = await folderHarness("send-only-waiting", {
      rows,
      confirm: false,
      hydrate: false,
      files: { "mine.md": typed("Mine") },
    });
    scriptFolderWrites(harness);
    expect(harness.added.first_sync.waiting).toBe(true);
    const before = directory(harness);
    const refused = await harness.folder.pushSendOnly();
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.refusal.code).toBe("first_sync_waiting");
    expect(
      writesSent(harness),
      "a send-only run sent a write while the first sync waited",
    ).toEqual([]);
    expect(directory(harness)).toEqual(before);

    // The witness: once confirmed, the same run sends the file.
    expect((await harness.folder.confirm()).ok).toBe(true);
    const sent = await harness.folder.pushSendOnly();
    expect(sent.ok, JSON.stringify(sent)).toBe(true);
    expect(sentTitles(harness)).toEqual(["Mine"]);
  });

  it("keeps its writes queued where the server cannot be reached, and sends them at the next run", async () => {
    harness = await folderHarness("send-only-offline", { rows });
    scriptFolderWrites(harness);
    put(harness, "mine.md", typed("Mine"));
    await harness.server.offline();
    const offline = await harness.folder.pushSendOnly();
    await harness.server.online();
    expect(offline.ok, JSON.stringify(offline)).toBe(true);
    if (!offline.ok) return;
    expect(
      offline.value.drain.undelivered,
      "the write the server could not take was dropped, or not reported",
    ).toBeGreaterThanOrEqual(1);
    expect(offline.value.drain.answered).toBe(0);
    expect(offline.value.exit).toBe(3);
    expect(sentCreates(harness)).toEqual([]);
    const waiting = await harness.folder.status();
    expect(waiting.ok && waiting.value.files).toMatchObject([
      { path: "mine.md", status: "waiting" },
    ]);

    const online = await harness.folder.pushSendOnly();
    expect(online.ok, JSON.stringify(online)).toBe(true);
    expect(sentTitles(harness)).toEqual(["Mine"]);
    expect(sentUpdates(harness)).toEqual([]);
    expect(existsSync(join(harness.dir, "Server note.md"))).toBe(false);
  });
  it("leaves the write a rate limit refused for the next run, without waiting", async () => {
    harness = await folderHarness("send-only-rate-limit", { rows });
    let attempts = 0;
    scriptFolderWrites(harness, {
      creating: (answer) => {
        attempts += 1;
        return attempts === 1 ? answers.rateLimited() : answer;
      },
    });
    put(harness, "mine.md", typed("Mine"));
    const sent = await harness.folder.pushSendOnly();
    expect(sent.ok, JSON.stringify(sent)).toBe(true);
    if (!sent.ok) return;
    expect(
      [attempts, sent.value.drain.undelivered, sent.value.exit],
      "the run waited out the rate limit and drained again",
    ).toEqual([1, 1, 3]);
    const again = await harness.folder.pushSendOnly();
    expect(again.ok, JSON.stringify(again)).toBe(true);
    if (!again.ok) return;
    expect([attempts, again.value.drain.undelivered, again.value.exit]).toEqual(
      [2, 0, 0],
    );
  });
});
