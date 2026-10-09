import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, afterEach, vi } from "vitest";
import {
  answers,
  catchupTooOld,
  connected,
  edgeEvent,
  copyHeadRead,
  copyItemEvent,
  copyLiveReplay,
  copyStreamCursor,
  refusal,
  copyReplay,
  wireEdge,
  wireItem,
  wireType,
  typeCatalog,
} from "../../device/marfa-answers.js";
import {
  KEY,
  acceptUploads,
  folderHarness,
  folderItem,
  hashOf,
  requireBinary,
  scriptBlob,
  scriptFolderRow,
  scriptHydration,
} from "./harness.js";
import { CliFolder, type FolderSettings } from "../../device/cli-adapter.js";
import { BUILT_FOR, ScriptedServer } from "../../device/scripted-server.js";
import { FolderDoor } from "../../device/folder-door.js";
import type { FolderHarness } from "./harness.js";
import type {
  Answer,
  RecordedRequest,
  Responder,
} from "../../device/scripted-server.js";
import type { WireItemOptions } from "../../device/marfa-answers.js";
import {
  EdgeDoor,
  bodyOf,
  frontOf,
  idIn,
  put,
  read,
  scriptFolderChanges,
  scriptFolderWrites,
  sentCreates,
  sentEdgeWrites,
  sentTitles,
  sentUpdates,
  settingsFile,
  withoutPlacements,
} from "./folders.shared.js";

/**
 * "A folder is a directory bound to a `system.folder`, whose search decides
 * what it holds."
 *
 * Most of the rules below exist because their absence is silent: a file bound
 * to the wrong item has one note written over another, and nothing anywhere
 * says so. So each is written as a rule the folder either keeps or refuses to
 * act on.
 */

let harness: FolderHarness | undefined;
let second: FolderHarness | undefined;

afterEach(async () => {
  await harness?.stop();
  await second?.stop();
  harness = undefined;
  second = undefined;
});

/** The paths the door holds an `in-folder` placement for, in order. */
function placedPaths(edges: EdgeDoor): string[] {
  return [...edges.edges.values()]
    .filter((edge) => edge.edge_type === "in-folder")
    .map((edge) => String((edge.properties as Record<string, unknown>).path))
    .sort();
}

/** How many edge creates the folder has sent. */
function postedEdges(harness: FolderHarness): number {
  return harness.server.requests.filter(
    (request) => request.method === "POST" && request.pathname === "/edges",
  ).length;
}

/**
 * What a stream of the server's changes meets: the conflicted copies the door
 * holds so far, as created, which the stream a device opens after its write
 * was answered carries and the one it opened before did not. Ended at once,
 * so a watch opens it again.
 */
function copiesAsTheyArrive(door: () => FolderDoor | undefined) {
  return (request: RecordedRequest): Answer => {
    const copies = door()?.conflictedCopies() ?? [];
    const seen = BigInt(request.headers["last-event-id"] ?? "0");
    // The log's head moves only once there is something in it to take.
    return copies.length === 0 || seen >= 3n
      ? copyReplay("2", [])
      : copyReplay(
          "3",
          copies.map(([id, row]) =>
            copyItemEvent(
              "3",
              "item.created",
              wireItem({ id, version: 1, properties: row.properties }),
              { tags: row.tags },
            ),
          ),
        );
  };
}

describe("what a folder is", () => {
  it("reads its settings from the system.folder it is bound to", async () => {
    harness = await folderHarness("folder-settings", {
      settings: {
        search: { types: ["core.bookmark"] },
        defaults: {
          type: "core.bookmark",
          properties: { language: "en" },
          tags: ["inbox"],
        },
      },
      rows: {
        "core.bookmark": [
          {
            item: {
              id: "01a00000-0000-7000-8000-0000000001b1",
              type: "core.bookmark",
              properties: { title: "a bookmark", body: "held\n" },
            },
          },
        ],
      },
    });
    scriptFolderWrites(harness);

    const status = await harness.folder.device().status();
    expect(status.ok && status.value.pinned).toContain(harness.settings.id);

    put(harness, "new.md", "---\ntitle: A new file\n---\nbody\n");
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    if (!pushed.ok) return;
    const [sent] = sentCreates(harness);
    expect(
      sent?.type,
      "a new file did not become the type the folder's settings name",
    ).toBe("core.bookmark");
    expect((sent?.properties as Record<string, unknown>).language).toBe("en");
    expect(sent?.tier).toBe("library");
    const queued = await harness.folder.device().queue();
    expect(queued.ok).toBe(true);
    if (!queued.ok) return;
    expect(
      queued.value
        .filter((row) => row.kind === "add_tag")
        .map((row) => row.tag),
    ).toEqual(["inbox"]);
    expect(
      existsSync(join(harness.dir, "a bookmark.md")),
      "the bookmark the search holds did not become a file",
    ).toBe(true);
  });

  it("takes settings changed on another device", async () => {
    const tagged = (id: string, title: string, tag: string) => ({
      item: { id, properties: { title, body: `${tag}\n` } },
      tags: [tag],
    });
    const before: FolderSettings = {
      search: { types: ["core.note"], filter: 'tags contains "a"' },
      defaults: { tags: ["a"] },
    };
    const after: FolderSettings = {
      search: { types: ["core.note"], filter: 'tags contains "b"' },
      defaults: { tags: ["b"] },
    };
    let changed: Record<string, unknown> = {};
    harness = await folderHarness("folder-settings-changed", {
      settings: before,
      rows: {
        "core.note": [
          tagged("01a00000-0000-7000-8000-0000000001a1", "tagged a", "a"),
          tagged("01a00000-0000-7000-8000-0000000001a2", "tagged b", "b"),
        ],
      },
      events: [
        (): Answer =>
          copyReplay("2", [copyItemEvent("2", "item.updated", changed)]),
        copyLiveReplay("2", []),
      ],
    });
    scriptFolderWrites(harness);
    expect((await harness.folder.pull()).ok).toBe(true);
    expect(existsSync(join(harness.dir, "tagged a.md"))).toBe(true);
    expect(existsSync(join(harness.dir, "tagged b.md"))).toBe(false);

    // Another device changes the settings; the push's catch-up brings them.
    harness.settings.settings = after;
    harness.settings.version = 2;
    changed = folderItem(harness.settings);
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    if (!pushed.ok) return;
    expect(
      existsSync(join(harness.dir, "tagged b.md")),
      "the folder went on answering the search it was added with",
    ).toBe(true);
    expect(pushed.value.pull?.unmatched).toBe(1);
    expect(
      pushed.value.catch_up.hydrated,
      "the changed settings did not reach the copy's own row through its stream",
    ).toBeNull();

    put(harness, "new.md", "---\ntitle: New\n---\nbody\n");
    expect((await harness.folder.push()).ok).toBe(true);
    const queued = await harness.folder.device().queue();
    expect(queued.ok).toBe(true);
    if (!queued.ok) return;
    expect(
      queued.value
        .filter((row) => row.kind === "add_tag")
        .map((row) => row.tag),
      "a new file took the defaults the folder was added with",
    ).toEqual(["b"]);
  });

  it("hydrates again where its changed settings ask for another slice", async () => {
    const note = "01a00000-0000-7000-8000-0000000001c1";
    for (const { asks, settings, check } of [
      {
        asks: "other types",
        settings: { search: { types: ["core.bookmark"] } },
        check: () => {
          expect(existsSync(join(harness!.dir, "a bookmark.md"))).toBe(true);
          expect(
            existsSync(join(harness!.dir, "a note.md")),
            "the file of an item that left by type was taken away",
          ).toBe(true);
        },
      },
      {
        asks: "another tier",
        settings: { search: { types: ["core.note"], tier: "feed" as const } },
        check: () => undefined,
      },
    ]) {
      let changed: Record<string, unknown> = {};
      harness = await folderHarness("folder-settings-reslice", {
        rows: {
          "core.note": [
            {
              item: {
                id: note,
                properties: { title: "a note", body: "held\n" },
              },
            },
          ],
          "core.bookmark": [
            {
              item: {
                id: "01a00000-0000-7000-8000-0000000001c2",
                type: "core.bookmark",
                properties: { title: "a bookmark", body: "held\n" },
              },
            },
          ],
        },
        edges: { "parent-of": [] },
        events: [
          (): Answer =>
            copyReplay("2", [copyItemEvent("2", "item.updated", changed)]),
          copyHeadRead("3"),
        ],
      });
      scriptFolderWrites(harness);
      expect((await harness.folder.pull()).ok).toBe(true);
      expect(existsSync(join(harness.dir, "a bookmark.md"))).toBe(false);

      harness.settings.settings = settings;
      harness.settings.version = 2;
      changed = folderItem(harness.settings);
      const pushed = await harness.folder.push();
      expect(pushed.ok, `${asks}: ${JSON.stringify(pushed)}`).toBe(true);
      if (!pushed.ok) return;
      expect(
        pushed.value.catch_up.hydrated,
        `settings asking for ${asks} were answered from the copy as it was`,
      ).not.toBeNull();
      check();
      await harness.stop();
      harness = undefined;
    }
  });

  it("refuses to follow an item that is not a live folder", async () => {
    const id = "01a00000-0000-7000-8000-0000000001f2";
    for (const { what, row, refused } of [
      // The witness: the same add of a live folder is taken.
      {
        what: "a live folder",
        row: () =>
          folderItem({
            id,
            version: 1,
            settings: { search: { types: ["core.note"] } },
          }),
        refused: undefined,
      },
      {
        what: "an item of another type",
        row: () =>
          wireItem({ id, properties: { title: "a note", body: "x\n" } }),
        refused: "not a system.folder",
      },
      {
        what: "a revoked folder",
        row: () =>
          wireItem({
            id,
            type: "system.folder",
            state: "revoked",
            properties: {
              title: "gone",
              revoked_at: "2026-09-01T00:00:00.000Z",
            },
          }),
        refused: "is revoked",
      },
    ]) {
      const server = await ScriptedServer.start();
      scriptHydration(server, { head: "1" });
      server.copyAnswer(
        "GET",
        "/keys/current",
        answers.currentKey("fixture-key", { "*": "write" }),
      );
      server.copyAnswer("GET", `/items/${id}`, answers.updated(row()));
      const dir = join(
        mkdtempSync(join(tmpdir(), "marfa-folder-not-a-folder-")),
        "notes",
      );
      const folder = new CliFolder(dir, {
        binary: requireBinary(),
        url: server.url,
        key: KEY,
      });
      try {
        const added = await folder.add(id);
        if (refused === undefined) {
          expect(
            added.ok,
            `${what} was refused: ${JSON.stringify(added)}`,
          ).toBe(true);
          continue;
        }
        expect(added.ok, `a directory was bound to ${what}`).toBe(false);
        if (added.ok) return;
        expect(added.refusal.raw, what).toContain(refused);
      } finally {
        await server.stop();
      }
    }
  });

  it("refuses to follow settings its key cannot read, naming the permission", async () => {
    const id = "01a00000-0000-7000-8000-0000000001f1";
    // The server answers a folder the key cannot read as no folder, so the
    // two keys differ only in what `GET /keys/current` says they hold.
    for (const [types, named] of [
      [{ "core.*": "write" }, true],
      [{ "*": "write" }, false],
    ] as const) {
      const server = await ScriptedServer.start();
      server.copyAnswer("GET", `/items/${id}`, answers.itemNotFound(id));
      server.copyAnswer(
        "GET",
        "/keys/current",
        answers.currentKey("fixture-key", { "*": "write" }, types),
      );
      const dir = join(
        mkdtempSync(join(tmpdir(), "marfa-folder-unreadable-")),
        "notes",
      );
      const folder = new CliFolder(dir, {
        binary: requireBinary(),
        url: server.url,
        key: KEY,
      });
      try {
        const added = await folder.add(id);
        expect(
          added.ok,
          "a folder was added that cannot read its own settings",
        ).toBe(false);
        if (added.ok) return;
        expect(
          added.refusal.raw.includes("system.folder:read"),
          `the refusal to a key holding ${JSON.stringify(types)}: ${added.refusal.raw}`,
        ).toBe(named);
        // Written by every add that succeeds (`› writes its settings out as
        // one file in .marfa/`).
        expect(existsSync(join(dir, ".marfa", "folder.yaml"))).toBe(false);
      } finally {
        await server.stop();
      }
    }
  });

  it("writes its settings out as one file in .marfa/", async () => {
    harness = await folderHarness("folder-settings-file", {
      settings: {
        search: { types: ["core.note"], filter: 'tags contains "kept"' },
        defaults: { tags: ["inbox"] },
        include: ["*.md"],
      },
    });
    expect(
      readdirSync(join(harness.dir, ".marfa")).filter(
        (name) => !name.startsWith("core."),
      ),
      "the settings went somewhere other than one file, or a record of its own stayed beside it",
    ).toEqual(["folder.yaml"]);
    const text = readFileSync(settingsFile(harness), "utf8");
    for (const line of [
      `folder: ${harness.settings.id}`,
      "version: 1",
      "- core.note",
      'filter: "tags contains \\"kept\\""',
      "- inbox",
      '- "*.md"',
    ]) {
      expect(text, `the settings file did not carry ${line}`).toContain(line);
    }
  });

  it("rewrites a settings file whose edit changes no setting", async () => {
    harness = await folderHarness("folder-settings-no-change", {
      events: [copyLiveReplay("1", [])],
    });
    scriptFolderWrites(harness);
    const sent = scriptFolderChanges(harness);
    const written = readFileSync(settingsFile(harness), "utf8");
    writeFileSync(settingsFile(harness), written + "# a comment of my own\n");
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    if (!pushed.ok) return;
    expect(sent, "an edit that changed no setting was sent").toEqual([]);
    expect(
      readFileSync(settingsFile(harness), "utf8"),
      "a file whose edit changed no setting stayed an edit, flagged or sent at every pass",
    ).toBe(written);
    expect(pushed.value.settings.written).toBe(true);

    // An edit that lands moves the file to version 2, the witness that an
    // edit is sent at all.
    writeFileSync(
      settingsFile(harness),
      written + "defaults:\n  tags:\n    - landed\n",
    );
    expect((await harness.folder.push()).ok).toBe(true);
    expect(sent).toHaveLength(1);
    const current = readFileSync(settingsFile(harness), "utf8");
    expect(current).toContain("version: 2");

    // A file older than the settings that names the settings in force
    // changes none of them.
    writeFileSync(
      settingsFile(harness),
      current.replace("version: 2", "version: 1"),
    );
    const stale = await harness.folder.push();
    expect(stale.ok, JSON.stringify(stale)).toBe(true);
    if (!stale.ok) return;
    expect(
      sent,
      "a file naming only the settings in force was sent because its version line is older",
    ).toHaveLength(1);
    expect(readFileSync(settingsFile(harness), "utf8")).toBe(current);
    expect(stale.value.settings.written).toBe(true);

    // One changed value makes it an older file's edit, sent whole.
    writeFileSync(
      settingsFile(harness),
      current
        .replace("version: 2", "version: 1")
        .replace("title: folder", "title: renamed"),
    );
    expect((await harness.folder.push()).ok).toBe(true);
    expect(sent.at(-1)).toEqual({
      version: 1,
      title: "renamed",
      search: { types: ["core.note"] },
      defaults: { tags: ["landed"] },
    });

    // So is one that only leaves a setting out, which may be one added
    // since; the door keeps a setting nobody sends.
    const third = readFileSync(settingsFile(harness), "utf8");
    expect(third).toContain("version: 3");
    writeFileSync(
      settingsFile(harness),
      third.replace("version: 3", "version: 2").replace(/title: .*\n/, ""),
    );
    const left = await harness.folder.push();
    expect(left.ok, JSON.stringify(left)).toBe(true);
    if (!left.ok) return;
    expect(left.value.settings.flagged).toBeNull();
    expect(sent.at(-1)).toEqual({
      version: 2,
      search: { types: ["core.note"] },
      defaults: { tags: ["landed"] },
    });
    expect(readFileSync(settingsFile(harness), "utf8")).toContain(
      "title: renamed",
    );
  });

  it("sends a settings edit the folder door could not take for now at the next push", async () => {
    harness = await folderHarness("folder-settings-retried", {
      events: [copyLiveReplay("1", [])],
    });
    scriptFolderWrites(harness);
    const sent = scriptFolderChanges(
      harness,
      refusal(503, "service_unavailable", "try again"),
      { once: true },
    );
    writeFileSync(
      settingsFile(harness),
      readFileSync(settingsFile(harness), "utf8") +
        "defaults:\n  tags:\n    - later\n",
    );
    const first = await harness.folder.push();
    expect(first.ok, JSON.stringify(first)).toBe(true);
    if (!first.ok) return;
    expect(first.value.settings.flagged).toContain("not sent yet");
    const second = await harness.folder.push();
    expect(second.ok, JSON.stringify(second)).toBe(true);
    if (!second.ok) return;
    expect(
      sent,
      "a server failure at the folder door was taken as a refusal, and the edit never sent again",
    ).toHaveLength(2);
    expect(second.value.settings).toMatchObject({ sent: true, flagged: null });
  });

  it("sends no settings edit while the server cannot say which instance it is", async () => {
    harness = await folderHarness("folder-settings-instance", {
      events: [copyLiveReplay("1", [])],
    });
    scriptFolderWrites(harness);
    const sent = scriptFolderChanges(harness);
    let restarting = true;
    harness.server.copyAnswer("GET", "/", () =>
      restarting
        ? refusal(503, "unavailable", "restarting")
        : answers.root(Number(BUILT_FOR)),
    );
    writeFileSync(
      settingsFile(harness),
      readFileSync(settingsFile(harness), "utf8") +
        "defaults:\n  tags:\n    - later\n",
    );
    const first = await harness.folder.push();
    expect(first.ok, JSON.stringify(first)).toBe(true);
    if (!first.ok) return;
    expect(
      sent,
      "a settings edit went to a server whose instance the folder could not confirm",
    ).toHaveLength(0);
    expect(first.value.settings.flagged).toContain("which instance");

    // The witness: once the root answers, the same edit is sent.
    restarting = false;
    const second = await harness.folder.push();
    expect(second.ok, JSON.stringify(second)).toBe(true);
    expect(sent).toHaveLength(1);
  });

  it("sends an edit to its settings file through the folder door", async () => {
    harness = await folderHarness("folder-settings-edit", {
      events: [copyLiveReplay("1", [])],
    });
    scriptFolderWrites(harness);
    const sent = scriptFolderChanges(harness);
    writeFileSync(
      settingsFile(harness),
      readFileSync(settingsFile(harness), "utf8") +
        "defaults:\n  tags:\n    - edited\n",
    );
    put(harness, "first.md", "---\ntitle: First\n---\nbody\n");
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    if (!pushed.ok) return;
    expect(
      sent,
      "the edit did not go to the folder door as the settings it changed, at the version the file was written from",
    ).toEqual([{ version: 1, defaults: { tags: ["edited"] } }]);
    expect(pushed.value.settings).toMatchObject({ sent: true, flagged: null });
    expect(readFileSync(settingsFile(harness), "utf8")).toContain("version: 2");
    // In force at once: the push's own new file took it.
    const queued = await harness.folder.device().queue();
    expect(queued.ok && queued.value.map((row) => row.tag)).toContain("edited");

    // A watch wakes for that one file under `.marfa`.
    const watching = harness.folder.watch();
    try {
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      writeFileSync(
        settingsFile(harness),
        readFileSync(settingsFile(harness), "utf8").replace(
          "- edited",
          "- edited again",
        ),
      );
      await vi.waitFor(() => expect(sent).toHaveLength(2), {
        timeout: 20_000,
        interval: 100,
      });
    } finally {
      await watching.stop();
    }
    expect(sent[1]).toEqual({
      version: 2,
      defaults: { tags: ["edited again"] },
    });
  });

  it("keeps its settings in force and flags the file when an edit is refused", async () => {
    const invalid = refusal(
      400,
      "validation_error",
      "that setting is not allowed",
    );
    for (const { refused, edit, why, answer = invalid } of [
      {
        refused: "by the folder door, for a conflict",
        edit: (text: string) => text.replace("- kept", "- conflicting"),
        why: "delete the file to take back the settings in force",
        answer: refusal(409, "version_conflict", "defaults changed since"),
      },
      {
        refused: "by the folder door",
        edit: (text: string) => text.replace("- kept", "- refused"),
        why: "the folder door refused it",
      },
      {
        refused: "because it names a search the folder cannot answer",
        edit: (text: string) =>
          text.replace(
            "search:\n",
            "search:\n  filter: backref[parent-of] exists\n",
          ),
        why: "backref",
      },
      {
        refused: "because it takes a setting out",
        edit: (text: string) => text.replace("title: folder\n", ""),
        why: "no longer names title",
      },
      {
        refused: "because it names a setting the folder does not know",
        edit: (text: string) => text + "ignores:\n  - drafts/\n",
        why: "unknown field `ignores`",
      },
      {
        refused: "because it does not parse",
        edit: (text: string) => text + "include: [not closed\n",
        why: "does not parse",
      },
      {
        refused: "because it names another folder",
        edit: (text: string) =>
          text.replace(
            /folder: \S+/,
            "folder: 01a00000-0000-7000-8000-0000000001f9",
          ),
        why: "names another folder",
      },
    ]) {
      harness = await folderHarness("folder-settings-refused", {
        settings: {
          search: { types: ["core.note"] },
          defaults: { tags: ["kept"] },
        },
      });
      scriptFolderWrites(harness);
      const sent = scriptFolderChanges(harness, answer);
      const edited = edit(readFileSync(settingsFile(harness), "utf8"));
      writeFileSync(settingsFile(harness), edited);
      put(harness, "new.md", "---\ntitle: New\n---\nbody\n");
      const pushed = await harness.folder.push();
      expect(pushed.ok, `${refused}: ${JSON.stringify(pushed)}`).toBe(true);
      if (!pushed.ok) return;
      expect(pushed.value.settings.flagged, refused).toContain(why);
      expect(pushed.value.pull?.settings.flagged, refused).toContain(why);
      expect(
        readFileSync(settingsFile(harness), "utf8"),
        `the person's edit refused ${refused} was written over`,
      ).toBe(edited);
      const queued = await harness.folder.device().queue();
      expect(
        queued.ok &&
          queued.value
            .filter((row) => row.kind === "add_tag")
            .map((row) => row.tag),
        `an edit refused ${refused} was put in force anyway`,
      ).toEqual(["kept"]);
      // Said in words too, and the same refused text is not sent again.
      const text = await harness.folder.pushText();
      expect(text.ok && text.value, refused).toContain("not in force");
      const pulled = await harness.folder.pullText();
      expect(pulled.ok && pulled.value, refused).toContain("not in force");
      expect(pulled.ok && pulled.value, refused).toContain(why);
      expect(sent.length, refused).toBe(
        refused.startsWith("by the folder door") ? 1 : 0,
      );
      if (refused === "by the folder door, for a conflict") {
        // As the reason says: deleted, the file is written back from the
        // settings in force.
        rmSync(settingsFile(harness));
        const reset = await harness.folder.push();
        expect(reset.ok && reset.value.pull?.settings.written).toBe(true);
        expect(readFileSync(settingsFile(harness), "utf8")).toContain("- kept");
      }
      await harness.stop();
      harness = undefined;
    }
  });

  it("rewrites its settings file when the settings change elsewhere", async () => {
    let changed: Record<string, unknown> = {};
    harness = await folderHarness("folder-settings-rewritten", {
      events: [
        (): Answer =>
          copyReplay("2", [copyItemEvent("2", "item.updated", changed)]),
        copyLiveReplay("2", []),
      ],
    });
    scriptFolderWrites(harness);
    harness.settings.settings = {
      ...harness.settings.settings,
      defaults: { tags: ["from elsewhere"] },
    };
    harness.settings.version = 2;
    changed = folderItem(harness.settings);
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    if (!pushed.ok) return;
    expect(pushed.value.pull?.settings.written).toBe(true);
    const text = readFileSync(settingsFile(harness), "utf8");
    expect(
      text,
      "a change made elsewhere never reached the settings file",
    ).toContain("version: 2");
    expect(text).toContain("- from elsewhere");
  });

  it("does not write its settings file over the person's edit, and sends the edit", async () => {
    let changed: Record<string, unknown> = {};
    harness = await folderHarness("folder-settings-edit-first", {
      events: [
        (): Answer =>
          copyReplay("2", [copyItemEvent("2", "item.updated", changed)]),
        copyLiveReplay("2", []),
      ],
    });
    scriptFolderWrites(harness);
    const edited =
      readFileSync(settingsFile(harness), "utf8") + "include:\n  - notes/**\n";
    writeFileSync(settingsFile(harness), edited);
    harness.settings.settings = {
      ...harness.settings.settings,
      defaults: { tags: ["from elsewhere"] },
    };
    harness.settings.version = 2;
    changed = folderItem(harness.settings);
    // A pull alone sends nothing, and leaves the edit where it is.
    const caught = await harness.folder.device().catchUp();
    expect(caught.ok ? caught.value.applied : 0).toBe(1);
    const pulled = await harness.folder.pull();
    expect(pulled.ok && pulled.value.settings.written).toBe(false);
    expect(readFileSync(settingsFile(harness), "utf8")).toBe(edited);

    const sent = scriptFolderChanges(harness);
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    expect(
      sent,
      "the edit went at a version other than the one its file was written from, so the door could not merge it",
    ).toEqual([{ version: 1, include: ["notes/**"] }]);
    const text = readFileSync(settingsFile(harness), "utf8");
    expect(text).toContain("- from elsewhere");
    expect(text).toContain("- notes/**");
  });

  it("bases an edit of its settings file on the version written in it", async () => {
    let changed: Record<string, unknown> = {};
    harness = await folderHarness("folder-settings-stale-edit", {
      events: [
        (): Answer =>
          copyReplay("2", [copyItemEvent("2", "item.updated", changed)]),
        copyLiveReplay("2", []),
      ],
    });
    scriptFolderWrites(harness);
    // An editor holds the text as the folder first wrote it.
    const held = readFileSync(settingsFile(harness), "utf8");
    harness.settings.settings = {
      ...harness.settings.settings,
      defaults: { tags: ["from elsewhere"] },
    };
    harness.settings.version = 2;
    changed = folderItem(harness.settings);
    expect((await harness.folder.push()).ok).toBe(true);
    expect(readFileSync(settingsFile(harness), "utf8")).toContain("version: 2");

    // It saves its old buffer, with a new title, over the rewrite.
    writeFileSync(
      settingsFile(harness),
      held.replace("title: folder", "title: renamed"),
    );
    const sent = scriptFolderChanges(harness);
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    expect(
      sent[0]?.version,
      "an edit written from version 1 went as though it were made on the version the folder last wrote, so the door put its stale settings over another device's",
    ).toBe(1);
    expect(
      sent[0],
      "a stale file sent only what differs from the last write, which reads its old values as changes",
    ).toEqual({
      version: 1,
      title: "renamed",
      search: { types: ["core.note"] },
    });

    // A line naming no version the server mints edits on the one last
    // written.
    writeFileSync(
      settingsFile(harness),
      readFileSync(settingsFile(harness), "utf8")
        .replace(/version: \d+/, "version: 0")
        .replace("title: renamed", "title: again"),
    );
    expect((await harness.folder.push()).ok).toBe(true);
    expect(sent[1]).toEqual({ version: 3, title: "again" });

    // A line written as text, or as `3.0`, names that version, as a
    // Markdown file's does.
    for (const [line, title] of [
      ['version: "3"', "quoted"],
      ["version: 3.0", "decimal"],
    ] as const) {
      writeFileSync(
        settingsFile(harness),
        readFileSync(settingsFile(harness), "utf8")
          .replace(/version: \d+/, line)
          .replace(/title: \w+/, `title: ${title}`),
      );
      expect((await harness.folder.push()).ok).toBe(true);
      expect(
        sent.at(-1)?.version,
        `a version line written ${line} was read as no line`,
      ).toBe(3);
      expect(sent.at(-1)?.title).toBe(title);
    }
  });

  it("makes a new document the search's first type that is not a file type", async () => {
    harness = await folderHarness("folder-type-fallback", {
      settings: { search: { types: ["core.file", "core.note"] } },
    });
    scriptFolderWrites(harness);
    put(harness, "new.md", "---\ntitle: New\n---\nbody\n");
    expect((await harness.folder.push()).ok).toBe(true);
    expect(
      sentCreates(harness).map((sent) => sent.type),
      "a new document became a file type, whose items are bytes",
    ).toEqual(["core.note"]);
  });

  it("refuses defaults its search would not hold", async () => {
    for (const { what, settings, named } of [
      {
        what: "a type",
        settings: {
          search: { types: ["core.note"] },
          defaults: { type: "core.bookmark" },
        },
        named: "core.bookmark",
      },
      {
        what: "a tier",
        settings: {
          search: { types: ["core.note"] },
          defaults: { tier: "feed" as const },
        },
        named: "feed",
      },
    ]) {
      const server = await ScriptedServer.start();
      scriptHydration(server, { head: "1" });
      server.copyAnswer(
        "GET",
        "/keys/current",
        answers.currentKey("fixture-key", { "*": "write" }),
      );
      const row = scriptFolderRow(server, settings);
      const dir = join(
        mkdtempSync(join(tmpdir(), "marfa-folder-defaults-refused-")),
        "notes",
      );
      const folder = new CliFolder(dir, {
        binary: requireBinary(),
        url: server.url,
        key: KEY,
      });
      try {
        const added = await folder.add(row.id);
        expect(
          added.ok,
          `a folder took defaults naming ${what} its search does not hold, so every new file would fall outside it`,
        ).toBe(false);
        if (added.ok) return;
        expect(added.refusal.raw, what).toContain(named);
      } finally {
        await server.stop();
      }
    }

    // Written into the settings file, it is flagged and not sent.
    harness = await folderHarness("folder-defaults-refused-file");
    scriptFolderWrites(harness);
    const sent = scriptFolderChanges(harness);
    writeFileSync(
      settingsFile(harness),
      readFileSync(settingsFile(harness), "utf8") +
        "defaults:\n  type: core.bookmark\n",
    );
    const pushed = await harness.folder.push();
    expect(pushed.ok && pushed.value.settings.flagged).toContain(
      "core.bookmark",
    );
    expect(sent).toEqual([]);
    await harness.stop();
    harness = undefined;

    // Changed on another device, the next pass refuses it.
    let changed: Record<string, unknown> = {};
    harness = await folderHarness("folder-defaults-refused-later", {
      events: [
        (): Answer =>
          copyReplay("2", [copyItemEvent("2", "item.updated", changed)]),
        copyLiveReplay("2", []),
      ],
    });
    scriptFolderWrites(harness);
    harness.settings.settings = {
      search: { types: ["core.note"] },
      defaults: { type: "core.bookmark" },
    };
    harness.settings.version = 2;
    changed = folderItem(harness.settings);
    const later = await harness.folder.push();
    expect(
      later.ok,
      "a pass made new files of a type its own search does not hold",
    ).toBe(false);
    if (!later.ok) expect(later.refusal.raw).toContain("core.bookmark");
  });

  it("fills a new file's blanks from its defaults, never an edit's", async () => {
    const target = "01a00000-0000-7000-8000-0000000003a1";
    const parent = "01a00000-0000-7000-8000-0000000003a2";
    const existing = "01a00000-0000-7000-8000-0000000003a3";
    harness = await folderHarness("folder-defaults", {
      settings: {
        search: { types: ["core.note", "core.file"], tier: "feed" },
        defaults: {
          type: "core.note",
          tier: "feed",
          properties: {
            language: "en",
            status: "draft",
            body: "a default body",
            title: "Untitled",
          },
          tags: ["inbox"],
          edges: { references: [target], "parent-of": [parent] },
        },
      },
      rows: {
        "core.note": [
          {
            item: {
              id: existing,
              tier: "feed",
              properties: { title: "existing", body: "as it was\n" },
            },
          },
        ],
      },
    });
    scriptFolderWrites(harness);
    acceptUploads(harness.server);
    expect((await harness.folder.pull()).ok).toBe(true);

    put(harness, "new.md", "---\ntitle: New\nstatus: mine\n---\nbody\n");
    // A file naming its own parent leaves no blank for the default's.
    put(
      harness,
      "own.md",
      '---\ntitle: Own\nchild-of: "[[existing]]"\n---\nbody\n',
    );
    put(harness, "plain.txt", "a text file\n");
    put(harness, "photo.png", "not really a picture");
    writeFileSync(
      join(harness.dir, "existing.md"),
      read(harness, "existing.md").replace("as it was", "edited here"),
    );
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    if (!pushed.ok) return;

    const creates = sentCreates(harness);
    const note = creates.find(
      (sent) => (sent.properties as Record<string, unknown>).title === "New",
    );
    expect(
      note?.properties,
      "a default went over what the file's own frontmatter says, or left a blank unfilled",
    ).toMatchObject({ status: "mine", language: "en" });
    expect(
      (note?.properties as Record<string, unknown>).body,
      "a default for the body field went over the file's body",
    ).toBe("body\n");
    // A default title is a property the file leaves blank, taken over the
    // file's name.
    const plain = creates.find(
      (sent) =>
        (sent.properties as Record<string, unknown>).body === "a text file\n",
    );
    expect((plain?.properties as Record<string, unknown>).title).toBe(
      "Untitled",
    );
    expect(creates).toHaveLength(4);
    expect(
      creates.map((sent) => sent.tier),
      "a new file, a file item among them, went at a tier other than the defaults'",
    ).toEqual(["feed", "feed", "feed", "feed"]);
    const created = creates.map((sent) => String(sent.id));
    const own = String(
      creates.find(
        (sent) => (sent.properties as Record<string, unknown>).title === "Own",
      )?.id,
    );

    const queued = await harness.folder.device().queue();
    expect(queued.ok).toBe(true);
    if (!queued.ok) return;
    expect(
      queued.value
        .filter((row) => row.kind === "add_tag")
        .map((row) => row.item_id)
        .sort(),
      "a new file went without the default tag, or an edit took it",
    ).toEqual([...created].sort());

    const edges = harness.server.requests
      .filter(
        (request) => request.method === "POST" && request.pathname === "/edges",
      )
      .map((request) => JSON.parse(request.body) as Record<string, unknown>)
      .filter((edge) => edge.edge_type !== "in-folder")
      .map(
        (edge) =>
          `${String(edge.source_id)} ${String(edge.edge_type)} ${String(edge.target_id)}`,
      )
      .sort();
    expect(
      edges,
      "a new file, a .txt or a file item among them, went without its default edges, or an edit took them",
    ).toEqual(
      created
        .flatMap((id) => [
          `${id} references ${target}`,
          `${id === own ? existing : parent} parent-of ${id}`,
        ])
        .sort(),
    );

    const [edit] = sentUpdates(harness).filter((sent) => sent.id === existing);
    expect(edit, "the edit was not sent").toBeDefined();
    expect(
      Object.keys((edit?.body.properties ?? {}) as Record<string, unknown>),
      "an edit took the defaults, which fill only what a new file leaves blank",
    ).not.toContain("language");
  });
  it("keeps each folder's state and queue to itself", async () => {
    harness = await folderHarness("folder-one", {
      settings: { search: { types: ["core.note"] } },
    });
    // One Mac: both are listed in one registry, and still independent.
    second = await folderHarness("folder-two", {
      settings: { search: { types: ["core.bookmark"] } },
      registry: harness.registry,
    });
    scriptFolderWrites(harness);
    scriptFolderWrites(second);

    put(harness, "first.md", "---\ntitle: First\n---\nin folder one\n");
    put(second, "second.md", "---\ntitle: Second\n---\nin folder two\n");
    expect((await harness.folder.push()).ok).toBe(true);
    expect((await second.folder.push()).ok).toBe(true);

    const queuedOne = await harness.folder.device().queue();
    const queuedTwo = await second.folder.device().queue();
    expect(queuedOne.ok && queuedTwo.ok).toBe(true);
    if (!queuedOne.ok || !queuedTwo.ok) return;
    const one = { value: withoutPlacements(harness, queuedOne.value) };
    const two = { value: withoutPlacements(second, queuedTwo.value) };
    expect(
      one.value.length,
      "one folder's queue holds the other's writes, so a push in one sends what was written in the other",
    ).toBe(1);
    expect(two.value.length).toBe(1);
    expect(
      one.value[0]?.id === two.value[0]?.id,
      "the two folders share a queue row, so they are one device with two faces rather than two devices",
    ).toBe(false);

    // And each folder's slice is its own: the types differ, so the item each
    // created is of the type its own folder declares.
    const [firstSent] = sentCreates(harness);
    const [secondSent] = sentCreates(second);
    expect(firstSent?.type).toBe("core.note");
    expect(
      secondSent?.type,
      "the second folder wrote the first folder's type, so a machine's folders share a slice rather than each being a view on its own",
    ).toBe("core.bookmark");
  });

  it("hydrates into an empty directory and pushes without holding anything else", async () => {
    // A folder in a container: nothing about it depends on the directory
    // outliving the work, so it starts empty and everything it needs is made.
    harness = await folderHarness("folder-container", {
      rows: {
        "core.note": [
          {
            item: {
              id: "01a00000-0000-7000-8000-00000000000a",
              properties: { title: "From the server", body: "pulled\n" },
            },
          },
        ],
      },
    });
    scriptFolderWrites(harness);

    const pulled = await harness.folder.pull();
    expect(pulled.ok).toBe(true);
    if (!pulled.ok) return;
    expect(
      pulled.value.written,
      "the folder hydrated into an empty directory and wrote nothing, so the container has the slice and no files",
    ).toBe(1);

    put(
      harness,
      "made-here.md",
      "---\ntitle: Made here\n---\nwritten in the container\n",
    );
    const pushed = await harness.folder.push();
    expect(pushed.ok).toBe(true);
    if (!pushed.ok) return;
    expect(
      pushed.value.drain.answered,
      "the folder queued the work and sent none of it, so discarding the container would lose it",
    ).toBeGreaterThan(0);

    // Discarded. Outside the directory only the registry's entry names the
    // folder, and it holds none of the folder's state.
    rmSync(harness.dir, { recursive: true, force: true });
    expect(
      (await harness.folder.scan()).ok,
      "the folder still answers after its directory was discarded, so something about it lives outside the directory",
    ).toBe(false);
  });
});

describe("what a folder's search holds", () => {
  const note = (
    id: string,
    title: string,
    extra: Partial<WireItemOptions> = {},
  ): { item: WireItemOptions; tags?: string[] } => ({
    item: { id, properties: { title, body: `${title}\n` }, ...extra },
  });
  const target = "01a00000-0000-7000-8000-0000000002f1";
  const root = "01a00000-0000-7000-8000-0000000002f2";
  const parentOf = (id: string, source: string, child: string) => ({
    id,
    source_id: source,
    target_id: child,
    edge_type: "parent-of",
  });

  /** The Markdown files a pull left in the folder. */
  const files = (made: FolderHarness): string[] =>
    readdirSync(made.dir)
      .filter((name) => name.endsWith(".md"))
      .sort();

  const searches: Array<{
    condition: string;
    settings: FolderSettings;
    rows: Record<string, Array<{ item: WireItemOptions; tags?: string[] }>>;
    edges?: Record<string, Array<ReturnType<typeof parentOf>>>;
    held: string[];
  }> = [
    {
      condition: "type, with its subtree",
      settings: { search: { types: ["core.note"] } },
      rows: {
        // Served on the note page so the copy holds the bookmark, and the
        // pull's own type rule is what leaves it out.
        "core.note": [
          note("01a00000-0000-7000-8000-000000000201", "a note"),
          note("01a00000-0000-7000-8000-000000000202", "a meeting", {
            type: "core.note.meeting",
          }),
          note("01a00000-0000-7000-8000-000000000203", "a bookmark", {
            type: "core.bookmark",
          }),
        ],
      },
      held: ["a meeting.md", "a note.md"],
    },
    {
      condition: "no type, which holds every type the key reads",
      settings: { search: {} },
      rows: {
        "core.note": [note("01a00000-0000-7000-8000-000000000211", "a note")],
        "core.bookmark": [
          note("01a00000-0000-7000-8000-000000000212", "a bookmark", {
            type: "core.bookmark",
          }),
        ],
      },
      held: ["a bookmark.md", "a note.md"],
    },
    {
      condition: "tier",
      settings: { search: { types: ["core.note"], tier: "feed" } },
      rows: {
        "core.note": [
          note("01a00000-0000-7000-8000-000000000221", "fed", {
            tier: "feed",
          }),
          note("01a00000-0000-7000-8000-000000000222", "kept"),
        ],
      },
      held: ["fed.md"],
    },
    {
      condition: "no tier, which holds the library tier",
      settings: { search: { types: ["core.note"] } },
      rows: {
        "core.note": [
          note("01a00000-0000-7000-8000-000000000223", "fed", {
            tier: "feed",
          }),
          note("01a00000-0000-7000-8000-000000000224", "kept"),
        ],
      },
      held: ["kept.md"],
    },
    {
      condition: "state",
      settings: { search: { types: ["core.note"], state: ["archived"] } },
      rows: {
        "core.note": [
          note("01a00000-0000-7000-8000-000000000231", "shelved", {
            state: "archived",
          }),
          note("01a00000-0000-7000-8000-000000000232", "live"),
        ],
      },
      held: ["shelved.md"],
    },
    {
      condition: "tags",
      settings: {
        search: { types: ["core.note"], filter: 'tags contains "keep"' },
      },
      rows: {
        "core.note": [
          {
            ...note("01a00000-0000-7000-8000-000000000241", "tagged"),
            tags: ["keep"],
          },
          note("01a00000-0000-7000-8000-000000000242", "untagged"),
        ],
      },
      held: ["tagged.md"],
    },
    {
      condition: "a property",
      settings: {
        search: {
          types: ["core.note"],
          filter: 'properties.status eq "ready"',
        },
      },
      rows: {
        "core.note": [
          {
            item: {
              id: "01a00000-0000-7000-8000-000000000251",
              properties: { title: "ready", body: "x\n", status: "ready" },
            },
          },
          {
            item: {
              id: "01a00000-0000-7000-8000-000000000252",
              properties: { title: "draft", body: "x\n", status: "draft" },
            },
          },
        ],
      },
      held: ["ready.md"],
    },
    {
      condition: "an edge to an item",
      settings: {
        search: {
          types: ["core.note"],
          filter: `edge[references] eq "${target}"`,
        },
      },
      rows: {
        "core.note": [
          note("01a00000-0000-7000-8000-000000000261", "linked", {
            edges: {
              references: {
                data: [
                  wireEdge({
                    id: "01a00000-0000-7000-8000-0000000002e1",
                    source_id: "01a00000-0000-7000-8000-000000000261",
                    target_id: target,
                  }),
                ],
                next_cursor: null,
              },
            },
          }),
          note("01a00000-0000-7000-8000-000000000262", "unlinked"),
        ],
      },
      held: ["linked.md"],
    },
    {
      condition: "beneath an item",
      settings: { search: { types: ["core.note"], beneath: root } },
      rows: {
        "core.note": [
          note(root, "the root"),
          note("01a00000-0000-7000-8000-000000000271", "a child"),
          note("01a00000-0000-7000-8000-000000000272", "a grandchild"),
          note("01a00000-0000-7000-8000-000000000273", "a stranger"),
        ],
      },
      edges: {
        "parent-of": [
          parentOf(
            "01a00000-0000-7000-8000-0000000002e2",
            root,
            "01a00000-0000-7000-8000-000000000271",
          ),
          parentOf(
            "01a00000-0000-7000-8000-0000000002e3",
            "01a00000-0000-7000-8000-000000000271",
            "01a00000-0000-7000-8000-000000000272",
          ),
        ],
      },
      held: ["a child.md", "a grandchild.md", "the root.md"],
    },
  ];

  // One case per condition, each on a folder of its own.
  it("holds exactly what its search matches", async () => {
    for (const { condition, settings, rows, edges, held } of searches) {
      harness = await folderHarness("folder-search", { settings, rows, edges });
      scriptFolderWrites(harness);
      const pulled = await harness.folder.pull();
      expect(pulled.ok, `${condition}: ${JSON.stringify(pulled)}`).toBe(true);
      expect(files(harness), condition).toEqual(held);
      if (settings.search?.types === undefined) {
        const status = await harness.folder.device().status();
        expect(status.ok && status.value.slice_types).toEqual(["*"]);
        expect(
          harness.server.requests
            .filter(
              (sent) => sent.method === "GET" && sent.pathname === "/items",
            )
            .every((sent) => !sent.query.has("type")),
          "a search naming no type was hydrated by naming types",
        ).toBe(true);
      }
      await harness.stop();
      harness = undefined;
    }
  });

  it("holds archived items unless its search narrows state", async () => {
    const rows = {
      "core.note": [
        note("01a00000-0000-7000-8000-000000000281", "live"),
        note("01a00000-0000-7000-8000-000000000282", "shelved", {
          state: "archived",
        }),
      ],
    };
    harness = await folderHarness("folder-archived", { rows });
    scriptFolderWrites(harness);
    expect((await harness.folder.pull()).ok).toBe(true);
    expect(
      files(harness),
      "a folder naming no state held only active items, as a list does",
    ).toEqual(["live.md", "shelved.md"]);

    second = await folderHarness("folder-active-only", {
      settings: { search: { types: ["core.note"], state: ["active"] } },
      rows,
    });
    scriptFolderWrites(second);
    expect((await second.folder.pull()).ok).toBe(true);
    expect(files(second)).toEqual(["live.md"]);
  });

  it("refuses a search condition it does not implement", async () => {
    // At a later pass, where the settings change to one it cannot answer.
    let changed: Record<string, unknown> = {};
    harness = await folderHarness("folder-search-refused-later", {
      events: [
        (): Answer =>
          copyReplay("2", [copyItemEvent("2", "item.updated", changed)]),
        copyLiveReplay("2", []),
      ],
    });
    scriptFolderWrites(harness);
    harness.settings.settings = {
      search: { types: ["core.note"], filter: "backref[parent-of] exists" },
    };
    harness.settings.version = 2;
    changed = folderItem(harness.settings);
    const later = await harness.folder.push();
    expect(
      later.ok,
      "a pass answered a search whose condition it cannot answer, as though the condition were not there",
    ).toBe(false);
    if (!later.ok) expect(later.refusal.raw).toContain("backref");
    await harness.stop();
    harness = undefined;

    for (const { condition, settings, named } of [
      {
        condition: "a backref, which a copy cannot answer whole",
        settings: { search: { filter: "backref[parent-of] exists" } },
        named: "backref",
      },
      {
        condition: "a search member it does not know",
        settings: { search: { near: "01a00000-0000-7000-8000-0000000002f9" } },
        named: "near",
      },
      {
        condition: "a defaults member it does not know",
        settings: { defaults: { colour: "red" } },
        named: "colour",
      },
      {
        condition: "a removal threshold member it does not know",
        settings: { removal_threshold: { percent: 5 } },
        named: "percent",
      },
      {
        condition: "a setting it does not know",
        settings: { ignores: ["drafts/"] },
        named: "ignores",
      },
      {
        condition: "no state at all",
        settings: { search: { state: [] } },
        named: "no state",
      },
      {
        condition: "a state a folder does not hold",
        settings: { search: { state: ["trashed"] } },
        named: "trashed",
      },
    ]) {
      const server = await ScriptedServer.start();
      const row = scriptFolderRow(server, settings as FolderSettings);
      const dir = join(
        mkdtempSync(join(tmpdir(), "marfa-folder-refused-")),
        "notes",
      );
      const folder = new CliFolder(dir, {
        binary: requireBinary(),
        url: server.url,
        key: KEY,
      });
      try {
        const added = await folder.add(row.id);
        expect(
          added.ok,
          `a folder took ${condition}, and would answer as though it were not there`,
        ).toBe(false);
        if (added.ok) return;
        expect(added.refusal.raw).toContain(named);
      } finally {
        await server.stop();
      }
    }
  });

  const joining = "01a00000-0000-7000-8000-0000000002a1";
  const joins: Array<{
    condition: string;
    settings: FolderSettings;
    item: { item: WireItemOptions; tags?: string[] };
    edges?: Record<string, Array<ReturnType<typeof parentOf>>>;
    change: () => ReturnType<typeof copyItemEvent>;
  }> = [
    {
      condition: "tag",
      settings: {
        search: { types: ["core.note"], filter: 'tags contains "keep"' },
      },
      item: note(joining, "joining"),
      change: () =>
        copyItemEvent(
          "2",
          "metadata.changed",
          wireItem(note(joining, "joining").item),
          {
            tags: ["keep"],
          },
        ),
    },
    {
      condition: "property",
      settings: {
        search: {
          types: ["core.note"],
          filter: 'properties.status eq "ready"',
        },
      },
      item: {
        item: {
          id: joining,
          properties: { title: "joining", body: "x\n", status: "draft" },
        },
      },
      change: () =>
        copyItemEvent(
          "2",
          "item.updated",
          wireItem({
            id: joining,
            version: 2,
            properties: { title: "joining", body: "x\n", status: "ready" },
          }),
        ),
    },
    {
      condition: "state",
      settings: { search: { types: ["core.note"], state: ["active"] } },
      item: note(joining, "joining", { state: "archived" }),
      change: () =>
        copyItemEvent(
          "2",
          "item.state_changed",
          wireItem(note(joining, "joining").item),
        ),
    },
    {
      condition: "edge",
      settings: {
        search: {
          types: ["core.note"],
          filter: `edge[references] eq "${target}"`,
        },
      },
      item: note(joining, "joining"),
      change: () =>
        edgeEvent(
          "2",
          "edge.created",
          wireEdge({
            id: "01a00000-0000-7000-8000-0000000002e4",
            source_id: joining,
            target_id: target,
          }),
        ),
    },
    {
      condition: "beneath",
      settings: { search: { types: ["core.note"], beneath: root } },
      item: note(joining, "joining"),
      edges: { "parent-of": [] },
      change: () =>
        edgeEvent(
          "2",
          "edge.created",
          wireEdge(
            parentOf("01a00000-0000-7000-8000-0000000002e5", root, joining),
          ),
        ),
    },
  ];

  // By tag, property, state, edge and beneath, each on a folder of its own.
  it("adds an item that starts to match", async () => {
    for (const { condition, settings, item, edges, change } of joins) {
      harness = await folderHarness("folder-joins", {
        settings,
        rows: { "core.note": [note(root, "the root"), item] },
        edges,
        events: [copyReplay("2", [change()]), copyLiveReplay("2", [])],
      });
      scriptFolderWrites(harness);
      expect((await harness.folder.pull()).ok).toBe(true);
      expect(existsSync(join(harness.dir, "joining.md")), condition).toBe(
        false,
      );
      const pushed = await harness.folder.push();
      expect(pushed.ok, `${condition}: ${JSON.stringify(pushed)}`).toBe(true);
      expect(
        existsSync(join(harness.dir, "joining.md")),
        `an item that came to match the search by ${condition} did not become a file at the next pass`,
      ).toBe(true);
      await harness.stop();
      harness = undefined;
    }
  });
});

describe("a search naming no type", () => {
  it("takes every type, and any default type, where its search names no type", async () => {
    const system = "01a00000-0000-7000-8000-0000000002c1";
    const note = "01a00000-0000-7000-8000-0000000002c2";
    harness = await folderHarness("folder-every-type", {
      settings: { search: {}, defaults: { type: "core.bookmark" } },
      events: [
        copyReplay("3", [
          copyItemEvent(
            "2",
            "item.created",
            wireItem({
              id: system,
              type: "system.connection",
              properties: { title: "c" },
            }),
          ),
          copyItemEvent(
            "3",
            "item.created",
            wireItem({ id: note, properties: { title: "n", body: "b\n" } }),
          ),
        ]),
        copyLiveReplay("3", []),
      ],
    });
    scriptFolderWrites(harness);
    acceptUploads(harness.server);
    put(harness, "new.md", "---\ntitle: New\n---\nbody\n");
    put(harness, "photo.png", "not really a picture");
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    const types = sentCreates(harness)
      .map((sent) => String(sent.type))
      .sort();
    expect(
      types,
      "a file of some type was left out of a search naming none",
    ).toHaveLength(2);
    expect(types[0]).toBe("core.bookmark");
    expect(types[1]).toMatch(/^core\.file/);
    expect((await harness.folder.device().get(note)).ok).toBe(true);
    expect(
      (await harness.folder.device().get(system)).ok,
      "a slice of every type took a system row",
    ).toBe(false);
  });
});

describe("files and items", () => {
  it("makes a file an item and an item a file", async () => {
    harness = await folderHarness("folder-both-ways", {
      rows: {
        "core.note": [
          {
            item: {
              id: "01a00000-0000-7000-8000-00000000000a",
              properties: { title: "from-server", body: "pulled\n" },
            },
          },
        ],
      },
    });
    scriptFolderWrites(harness);

    // An item in the slice is a file in the folder.
    expect((await harness.folder.pull()).ok).toBe(true);
    expect(
      read(harness, "from-server.md"),
      "an item in the slice did not become a file, so half the folder is a one-way street",
    ).toContain("pulled");

    // A file in the folder is an item on the server.
    put(harness, "from-here.md", "---\ntitle: From here\n---\npushed\n");
    const pushed = await harness.folder.push();
    expect(pushed.ok).toBe(true);
    if (!pushed.ok) return;
    const [sent] = sentCreates(harness);
    expect(
      (sent?.properties as Record<string, string>).body,
      "a file in the folder did not become an item, so nothing written on this machine reaches the server",
    ).toBe("pushed\n");
    expect(
      typeof sent?.id,
      "the create named no id, so the file has no item to name until the server answers",
    ).toBe("string");
  });

  it("carries frontmatter to properties and the body to the body", async () => {
    harness = await folderHarness("folder-frontmatter");
    scriptFolderWrites(harness);
    put(
      harness,
      "note.md",
      // A line named for the body field is overwritten by the body.
      "---\ntitle: A note\ncount: 3\nundeclared_field: kept\nnested:\n  deep: true\nbody: a line of its own\n---\nThe body.\n",
    );
    expect((await harness.folder.push()).ok).toBe(true);

    const [sent] = sentCreates(harness);
    const properties = sent?.properties as Record<string, unknown>;
    expect(properties.title).toBe("A note");
    expect(properties.count).toBe(3);
    expect(
      properties.undeclared_field,
      "a property the type does not declare was dropped on the way in, so a file's fields survive only if the type happened to name them",
    ).toBe("kept");
    expect(
      properties.nested,
      "a nested field was flattened or dropped, and a file's fields travel whole or not at all",
    ).toEqual({ deep: true });
    expect(
      properties.body,
      "the body did not arrive as the body, so the text of every note is somewhere other than where a reader looks for it",
    ).toBe("The body.\n");
  });

  it("writes a person's frontmatter back in the order they wrote it", async () => {
    harness = await folderHarness("folder-frontmatter-order");
    scriptFolderWrites(harness);
    put(
      harness,
      "note.md",
      "---\nzebra: last in the alphabet\napple: first\nmango: in between\ntitle: Ordered\n---\nbody\n",
    );
    expect((await harness.folder.push()).ok).toBe(true);

    // The file's own fields, and only those. A field the type declares is
    // ordered by the type: a real server answers `body` and `title` first
    // whatever order they were sent in, so asserting where `title` lands
    // would be asserting something only the scripted server does.
    const own = ["zebra", "apple", "mango"];
    const written = read(harness, "note.md");
    expect(
      written,
      "the folder never wrote the file back, so what is being read is what this fixture itself typed and the order below is its own",
    ).toMatch(/^marfa_id:/m);
    const fields = [...written.matchAll(/^([a-z_]+):/gm)]
      .map((found) => found[1])
      .filter((field) => own.includes(field));
    expect(
      fields.length,
      "none of the file's own fields came back at all, so the assertion below is about an empty list",
    ).toBe(own.length);
    expect(
      fields,
      "the folder rewrote the person's frontmatter in an order nobody asked for, which is a change to their file on the first pull and one no scan can tell from a change they made",
    ).toEqual(own);
  });

  it("preserves frontmatter bytes through metadata, remote edits and presentation-only saves", async () => {
    const edges = new EdgeDoor();
    harness = await folderHarness("folder-frontmatter-preserved", {
      events: [edges.stream()],
    });
    let door: FolderDoor | undefined;
    scriptFolderWrites(harness, {
      edges,
      door: (made) => {
        door = made;
      },
      tagging: (request) => {
        const id = request.pathname.split("/")[2]!;
        const row = door!.rows.get(id)!;
        const tags = [
          ...new Set([
            ...(row.tags ?? []),
            ...(JSON.parse(request.body) as { tags: string[] }).tags,
          ]),
        ];
        edges.events.push(
          copyItemEvent(
            String(edges.events.length + 2),
            "metadata.changed",
            wireItem({ id, version: row.version, properties: row.properties }),
            { tags },
          ),
        );
        return undefined;
      },
    });
    const prefix =
      "---\r\n# café\r\nzebra: 1.10 # number\r\ninteger: 1.00\r\ntitle: 'Styled'\r\nlist: [a, 'b']\r\nnested: {keep: 'é', change: old}\r\ntags: beta, alpha\r\nstate: null\r\nblock: |\r\n  text\r\n";
    put(harness, "styled.md", `${prefix}---\r\nBody\r\n`);
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    const id = idIn(harness, "styled.md");
    expect(id).toBeTruthy();
    const first = read(harness, "styled.md");
    expect(first).toContain("marfa_version: 1\r\n");
    expect(first.slice(0, prefix.length)).toBe(prefix);
    expect(first.endsWith("---\r\nBody\r\n")).toBe(true);
    const saves = sentUpdates(harness).length;
    const scan = await harness.folder.scan();
    expect(scan.ok && scan.value.updated).toBe(0);
    expect(sentUpdates(harness)).toHaveLength(saves);

    edges.logItem(
      "item.updated",
      door!.update(id!, {
        properties: { nested: { keep: "é", change: "new" } },
        version: 1,
      }),
    );
    expect((await harness.folder.device().catchUp()).ok).toBe(true);
    const pulled = await harness.folder.pull();
    expect(pulled.ok && pulled.value.rewritten).toBe(1);
    const second = first
      .replace("change: old", "change: new")
      .replace("marfa_version: 1", "marfa_version: 2");
    expect(read(harness, "styled.md")).toBe(second);

    const reformatted = second
      .replace("zebra: 1.10 # number", "zebra: 1.100 # my spelling")
      .replace("tags: beta, alpha", "tags: ['alpha', beta]")
      .replace("state: null", "state: active")
      .replace("marfa_version: 2", 'marfa_version: "2"');
    put(harness, "styled.md", reformatted);
    const again = await harness.folder.push();
    expect(again.ok && again.value.scan.updated).toBe(0);
    expect(again.ok && again.value.pull?.rewritten).toBe(0);
    expect(read(harness, "styled.md")).toBe(reformatted);
    expect(sentUpdates(harness)).toHaveLength(saves);

    edges.logItem(
      "item.updated",
      door!.update(id!, { properties: {}, version: 2 }),
    );
    const stepped = await harness.folder.push();
    expect(stepped.ok && stepped.value.catch_up.caught_up?.applied).toBe(1);
    expect(read(harness, "styled.md")).toBe(reformatted);
  });

  it("treats a fence pair holding a list or one line as a body", async () => {
    harness = await folderHarness("folder-fence-list");
    scriptFolderWrites(harness);
    const texts = [
      "---\n- just\n- a list\n---\nbody\n",
      "---\nA heading\n---\nbody\n",
    ];
    put(harness, "list.md", texts[0]!);
    put(harness, "line.md", texts[1]!);
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    expect(
      sentCreates(harness)
        .map((sent) => (sent.properties as Record<string, unknown>).body)
        .sort(),
      "a list or a line between rules was read as frontmatter, or held",
    ).toEqual([...texts].sort());
  });

  it("treats a body opening with a horizontal rule as a body", async () => {
    harness = await folderHarness("folder-rule");
    scriptFolderWrites(harness);
    // Two horizontal rules, which look exactly like a fence pair. Read as
    // frontmatter, the first paragraph is gone and the loss is written back.
    const text = "---\n\nA paragraph after a rule.\n\n---\n\nAnother.\n";
    put(harness, "rule.md", text);
    expect((await harness.folder.push()).ok).toBe(true);

    const [sent] = sentCreates(harness);
    const properties = sent?.properties as Record<string, unknown>;
    expect(
      properties.body,
      "a body opening with a horizontal rule was read as frontmatter, so its first paragraph is gone and the loss has been written to the server",
    ).toBe(text);
    expect(
      Object.keys(properties).filter(
        (key) => key !== "body" && key !== "title",
      ),
      "the rule yielded properties, which means part of the body became fields",
    ).toEqual([]);

    // And it comes back out as itself, so the next scan does not push a
    // change nobody made.
    expect((await harness.folder.pull()).ok).toBe(true);
    const again = await harness.folder.scan();
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(
      again.value.updated,
      "the file changed under the folder's own hand, so every pass pushes a change nobody made",
    ).toBe(0);
  });

  it("reads past a byte-order mark and writes the file back without it", async () => {
    harness = await folderHarness("folder-byte-order-mark");
    scriptFolderWrites(harness);
    const text = "---\ntitle: Marked\ncolor: blue\n---\nThe body.\n";
    put(harness, "marked.md", `\uFEFF${text}`);
    expect(
      readFileSync(join(harness.dir, "marked.md")).subarray(0, 3),
      "the file was not written with the mark, so what follows proves nothing about one",
    ).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
    expect((await harness.folder.push()).ok).toBe(true);

    const [sent] = sentCreates(harness);
    const properties = sent?.properties as Record<string, unknown>;
    expect(
      [properties.title, properties.color, properties.body],
      "a byte-order mark hid the frontmatter, so the fields became body text and the title and properties are gone",
    ).toEqual(["Marked", "blue", "The body.\n"]);

    const written = readFileSync(join(harness.dir, "marked.md"));
    expect(
      written.toString("utf8"),
      "the folder never wrote the file back, so the absence of the mark below would be the fixture's own",
    ).toMatch(/^marfa_id:/m);
    expect(
      written.subarray(0, 3).toString("utf8"),
      "the folder wrote the mark back, or wrote its fields after it where only it can see them",
    ).toBe("---");

    const again = await harness.folder.scan();
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(
      again.value.updated,
      "the file changed under the folder's own hand, so every pass pushes a change nobody made",
    ).toBe(0);
  });

  it("takes the edge with a link the body no longer names", async () => {
    harness = await folderHarness("folder-link-removed");
    scriptFolderWrites(harness);
    put(harness, "target.md", "---\ntitle: Target\n---\nthe other end\n");
    expect((await harness.folder.scan()).ok).toBe(true);
    put(
      harness,
      "source.md",
      "---\ntitle: Source\n---\nsee [[target]] for more\n",
    );
    expect((await harness.folder.push()).ok).toBe(true);

    // The person takes the line out. The edge is the folder's own kind and
    // its target is a file in the same folder, so it is the folder's to
    // remove.
    writeFileSync(
      join(harness.dir, "source.md"),
      "---\ntitle: Source\n---\nsee nothing for more\n",
    );
    expect((await harness.folder.scan()).ok).toBe(true);

    const queued = await harness.folder.device().queue();
    expect(queued.ok).toBe(true);
    if (!queued.ok) return;
    expect(
      withoutPlacements(harness, queued.value).filter(
        (row) => row.kind === "delete_edge",
      ).length,
      "the edge outlived the link, so the next pull writes the line back and the person deletes it again forever",
    ).toBe(1);

    expect((await harness.folder.push()).ok).toBe(true);
    const after = read(harness, "source.md");
    expect(
      after,
      "the pull left the file as the person saved it, so the absence below is their own typing rather than anything the folder decided",
    ).toMatch(/^marfa_id:/m);
    expect(
      after,
      "the folder put the link back into the file after the person took it out, which is a fight the person cannot win",
    ).not.toContain("[[target]]");
  });

  it("keeps an edge the file never carried, whoever made it", async () => {
    harness = await folderHarness("folder-edge-from-elsewhere");
    scriptFolderWrites(harness);
    put(harness, "target.md", "---\ntitle: Target\n---\nthe other end\n");
    put(harness, "source.md", "---\ntitle: Source\n---\nno link at all\n");
    expect((await harness.folder.push()).ok).toBe(true);

    const device = harness.folder.device();
    const rows = await device.queue();
    expect(rows.ok).toBe(true);
    if (!rows.ok) return;
    const ids = rows.value
      .filter((row) => row.kind === "create_item")
      .map((row) => row.item_id as string);
    expect(
      ids.length,
      "the two files never became items, so there is nothing for an edge to join",
    ).toBe(2);

    // An agent with its own key joins them. The folder holds the edge from
    // this moment on, and no file in the folder mentions it, because nothing
    // has rendered it yet — which is exactly what a link the person deleted
    // also looks like.
    const made = await device.createEdge({
      source: ids[0]!,
      target: ids[1]!,
      type: "references",
    });
    expect(made.ok, `the edge was refused: ${JSON.stringify(made)}`).toBe(true);

    // The person types one word into the file. A scan runs before any pull.
    writeFileSync(
      join(harness.dir, "source.md"),
      "---\ntitle: Source\n---\nno link at all, and a word more\n",
    );
    const scanned = await harness.folder.scan();
    expect(scanned.ok).toBe(true);
    if (!scanned.ok) return;
    expect(
      scanned.value.updated,
      "the edit was not seen at all, so nothing below could have deleted anything",
    ).toBe(1);

    const queued = await device.queue();
    expect(queued.ok).toBe(true);
    if (!queued.ok) return;
    expect(
      withoutPlacements(harness, queued.value).filter(
        (row) => row.kind === "delete_edge",
      ),
      "one keystroke in a file destroyed an edge made somewhere else, because an edge nothing has rendered yet looks exactly like a link the person removed",
    ).toEqual([]);
  });

  it("removes no edge at all when a link in the body names nothing", async () => {
    harness = await folderHarness("folder-unresolved-link");
    scriptFolderWrites(harness);
    put(
      harness,
      "target.md",
      "---\ntitle: Different target\n---\nthe other end\n",
    );
    put(harness, "other.md", "---\ntitle: Other\n---\nanother end\n");
    expect((await harness.folder.scan()).ok).toBe(true);
    put(
      harness,
      "source.md",
      "---\ntitle: Source\n---\nsee [[target]] for more, and [[other]]\n",
    );
    expect((await harness.folder.push()).ok).toBe(true);

    const device = harness.folder.device();
    const before = await device.queue();
    expect(before.ok).toBe(true);
    if (!before.ok) return;
    const made = withoutPlacements(harness, before.value).filter(
      (row) => row.kind === "create_edge",
    );
    expect(
      made.length,
      "the links never became edges, so there is nothing here for a later scan to remove",
    ).toBe(2);

    // A link naming nothing looks like one gone, so while `target` names
    // nothing, taking out `other` removes nothing.
    renameSync(join(harness.dir, "target.md"), join(harness.dir, "moved.md"));
    writeFileSync(
      join(harness.dir, "source.md"),
      "---\ntitle: Source\n---\nsee [[target]] for more, and a word\n",
    );
    const scanned = await harness.folder.scan();
    expect(scanned.ok).toBe(true);
    if (!scanned.ok) return;
    expect(
      [scanned.value.renamed, scanned.value.updated],
      "the rename and the edit were not both seen, so nothing below is about the window they share",
    ).toEqual([1, 1]);

    const queued = await device.queue();
    expect(queued.ok).toBe(true);
    if (!queued.ok) return;
    expect(
      withoutPlacements(harness, queued.value).filter(
        (row) => row.kind === "delete_edge",
      ),
      "the folder destroyed an edge while a link stopped resolving, so renaming a file while editing another quietly cuts a connection, the one whose link is gone as well as the one whose link still says otherwise",
    ).toEqual([]);

    // The witness: once every link resolves, the removal of `other`'s edge
    // lands, and only that one.
    writeFileSync(
      join(harness.dir, "source.md"),
      "---\ntitle: Source\n---\nsee [[moved]] for more, and a word\n",
    );
    expect((await harness.folder.scan()).ok).toBe(true);
    const after = await device.queue();
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    const other = sentCreates(harness).find(
      (sent) => (sent.properties as Record<string, unknown>).title === "Other",
    );
    const toOther = made.find((row) => row.target_id === other?.id);
    expect(toOther).toBeDefined();
    expect(
      withoutPlacements(harness, after.value)
        .filter((row) => row.kind === "delete_edge")
        .map((row) => row.edge_id),
    ).toEqual([toOther?.edge_id]);
  });

  it("remembers a link it stood down over, so a later removal still lands", async () => {
    harness = await folderHarness("folder-stand-down-memory");
    scriptFolderWrites(harness);
    put(harness, "one.md", "---\ntitle: One\n---\nfirst\n");
    put(harness, "two.md", "---\ntitle: Different second\n---\nsecond\n");
    expect((await harness.folder.scan()).ok).toBe(true);
    put(
      harness,
      "source.md",
      "---\ntitle: Source\n---\nsee [[one]] and [[two]]\n",
    );
    expect((await harness.folder.push()).ok).toBe(true);

    const device = harness.folder.device();
    const first = await device.queue();
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(
      withoutPlacements(harness, first.value).filter(
        (row) => row.kind === "create_edge",
      ).length,
      "the two links never became edges, so there is nothing for a later removal to land on",
    ).toBe(2);

    // `two` stops resolving, in the same window as an edit. The folder stands
    // the removal down — and must not forget that the file carried the link.
    renameSync(join(harness.dir, "two.md"), join(harness.dir, "moved.md"));
    writeFileSync(
      join(harness.dir, "source.md"),
      "---\ntitle: Source\n---\nsee [[one]] and [[two]], plus a word\n",
    );
    expect((await harness.folder.scan()).ok).toBe(true);

    // The person takes the stale link out. Every link left resolves, so the
    // removal runs — and it can only reach the edge if the folder still
    // remembers the file used to carry it.
    writeFileSync(
      join(harness.dir, "source.md"),
      "---\ntitle: Source\n---\nsee [[one]] only\n",
    );
    expect((await harness.folder.scan()).ok).toBe(true);

    const queued = await device.queue();
    expect(queued.ok).toBe(true);
    if (!queued.ok) return;
    expect(
      withoutPlacements(harness, queued.value).filter(
        (row) => row.kind === "delete_edge",
      ).length,
      "the stand-down dropped the link out of the folder's memory for good, so removing it later does nothing and the next pull writes it back forever",
    ).toBe(1);
  });

  it("keeps an edge of a kind it could not have made", async () => {
    harness = await folderHarness("folder-foreign-edge");
    scriptFolderWrites(harness);
    put(harness, "target.md", "---\ntitle: Target\n---\nthe other end\n");
    expect((await harness.folder.scan()).ok).toBe(true);
    put(
      harness,
      "source.md",
      "---\ntitle: Source\n---\nsee [[target]] for more\n",
    );
    expect((await harness.folder.push()).ok).toBe(true);

    const device = harness.folder.device();
    const rows = await device.queue();
    expect(rows.ok).toBe(true);
    if (!rows.ok) return;
    const edge = withoutPlacements(harness, rows.value).find(
      (row) => row.kind === "create_edge",
    );
    expect(
      edge,
      "the link never became an edge, so there is nothing here of any kind to keep",
    ).toBeDefined();

    // A second edge between the same two, of a kind a folder never writes.
    const made = await device.createEdge({
      source: edge!.item_id as string,
      target: edge!.target_id as string,
      type: "mentions",
    });
    expect(made.ok, `the edge was refused: ${JSON.stringify(made)}`).toBe(true);

    writeFileSync(
      join(harness.dir, "source.md"),
      "---\ntitle: Source\n---\nsee nothing for more\n",
    );
    expect((await harness.folder.scan()).ok).toBe(true);

    const queued = await device.queue();
    expect(queued.ok).toBe(true);
    if (!queued.ok) return;
    const deleted = withoutPlacements(harness, queued.value).filter(
      (row) => row.kind === "delete_edge",
    );
    expect(
      deleted.length,
      "the link the person removed took no edge with it, so this fixture is not looking at a removal at all",
    ).toBeGreaterThan(0);
    expect(
      deleted.map((row) => row.edge_id),
      "the folder removed an edge of a kind it could not have made and cannot make again, on the strength of a line it never wrote",
    ).toEqual([edge!.edge_id]);
  });

  it("takes another device's change at the next push, without a hydration", async () => {
    const id = "01a00000-0000-7000-8000-0000000000c1";
    harness = await folderHarness("folder-push-catches-up", {
      rows: {
        "core.note": [
          {
            item: {
              id,
              version: 1,
              properties: { title: "elsewhere", body: "as it was" },
            },
          },
        ],
      },
      events: [
        copyLiveReplay("2", [
          copyItemEvent(
            "2",
            "item.updated",
            wireItem({
              id,
              version: 2,
              properties: {
                title: "elsewhere",
                body: "changed on another device",
              },
            }),
          ),
        ]),
      ],
    });
    scriptFolderWrites(harness);
    expect((await harness.folder.pull()).ok).toBe(true);
    // The witness: the file holds what the hydration brought.
    expect(read(harness, "elsewhere.md")).toContain("as it was");

    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    if (!pushed.ok) return;
    expect(
      read(harness, "elsewhere.md"),
      "a push wrote the folder out from a copy that never heard of the change another device made",
    ).toContain("changed on another device");
    // Taken from the log: the witness that a push can hydrate is `› hydrates
    // again at a push whose cursor the log has aged past`.
    expect(pushed.value.catch_up.caught_up?.applied).toBe(1);
    expect(
      [pushed.value.hydrated, pushed.value.catch_up.hydrated ?? null],
      "the push hydrated to take a change the log held",
    ).toEqual([null, null]);
  });

  it("takes another device's change while watching, without a hydration", async () => {
    const id = "01a00000-0000-7000-8000-0000000000c2";
    harness = await folderHarness("folder-watch-follows", {
      rows: {
        "core.note": [
          {
            item: {
              id,
              version: 1,
              properties: { title: "watched", body: "as it was" },
            },
          },
        ],
      },
      events: [
        copyLiveReplay("2", [
          copyItemEvent(
            "2",
            "item.updated",
            wireItem({
              id,
              version: 2,
              properties: { title: "watched", body: "changed while watching" },
            }),
          ),
        ]),
      ],
    });
    scriptFolderWrites(harness);
    const watching = harness.folder.watch();
    try {
      await vi.waitFor(
        () =>
          expect(read(harness!, "watched.md")).toContain(
            "changed while watching",
          ),
        { timeout: 20_000, interval: 100 },
      );
      expect(watching.running(), watching.stderr).toBe(true);
    } finally {
      await watching.stop();
    }
  });

  it("keeps syncing both ways while a file changes twice a second", async () => {
    const id = "01a00000-0000-7000-8000-0000000000c4";
    harness = await folderHarness("folder-watch-steady", {
      rows: {
        "core.note": [
          {
            item: {
              id,
              version: 1,
              properties: { title: "remote", body: "as it was" },
            },
          },
        ],
      },
      events: [
        copyLiveReplay("2", [
          copyItemEvent(
            "2",
            "item.updated",
            wireItem({
              id,
              version: 2,
              properties: { title: "remote", body: "changed elsewhere" },
            }),
          ),
        ]),
      ],
    });
    scriptFolderWrites(harness);
    const log = put(harness, "log.md", "a log\n");
    let lines = 0;
    // Faster than the watch's debounce lets the folder settle, and for the
    // whole run, so nothing below can be waiting for it to stop.
    const writing = setInterval(() => {
      lines += 1;
      appendFileSync(log, `line ${lines}\n`);
    }, 500);
    const watching = harness.folder.watch();
    try {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      put(
        harness,
        "other.md",
        "---\ntitle: Other\n---\nwritten beside the log\n",
      );
      await vi.waitFor(
        () => {
          expect(
            read(harness!, "remote.md"),
            "a change from the server never reached the folder while one file kept changing",
          ).toContain("changed elsewhere");
          expect(
            sentTitles(harness!),
            "a new file never reached the server while another file kept changing",
          ).toContain("Other");
        },
        { timeout: 30_000, interval: 100 },
      );
      expect(watching.running(), watching.stderr).toBe(true);
    } finally {
      clearInterval(writing);
      await watching.stop();
    }
  });

  it("sends a file being copied in only once it stops changing, while every other file goes on", async () => {
    harness = await folderHarness("folder-watch-copying", {
      settings: { search: { types: ["core.note", "core.file"] } },
    });
    scriptFolderWrites(harness);
    acceptUploads(harness.server);
    const uploads = () =>
      harness!.server.requests
        .filter(
          (request) =>
            request.method === "POST" && request.pathname === "/blobs",
        )
        .map((request) => request.raw);
    const copying = join(harness.dir, "movie.bin");
    writeFileSync(copying, Buffer.alloc(0));
    let written = 0;
    // Faster than the watch's debounce, for longer than it waits for the
    // folder to settle, so passes run while the copy is under way.
    const writing = setInterval(() => {
      written += 1;
      appendFileSync(copying, Buffer.alloc(4096, written % 256));
    }, 50);
    const watching = harness.folder.watch();
    let whole: Buffer;
    try {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      put(harness, "other.md", "---\ntitle: Other\n---\nwritten beside it\n");
      // The witness: a pass ran, and sent a file, while the copy went on.
      await vi.waitFor(
        () => {
          expect(
            sentTitles(harness!),
            "no pass ran while the copy went on, so nothing below shows a pass passing it over",
          ).toContain("Other");
        },
        { timeout: 30_000, interval: 100 },
      );
      await new Promise((resolve) => setTimeout(resolve, 6_000));
      clearInterval(writing);
      whole = readFileSync(copying);
      await vi.waitFor(
        () => {
          expect(sentTitles(harness!)).toContain("movie.bin");
        },
        { timeout: 30_000, interval: 100 },
      );
      expect(watching.running(), watching.stderr).toBe(true);
    } finally {
      clearInterval(writing);
      await watching.stop();
    }
    expect(
      uploads().map((bytes) => bytes.length),
      "a file still being copied in was uploaded half-written",
    ).toEqual([whole.length]);
    expect(uploads()[0]).toEqual(whole);
  });

  it("says once that a file which never stops changing has not been sent", async () => {
    harness = await folderHarness("folder-watch-never-settles", {
      settings: { search: { types: ["core.note", "core.file"] } },
    });
    scriptFolderWrites(harness);
    acceptUploads(harness.server);
    const log = join(harness.dir, "capture.bin");
    writeFileSync(log, Buffer.alloc(0));
    let written = 0;
    const writing = setInterval(() => {
      written += 1;
      appendFileSync(log, Buffer.alloc(1024, written % 256));
    }, 50);
    const said = "capture.bin: still changing, so not sent yet";
    const watching = harness.folder.watchText();
    try {
      // Long enough for several passes the folder never settles for.
      await vi.waitFor(
        () => {
          expect(watching.stdout).toContain(said);
        },
        { timeout: 30_000, interval: 100 },
      );
      await new Promise((resolve) => setTimeout(resolve, 11_000));
      expect(
        watching.stdout.split(said).length - 1,
        `a watch said the same still-changing file at every pass: ${watching.stdout}`,
      ).toBe(1);
      expect(
        harness.server.requests.filter(
          (request) =>
            request.method === "POST" && request.pathname === "/blobs",
        ),
        "a file that never stopped changing was uploaded part-written",
      ).toEqual([]);
      expect(watching.running(), watching.stderr).toBe(true);
    } finally {
      clearInterval(writing);
      await watching.stop();
    }
  });

  describe("a copy that falls behind the log", () => {
    const id = "01a00000-0000-7000-8000-0000000000c3";
    const agedOut: Answer = {
      kind: "sse",
      frames: [connected, copyStreamCursor("900"), catchupTooOld("500", "1")],
    };

    /** A folder with one note written out, whose later hydrations serve
     *  `later` in its place. */
    async function behind(
      label: string,
      events: Responder[],
    ): Promise<FolderHarness> {
      const made = await folderHarness(label, {
        rows: {
          "core.note": [
            {
              item: {
                id,
                version: 1,
                properties: { title: "aged", body: "as it was" },
              },
            },
          ],
        },
        events,
      });
      scriptFolderWrites(made);
      expect((await made.folder.pull()).ok).toBe(true);
      expect(read(made, "aged.md")).toContain("as it was");
      made.rows["core.note"]![0]!.item = {
        id,
        version: 2,
        properties: { title: "aged", body: "changed elsewhere" },
      };
      return made;
    }

    it("hydrates again at a push whose cursor the log has aged past", async () => {
      harness = await behind("folder-push-aged-out", [
        agedOut,
        copyHeadRead("900"),
      ]);
      const pushed = await harness.folder.push();
      expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
      if (!pushed.ok) return;
      // The note, and the folder's own settings, which it pins.
      expect(pushed.value.catch_up.hydrated?.items).toBe(2);
      expect(
        read(harness, "aged.md"),
        "a push whose cursor aged out wrote the folder from the copy it could no longer keep current",
      ).toContain("changed elsewhere");
    });

    it("hydrates again while watching when the log ages past its cursor", async () => {
      harness = await behind("folder-watch-aged-out", [
        agedOut,
        copyHeadRead("900"),
        copyLiveReplay("900", []),
      ]);
      const watching = harness.folder.watch();
      try {
        await vi.waitFor(
          () =>
            expect(read(harness!, "aged.md"), watching.stderr).toContain(
              "changed elsewhere",
            ),
          { timeout: 20_000, interval: 100 },
        );
        expect(watching.running(), watching.stderr).toBe(true);
      } finally {
        await watching.stop();
      }
    });

    it("keeps watching through a hydration that failed, and tries it again", async () => {
      harness = await behind("folder-watch-hydration-fails", [
        agedOut,
        answers.serverFault(),
        answers.serverFault(),
        copyHeadRead("900"),
        copyLiveReplay("900", []),
      ]);
      const watching = harness.folder.watch();
      try {
        await vi.waitFor(
          () =>
            expect(read(harness!, "aged.md"), watching.stderr).toContain(
              "changed elsewhere",
            ),
          { timeout: 20_000, interval: 100 },
        );
        expect(watching.running(), watching.stderr).toBe(true);
        // The witness: the first hydration did fail.
        expect(watching.stderr).toContain("could not hydrate");
      } finally {
        await watching.stop();
      }
      expect(
        watching.stderr.split("could not hydrate").length - 1,
        `a watch said it could not hydrate at every attempt rather than once: ${watching.stderr}`,
      ).toBe(1);
    });

    it("waits out a rate limit's Retry-After before hydrating again while watching", async () => {
      const asked: number[] = [];
      const timed =
        (answer: Answer): Responder =>
        () => {
          asked.push(Date.now());
          return answer;
        };
      harness = await behind("folder-watch-hydration-limited", [
        agedOut,
        timed(answers.rateLimited()),
        timed(copyHeadRead("900")),
        copyLiveReplay("900", []),
      ]);
      const watching = harness.folder.watch();
      try {
        await vi.waitFor(
          () =>
            expect(read(harness!, "aged.md"), watching.stderr).toContain(
              "changed elsewhere",
            ),
          { timeout: 20_000, interval: 100 },
        );
      } finally {
        await watching.stop();
      }
      // The first wait is a second; the rate limit names two.
      expect(asked).toHaveLength(2);
      expect(
        asked[1]! - asked[0]!,
        "the watch hydrated again before the wait the rate limit named",
      ).toBeGreaterThanOrEqual(1900);
    });

    it("ends the watch and says so when its hydration meets an answer no retry changes", async () => {
      harness = await behind("folder-watch-hydration-refused", [
        agedOut,
        answers.forbidden("forbidden"),
      ]);
      const watching = harness.folder.watch();
      try {
        // The witness is `› keeps watching through a hydration that failed,
        // and tries it again`: a 500 in the same place keeps it running.
        await vi.waitFor(
          () =>
            expect(
              watching.running(),
              `a watch went on after its hydration was refused, so nothing says the folder no longer keeps up: ${watching.stderr}`,
            ).toBe(false),
          { timeout: 20_000, interval: 100 },
        );
        expect(watching.stderr).toContain(
          "the server's changes stopped reaching this folder",
        );
        expect(watching.stderr).toContain("forbidden");
      } finally {
        await watching.stop();
      }
    });

    it("hydrates at the next push after one whose hydration failed", async () => {
      harness = await behind("folder-push-hydration-fails", [
        agedOut,
        answers.serverFault(),
        copyHeadRead("900"),
        copyLiveReplay("900", []),
      ]);
      const failed = await harness.folder.push();
      expect(failed.ok, JSON.stringify(failed)).toBe(true);
      if (!failed.ok) return;
      expect(failed.value.catch_up.failed).toMatch(/500/);
      expect(
        failed.value.pull,
        "a push pulled from a copy it could not hydrate",
      ).toBeNull();
      expect(read(harness, "aged.md")).toContain("as it was");

      const next = await harness.folder.push();
      expect(
        next.ok,
        `the push after a failed hydration failed too: ${JSON.stringify(next)}`,
      ).toBe(true);
      if (!next.ok) return;
      // The note, and the folder's own settings, which it pins.
      expect(next.value.hydrated?.items).toBe(2);
      expect(read(harness, "aged.md")).toContain("changed elsewhere");
    });
  });

  it("pulls at a push that cannot reach the server, and says the catch-up failed", async () => {
    const id = "01a00000-0000-7000-8000-0000000000c4";
    harness = await folderHarness("folder-push-offline", {
      rows: {
        "core.note": [
          {
            item: {
              id,
              version: 1,
              properties: { title: "offline", body: "as it was" },
            },
          },
        ],
      },
      events: [
        copyLiveReplay("2", [
          copyItemEvent(
            "2",
            "item.updated",
            wireItem({
              id,
              version: 2,
              properties: { title: "offline", body: "changed elsewhere" },
            }),
          ),
        ]),
      ],
    });
    scriptFolderWrites(harness);
    expect(existsSync(join(harness.dir, "offline.md"))).toBe(false);

    await harness.server.offline();
    const offline = await harness.folder.push();
    await harness.server.online();
    expect(
      offline.ok,
      `a push that could not reach the server failed rather than writing out what it holds: ${JSON.stringify(offline)}`,
    ).toBe(true);
    if (!offline.ok) return;
    expect(offline.value.catch_up.failed).toMatch(/network/);
    expect(offline.value.pull?.written).toBe(1);
    expect(read(harness, "offline.md")).toContain("as it was");

    // The witness: the same push online catches up.
    const online = await harness.folder.push();
    expect(online.ok, JSON.stringify(online)).toBe(true);
    if (!online.ok) return;
    expect(online.value.catch_up.caught_up?.applied).toBe(1);
    expect(read(harness, "offline.md")).toContain("changed elsewhere");
  });

  it("sends the placement of each file a push writes in the push, and counts it", async () => {
    const edges = new EdgeDoor();
    harness = await folderHarness("placement-in-the-push", {
      rows: {
        "core.note": [
          {
            item: {
              id: "01a00000-0000-7000-8000-0000000055a1",
              properties: { title: "One", body: "made elsewhere\n" },
            },
          },
          {
            item: {
              id: "01a00000-0000-7000-8000-0000000055a2",
              properties: { title: "Two", body: "made elsewhere\n" },
            },
          },
        ],
      },
    });
    scriptFolderWrites(harness, { edges });
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    if (!pushed.ok) return;
    expect(pushed.value.pull?.written).toBe(2);
    expect(
      pushed.value.drain.answered,
      "the placements the pull queued were left for the next push",
    ).toBe(2);
    expect(placedPaths(edges)).toEqual(["One.md", "Two.md"]);
    const status = await harness.folder.status();
    expect(status.ok && status.value.files.map((file) => file.status)).toEqual([
      "in_step",
      "in_step",
    ]);
    const again = await harness.folder.push();
    expect(
      again.ok && [again.value.drain.answered, again.value.pull?.written],
    ).toEqual([0, 0]);
  });

  it("leaves the placements of the files a push wrote waiting where it could not reach the server, and sends them at the next push", async () => {
    const edges = new EdgeDoor();
    harness = await folderHarness("placement-push-offline", {
      rows: {
        "core.note": [
          {
            item: {
              id: "01a00000-0000-7000-8000-0000000055b1",
              properties: { title: "Offline", body: "made elsewhere\n" },
            },
          },
        ],
      },
    });
    scriptFolderWrites(harness, { edges });
    await harness.server.offline();
    const offline = await harness.folder.push();
    await harness.server.online();
    expect(offline.ok, JSON.stringify(offline)).toBe(true);
    if (!offline.ok) return;
    expect(offline.value.catch_up.failed).toMatch(/network/);
    expect(offline.value.pull?.written).toBe(1);
    expect(offline.value.drain.answered).toBe(0);
    const waiting = await harness.folder.status();
    expect(waiting.ok && waiting.value.files).toMatchObject([
      { path: "Offline.md", status: "waiting", waits: ["placement"] },
    ]);
    expect(placedPaths(edges)).toEqual([]);

    const online = await harness.folder.push();
    expect(online.ok, JSON.stringify(online)).toBe(true);
    if (!online.ok) return;
    expect(online.value.drain.answered).toBe(1);
    expect(placedPaths(edges)).toEqual(["Offline.md"]);
    const settled = await harness.folder.status();
    expect(
      settled.ok && settled.value.files.map((file) => file.status),
    ).toEqual(["in_step"]);
  });

  it("leaves the placements waiting where the server fails them as the push sends them, and sends them at the next push", async () => {
    const edges = new EdgeDoor();
    let failing = true;
    edges.placing = (edge) =>
      failing && edge.edge_type === "in-folder"
        ? refusal(503, "unavailable", "Try again")
        : undefined;
    harness = await folderHarness("placement-push-failing", {
      rows: {
        "core.note": [
          {
            item: {
              id: "01a00000-0000-7000-8000-0000000055c1",
              properties: { title: "Elsewhere", body: "made elsewhere\n" },
            },
          },
        ],
      },
    });
    scriptFolderWrites(harness, { edges });
    // A file made here, whose create and placement the first drain sends:
    // the server fails the placement, so the push has nothing to ask of it
    // again for the file its pull wrote.
    put(harness, "Here.md", "---\ntitle: Here\n---\nmade here\n");
    const failed = await harness.folder.push();
    expect(failed.ok, JSON.stringify(failed)).toBe(true);
    if (!failed.ok) return;
    expect(failed.value.pull?.written).toBe(1);
    expect(failed.value.drain.unavailable).toBeTruthy();
    expect(
      postedEdges(harness),
      "the push asked the server that failed it to take the placements again",
    ).toBe(1);
    const waiting = await harness.folder.status();
    expect(
      waiting.ok && waiting.value.files.map((file) => file.status),
    ).toEqual(["waiting", "waiting"]);

    failing = false;
    const next = await harness.folder.push();
    expect(next.ok, JSON.stringify(next)).toBe(true);
    expect(placedPaths(edges)).toEqual(["Elsewhere.md", "Here.md"]);
    const settled = await harness.folder.status();
    expect(
      settled.ok && settled.value.files.map((file) => file.status),
    ).toEqual(["in_step", "in_step"]);
  });

  it("does not drain again after a push whose first drain a refused credential stopped", async () => {
    harness = await folderHarness("placement-push-credential", {
      rows: {
        "core.note": [
          {
            item: {
              id: "01a00000-0000-7000-8000-0000000055e1",
              properties: { title: "Elsewhere", body: "made elsewhere\n" },
            },
          },
        ],
      },
    });
    const edges = new EdgeDoor();
    harness.server.answer("POST", "/items", answers.unauthorized());
    scriptFolderWrites(harness, { edges });
    put(harness, "Here.md", "---\ntitle: Here\n---\nmade here\n");
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    if (!pushed.ok) return;
    // The witness: the first drain met the refusal and the pull wrote a file.
    expect(pushed.value.drain.stopped).toBeTruthy();
    expect(pushed.value.pull?.written).toBe(1);
    expect(
      postedEdges(harness),
      "the push drained again with a credential the server refused",
    ).toBe(0);
    const status = await harness.folder.status();
    expect(
      status.ok &&
        status.value.files.find((file) => file.path === "Elsewhere.md"),
    ).toMatchObject({ status: "waiting", waits: ["placement"] });
  });

  it("does not drain again after a push whose first drain left a write undelivered", async () => {
    harness = await folderHarness("placement-push-undelivered", {
      settings: { search: { types: ["core.note", "core.file"] } },
      rows: {
        "core.note": [
          {
            item: {
              id: "01a00000-0000-7000-8000-0000000055f1",
              properties: { title: "Elsewhere", body: "made elsewhere\n" },
            },
          },
        ],
      },
    });
    const edges = new EdgeDoor();
    scriptFolderWrites(harness, { edges });
    acceptUploads(harness.server);
    writeFileSync(join(harness.dir, "photo.png"), Buffer.from("png bytes"));
    expect((await harness.folder.scan()).ok).toBe(true);
    // A cached copy of the bytes the drain cannot open: not the server's
    // failure, so no refusal and no unreachable server.
    const cache = join(harness.dir, ".marfa", "core.sqlite.blobs");
    const held = readdirSync(cache, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => join(entry.parentPath, entry.name));
    expect(held.length, "no bytes were cached to make unreadable").toBe(1);
    chmodSync(held[0]!, 0o000);
    try {
      const pushed = await harness.folder.push();
      expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
      if (!pushed.ok) return;
      expect(pushed.value.drain.undelivered).toBeGreaterThan(0);
      expect(pushed.value.drain.unavailable).toBeNull();
      expect(pushed.value.drain.stopped).toBeNull();
      expect(pushed.value.pull?.written).toBe(1);
      expect(
        postedEdges(harness),
        "the push drained again with a write it could not deliver",
      ).toBe(0);
    } finally {
      chmodSync(held[0]!, 0o600);
    }
    const next = await harness.folder.push();
    expect(next.ok, JSON.stringify(next)).toBe(true);
    expect(placedPaths(edges)).toContain("Elsewhere.md");
  });

  it("reports a placement the server refuses in the push's second drain, and does not send it again", async () => {
    const edges = new EdgeDoor();
    edges.placing = (edge) =>
      edge.edge_type === "in-folder"
        ? refusal(
            403,
            "edge_permission_denied",
            "Write access to edge type denied",
          )
        : undefined;
    harness = await folderHarness("placement-push-refused", {
      rows: {
        "core.note": [
          {
            item: {
              id: "01a00000-0000-7000-8000-0000000055a4",
              properties: { title: "Elsewhere", body: "made elsewhere\n" },
            },
          },
        ],
      },
    });
    scriptFolderWrites(harness, { edges });
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    if (!pushed.ok) return;
    expect(pushed.value.pull?.written).toBe(1);
    expect(
      pushed.value.drain.verdicts.map((entry) => [entry.kind, entry.verdict]),
    ).toEqual([["create_edge", "refused"]]);
    expect(placedPaths(edges)).toEqual([]);
    const next = await harness.folder.push();
    expect(next.ok, JSON.stringify(next)).toBe(true);
    expect(postedEdges(harness), "a refused placement was sent again").toBe(1);
  });

  it("makes an edge between two files that arrive together", async () => {
    harness = await folderHarness("folder-links-same-scan");
    scriptFolderWrites(harness);
    // Both new in one scan, each naming the other. The walk returns them
    // sorted, so one is reached before the other is bound; the first names
    // the second in a line too.
    put(
      harness,
      "alpha.md",
      '---\ntitle: Alpha\nchild-of: "[[omega]]"\n---\nsee [[omega]]\n',
    );
    put(harness, "omega.md", "---\ntitle: Omega\n---\nsee [[alpha]]\n");
    expect((await harness.folder.push()).ok).toBe(true);

    const creates = sentCreates(harness);
    expect(
      creates.length,
      "the two files never became items, so there is nothing for an edge to join",
    ).toBe(2);
    const id = (title: string): string =>
      String(
        creates.find(
          (sent) =>
            (sent.properties as Record<string, unknown>).title === title,
        )?.id,
      );
    const [alpha, omega] = [id("Alpha"), id("Omega")];
    expect(
      sentEdgeWrites(harness).sort(),
      "a link or a line naming a file that arrived in the same scan never became an edge, and no later scan retries it because both files are unchanged from then on",
    ).toEqual(
      [
        `create ${alpha} references ${omega}`,
        `create ${omega} references ${alpha}`,
        `create ${omega} parent-of ${alpha}`,
      ].sort(),
    );
  });

  it("carries body links to edges, and an edge no link names to a line", async () => {
    harness = await folderHarness("folder-links");
    scriptFolderWrites(harness);
    put(harness, "target.md", "---\ntitle: Target\n---\nthe other end\n");
    // Scanned first, so the link below names a file the folder already holds.
    expect((await harness.folder.scan()).ok).toBe(true);
    put(
      harness,
      "source.md",
      "---\ntitle: Source\n---\nsee [[target]] for more\n",
    );
    // An embed is not a link.
    put(harness, "shows.md", "---\ntitle: Shows\n---\n![[target]]\n");
    expect((await harness.folder.push()).ok).toBe(true);

    const queued = await harness.folder.device().queue();
    expect(queued.ok).toBe(true);
    if (!queued.ok) return;
    const edges = withoutPlacements(harness, queued.value).filter(
      (row) => row.kind === "create_edge",
    );
    expect(
      edges.map(
        (row) =>
          sentCreates(harness!).find((sent) => sent.id === row.item_id)
            ?.properties,
      ),
      "a link in the body did not become an edge, or an embed did",
    ).toEqual([expect.objectContaining({ title: "Source" })]);

    const bound = queued.value.find(
      (row) =>
        row.kind === "create_item" && row.item_id === edges[0]?.target_id,
    );
    expect(
      bound,
      "the edge points at something this folder did not create, so the link resolved to the wrong item",
    ).toBeDefined();

    // And the other direction, with a witness that it ran. The body above
    // already carries its link, so writing it back proves only that nothing
    // was lost; an edge the file does not mention is what makes the folder
    // add one.
    expect((await harness.folder.pull()).ok).toBe(true);
    expect(
      bodyOf(harness, "source.md"),
      "the link went from the file when the item was written back, so an edge a folder made disappears from the note that made it",
    ).toContain("[[target]]");
    expect(
      frontOf(harness, "source.md"),
      "an edge the body links was repeated as a line",
    ).not.toContain("references");

    // A second folder, hydrated on an item that carries an edge in its own
    // body-free form: the file has no link, and the edge is what has to put
    // one there.
    second = await folderHarness("folder-edges-to-links", {
      rows: {
        "core.note": [
          {
            item: {
              id: "01a00000-0000-7000-8000-0000000000a1",
              properties: { title: "from-server", body: "no link here\n" },
              edges: {
                references: {
                  data: [
                    {
                      id: "01a00000-0000-7000-8000-0000000000e1",
                      source_id: "01a00000-0000-7000-8000-0000000000a1",
                      target_id: "01a00000-0000-7000-8000-0000000000a2",
                      edge_type: "references",
                      properties: {},
                      version: 1,
                      created_at: "2026-09-18T00:00:00.000Z",
                      updated_at: "2026-09-18T00:00:00.000Z",
                    },
                  ],
                  next_cursor: null,
                },
              },
            },
          },
          {
            item: {
              id: "01a00000-0000-7000-8000-0000000000a2",
              properties: { title: "the-target", body: "the other end\n" },
            },
          },
        ],
      },
    });
    scriptFolderWrites(second);
    const pulled = await second.folder.pull();
    expect(pulled.ok).toBe(true);
    if (!pulled.ok) return;
    expect(
      pulled.value.written,
      "the folder wrote no files at all, so the assertion below is about a file that is not there",
    ).toBe(2);
    expect(
      frontOf(second, "from-server.md"),
      "an edge the item carries is not a line in the file, so a connection made anywhere else is invisible in the folder",
    ).toContain('references:\n  - "[[the-target]]"');
    expect(
      bodyOf(second, "from-server.md"),
      "the edge was appended to the body, which is the person's text",
    ).toBe("no link here\n");
  });
});

describe("what a folder takes", () => {
  it("excludes a dot-led directory at any depth", async () => {
    harness = await folderHarness("folder-dot-led");
    scriptFolderWrites(harness);
    put(harness, "kept.md", "---\ntitle: Kept\n---\nbody\n");
    put(harness, ".hidden/note.md", "---\ntitle: Hidden\n---\nbody\n");
    put(harness, "deep/.hidden/note.md", "---\ntitle: Deeper\n---\nbody\n");
    put(harness, "deep/kept.md", "---\ntitle: Deep kept\n---\nbody\n");
    expect((await harness.folder.push()).ok).toBe(true);

    expect(
      sentTitles(harness).sort(),
      "a dot-led directory was pushed, and at depth is where it matters: an editor's own state, a version control directory, a cache — none of them is the person's content",
    ).toEqual(["Deep kept", "Kept"]);
  });

  it("takes only what its include list names", async () => {
    harness = await folderHarness("folder-include", {
      settings: {
        search: { types: ["core.note"] },
        include: ["Notes/", "Other/kept.md"],
      },
      rows: {
        "core.note": [
          {
            item: {
              id: "01a00000-0000-7000-8000-000000017001",
              properties: { title: "Elsewhere", body: "made elsewhere\n" },
            },
          },
        ],
      },
    });
    scriptFolderWrites(harness);
    put(harness, "Notes/inside.md", "---\ntitle: Inside\n---\nbody\n");
    put(harness, "Notes/deep/deeper.md", "---\ntitle: Deeper\n---\nbody\n");
    put(harness, "Other/kept.md", "---\ntitle: Kept\n---\nbody\n");
    put(harness, "Other/left.md", "---\ntitle: Left\n---\nbody\n");
    put(harness, "root.md", "---\ntitle: Root\n---\nbody\n");
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    if (!pushed.ok) return;
    expect(
      sentTitles(harness).sort(),
      "the folder took a file its include list does not name, or left out one it does, so the list decides nothing",
    ).toEqual(["Deeper", "Inside", "Kept"]);
    // The pull half: an item whose file would land where the list takes
    // nothing is not written, and is counted rather than dropped silently.
    expect(
      existsSync(join(harness.dir, "Elsewhere.md")),
      "the pull wrote a file where the include list takes nothing, so the next scan reads it as gone and deletes its item",
    ).toBe(false);
    expect(pushed.value.pull?.outside).toBe(1);
    expect(
      pushed.value.pull?.flagged,
      "the pull counted an item it did not write without naming it",
    ).toContainEqual({
      path: "Elsewhere.md",
      flag: "outside",
      reason: "the folder's lists do not take the path",
      item: "01a00000-0000-7000-8000-000000017001",
    });
    const said = await harness.folder.pullText();
    expect(said.ok && said.value).toContain(
      "Elsewhere.md is not written (item 01a00000-0000-7000-8000-000000017001): the folder's lists do not take the path",
    );
  });

  it("never takes a secret whatever its lists say", async () => {
    harness = await folderHarness("folder-secrets", {
      settings: {
        search: { types: ["core.note", "core.file"] },
        defaults: { type: "core.note" },
        include: [".env", "*.pem", "keys/", "ssh/", "*.md"],
        ignore: ["!.env", "!*.pem"],
      },
    });
    scriptFolderWrites(harness);
    acceptUploads(harness.server);
    put(harness, ".env", "TOKEN=hunter2-env\n");
    put(harness, "keys/server.pem", "hunter2-pem\n");
    put(harness, "keys/Deploy.KEY", "hunter2-key\n");
    put(harness, "keys/credentials", "hunter2-credentials\n");
    put(harness, "ssh/id_ed25519", "hunter2-ssh\n");
    // The controls: the include list reaches these, so it is the secrets
    // alone that are refused.
    writeFileSync(
      join(harness.dir, "keys", "diagram.png"),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7]),
    );
    put(harness, "keys/readme.md", "---\ntitle: Readme\n---\nbody\n");
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    expect(
      sentTitles(harness).sort(),
      "a secret an include line names was taken, or the controls beside it were not",
    ).toEqual(["Readme", "diagram.png"]);
    expect(
      harness.server.requests.filter((request) =>
        request.body.includes("hunter2"),
      ),
      "a secret's bytes reached the server, where every machine and key that reads the folder can have them",
    ).toEqual([]);
    expect(
      pushed.ok && [...pushed.value.scan.secrets].sort(),
      "a refused secret went unnamed, so a person cannot tell why their file never arrived",
    ).toEqual([
      ".env",
      "keys/Deploy.KEY",
      "keys/credentials",
      "keys/server.pem",
      "ssh/id_ed25519",
    ]);
    const said = await harness.folder.pushText();
    expect(said.ok && said.value).toContain(
      "keys/server.pem: not taken, because its name is one a secret goes by",
    );
  });

  it("names each item it holds back at a secret's name, two at one path as two", async () => {
    const [one, two] = [
      "01a00000-0000-7000-8000-000000017101",
      "01a00000-0000-7000-8000-000000017102",
    ];
    const key = (id: string) => ({
      item: {
        id,
        type: "core.file",
        properties: {
          title: "id_rsa",
          blob_ref: hashOf(Buffer.from(`key ${id}`)),
          mime_type: "application/octet-stream",
        },
      },
    });
    harness = await folderHarness("folder-secret-items", {
      settings: { search: { types: ["core.file"] } },
      rows: { "core.file": [key(one), key(two)] },
    });
    scriptFolderWrites(harness);
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    if (!pushed.ok) return;
    expect(
      pushed.value.pull?.flagged
        .filter((file) => file.path === "id_rsa")
        .map((file) => [file.flag, file.item])
        .sort(),
    ).toEqual([
      ["outside", one],
      ["outside", two],
    ]);
    const said = await harness.folder.pushText();
    expect(said.ok, JSON.stringify(said)).toBe(true);
    if (!said.ok) return;
    for (const id of [one, two]) {
      expect(
        said.value,
        "two items held back at one path were said as one",
      ).toContain(`id_rsa is not written (item ${id})`);
    }
  });

  it("never takes an editor's or a download's temporary file", async () => {
    harness = await folderHarness("folder-temporary", {
      settings: { search: { types: ["core.note", "core.file"] } },
    });
    scriptFolderWrites(harness);
    acceptUploads(harness.server);
    const temporary = [
      "report.pdf.crdownload",
      "page.html.crswap",
      "archive.zip.part",
      "movie.mov.download",
      "#draft.md#",
      "notes.txt___jb_tmp___",
      "notes.txt___jb_old___",
      ".#draft.md",
      "draft.md.swp",
      "~$Budget.xlsx",
      "upload.tmp",
    ];
    for (const name of temporary) put(harness, name, `half of ${name}\n`);
    // Safari's download is a directory holding the bytes as they arrive.
    put(harness, "image.png.download/image.png", "half a picture\n");
    // The witnesses: a finished download and a note beside them are taken.
    writeFileSync(
      join(harness.dir, "report.pdf"),
      Buffer.from("%PDF-1.4\n%%EOF\n"),
    );
    put(harness, "draft.md", "---\ntitle: Draft\n---\nbody\n");
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    expect(
      sentTitles(harness).sort(),
      "an editor's or a download's temporary file was sent as an item",
    ).toEqual(["Draft", "report.pdf"]);
    expect(
      harness.server.requests.filter((request) =>
        request.body.includes("half"),
      ),
    ).toEqual([]);
  });

  it("ignores what its ignore list names", async () => {
    harness = await folderHarness("folder-ignore", {
      events: [copyLiveReplay("1", [])],
    });
    scriptFolderWrites(harness);
    put(harness, "gone.md", "---\ntitle: Gone\n---\nbody\n");
    put(harness, "drafts/draft.md", "---\ntitle: Draft\n---\nbody\n");
    put(harness, "kept.md", "---\ntitle: Kept\n---\nbody\n");
    expect((await harness.folder.push()).ok).toBe(true);
    const draft = idIn(harness, "drafts/draft.md");
    expect(draft).toBeDefined();

    const sent = scriptFolderChanges(harness);
    writeFileSync(
      settingsFile(harness),
      readFileSync(settingsFile(harness), "utf8") + "ignore:\n  - drafts/\n",
    );
    writeFileSync(
      join(harness.dir, "drafts", "draft.md"),
      read(harness, "drafts/draft.md") + "edited while ignored\n",
    );
    put(harness, "drafts/new.md", "---\ntitle: New draft\n---\nbody\n");
    // The witness: a file taken away in the same scan is journaled, so a
    // count of none below is the ignore list, not a scan that journals
    // nothing.
    rmSync(join(harness.dir, "gone.md"));
    const updates = sentUpdates(harness).length;
    const ignoring = await harness.folder.push();
    expect(ignoring.ok, JSON.stringify(ignoring)).toBe(true);
    if (!ignoring.ok) return;
    expect(sent).toEqual([{ version: 1, ignore: ["drafts/"] }]);
    expect(
      sentTitles(harness),
      "a new file in a directory the ignore list names was sent",
    ).not.toContain("New draft");
    expect(
      sentUpdates(harness).slice(updates),
      "an edit of a file the ignore list names was sent",
    ).toEqual([]);
    expect(
      [ignoring.value.scan.missing, ignoring.value.scan.unreached],
      "a file the list stopped taking was journaled as deleted, so a new ignore line trashes every item it covers",
    ).toEqual([1, 1]);
    expect(
      ignoring.value.pull?.outside,
      "the pull wrote into a directory the ignore list names, or said nothing of the item it did not write",
    ).toBe(1);
    expect(read(harness, "drafts/draft.md")).toContain("edited while ignored");

    // Taken again, the file is its item's, and the edit made meanwhile goes.
    writeFileSync(
      settingsFile(harness),
      readFileSync(settingsFile(harness), "utf8").replace(
        /ignore:\n(\s*- .*\n)+/,
        "ignore: []\n",
      ),
    );
    const taken = await harness.folder.push();
    expect(taken.ok, JSON.stringify(taken)).toBe(true);
    if (!taken.ok) return;
    expect(taken.value.scan.unreached).toBe(0);
    expect(sentUpdates(harness).map((update) => update.id)).toContain(draft);
    expect(sentTitles(harness)).toContain("New draft");
    expect(idIn(harness, "drafts/draft.md")).toBe(draft);
  });

  it("keeps a bound file at the top that a line naming only directories does not take", async () => {
    harness = await folderHarness("folder-top-unreached", {
      events: [copyLiveReplay("1", [])],
    });
    scriptFolderWrites(harness);
    put(harness, "top.md", "---\ntitle: Top\n---\nbody\n");
    put(harness, "deep/inner.md", "---\ntitle: Inner\n---\nbody\n");
    expect((await harness.folder.push()).ok).toBe(true);
    const top = idIn(harness, "top.md");
    expect(top).toBeDefined();

    // A line that names every directory and nothing at the top: the folder's
    // own directory is not a path a line matches, whatever it names.
    scriptFolderChanges(harness);
    writeFileSync(
      settingsFile(harness),
      readFileSync(settingsFile(harness), "utf8") + 'include:\n  - "*/"\n',
    );
    writeFileSync(
      join(harness.dir, "top.md"),
      read(harness, "top.md") + "edited while not taken\n",
    );
    const updates = sentUpdates(harness).length;
    const narrowed = await harness.folder.push();
    expect(narrowed.ok, JSON.stringify(narrowed)).toBe(true);
    if (!narrowed.ok) return;
    // As a file a list change stops taking: not reached, not deleted, its
    // edits held and its bytes left as they are.
    expect([
      narrowed.value.scan.missing,
      narrowed.value.scan.unreached,
    ]).toEqual([0, 1]);
    expect(sentUpdates(harness).slice(updates)).toEqual([]);
    expect(read(harness, "top.md")).toContain("edited while not taken");
    expect(idIn(harness, "top.md")).toBe(top);

    // Taken again, the file is still its item's.
    writeFileSync(
      settingsFile(harness),
      readFileSync(settingsFile(harness), "utf8").replace(
        /include:\n(\s*- .*\n)+/,
        "include: []\n",
      ),
    );
    const taken = await harness.folder.push();
    expect(taken.ok, JSON.stringify(taken)).toBe(true);
    if (!taken.ok) return;
    expect(taken.value.scan.unreached).toBe(0);
    expect(sentUpdates(harness).map((update) => update.id)).toContain(top);
    expect(idIn(harness, "top.md")).toBe(top);
  });

  it("reaches a dot-led path its include list names", async () => {
    harness = await folderHarness("folder-include-dot-led", {
      settings: {
        search: { types: ["core.note"] },
        include: [".notes/", "*.md"],
      },
    });
    scriptFolderWrites(harness);
    put(harness, ".notes/idea.md", "---\ntitle: Idea\n---\nbody\n");
    put(harness, ".notes/deep/more.md", "---\ntitle: More\n---\nbody\n");
    // `*.md` names this file too, and names no dot-led name on its way.
    put(harness, ".cache/stale.md", "---\ntitle: Stale\n---\nbody\n");
    put(harness, "plain.md", "---\ntitle: Plain\n---\nbody\n");
    expect((await harness.folder.push()).ok).toBe(true);
    expect(
      sentTitles(harness).sort(),
      "a dot-led directory an include line names was not walked, or one no line names was",
    ).toEqual(["Idea", "More", "Plain"]);
    expect(
      idIn(harness, ".notes/idea.md"),
      "the pull did not write the id back into a file under a dot-led directory the list takes",
    ).toBeDefined();
    const again = await harness.folder.push();
    expect(again.ok, JSON.stringify(again)).toBe(true);
    expect(
      again.ok && [again.value.scan.created, again.value.scan.missing],
      "a file the pull wrote under the dot-led directory was read back as new or gone",
    ).toEqual([0, 0]);
  });

  it("takes nothing under a dot-led directory a negated include line names", async () => {
    harness = await folderHarness("folder-include-negated", {
      settings: {
        search: { types: ["core.note"] },
        include: ["*", "!.git/"],
      },
    });
    scriptFolderWrites(harness);
    put(harness, ".git/notes.md", "---\ntitle: Hidden\n---\nbody\n");
    put(harness, "plain.md", "---\ntitle: Plain\n---\nbody\n");
    expect((await harness.folder.push()).ok).toBe(true);
    // The witness: the file beside it is taken.
    expect(
      sentTitles(harness),
      "a file under a directory a `!` line names was taken",
    ).toEqual(["Plain"]);
  });

  it("writes nothing under a dot-led directory its walk does not enter", async () => {
    const id = "01a00000-0000-7000-8000-0000000018a1";
    const placed = (include: string[]) => ({
      settings: {
        search: { types: ["core.note"] },
        include,
        first_placement: { "core.note": ".notes/.hidden" },
      },
      rows: {
        "core.note": [
          { item: { id, properties: { title: "Placed", body: "b\n" } } },
        ],
      },
    });
    // The witness: where both dot-led names are included, the file is
    // written there.
    const both = await folderHarness(
      "folder-dot-led-both",
      placed([".notes/", ".hidden/"]),
    );
    try {
      expect((await both.folder.pull()).ok).toBe(true);
      expect(existsSync(join(both.dir, ".notes/.hidden/Placed.md"))).toBe(true);
    } finally {
      await both.stop();
    }
    harness = await folderHarness("folder-dot-led-one", placed([".notes/"]));
    scriptFolderWrites(harness);
    const pulled = await harness.folder.pull();
    expect(pulled.ok, JSON.stringify(pulled)).toBe(true);
    expect(
      existsSync(join(harness.dir, ".notes/.hidden/Placed.md")),
      "a pull wrote under a dot-led directory no scan walks, where the next scan would read it as gone",
    ).toBe(false);
  });

  it("names the file a conflicted edit's text went to, in a push", async () => {
    const id = "01a00000-0000-7000-8000-0000000055a7";
    let door: FolderDoor | undefined;
    harness = await folderHarness("folder-conflict-push-copy", {
      rows: {
        "core.note": [
          { item: { id, properties: { title: "Note", body: "as read\n" } } },
        ],
      },
      events: [copiesAsTheyArrive(() => door)],
    });
    scriptFolderWrites(harness, {
      door: (made) => {
        door = made;
      },
    });
    expect((await harness.folder.pull()).ok).toBe(true);
    door?.update(id, { properties: { body: "theirs\n" }, version: 1 });
    put(
      harness,
      "Note.md",
      read(harness, "Note.md").replace("as read", "mine"),
    );
    const pushed = await harness.folder.pushText();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    if (!pushed.ok) return;
    expect(read(harness, "Note (2).md")).toContain("mine");
    expect(
      pushed.value.split("\n").filter((line) => line.startsWith("conflicted ")),
      pushed.value,
    ).toEqual([
      "conflicted update_item Note.md conflicted copy Note (2).md merged body",
    ]);
  });

  it("says in a watch the file a conflicted copy became, once it is one", async () => {
    const id = "01a00000-0000-7000-8000-0000000055a8";
    let door: FolderDoor | undefined;
    harness = await folderHarness("folder-conflict-watch-copy", {
      rows: {
        "core.note": [
          { item: { id, properties: { title: "Note", body: "as read\n" } } },
        ],
      },
      events: [copiesAsTheyArrive(() => door)],
    });
    scriptFolderWrites(harness, {
      door: (made) => {
        door = made;
      },
    });
    expect((await harness.folder.pull()).ok).toBe(true);
    door?.update(id, { properties: { body: "theirs\n" }, version: 1 });
    put(
      harness,
      "Note.md",
      read(harness, "Note.md").replace("as read", "mine"),
    );
    const watching = harness.folder.watchText();
    try {
      await vi.waitFor(
        () =>
          expect(watching.stdout, watching.stdout).toContain(
            "Note (2).md holds the text of the conflicted edit of Note.md",
          ),
        { timeout: 30_000, interval: 100 },
      );
    } finally {
      await watching.stop();
    }
    const said = watching.stdout
      .split("\n")
      .filter((line) => line.includes("conflicted"));
    expect(said, watching.stdout).toHaveLength(2);
    expect(said[0]).toMatch(
      /^conflicted update_item Note\.md conflicted copy [0-9a-f-]{36} merged body; it is not a file in this folder yet$/,
    );
    expect(said[1]).toBe(
      "Note (2).md holds the text of the conflicted edit of Note.md",
    );
  });

  it("says a conflicted edit while watching, and that its copy is not a file yet", async () => {
    const id = "01a00000-0000-7000-8000-0000000055d1";
    harness = await folderHarness("folder-conflict-watch", {
      rows: {
        "core.note": [
          {
            item: { id, properties: { title: "Note", body: "as read\n" } },
          },
        ],
      },
    });
    let door: FolderDoor | undefined;
    scriptFolderWrites(harness, {
      door: (made) => {
        door = made;
      },
    });
    expect((await harness.folder.pull()).ok).toBe(true);
    // Another machine changes the body the file carries, and the person
    // edits the file as it was read.
    door?.update(id, { properties: { body: "theirs\n" }, version: 1 });
    put(
      harness,
      "Note.md",
      read(harness, "Note.md").replace("as read", "mine"),
    );
    const watching = harness.folder.watchText();
    try {
      await vi.waitFor(
        () =>
          expect(watching.stdout).toContain("conflicted update_item Note.md"),
        { timeout: 20_000, interval: 100 },
      );
      // Passes enough for a line said at every one to show more than once.
      await new Promise((resolve) => setTimeout(resolve, 3_000));
    } finally {
      await watching.stop();
    }
    const said = watching.stdout
      .split("\n")
      .filter((line) => line.startsWith("conflicted "));
    expect(said, watching.stdout).toHaveLength(1);
    expect(said[0]).toMatch(
      /^conflicted update_item Note\.md conflicted copy [0-9a-f-]{36} merged body; it is not a file in this folder yet$/,
    );
    expect(door?.conflictedCopies()).toHaveLength(1);
  });

  it("says nothing for passes that only wait out a delete's grace", async () => {
    harness = await folderHarness("folder-grace-quiet");
    scriptFolderWrites(harness);
    put(harness, "going.md", "---\ntitle: Going\n---\nbody\n");
    put(harness, ".env", "TOKEN=not-a-real-one\n");
    expect((await harness.folder.push()).ok).toBe(true);
    // Gone before the watch starts, which journals it at its first pass, so
    // no pass of the watch races the removal.
    rmSync(join(harness.dir, "going.md"));
    const watching = harness.folder.watchText();
    let quiet = "";
    try {
      await vi.waitFor(
        () => expect(watching.stdout).toContain(".env: not taken"),
        { timeout: 20_000, interval: 100 },
      );
      quiet = watching.stdout;
      // Inside the grace, which is five seconds from the pass that finds the
      // file gone: every pass of it finds the file still gone.
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      expect(
        watching.stdout,
        "a pass that only waited out the grace was told",
      ).toBe(quiet);
      // The pass that sends the delete says so.
      await vi.waitFor(
        () =>
          expect(watching.stdout, watching.stdout).toMatch(
            /0 created, 0 updated, 0 renamed, 1 deleted/,
          ),
        { timeout: 20_000, interval: 100 },
      );
    } finally {
      await watching.stop();
    }
    expect(watching.stdout.split(".env: not taken").length - 1).toBe(1);
  });

  it("says a refused secret once while a delete waits out its grace and other passes report", async () => {
    harness = await folderHarness("folder-secret-grace-watch");
    scriptFolderWrites(harness);
    put(harness, "going.md", "---\ntitle: Going\n---\nbody\n");
    put(harness, ".env", "TOKEN=not-a-real-one\n");
    expect((await harness.folder.push()).ok).toBe(true);
    rmSync(join(harness.dir, "going.md"));
    const watching = harness.folder.watchText();
    try {
      await vi.waitFor(
        () => expect(watching.stdout).toContain(".env: not taken"),
        { timeout: 20_000, interval: 100 },
      );
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      // A pass that reports something, inside the grace, with the secret
      // still standing.
      put(harness, "fresh.md", "---\ntitle: Fresh\n---\nbody\n");
      await vi.waitFor(
        () =>
          expect(watching.stdout, watching.stdout).toMatch(
            /1 created, 0 updated/,
          ),
        { timeout: 20_000, interval: 100 },
      );
      await vi.waitFor(
        () =>
          expect(watching.stdout, watching.stdout).toMatch(
            /0 renamed, 1 deleted/,
          ),
        { timeout: 20_000, interval: 100 },
      );
    } finally {
      await watching.stop();
    }
    expect(
      watching.stdout.split(".env: not taken").length - 1,
      `a watch said the standing secret again at a pass that reported: ${watching.stdout}`,
    ).toBe(1);
  });

  const keptId = "01a00000-0000-7000-8000-0000000055a5";
  const otherId = "01a00000-0000-7000-8000-0000000055a6";

  /** A folder holding only the tagged note, whose copy also holds a note
   *  outside its search that a write of the device's own conflicts on. */
  async function conflictedElsewhere(label: string) {
    harness = await folderHarness(label, {
      settings: {
        search: { types: ["core.note"], filter: 'tags contains "kept"' },
      },
      rows: {
        "core.note": [
          {
            item: {
              id: keptId,
              properties: { title: "Kept", body: "as read\n" },
            },
            tags: ["kept"],
          },
          {
            item: {
              id: otherId,
              properties: { title: "Other", body: "as read\n" },
            },
          },
        ],
      },
    });
    let door: FolderDoor | undefined;
    scriptFolderWrites(harness, {
      door: (made) => {
        door = made;
      },
    });
    expect((await harness.folder.pull()).ok).toBe(true);
    door?.update(otherId, { properties: { body: "theirs\n" }, version: 1 });
    const queued = await harness.folder
      .device()
      .update(otherId, { properties: { body: "mine\n" }, version: 1 });
    expect(queued.ok, JSON.stringify(queued)).toBe(true);
    return door!;
  }

  it("does not name a conflict on a write that is no file of the folder's, in a push", async () => {
    const door = await conflictedElsewhere("folder-conflict-other-push");
    const pushed = await harness!.folder.pushText();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    if (!pushed.ok) return;
    // The witness: the write conflicted, and a drain answered it.
    expect(door.conflictedCopies()).toHaveLength(1);
    expect(pushed.value).not.toContain("conflicted");
    expect(pushed.value).not.toContain("not a file in this folder");
  });

  it("does not name a conflict on a write that is no file of the folder's, in a watch", async () => {
    const door = await conflictedElsewhere("folder-conflict-other-watch");
    const watching = harness!.folder.watchText();
    try {
      await vi.waitFor(() => expect(door.conflictedCopies()).toHaveLength(1), {
        timeout: 20_000,
        interval: 100,
      });
      // A pass that reports something, after the drain that answered it.
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      put(harness!, "fresh.md", "---\ntitle: Fresh\ntags: [kept]\n---\nbody\n");
      await vi.waitFor(
        () => expect(watching.stdout, watching.stdout).toMatch(/1 created/),
        { timeout: 20_000, interval: 100 },
      );
    } finally {
      await watching.stop();
    }
    expect(watching.stdout).not.toContain("conflicted");
    expect(watching.stdout).not.toContain("not a file in this folder");
  });

  it("says a refused secret in words once while watching", async () => {
    harness = await folderHarness("folder-secret-watch");
    scriptFolderWrites(harness);
    put(harness, ".env", "TOKEN=not-a-real-one\n");
    const watching = harness.folder.watchText();
    let quiet = "";
    try {
      await vi.waitFor(
        () => expect(watching.stdout).toContain(".env: not taken"),
        { timeout: 20_000, interval: 100 },
      );
      // Passes enough for a line said at every one to show more than once.
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      quiet = watching.stdout;
      // One arriving while it watches is said as it arrives.
      put(harness, "id_ed25519", "not a real key\n");
      await vi.waitFor(
        () => expect(watching.stdout).toContain("id_ed25519: not taken"),
        { timeout: 20_000, interval: 100 },
      );
    } finally {
      await watching.stop();
    }
    expect(
      quiet.split(".env: not taken").length - 1,
      `a watch said the same refused secret at every pass: ${quiet}`,
    ).toBe(1);
  });

  it("does not walk into a package", async () => {
    harness = await folderHarness("folder-package", {
      settings: {
        search: { types: ["core.note"] },
        first_placement: { "core.note": "Deck.key" },
      },
      rows: {
        "core.note": [
          {
            item: {
              id: "01a00000-0000-7000-8000-000000017011",
              properties: { title: "Placed", body: "made elsewhere\n" },
            },
          },
        ],
      },
    });
    scriptFolderWrites(harness);
    put(harness, "Deck.key/Data/slide.md", "---\ntitle: Slide\n---\nbody\n");
    put(
      harness,
      "Tool.APP/Contents/readme.md",
      "---\ntitle: Tool\n---\nbody\n",
    );
    put(harness, "Thing.mystery/inner.md", "---\ntitle: Marked\n---\nbody\n");
    // The Finder's bundle bit: a package by the system's word, not its name.
    // Only macOS has one, so elsewhere the directory is an ordinary one and
    // its file is walked into like any other.
    const marked = process.platform === "darwin";
    if (marked) {
      const info = Buffer.alloc(32);
      info[8] = 0x20;
      execFileSync("xattr", [
        "-wx",
        "com.apple.FinderInfo",
        info.toString("hex"),
        join(harness.dir, "Thing.mystery"),
      ]);
    }
    put(harness, "notes/note.md", "---\ntitle: Note\n---\nbody\n");
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    if (!pushed.ok) return;
    expect(
      sentTitles(harness).sort(),
      "a file inside a package was sent as a note, so a presentation or an app reaches the server piece by piece",
    ).toEqual(marked ? ["Note"] : ["Marked", "Note"]);
    expect(
      pushed.value.scan.directories.map((dir) => [dir.path, dir.flag]).sort(),
      "a package the folder did not walk into was not reported, so its files are missing without a word",
    ).toEqual([
      ["Deck.key", "package"],
      ...(marked ? [["Thing.mystery", "package"]] : []),
      ["Tool.APP", "package"],
    ]);
    expect(
      existsSync(join(harness.dir, "Deck.key", "Placed.md")),
      "the pull wrote a file inside a package",
    ).toBe(false);
    expect(pushed.value.pull?.outside).toBe(1);
  });

  it("holds the files of a directory it cannot read, and goes on with the rest", async () => {
    let changed: Record<string, unknown> = {};
    harness = await folderHarness("folder-unreadable-dir", {
      events: [
        copyLiveReplay("1", []),
        (): Answer =>
          copyLiveReplay("2", [copyItemEvent("2", "item.updated", changed)]),
        copyLiveReplay("2", []),
      ],
    });
    scriptFolderWrites(harness);
    put(harness, "locked/inner.txt", "inner text\n");
    put(harness, "gone.md", "---\ntitle: Gone\n---\nbody\n");
    expect((await harness.folder.push()).ok).toBe(true);
    const inner = sentCreates(harness).find(
      (create) =>
        (create.properties as Record<string, unknown>).body === "inner text\n",
    );
    expect(inner).toBeDefined();
    // Changed elsewhere, so the pull tries to write a file it cannot reach.
    changed = wireItem({
      id: String(inner?.id),
      version: 2,
      properties: {
        ...(inner?.properties as Record<string, unknown>),
        body: "changed elsewhere\n",
      },
    });
    const locked = join(harness.dir, "locked");
    chmodSync(locked, 0o000);
    try {
      // The witness: a file taken away in the same scan is journaled.
      rmSync(join(harness.dir, "gone.md"));
      put(harness, "after.md", "---\ntitle: After\n---\nbody\n");
      const pushed = await harness.folder.push();
      expect(
        pushed.ok,
        `one directory the walk could not read stopped the scan of every other: ${JSON.stringify(pushed)}`,
      ).toBe(true);
      if (!pushed.ok) return;
      expect(sentTitles(harness)).toContain("After");
      expect(
        pushed.value.scan.directories.map((dir) => [dir.path, dir.flag]),
      ).toEqual([["locked", "unreadable"]]);
      expect(
        [pushed.value.scan.missing, pushed.value.scan.unreached],
        "a file in a directory the walk could not read was journaled as deleted, and its item goes to the bin",
      ).toEqual([1, 1]);
      expect(pushed.value.pull?.unwritten).toBe(1);
    } finally {
      chmodSync(locked, 0o755);
    }
    const readable = await harness.folder.scan();
    expect(readable.ok, JSON.stringify(readable)).toBe(true);
    if (!readable.ok) return;
    expect(
      [readable.value.unreached, readable.value.created],
      "the file lost its binding when the pull could not write it, and came back as a second item",
    ).toEqual([0, 0]);
    expect((await harness.folder.push()).ok).toBe(true);
    expect(read(harness, "locked/inner.txt")).toBe("changed elsewhere\n");
  });

  it("treats names differing only in case or Unicode form as one", async () => {
    const composed = "R\u00e9sum\u00e9";
    const decomposed = "Re\u0301sume\u0301";
    const cafe = "01a00000-0000-7000-8000-000000017025";
    const pairs = [
      ["01a00000-0000-7000-8000-000000017021", "Plan"],
      ["01a00000-0000-7000-8000-000000017022", "plan"],
      ["01a00000-0000-7000-8000-000000017023", composed],
      ["01a00000-0000-7000-8000-000000017024", decomposed],
    ];
    harness = await folderHarness("folder-one-name", {
      rows: {
        "core.note": [...pairs, [cafe, "Caf\u00e9"]].map(([id, title]) => ({
          item: { id, properties: { title, body: `${title}\n` } },
        })),
      },
    });
    const edges = new EdgeDoor();
    scriptFolderWrites(harness, { edges });
    const pulled = await harness.folder.pull();
    expect(pulled.ok, JSON.stringify(pulled)).toBe(true);
    if (!pulled.ok) return;
    const files = readdirSync(harness.dir).filter((name) =>
      name.endsWith(".md"),
    );
    for (const [id, title] of pairs) {
      expect(
        files.filter((name) => idIn(harness!, name) === id),
        `${title} has no file of its own: two names differing only in case or form were given as two paths, and one disk holds them as one file`,
      ).toHaveLength(1);
    }
    expect([pulled.value.beside, pulled.value.unwritten]).toEqual([2, 0]);

    // A line and a link typed in another case and form name the item all
    // the same.
    put(
      harness,
      "Link.md",
      '---\ntitle: Link\nabout: "[[CAFE\u0301]]"\n---\nsee [[CAFE\u0301]]\n',
    );
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    if (!pushed.ok) return;
    expect(pushed.value.scan.flagged).toEqual([]);
    const link = idIn(harness, "Link.md");
    expect(sentEdgeWrites(harness).sort()).toEqual([
      `create ${link} about ${cafe}`,
      `create ${link} references ${cafe}`,
    ]);
  });

  it("keeps its own state in .marfa and never pushes it", async () => {
    // An include line naming `.marfa/` takes nothing under it either.
    harness = await folderHarness("folder-state", {
      settings: { search: { types: ["core.note"] }, include: [".marfa/", "*"] },
    });
    scriptFolderWrites(harness);
    put(harness, "note.md", "---\ntitle: A note\n---\nbody\n");
    put(harness, ".marfa/stray.md", "---\ntitle: Stray\n---\nbody\n");
    expect((await harness.folder.push()).ok).toBe(true);

    expect(
      existsSync(settingsFile(harness)),
      "the folder keeps its settings somewhere other than its own directory, so the directory is not the whole of it",
    ).toBe(true);
    expect(
      existsSync(join(harness.dir, ".marfa", "core.sqlite")),
      "the folder keeps its working copy and queue somewhere other than its own directory",
    ).toBe(true);
    expect(
      sentTitles(harness),
      "the folder pushed its own state, so its mapping and its queue are items on the server",
    ).toEqual(["A note"]);
  });

  it("refuses to write a file outside the folder", async () => {
    const elsewhere = mkdtempSync(join(tmpdir(), "marfa-folder-elsewhere-"));
    harness = await folderHarness("folder-outside", {
      rows: {
        "core.note": [
          {
            item: {
              id: "01a00000-0000-7000-8000-00000000000e",
              properties: { title: "note", body: "body\n" },
            },
          },
          // The control. A guard that refuses everything satisfies the
          // assertions below, and a pull that writes nothing at all is the
          // plausible way to write one.
          {
            item: {
              id: "01a00000-0000-7000-8000-00000000000f",
              properties: { title: "ordinary", body: "body\n" },
            },
          },
          // The link that points back in: a write through it lands on
          // another file and truncates it.
          {
            item: {
              id: "01a00000-0000-7000-8000-000000000010",
              properties: { title: "alias", body: "written through a link\n" },
            },
          },
        ],
      },
    });
    scriptFolderWrites(harness);
    writeFileSync(
      join(harness.dir, "kept.md"),
      "---\ntitle: Kept\n---\nmine\n",
    );
    symlinkSync(join(harness.dir, "kept.md"), join(harness.dir, "alias.md"));
    const first = await harness.folder.pull();
    expect(first.ok, JSON.stringify(first)).toBe(true);
    if (!first.ok) return;
    expect(
      first.value.written,
      "the pull wrote nothing at all, so a guard that refuses every path would satisfy everything below",
    ).toBeGreaterThan(0);
    expect(
      read(harness, "kept.md"),
      "an item was written through a link pointing back into the folder, so it truncated a file that belonged to another item",
    ).toContain("mine");
    expect(first.value.outside).toBe(1);
    expect(first.value.flagged).toContainEqual({
      path: "alias.md",
      flag: "outside",
      reason: "the path leads out of the folder",
      item: "01a00000-0000-7000-8000-000000000010",
    });

    // The note moves into a directory, which is then replaced by a link out
    // of the folder. The walk never descends the link, and the pull must not
    // write through it.
    mkdirSync(join(harness.dir, "out"));
    renameSync(
      join(harness.dir, "note.md"),
      join(harness.dir, "out", "note.md"),
    );
    const moved = await harness.folder.scan();
    expect(moved.ok && moved.value.renamed).toBe(1);
    renameSync(join(harness.dir, "out"), join(harness.dir, "out-real"));
    symlinkSync(elsewhere, join(harness.dir, "out"));
    const pulled = await harness.folder.pull();
    expect(pulled.ok, JSON.stringify(pulled)).toBe(true);
    if (!pulled.ok) return;
    expect(
      existsSync(join(elsewhere, "note.md")),
      "a file landed outside the folder, where nothing the folder does will ever find it again",
    ).toBe(false);
    expect(
      pulled.value.outside,
      "the folder declined to write out of itself and said nothing about it, so the item has no file and the report reads as though it does",
    ).toBe(2);
  });

  it("does not write over a file it never wrote", async () => {
    harness = await folderHarness("folder-unbound-file", {
      rows: {
        "core.note": [
          {
            item: {
              id: "01a00000-0000-7000-8000-000000000011",
              properties: { title: "note", body: "the item\n" },
            },
          },
          {
            item: {
              id: "01a00000-0000-7000-8000-000000000012",
              properties: { title: "other", body: "the other item\n" },
            },
          },
        ],
      },
    });
    scriptFolderWrites(harness);
    // A note made and not yet scanned. `folders pull` runs no scan of its
    // own, so this is a person who typed something and then pulled.
    put(harness, "note.md", "---\ntitle: Mine\n---\nan afternoon of it\n");

    const pulled = await harness.folder.pull();
    expect(
      pulled.ok,
      `the folder could not pull: ${JSON.stringify(pulled)}`,
    ).toBe(true);
    if (!pulled.ok) return;
    expect(
      pulled.value.written,
      "the pull wrote nothing at all, so a folder that never writes would satisfy everything below",
    ).toBeGreaterThan(0);
    expect(
      read(harness, "note.md"),
      "the pull wrote an item over a file the folder had never written, so an afternoon's typing went with no queue row and no line in the report",
    ).toContain("an afternoon of it");
    expect(
      pulled.value.unwritten,
      "the folder left the file alone and said nothing about it, so the item it could not write reads as an ordinary quiet pull",
    ).toBeGreaterThan(0);
    expect(pulled.value.flagged).toContainEqual({
      path: "note.md",
      flag: "unwritten",
      reason: "a file the folder did not write is at the path",
      item: "01a00000-0000-7000-8000-000000000011",
    });

    // The next scan pushes the file as a new item, and never as the item
    // that wanted its path.
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    expect(sentTitles(harness)).toEqual(["Mine"]);
    expect(
      sentUpdates(harness),
      "the file went to the item that wanted its path",
    ).toEqual([]);
    expect(read(harness, "note.md")).toContain("an afternoon of it");
  });

  it("takes back a file of its own the mapping had lost", async () => {
    const rows = {
      "core.note": [
        {
          item: {
            id: "01a00000-0000-7000-8000-000000000013",
            properties: { title: "note", body: "the item\n" },
          },
        },
      ],
    };
    harness = await folderHarness("folder-recover-a", { rows });
    scriptFolderWrites(harness);
    expect((await harness.folder.pull()).ok).toBe(true);
    // The bytes this item renders to, which only this item can render: the
    // render carries its id. A second folder on the same item stands in for
    // the folder whose mapping lost the file — a write that made the file and
    // failed before the bytes landed unbinds exactly this way.
    const bytes = read(harness, "note.md");
    expect(bytes, "the first folder wrote nothing to copy").toContain(
      "01a00000-0000-7000-8000-000000000013",
    );

    second = await folderHarness("folder-recover-b", { rows });
    scriptFolderWrites(second);
    writeFileSync(join(second.dir, "note.md"), bytes);
    const pulled = await second.folder.pull();
    expect(
      pulled.ok,
      `the folder could not pull: ${JSON.stringify(pulled)}`,
    ).toBe(true);
    if (!pulled.ok) return;
    expect(
      pulled.value.unwritten,
      "the folder refused its own file because the mapping had lost it, so the item has no file and will never be given one",
    ).toBe(0);
    expect(
      pulled.value.unchanged,
      "the folder neither wrote the file nor took it back, so the assertion below is about a binding nothing made",
    ).toBe(1);

    // The binding is what this is for: without it the next scan makes the
    // file a second item.
    const scanned = await second.folder.scan();
    expect(scanned.ok).toBe(true);
    if (!scanned.ok) return;
    expect(
      scanned.value.created,
      "the file the folder had written became a second item, because nothing bound it back",
    ).toBe(0);
  });

  it("leaves a file outside its search alone", async () => {
    harness = await folderHarness("folder-outside-slice", {
      settings: { search: { types: ["core.note"] } },
      rows: {
        "core.note": [
          {
            item: {
              id: "01a00000-0000-7000-8000-00000000000a",
              properties: { title: "served", body: "in the slice\n" },
            },
          },
          // An item of a type this folder does not hold, arriving through
          // the same page. Without one the pull's own slice rule is never
          // exercised, and the assertion below is about the push half only.
          {
            item: {
              id: "01a00000-0000-7000-8000-00000000000b",
              type: "core.bookmark",
              properties: { title: "outside", body: "not in the slice\n" },
            },
          },
        ],
      },
    });
    scriptFolderWrites(harness);
    // A file the folder does not carry: not a document, so not a note.
    put(harness, "photo.png", "not text at all");
    put(harness, "inside.md", "---\ntitle: Inside\n---\nin the slice\n");
    // A document is pushed whatever type its line names.
    put(
      harness,
      "typed.md",
      "---\ntitle: Typed\ntype: core.bookmark\n---\nnamed outside\n",
    );
    const pushed = await harness.folder.push();
    expect(pushed.ok).toBe(true);
    if (!pushed.ok) return;
    expect(
      pushed.value.scan.skipped,
      "a file outside the folder's slice was pushed as a note, so anything dropped in the directory becomes an item of whatever type the folder defaults to",
    ).toBe(1);
    expect(
      sentCreates(harness).map((sent) => [
        (sent.properties as Record<string, unknown>).title,
        sent.type,
      ]),
      "the file outside the slice reached the server, or a document naming a type outside it did not",
    ).toEqual([
      ["Inside", "core.note"],
      ["Typed", "core.bookmark"],
    ]);
    expect(
      pushed.value.pull?.unmatched,
      "a document pushed as a type the search does not hold was not flagged outside it",
    ).toBe(1);
    expect(
      readFileSync(join(harness.dir, "photo.png"), "utf8"),
      "the folder rewrote a file it does not carry",
    ).toBe("not text at all");

    // The pull half: an item outside the slice does not become a file.
    expect(
      existsSync(join(harness.dir, "outside.md")),
      "an item of a type this folder does not hold became a file in it, so a folder declaring one type writes every type it is sent",
    ).toBe(false);
    expect(
      pushed.value.pull?.skipped,
      "the pull reported skipping nothing, so the absence above is a pull that wrote nothing at all",
    ).toBeGreaterThan(0);
    expect(
      existsSync(join(harness.dir, "served.md")),
      "the item inside the slice did not become a file either, so the folder is writing nothing rather than choosing",
    ).toBe(true);
  });
});

describe("large removals, status and size", () => {
  const noteRow = (n: number) => ({
    item: {
      id: `01a00000-0000-7000-8000-0000000004${String(n).padStart(2, "0")}`,
      version: 1,
      properties: { title: `Note ${String(n)}`, body: "body\n" },
    },
  });
  const deletes = (h: FolderHarness) =>
    h.server.requests.filter(
      (request) =>
        request.method === "DELETE" &&
        /^\/items\/[^/]+$/.test(request.pathname),
    );
  const grace = () => new Promise((resolve) => setTimeout(resolve, 6_000));

  /** Six notes pushed, then three deleted from the disk. */
  async function sixLessThree(
    label: string,
    settings?: Record<string, unknown>,
  ): Promise<FolderHarness> {
    const made = await folderHarness(label, settings ? { settings } : {});
    scriptFolderWrites(made);
    for (let n = 0; n < 6; n += 1) {
      put(
        made,
        `note-${String(n)}.md`,
        `---\ntitle: Note ${String(n)}\n---\nbody\n`,
      );
    }
    expect((await made.folder.push()).ok).toBe(true);
    for (let n = 0; n < 3; n += 1) {
      rmSync(join(made.dir, `note-${String(n)}.md`));
    }
    return made;
  }

  const tight = {
    search: { types: ["core.note"] },
    defaults: { type: "core.note" },
    removal_threshold: { files: 2, fraction: 0.25 },
  };

  it("pauses a large removal made on disk", async () => {
    // The witness: at the default threshold three of six is no large
    // removal, and the deletes go once the grace runs out.
    const plain = await sixLessThree("folder-removal-plain");
    expect((await plain.folder.push()).ok).toBe(true);
    await grace();
    expect((await plain.folder.push()).ok).toBe(true);
    expect(deletes(plain)).toHaveLength(3);
    await plain.stop();

    harness = await sixLessThree("folder-removal-disk", tight);
    const first = await harness.folder.push();
    expect(first.ok && first.value.scan.paused).toBe(3);
    await grace();
    const later = await harness.folder.push();
    expect(later.ok && later.value.scan.paused).toBe(3);
    expect(
      deletes(harness),
      "a removal past the threshold was sent without being confirmed",
    ).toEqual([]);
    const said = await harness.folder.pushText();
    expect(said.ok && said.value).toContain(
      "a large removal waits: 3 delete(s) not sent",
    );
  });

  it("says a paused removal once while watching", async () => {
    harness = await sixLessThree("folder-removal-watch", tight);
    const watching = harness.folder.watchText();
    try {
      await vi.waitFor(
        () => expect(watching.stdout).toContain("a large removal waits"),
        { timeout: 20_000, interval: 100 },
      );
      // Passes enough for a line said at every one to show more than once.
      await new Promise((resolve) => setTimeout(resolve, 4_000));
    } finally {
      await watching.stop();
    }
    expect(
      watching.stdout.split("a large removal waits").length - 1,
      `a watch said the same paused removal at every pass: ${watching.stdout}`,
    ).toBe(1);
    expect(deletes(harness)).toEqual([]);
  });

  it("follows the settings' removal threshold", async () => {
    // More than one file and more than a tenth of the folder: two of six
    // pass it where three of six passed the tighter setting above.
    harness = await sixLessThree("folder-removal-threshold", {
      ...tight,
      removal_threshold: { files: 1, fraction: 0.1 },
    });
    put(harness, "note-0.md", "---\ntitle: Note 0\n---\nbody\n");
    const pushed = await harness.folder.push();
    expect(pushed.ok && pushed.value.scan.paused).toBe(2);
  });

  it("lets a paused removal go once confirmed, or puts it back", async () => {
    harness = await sixLessThree("folder-removal-confirm", tight);
    expect((await harness.folder.push()).ok).toBe(true);
    const confirmed = await harness.folder.confirm();
    expect(confirmed.ok && confirmed.value.deleted).toBe(3);
    expect((await harness.folder.push()).ok).toBe(true);
    expect(deletes(harness)).toHaveLength(3);
    await harness.stop();

    harness = await sixLessThree("folder-removal-restore", tight);
    expect((await harness.folder.push()).ok).toBe(true);
    const restored = await harness.folder.restore();
    expect(restored.ok && restored.value.put_back).toBe(3);
    for (let n = 0; n < 3; n += 1) {
      expect(existsSync(join(harness.dir, `note-${String(n)}.md`))).toBe(true);
    }
    await grace();
    expect((await harness.folder.push()).ok).toBe(true);
    expect(deletes(harness), "a removal put back was still sent").toEqual([]);
  });

  it("pauses a large removal from another device", async () => {
    const rows = [0, 1, 2, 3, 4, 5].map(noteRow);
    const trashed = rows
      .slice(0, 3)
      .map((row, at) =>
        copyItemEvent(
          String(at + 2),
          "item.deleted",
          wireItem({ ...row.item, state: "trashed" }),
        ),
      );
    const departing = (label: string, settings?: Record<string, unknown>) =>
      folderHarness(label, {
        rows: { "core.note": rows },
        events: [copyReplay("4", trashed)],
        ...(settings ? { settings } : {}),
      });
    // The witness: at the default threshold the three files are taken away.
    const plain = await departing("folder-removal-pull-plain");
    scriptFolderWrites(plain);
    expect((await plain.folder.pull()).ok).toBe(true);
    expect((await plain.folder.device().catchUp()).ok).toBe(true);
    const taken = await plain.folder.pull();
    expect(taken.ok && taken.value.removed).toBe(3);
    await plain.stop();

    harness = await departing("folder-removal-pull", tight);
    scriptFolderWrites(harness);
    expect((await harness.folder.pull()).ok).toBe(true);
    expect((await harness.folder.device().catchUp()).ok).toBe(true);
    const held = await harness.folder.pull();
    expect(held.ok && [held.value.removed, held.value.paused]).toEqual([0, 3]);
    expect(
      readdirSync(harness.dir).filter((name) => name.endsWith(".md")),
    ).toHaveLength(6);
    const status = await harness.folder.status();
    expect(status.ok && status.value.paused).toEqual({ disk: 0, pull: 3 });
  });

  it("lets a paused file whose item left by state go when the removal is put back, rather than journaling it again", async () => {
    const rows = [0, 1, 2, 3, 4, 5].map(noteRow);
    harness = await folderHarness("folder-removal-restore-departed", {
      rows: { "core.note": rows },
      events: [
        copyReplay("2", [
          copyItemEvent(
            "2",
            "item.state_changed",
            wireItem({ ...rows[0]!.item, state: "archived" }),
          ),
        ]),
      ],
      settings: { ...tight, search: { ...tight.search, state: ["active"] } },
    });
    scriptFolderWrites(harness);
    expect((await harness.folder.pull()).ok).toBe(true);
    for (let n = 0; n < 3; n += 1) {
      rmSync(join(harness.dir, `Note ${String(n)}.md`));
    }
    const paused = await harness.folder.scan();
    expect(paused.ok && paused.value.paused).toBe(3);
    // Another device archives one of the three, which the search leaves out.
    const caught = await harness.folder.device().catchUp();
    expect(caught.ok ? caught.value.applied : 0).toBe(1);
    const restored = await harness.folder.restore();
    expect(restored.ok, JSON.stringify(restored)).toBe(true);
    if (!restored.ok) return;
    // The witness: the two the search still holds are written back.
    for (const n of [1, 2]) {
      expect(existsSync(join(harness.dir, `Note ${String(n)}.md`))).toBe(true);
    }
    expect(
      restored.value.put_back,
      "restore counted as put back a file no pull will write, since the search no longer holds its item's state",
    ).toBe(2);
    expect(existsSync(join(harness.dir, "Note 0.md"))).toBe(false);
    // The file that left for good took its placement with it, and the two put
    // back kept theirs.
    const placing = await harness.folder.device().queue();
    expect(
      placing.ok &&
        placing.value
          .filter((row) => row.kind === "delete_edge")
          .map((row) => row.item_id),
      "restore let a file go without ending its item's placement",
    ).toEqual([rows[0]!.item.id]);

    await grace();
    const later = await harness.folder.scan();
    expect(later.ok).toBe(true);
    if (!later.ok) return;
    expect(
      [later.value.missing, later.value.paused, later.value.deleted],
      "the file restore put back was journaled again at the next scan",
    ).toEqual([0, 0, 0]);
    const queued = await harness.folder.device().queue();
    expect(
      queued.ok && queued.value.filter((row) => row.kind === "delete_item"),
    ).toEqual([]);
  });

  it("warns of a text near the limit", async () => {
    const largeType = "user.large_text";
    harness = await folderHarness("folder-size", {
      settings: {
        search: { types: ["core.note", largeType] },
        defaults: { type: largeType },
      },
      catalog: typeCatalog([
        wireType(largeType, {
          bodyField: "body",
          fields: {
            title: { type: "string" },
            body: { type: "string", required: true, maxLength: 1_000_000 },
          },
        }),
      ]),
    });
    scriptFolderWrites(harness);
    put(harness, "small.md", "---\ntitle: Small\n---\nbody\n");
    put(
      harness,
      "large.md",
      `---\ntitle: Large\n---\n${"x".repeat(960_000)}\n`,
    );
    put(
      harness,
      "default.md",
      `---\ntype: core.note\ntitle: Default\n---\n${"x".repeat(100_001)}\n`,
    );
    const scanned = await harness.folder.scan();
    expect(scanned.ok).toBe(true);
    if (!scanned.ok) return;
    expect(scanned.value.created).toBe(2);
    expect(scanned.value.flagged.map((file) => file.path)).toEqual([
      "default.md",
    ]);
    expect(scanned.value.flagged[0]?.reason).toContain("body");
    expect(scanned.value.flagged[0]?.reason).toContain("100000");
    expect(
      scanned.value.warnings.map((file) => [file.path, file.flag]),
      "a text near the server's limit went without a warning, or a small one was warned of",
    ).toEqual([["large.md", "size"]]);
    const status = await harness.folder.status();
    expect(status.ok).toBe(true);
    if (!status.ok) return;
    const warned = (path: string) =>
      status.value.files.find((file) => file.path === path)?.warning;
    expect(
      warned("large.md"),
      "the status did not name the text near the limit",
    ).toMatch(/\d/);
    expect(warned("small.md")).toBeUndefined();
    // A push says it in words for the file its own scan takes.
    put(
      harness,
      "later.md",
      `---\ntitle: Later\n---\n${"y".repeat(960_000)}\n`,
    );
    const said = await harness.folder.pushText();
    expect(
      said.ok && said.value,
      "a push did not say the warning in words",
    ).toMatch(/later\.md: .*\d/);
  });

  it("reports each file's status", async () => {
    harness = await folderHarness("folder-status");
    scriptFolderWrites(harness);
    put(harness, "steady.md", "---\ntitle: Steady\n---\nbody\n");
    expect((await harness.folder.push()).ok).toBe(true);
    put(harness, "queued.md", "---\ntitle: Queued\n---\nbody\n");
    put(harness, "broken.md", "---\ntitle: [unclosed\n---\nbody\n");
    put(harness, "bogus.md", "---\ntitle: Bogus\ntier: bogus\n---\nbody\n");
    expect((await harness.folder.scan()).ok).toBe(true);
    const status = await harness.folder.status();
    expect(status.ok, JSON.stringify(status)).toBe(true);
    if (!status.ok) return;
    const of = (path: string) =>
      status.value.files.find((file) => file.path === path);
    expect(of("steady.md")?.status).toBe("in_step");
    expect(of("queued.md")?.status).toBe("waiting");
    expect(of("queued.md")?.waits).toContain("create");
    expect([of("broken.md")?.status, of("broken.md")?.flag]).toEqual([
      "held",
      "unreadable",
    ]);
    // Its YAML parses, but no item can hold that tier.
    expect([of("bogus.md")?.status, of("bogus.md")?.flag]).toEqual([
      "held",
      "unreadable",
    ]);
    expect(status.value.paused).toEqual({ disk: 0, pull: 0 });
  });
});

describe("reading only what changed", () => {
  const settle = () => new Promise((resolve) => setTimeout(resolve, 3_000));
  const idOf = (h: FolderHarness, name: string) =>
    /^marfa_id: "?([^"\n]+)"?$/m.exec(read(h, name))?.[1] ?? "";

  /** Two notes in step and a watch past its first pass; `kept.md` is then
   *  edited at the same size with its modification time put back, and
   *  `edited.md` edited the same way but with the time left moved. */
  async function editedUnderWatch(label: string): Promise<FolderHarness> {
    const made = await folderHarness(label);
    scriptFolderWrites(made);
    put(made, "kept.md", "---\ntitle: Kept\n---\nfirst\n");
    put(made, "edited.md", "---\ntitle: Edited\n---\nfirst\n");
    expect((await made.folder.push()).ok).toBe(true);
    const updates = sentUpdates(made).length;
    const watching = made.folder.watch();
    try {
      await settle();
      const kept = join(made.dir, "kept.md");
      const time = join(mkdtempSync(join(tmpdir(), "marfa-time-")), "time");
      execFileSync("touch", ["-r", kept, time]);
      writeFileSync(kept, read(made, "kept.md").replace("first", "FIRST"));
      execFileSync("touch", ["-r", time, kept]);
      put(made, "edited.md", read(made, "edited.md").replace("first", "FIRST"));
      await vi.waitFor(
        () => expect(sentUpdates(made).length).toBeGreaterThan(updates),
        { timeout: 20_000, interval: 100 },
      );
      await settle();
    } finally {
      await watching.stop();
    }
    return made;
  }

  it("does not reread an unchanged file", async () => {
    harness = await editedUnderWatch("folder-quick-pass");
    const sent = sentUpdates(harness).map((update) => update.id);
    // The witness: the edit whose time moved was read and sent.
    expect(sent).toContain(idOf(harness, "edited.md"));
    expect(
      sent,
      "a watch reread a file whose size and time had not changed",
    ).not.toContain(idOf(harness, "kept.md"));
  });

  it("finds a missed change on its full pass", async () => {
    harness = await editedUnderWatch("folder-full-pass");
    const kept = idOf(harness, "kept.md");
    expect(sentUpdates(harness).map((update) => update.id)).not.toContain(kept);
    expect((await harness.folder.push()).ok).toBe(true);
    const sent = sentUpdates(harness).filter((update) => update.id === kept);
    expect(
      sent,
      "a full pass missed a change that left the size and time as they were",
    ).toHaveLength(1);
    expect(JSON.stringify(sent[0]?.body)).toContain("FIRST");
  });

  it("tells a copy from its unread original on a quick pass", async () => {
    harness = await folderHarness("folder-quick-copy");
    scriptFolderWrites(harness);
    put(harness, "note.md", "---\ntitle: Note\n---\nthe original\n");
    expect((await harness.folder.push()).ok).toBe(true);
    const id = idOf(harness, "note.md");
    const watching = harness.folder.watch();
    try {
      await settle();
      writeFileSync(join(harness.dir, "copy.md"), read(harness, "note.md"));
      await vi.waitFor(() => expect(sentCreates(harness!)).toHaveLength(2), {
        timeout: 20_000,
        interval: 100,
      });
      await settle();
    } finally {
      await watching.stop();
    }
    const copy = String(sentCreates(harness)[1]?.id);
    expect(
      copy,
      "the copy took the original's item while the original went unread",
    ).not.toBe(id);
    expect(idOf(harness, "copy.md")).toBe(copy);
    expect(idOf(harness, "note.md")).toBe(id);
    expect(sentUpdates(harness)).toEqual([]);
  });
});

describe("a file's permission", () => {
  const runs = (h: FolderHarness, name: string) =>
    (statSync(join(h.dir, name)).mode & 0o100) !== 0;

  it("keeps a file's executable permission", async () => {
    harness = await folderHarness("folder-executable-push", {
      settings: { search: { types: ["core.note", "core.file"] } },
    });
    scriptFolderWrites(harness);
    acceptUploads(harness.server);
    writeFileSync(join(harness.dir, "run.sh"), "#!/bin/sh\necho run\n");
    chmodSync(join(harness.dir, "run.sh"), 0o755);
    writeFileSync(join(harness.dir, "data.bin"), Buffer.from([1, 2, 3]));
    chmodSync(join(harness.dir, "data.bin"), 0o644);
    expect((await harness.folder.push()).ok).toBe(true);
    const created = (title: string) =>
      sentCreates(harness!).find(
        (create) =>
          (create.properties as Record<string, unknown>).title === title,
      );
    expect(
      (created("run.sh")?.properties as Record<string, unknown>).executable,
      "a file its owner may run went without its permission",
    ).toBe(true);
    // The witness: a file its owner may not run carries no property.
    expect(created("data.bin")?.properties).not.toHaveProperty("executable");

    // Changed alone, under a watch past its first pass.
    const watching = harness.folder.watch();
    try {
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      chmodSync(join(harness.dir, "run.sh"), 0o644);
      chmodSync(join(harness.dir, "data.bin"), 0o755);
      await vi.waitFor(() => expect(sentUpdates(harness!)).toHaveLength(2), {
        timeout: 20_000,
        interval: 100,
      });
    } finally {
      await watching.stop();
    }
    const sent = Object.fromEntries(
      sentUpdates(harness).map((update) => [
        update.id,
        (update.body.properties as Record<string, unknown>).executable,
      ]),
    );
    expect(sent).toEqual({
      [String(created("run.sh")?.id)]: false,
      [String(created("data.bin")?.id)]: true,
    });
    expect(sentUpdates(harness)).toHaveLength(2);
  });

  it("gives a pulled file the permission its item holds", async () => {
    const tool = "01a00000-0000-7000-8000-00000000f501";
    const plain = "01a00000-0000-7000-8000-00000000f502";
    const later = "01a00000-0000-7000-8000-00000000f503";
    const fileItem = (
      id: string,
      title: string,
      bytes: Buffer,
      extra: Record<string, unknown> = {},
    ) => ({
      id,
      version: 1,
      type: "core.file",
      properties: {
        title,
        blob_ref: hashOf(bytes),
        mime_type: "application/octet-stream",
        ...extra,
      },
    });
    const [toolBytes, plainBytes, laterBytes] = [1, 2, 3].map((n) =>
      Buffer.from([n, n, n]),
    );
    harness = await folderHarness("folder-executable-pull", {
      settings: { search: { types: ["core.file"] } },
      rows: {
        "core.file": [
          { item: fileItem(tool, "tool.bin", toolBytes, { executable: true }) },
          { item: fileItem(plain, "plain.bin", plainBytes) },
          { item: fileItem(later, "later.bin", laterBytes) },
        ],
      },
      events: [
        copyLiveReplay("3", [
          copyItemEvent(
            "2",
            "item.updated",
            wireItem({
              ...fileItem(later, "later.bin", laterBytes, { executable: true }),
              version: 2,
            }),
          ),
          copyItemEvent(
            "3",
            "item.updated",
            wireItem({
              ...fileItem(tool, "tool.bin", toolBytes, { executable: false }),
              version: 2,
            }),
          ),
        ]),
      ],
    });
    scriptFolderWrites(harness);
    for (const bytes of [toolBytes, plainBytes, laterBytes]) {
      scriptBlob(harness.server, bytes);
    }
    expect((await harness.folder.pull()).ok).toBe(true);
    expect(runs(harness, "tool.bin"), "a pulled file lost its permission").toBe(
      true,
    );
    // The witness: an item that says nothing is written as not run.
    expect(runs(harness, "plain.bin")).toBe(false);
    expect(runs(harness, "later.bin")).toBe(false);

    // The push's catch-up brings the changes, and its pull gives them to
    // the files in place, sending nothing back.
    expect((await harness.folder.push()).ok).toBe(true);
    expect(
      [runs(harness, "later.bin"), runs(harness, "tool.bin")],
      "a permission changed elsewhere did not reach the file in place",
    ).toEqual([true, false]);
    expect(runs(harness, "plain.bin")).toBe(false);
    expect((await harness.folder.push()).ok).toBe(true);
    expect(sentUpdates(harness)).toEqual([]);

    // Changed by the person since the scan read it, the permission is theirs:
    // a pull leaves it, and the next push sends it.
    chmodSync(join(harness.dir, "plain.bin"), 0o755);
    expect((await harness.folder.pull()).ok).toBe(true);
    expect(
      runs(harness, "plain.bin"),
      "a pull undid the person's permission",
    ).toBe(true);
    expect((await harness.folder.push()).ok).toBe(true);
    expect(
      sentUpdates(harness).map((update) => [
        update.id,
        (update.body.properties as Record<string, unknown>).executable,
      ]),
    ).toEqual([[plain, true]]);
  });
});

describe("a folder that cannot reach the server", () => {
  it("says once that a watch cannot reach the server, and once that it can again", async () => {
    // Every stream ends as it opens, so the follow asks again while the
    // server is away, as the watch's passes do.
    harness = await folderHarness("folder-watch-reach", {
      events: [copyHeadRead("1")],
    });
    scriptFolderWrites(harness);
    const watching = harness.folder.watchText();
    const said = (text: string) => watching.stdout.split(text).length - 1;
    try {
      await vi.waitFor(() => expect(watching.stderr).toContain("watching"), {
        timeout: 20_000,
        interval: 100,
      });
      await harness.server.offline();
      put(harness, "away.md", "---\ntitle: Away\n---\nwritten offline\n");
      await vi.waitFor(() => expect(said("cannot reach the server")).toBe(1), {
        timeout: 20_000,
        interval: 100,
      });
      put(harness, "later.md", "---\ntitle: Later\n---\nstill offline\n");
      // Passes enough for a line repeated each pass to show.
      await new Promise((resolve) => setTimeout(resolve, 4_000));
      await harness.server.online();
      await vi.waitFor(
        () => {
          expect(said("answers again")).toBe(1);
          expect(sentTitles(harness!).sort()).toEqual(["Away", "Later"]);
        },
        { timeout: 40_000, interval: 100 },
      );
      expect(watching.running(), watching.stderr).toBe(true);
    } finally {
      await watching.stop();
    }
    expect(
      said("cannot reach the server"),
      `a watch said it could not reach the server more than once while it stayed away: ${watching.stdout}`,
    ).toBe(1);
    expect(watching.stdout).toContain(harness.server.url);
    expect(
      said("answers again"),
      `a watch did not say once that the server was back: ${watching.stdout}`,
    ).toBe(1);
    const offlineLines = watching.stdout
      .split("\n")
      .filter((line) => line.includes("; answered 0"));
    expect(
      offlineLines.length,
      `a watch printed its line at every pass while nothing went: ${watching.stdout}`,
    ).toBeLessThanOrEqual(2);
    expect(
      offlineLines.every((line) => /waiting/.test(line)),
      `a pass line did not say what waits: ${offlineLines.join("\n")}`,
    ).toBe(true);
  });

  it("waits out a gateway refusing its key, naming no contract, without stopping", async () => {
    const unnamed: Answer = {
      kind: "json",
      status: 401,
      body: { error: { code: "access_denied", message: "at the edge" } },
      contract: null,
    };
    // The stream and the first create both meet the gateway, then the server.
    harness = await folderHarness("folder-watch-gateway", {
      events: [unnamed, unnamed, copyHeadRead("1")],
    });
    harness.server.answer("POST", "/items", unnamed);
    scriptFolderWrites(harness);
    put(harness, "gated.md", "---\ntitle: Gated\n---\nbehind a gateway\n");
    const watching = harness.folder.watchText();
    const said = (text: string) => watching.stdout.split(text).length - 1;
    try {
      await vi.waitFor(
        () => {
          expect(said("cannot reach the server")).toBe(1);
          expect(said("answers again")).toBe(1);
          expect(
            harness!.server.requests.filter(
              (request) =>
                request.method === "POST" && request.pathname === "/items",
            ).length,
          ).toBeGreaterThanOrEqual(2);
        },
        { timeout: 40_000, interval: 100 },
      );
      expect(
        watching.running(),
        `a watch stopped on a gateway's 401 as though its key were refused: ${watching.stderr}`,
      ).toBe(true);
    } finally {
      await watching.stop();
    }
    expect(watching.stdout).toMatch(/naming no contract/);
  });

  it("says why a push's drain stopped", async () => {
    harness = await folderHarness("folder-push-stopped");
    harness.server.answer("POST", "/items", answers.unauthorized());
    scriptFolderWrites(harness);
    put(harness, "stopped.md", "---\ntitle: Stopped\n---\nthe key is gone\n");
    const pushed = await harness.folder.pushText();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    if (!pushed.ok) return;
    expect(
      pushed.value,
      `a push whose drain stopped did not say why: ${pushed.value}`,
    ).toMatch(/refused the credential.*drain stopped/);
    // The witness: the create met the refusal.
    expect(sentTitles(harness)).toEqual(["Stopped"]);
  });

  it("stops a watch whose credential is refused, with the credential's exit", async () => {
    harness = await folderHarness("folder-watch-refused");
    // Before the folder's own doors, so the first create meets it.
    harness.server.answer("POST", "/items", answers.unauthorized());
    scriptFolderWrites(harness);
    put(harness, "refused.md", "---\ntitle: Refused\n---\nthe key is gone\n");
    const watching = harness.folder.watchText();
    try {
      await vi.waitFor(
        () =>
          expect(
            watching.running(),
            `a watch went on with a refused credential: ${watching.stdout}`,
          ).toBe(false),
        { timeout: 20_000, interval: 100 },
      );
    } finally {
      await watching.stop();
    }
    expect(
      watching.exitCode(),
      `a watch stopped on a refused credential with another exit than a one-off command's: ${watching.stderr}`,
    ).toBe(5);
    expect(watching.stderr).toMatch(/refused this watch's credential/);
    expect(
      watching.stdout,
      `the watch did not say in its own lines why its drain stopped: ${watching.stdout}`,
    ).toMatch(/the drain stopped: .*refused the credential/);
    // The witness: it was the create that met the refusal.
    expect(sentTitles(harness)).toEqual(["Refused"]);
  });
});

describe("a folder's first sync", () => {
  const remoteA = "01a00000-0000-7000-8000-0000000005a1";
  const remoteB = "01a00000-0000-7000-8000-0000000005a2";
  const remote = {
    "core.note": [
      { item: { id: remoteA, properties: { title: "Remote A", body: "a\n" } } },
      { item: { id: remoteB, properties: { title: "Remote B", body: "b\n" } } },
    ],
  };
  const typed = (title: string): string =>
    `---\ntitle: ${title}\n---\nwritten by hand\n`;

  /** Every request that is not a read, so a quiet folder shows an empty list. */
  function writesSent(made: FolderHarness): string[] {
    return made.server.requests
      .filter((request) => request.method !== "GET")
      .map((request) => `${request.method} ${request.pathname}`);
  }

  /** A folder that waits, holding two items on the server and what `files` names on disk. */
  async function waiting(
    label: string,
    files: Record<string, string> = {},
    rows: typeof remote | null = remote,
  ): Promise<FolderHarness> {
    // The add reads the folder for its plan, which hydrates the copy.
    const made = await folderHarness(label, {
      confirm: false,
      hydrate: false,
      files,
      ...(rows === null ? {} : { rows }),
    });
    scriptFolderWrites(made);
    return made;
  }

  it("says what it will do when the folder is added, and sends and writes nothing", async () => {
    harness = await waiting("first-sync-add", {
      "mine one.md": typed("Mine one"),
      "mine two.md": typed("Mine two"),
      "mine three.md": typed("Mine three"),
    });
    expect(harness.added.first_sync).toEqual({
      waiting: true,
      write: 2,
      send: 3,
      beside: 0,
      unread: null,
    });
    expect(
      writesSent(harness),
      "a folder waiting for its first sync sent a write",
    ).toEqual([]);
    expect(existsSync(join(harness.dir, "Remote A.md"))).toBe(false);
    expect(read(harness, "mine one.md")).toBe(typed("Mine one"));

    const said = await harness.folder.pushWaiting();
    expect(said.ok && said.value.first_sync).toEqual(harness.added.first_sync);
    expect(writesSent(harness)).toEqual([]);
    const status = await harness.folder.status();
    expect(status.ok && status.value.first_sync).toEqual({
      plan: { write: 2, send: 3, beside: 0 },
    });
  });

  it("goes once it is confirmed, and does not ask again", async () => {
    harness = await waiting("first-sync-confirm", {
      "mine.md": typed("Mine"),
    });
    const refused = await harness.folder.pull();
    expect(
      !refused.ok && refused.refusal.raw,
      "a pull wrote into a folder waiting for its first sync",
    ).toContain("first_sync_waiting");
    expect(existsSync(join(harness.dir, "Remote A.md"))).toBe(false);

    const confirmed = await harness.folder.confirm();
    expect(confirmed.ok && confirmed.value.first_sync).toBe(true);
    // The witness: the same folder, once confirmed, sends and writes.
    const pushed = await harness.folder.push();
    expect(pushed.ok && pushed.value.drain.answered).toBeGreaterThan(0);
    expect(sentTitles(harness)).toEqual(["Mine"]);
    expect(existsSync(join(harness.dir, "Remote A.md"))).toBe(true);
    expect(existsSync(join(harness.dir, "Remote B.md"))).toBe(true);

    const again = await harness.folder.push();
    // A sync, not the first sync's plan.
    expect(again.ok && again.value.scan).toBeDefined();
    expect(sentTitles(harness)).toEqual(["Mine"]);
    const status = await harness.folder.status();
    expect(status.ok && status.value.first_sync).toBeUndefined();
    // Added again over its own state, the folder keeps the answer it had.
    const readded = await harness.folder.add(harness.settings.id, {
      confirm: false,
    });
    expect(readded.ok && readded.value.first_sync.waiting).toBe(false);
  });

  it("refuses a watch while it waits, and a script confirms it with --yes", async () => {
    harness = await waiting("first-sync-watch", { "mine.md": typed("Mine") });
    const watching = harness.folder.watchText();
    try {
      await vi.waitFor(() => expect(watching.running()).toBe(false), {
        timeout: 20_000,
        interval: 100,
      });
    } finally {
      await watching.stop();
    }
    expect(watching.exitCode()).not.toBe(0);
    expect(watching.stderr).toContain("first sync waits for confirmation");
    expect(writesSent(harness)).toEqual([]);
    expect(existsSync(join(harness.dir, "Remote A.md"))).toBe(false);

    second = await folderHarness("first-sync-yes", { rows: remote });
    scriptFolderWrites(second);
    expect(second.added.first_sync.waiting).toBe(false);
    const pushed = await second.folder.push();
    expect(pushed.ok).toBe(true);
    expect(existsSync(join(second.dir, "Remote A.md"))).toBe(true);
  });

  it("writes beside a file already where an item's file would go, and says so", async () => {
    harness = await waiting("first-sync-beside", {
      "Remote A.md": typed("Remote A"),
    });
    expect(harness.added.first_sync).toEqual({
      waiting: true,
      write: 2,
      send: 1,
      beside: 1,
      unread: null,
    });
    expect((await harness.folder.confirm()).ok).toBe(true);
    expect((await harness.folder.push()).ok).toBe(true);
    // Both end up in the folder, one with a number in its name, and the
    // person's words are in one of them.
    const names = readdirSync(harness.dir).filter((name) =>
      name.startsWith("Remote A"),
    );
    expect(names.sort()).toEqual(["Remote A (2).md", "Remote A.md"]);
    const texts = names.map((name) => read(harness!, name));
    expect(
      texts.filter((text) => text.includes("written by hand")),
      "the person's file was written over or lost",
    ).toHaveLength(1);
    expect(texts.filter((text) => /^a$/m.test(text))).toHaveLength(1);
    expect(sentTitles(harness)).toEqual(["Remote A"]);
    expect(existsSync(join(harness.dir, "Remote B.md"))).toBe(true);
  });

  it("refuses a drain by the folder's device door while it waits", async () => {
    harness = await waiting("first-sync-drain", { "mine.md": typed("Mine") });
    const drained = await harness.folder.device().drain();
    expect(!drained.ok && drained.refusal.raw).toContain("first_sync_waiting");
    expect(writesSent(harness)).toEqual([]);
    // The witness: confirmed, the same door sends what the scan queued.
    expect((await harness.folder.confirm()).ok).toBe(true);
    const sent = await harness.folder.device().drain();
    expect(sent.ok && sent.value.answered).toBeGreaterThan(0);
  });

  it("confirms itself where there is nothing to write, send or keep", async () => {
    harness = await waiting("first-sync-empty", {}, null);
    expect(harness.added.first_sync).toEqual({
      waiting: false,
      write: null,
      send: null,
      beside: null,
      unread: null,
    });
    const status = await harness.folder.status();
    expect(status.ok && status.value.first_sync).toBeUndefined();
    put(harness, "later.md", typed("Later"));
    const pushed = await harness.folder.push();
    expect(pushed.ok && pushed.value.scan.created).toBe(1);
    expect(sentTitles(harness)).toEqual(["Later"]);
  });

  it("is canceled by removing the folder, which leaves its files", async () => {
    harness = await waiting("first-sync-cancel", { "mine.md": typed("Mine") });
    // The scan has queued the file's create, which is not yet sent.
    const queued = await harness.folder.device().queue();
    expect(queued.ok && queued.value.length).toBeGreaterThan(0);
    expect((await harness.folder.remove()).ok).toBe(true);
    expect(existsSync(join(harness.dir, ".marfa"))).toBe(false);
    expect(read(harness, "mine.md")).toBe(typed("Mine"));
    expect(writesSent(harness)).toEqual([]);

    // The witness: once confirmed and queued, the same removal is refused.
    second = await folderHarness("first-sync-cancel-witness");
    scriptFolderWrites(second);
    put(second, "mine.md", typed("Mine"));
    expect((await second.folder.scan()).ok).toBe(true);
    const refused = await second.folder.remove();
    expect(refused.ok).toBe(false);
  });

  it("reads the copy it already holds when the server is out of reach", async () => {
    harness = await waiting("first-sync-offline", { "mine.md": typed("Mine") });
    await harness.server.stop();
    const said = await harness.folder.pushWaiting();
    expect(said.ok && said.value.first_sync).toEqual({
      waiting: true,
      write: 2,
      send: 1,
      beside: 0,
      unread: null,
    });
    expect(existsSync(join(harness.dir, "Remote A.md"))).toBe(false);
  });

  it("asks of each machine's folder for itself", async () => {
    harness = await waiting("first-sync-machine-one");
    second = await folderHarness("first-sync-machine-two", {
      confirm: false,
      hydrate: false,
      sharing: { server: harness.server, key: KEY },
      folder: harness.settings,
    });
    expect((await harness.folder.confirm()).ok).toBe(true);
    const status = await second.folder.status();
    expect(
      status.ok && status.value.first_sync,
      "one machine's confirmation let another machine's folder go",
    ).toEqual({ plan: { write: 2, send: 0, beside: 0 } });
    const first = await harness.folder.status();
    expect(first.ok && first.value.first_sync).toBeUndefined();
  });
});
