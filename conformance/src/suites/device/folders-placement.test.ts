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
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, afterEach, vi } from "vitest";
import {
  answers,
  copyItemEvent,
  copyLiveReplay,
  refusal,
  copyReplay,
  wireEdge,
  wireItem,
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
import {
  CliFolder,
  type FolderSettings,
  type PushReport,
} from "../../device/cli-adapter.js";
import { ScriptedServer } from "../../device/scripted-server.js";
import {
  CONFLICTED_COPY_TAG,
  FolderDoor,
  type DoorRow,
} from "../../device/folder-door.js";
import type { FolderHarness } from "./harness.js";
import type { Answer } from "../../device/scripted-server.js";
import type {
  WireEdgeOptions,
  WireItemOptions,
} from "../../device/marfa-answers.js";
import {
  EdgeDoor,
  idIn,
  itemVerdicts,
  put,
  read,
  scriptFolderWrites,
  sentCreates,
  sentTitles,
  sentUpdates,
  withFault,
} from "./folders.shared.js";

let harness: FolderHarness | undefined;
let second: FolderHarness | undefined;

afterEach(async () => {
  await harness?.stop();
  await second?.stop();
  harness = undefined;
  second = undefined;
});

describe("where a file sits", () => {
  /** An item the server holds, a note unless typed, placed in the folder at
   *  `path` where one is named. */
  interface Placed {
    id: string;
    title: string;
    type?: string;
    properties?: Record<string, unknown>;
    path?: string;
    tags?: string[];
    state?: string;
  }

  /**
   * A folder whose server holds these notes, each with its `in-folder` edge
   * to the folder where it names a path. The folder's id is minted with the
   * harness, so the edges go on before the hydration reads them.
   */
  async function placedHarness(
    label: string,
    notes: Placed[],
    settings?: FolderSettings,
  ): Promise<{ harness: FolderHarness; edges: EdgeDoor }> {
    const edges = new EdgeDoor();
    const rows = notes.map((note) => ({
      item: {
        id: note.id,
        type: note.type ?? "core.note",
        properties: note.properties ?? {
          title: note.title,
          body: `${note.title}\n`,
        },
        ...(note.state === undefined ? {} : { state: note.state }),
      } as WireItemOptions,
      tags: note.tags,
    }));
    const byType: Record<string, typeof rows> = {};
    for (const row of rows) {
      const type = row.item.type ?? "core.note";
      (byType[type] ??= []).push(row);
    }
    const made = await folderHarness(label, {
      settings,
      rows: byType,
      hydrate: false,
      events: [edges.stream()],
    });
    notes.forEach((note, at) => {
      if (note.path === undefined) return;
      const edge: WireEdgeOptions = {
        id: randomUUID(),
        source_id: note.id,
        target_id: made.settings.id,
        edge_type: "in-folder",
        properties: { path: note.path },
      };
      edges.hold(edge);
      rows[at]!.item.edges = {
        "in-folder": {
          data: [wireEdge(edges.edges.get(edge.id)!)],
          next_cursor: null,
        },
      };
    });
    scriptFolderWrites(made, { edges });
    const hydrated = await made.folder.hydrate();
    if (!hydrated.ok) {
      await made.stop();
      throw new Error(
        `the fixture could not hydrate: ${JSON.stringify(hydrated)}`,
      );
    }
    return { harness: made, edges };
  }

  /** Another Mac: its own directory and store, bound to the same folder. */
  function anotherMac(
    harness: FolderHarness,
    label: string,
  ): Promise<FolderHarness> {
    return folderHarness(label, {
      sharing: { server: harness.server, key: "another-mac-key" },
      folder: harness.settings,
    });
  }

  it("places an item where its in-folder edge says, on every Mac", async () => {
    const id = "01a00000-0000-7000-8000-0000000016a1";
    const placed = await placedHarness("placement-every-mac", [
      { id, title: "Plan", path: "Projects/Plan.md" },
    ]);
    harness = placed.harness;
    // Another Mac: its own directory and store, bound to the same folder.
    second = await folderHarness("placement-other-mac", {
      sharing: { server: harness.server, key: "another-mac-key" },
      folder: harness.settings,
    });
    for (const mac of [harness, second]) {
      expect((await mac.folder.pull()).ok).toBe(true);
      expect(
        existsSync(join(mac.dir, "Projects", "Plan.md")),
        "the file is not where its item's in-folder edge says, so each Mac lays the folder out its own way",
      ).toBe(true);
      expect(existsSync(join(mac.dir, "Plan.md"))).toBe(false);
    }

    // Moved on one Mac, the file follows on the other.
    mkdirSync(join(harness.dir, "Archive"));
    renameSync(
      join(harness.dir, "Projects", "Plan.md"),
      join(harness.dir, "Archive", "Plan.md"),
    );
    expect((await harness.folder.push()).ok).toBe(true);
    expect(placed.edges.placements(harness.settings.id).get(id)).toBe(
      "Archive/Plan.md",
    );
    const followed = await second.folder.push();
    expect(followed.ok, JSON.stringify(followed)).toBe(true);
    if (!followed.ok) return;
    expect(followed.value.pull?.moved).toBe(1);
    expect(
      existsSync(join(second.dir, "Archive", "Plan.md")),
      "a move on one Mac did not reach the other, so the two lay the folder out differently from then on",
    ).toBe(true);
    expect(existsSync(join(second.dir, "Projects", "Plan.md"))).toBe(false);
  });

  it("places a new item from elsewhere under its type's first placement", async () => {
    const note = "01a00000-0000-7000-8000-0000000016b1";
    const bookmark = "01a00000-0000-7000-8000-0000000016b2";
    harness = await folderHarness("placement-first", {
      settings: {
        search: { types: ["core.note", "core.bookmark"] },
        first_placement: { "core.note": "Notes/" },
      },
      rows: {
        "core.note": [
          { item: { id: note, properties: { title: "An idea", body: "x\n" } } },
        ],
        "core.bookmark": [
          {
            item: {
              id: bookmark,
              type: "core.bookmark",
              properties: { title: "A link", body: "y\n" },
            },
          },
        ],
      },
    });
    const edges = new EdgeDoor();
    scriptFolderWrites(harness, { edges });
    const pulled = await harness.folder.pull();
    expect(pulled.ok, JSON.stringify(pulled)).toBe(true);
    if (!pulled.ok) return;
    expect(
      existsSync(join(harness.dir, "Notes", "An idea.md")),
      "a note made elsewhere did not go under the first placement its type names",
    ).toBe(true);
    expect(
      existsSync(join(harness.dir, "A link.md")),
      "a type with no first placement did not go at the root by its title",
    ).toBe(true);
    expect(pulled.value.placed).toBe(2);

    // The folder then writes where it put each.
    expect((await harness.folder.push()).ok).toBe(true);
    expect(edges.placements(harness.settings.id)).toEqual(
      new Map([
        [note, "Notes/An idea.md"],
        [bookmark, "A link.md"],
      ]),
    );
  });

  it("sends only the placement for a rename", async () => {
    harness = await folderHarness("placement-rename");
    const edges = new EdgeDoor();
    scriptFolderWrites(harness, { edges });
    put(harness, "draft.md", "---\ntitle: Draft\n---\nwords\n");
    expect((await harness.folder.push()).ok).toBe(true);
    const id = idIn(harness, "draft.md") ?? "";
    expect(edges.placements(harness.settings.id).get(id)).toBe("draft.md");

    const before = harness.server.requests.length;
    mkdirSync(join(harness.dir, "Done"));
    renameSync(
      join(harness.dir, "draft.md"),
      join(harness.dir, "Done", "draft.md"),
    );
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    const sent = harness.server.requests
      .slice(before)
      .filter((request) => request.method !== "GET");
    expect(
      sent.map((request) => request.method),
      "a rename sent something other than one change to the file's placement",
    ).toEqual(["PATCH"]);
    expect(sent[0]?.pathname).toMatch(/^\/edges\//);
    expect(JSON.parse(sent[0]?.body ?? "{}")).toEqual({
      properties: { path: "Done/draft.md" },
      version: 1,
    });
    expect(edges.placements(harness.settings.id).get(id)).toBe("Done/draft.md");
    expect(existsSync(join(harness.dir, "Done", "draft.md"))).toBe(true);
    expect(existsSync(join(harness.dir, "draft.md"))).toBe(false);
  });

  it("writes the in-folder edge for a file made in the folder", async () => {
    harness = await folderHarness("placement-made-here");
    const edges = new EdgeDoor();
    scriptFolderWrites(harness, { edges });
    put(harness, "Inbox/idea.md", "---\ntitle: Idea\n---\nfirst thought\n");
    expect((await harness.folder.push()).ok).toBe(true);
    const [created] = sentCreates(harness);
    const placements = harness.server.requests
      .filter(
        (request) => request.method === "POST" && request.pathname === "/edges",
      )
      .map((request) => JSON.parse(request.body) as Record<string, unknown>)
      .filter((edge) => edge.edge_type === "in-folder");
    expect(
      placements,
      "a file made in the folder went without its placement, so no other Mac knows where it sits",
    ).toMatchObject([
      {
        source_id: created?.id,
        target_id: harness.settings.id,
        properties: { path: "Inbox/idea.md" },
      },
    ]);

    // Never in the file: the pull has rewritten it, and it names the item
    // and nothing of the placement.
    const text = read(harness, "Inbox/idea.md");
    expect(text).toContain(`marfa_id: ${String(created?.id)}`);
    expect(
      text,
      "the placement was written into the file, as a link to the folder's own settings",
    ).not.toContain(harness.settings.id);
    expect(text).not.toContain("in-folder");
  });

  it("places a checked-out file where it sits", async () => {
    const id = "01a00000-0000-7000-8000-0000000016e1";
    const placed = await placedHarness("placement-checkout", [
      { id, title: "Plan", path: "Elsewhere/Plan.md" },
    ]);
    harness = placed.harness;
    put(harness, "Plan.md", `---\nmarfa_id: ${id}\ntitle: Plan\n---\nPlan\n`);
    expect((await harness.folder.push()).ok).toBe(true);
    expect(
      placed.edges.placements(harness.settings.id).get(id),
      "a file the person put in the folder was not placed where they put it",
    ).toBe("Plan.md");
    expect(idIn(harness, "Plan.md")).toBe(id);
    expect(existsSync(join(harness.dir, "Elsewhere", "Plan.md"))).toBe(false);
  });

  it.each([false, true])(
    "keeps the item of a renamed file that is still settling (replacement %s)",
    async (replacement) => {
      const id = "01a00000-0000-7000-8000-0000000016f1";
      const bytes = Buffer.from("initial file bytes");
      const placed = await placedHarness(
        "folder-rename-settling",
        [
          {
            id,
            title: "capture.bin",
            type: "core.file",
            path: "capture.bin",
            properties: {
              title: "capture.bin",
              blob_ref: hashOf(bytes),
              mime_type: "application/octet-stream",
            },
          },
        ],
        { search: { types: ["core.file"] } },
      );
      harness = placed.harness;
      scriptBlob(harness.server, bytes);
      acceptUploads(harness.server);
      expect((await harness.folder.pull()).ok).toBe(true);
      const moving = join(harness.dir, "renamed.bin");
      renameSync(join(harness.dir, "capture.bin"), moving);
      if (replacement) put(harness, "capture.bin", "different new file");
      const writing = setInterval(
        () => appendFileSync(moving, Buffer.from("more")),
        30,
      );
      appendFileSync(moving, Buffer.from("first edit"));
      const watching = harness.folder.watchText();
      try {
        await vi.waitFor(
          () => expect(watching.stdout).toContain("still changing"),
          { timeout: 30000, interval: 100 },
        );
        await new Promise((resolve) => setTimeout(resolve, 12000));
        expect(watching.running(), watching.stderr).toBe(true);
        const deletes = harness.server.requests.filter(
          (r) => r.method === "DELETE" && r.pathname === `/items/${id}`,
        );
        expect(existsSync(moving)).toBe(true);
        expect(
          deletes,
          "the moved file is present and changing but its item was trashed",
        ).toEqual([]);
        expect(sentUpdates(harness)).toEqual([]);
        const status = await harness.folder.status();
        expect(
          status.ok &&
            status.value.files.find((file) => file.path === "renamed.bin")
              ?.item_id,
        ).toBe(id);
        if (replacement) {
          const other =
            status.ok &&
            status.value.files.find((file) => file.path === "capture.bin")
              ?.item_id;
          expect(other).toEqual(expect.any(String));
          expect(other).not.toBe(id);
        }
        clearInterval(writing);
        const settled = readFileSync(moving);
        scriptBlob(harness.server, settled);
        await vi.waitFor(
          () =>
            expect(sentUpdates(harness!)).toContainEqual(
              expect.objectContaining({
                id,
                body: expect.objectContaining({
                  properties: expect.objectContaining({
                    blob_ref: hashOf(settled),
                  }),
                }),
              }),
            ),
          { timeout: 30000, interval: 100 },
        );
        await vi.waitFor(
          () =>
            expect(placed.edges.placements(harness!.settings.id).get(id)).toBe(
              "renamed.bin",
            ),
          { timeout: 30000, interval: 100 },
        );
        expect(sentCreates(harness)).toHaveLength(replacement ? 1 : 0);
        rmSync(moving);
        await vi.waitFor(
          () =>
            expect(
              harness!.server.requests.some(
                (r) => r.method === "DELETE" && r.pathname === `/items/${id}`,
              ),
            ).toBe(true),
          { timeout: 30000, interval: 100 },
        );
      } finally {
        clearInterval(writing);
        await watching.stop();
      }
    },
  );

  it.each(["empty", "unreadable"])(
    "keeps a renamed file's item while its bytes are %s",
    async (kind) => {
      const id = "01a00000-0000-7000-8000-0000000016f1";
      const bytes = Buffer.from("initial file bytes");
      const placed = await placedHarness(
        "folder-rename-unread",
        [
          {
            id,
            title: "capture.bin",
            type: "core.file",
            path: "capture.bin",
            properties: {
              title: "capture.bin",
              blob_ref: hashOf(bytes),
              mime_type: "application/octet-stream",
            },
          },
        ],
        { search: { types: ["core.file"] } },
      );
      harness = placed.harness;
      scriptBlob(harness.server, bytes);
      acceptUploads(harness.server);
      expect((await harness.folder.pull()).ok).toBe(true);
      const moving = join(harness.dir, "renamed.bin");
      renameSync(join(harness.dir, "capture.bin"), moving);
      if (kind === "empty") writeFileSync(moving, "");
      else chmodSync(moving, 0);
      try {
        const scanned = await harness.folder.scan();
        expect(scanned.ok, JSON.stringify(scanned)).toBe(true);
        expect(scanned.ok && scanned.value.missing).toBe(0);
      } finally {
        chmodSync(moving, 0o600);
      }
      writeFileSync(moving, bytes);
      const pushed = await harness.folder.push();
      expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
      expect(placed.edges.placements(harness.settings.id).get(id)).toBe(
        "renamed.bin",
      );
      expect(sentCreates(harness)).toEqual([]);
    },
  );

  it.each([true, false])(
    "keeps unread rename ownership over a replacement at the old path: %s",
    async (unread) => {
      const id = "01a00000-0000-7000-8000-0000000016f1";
      const bytes = Buffer.from("original bytes");
      const placed = await placedHarness(
        "folder-unread-owner",
        [
          {
            id,
            title: "capture.bin",
            type: "core.file",
            path: "capture.bin",
            properties: {
              title: "capture.bin",
              blob_ref: hashOf(bytes),
              mime_type: "application/octet-stream",
            },
          },
        ],
        { search: { types: ["core.file"] } },
      );
      harness = placed.harness;
      scriptBlob(harness.server, bytes);
      acceptUploads(harness.server);
      expect((await harness.folder.pull()).ok).toBe(true);
      const moving = join(harness.dir, "renamed.bin");
      renameSync(join(harness.dir, "capture.bin"), moving);
      if (unread) writeFileSync(moving, "");
      writeFileSync(join(harness.dir, "capture.bin"), "different new file");
      const scanned = await harness.folder.scan();
      expect(scanned.ok, JSON.stringify(scanned)).toBe(true);
      writeFileSync(moving, bytes);
      const after = await harness.folder.scan();
      const status = await harness.folder.status();
      expect(
        status.ok &&
          status.value.files.find((f) => f.path === "renamed.bin")?.item_id,
        JSON.stringify({ after, status }),
      ).toBe(id);
      expect(scanned.ok && scanned.value.updated, JSON.stringify(scanned)).toBe(
        0,
      );
      const other =
        status.ok &&
        status.value.files.find((file) => file.path === "capture.bin")?.item_id;
      expect(other).toEqual(expect.any(String));
      expect(other).not.toBe(id);
      expect(status.ok && status.value.files).toHaveLength(2);
    },
  );

  it("takes back an empty text file rendered from a missing body", async () => {
    const id = "01a00000-0000-7000-8000-0000000016f1";
    const placed = await placedHarness(
      "folder-empty-body",
      [
        {
          id,
          title: "empty",
          type: "core.event",
          path: "empty.txt",
          properties: { title: "empty" },
        },
      ],
      { search: { types: ["core.note", "core.event"] } },
    );
    harness = placed.harness;
    expect((await harness.folder.pull()).ok).toBe(true);
    expect(read(harness, "empty.txt")).toBe("");
    expect((await harness.folder.remove()).ok).toBe(true);
    expect((await harness.folder.add(harness.settings.id)).ok).toBe(true);
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    expect(sentCreates(harness), JSON.stringify(pushed)).toEqual([]);
    const status = await harness.folder.status();
    expect(
      status.ok && status.value.files.map((file) => [file.path, file.item_id]),
    ).toEqual([["empty.txt", id]]);
  });

  it("takes back the files it holds by placement and bytes when it is added again over them", async () => {
    const [photo, paper, words] = [
      "01a00000-0000-7000-8000-0000000016f1",
      "01a00000-0000-7000-8000-0000000016f2",
      "01a00000-0000-7000-8000-0000000016f3",
    ];
    const photoBytes = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x16, 0xf1,
    ]);
    const paperBytes = Buffer.from("%PDF-1.4\n%%EOF\n");
    const placed = await placedHarness(
      "placement-added-again",
      [
        {
          id: photo,
          title: "photo.png",
          type: "core.file.image",
          properties: {
            title: "photo.png",
            blob_ref: hashOf(photoBytes),
            mime_type: "image/png",
          },
          path: "Pictures/photo.png",
        },
        {
          id: paper,
          title: "paper.pdf",
          type: "core.file",
          properties: {
            title: "paper.pdf",
            blob_ref: hashOf(paperBytes),
            mime_type: "application/pdf",
          },
          path: "paper.pdf",
        },
        {
          id: words,
          title: "words",
          properties: { title: "words", body: "plain words\n" },
          path: "words.txt",
        },
      ],
      { search: { types: ["core.file", "core.file.image", "core.note"] } },
    );
    harness = placed.harness;
    acceptUploads(harness.server);
    for (const bytes of [photoBytes, paperBytes]) {
      scriptBlob(harness.server, bytes);
    }
    const first = await harness.folder.pull();
    expect(first.ok, JSON.stringify(first)).toBe(true);
    expect(readFileSync(join(harness.dir, "Pictures", "photo.png"))).toEqual(
      photoBytes,
    );
    expect(read(harness, "words.txt")).toBe("plain words\n");

    // Its own state goes, and the directory is added again: none of these
    // files can carry an id, so only where each sits and what it holds can
    // name its item.
    expect((await harness.folder.remove()).ok).toBe(true);
    const added = await harness.folder.add(harness.settings.id);
    expect(added.ok, JSON.stringify(added)).toBe(true);
    // The witness: a new picture beside them is created.
    writeFileSync(
      join(harness.dir, "Pictures", "new.png"),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x16, 0xf9]),
    );
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    if (!pushed.ok) return;
    expect(
      sentTitles(harness),
      "a folder added again over its own files made a second item of each",
    ).toEqual(["new.png"]);
    expect(sentUpdates(harness)).toEqual([]);
    expect(
      readdirSync(join(harness.dir, "Pictures")).sort(),
      "the pull wrote the item again beside the file that already held it",
    ).toEqual(["new.png", "photo.png"]);
    expect(existsSync(join(harness.dir, "words (2).txt"))).toBe(false);
    expect(existsSync(join(harness.dir, "paper (2).pdf"))).toBe(false);

    // Taken back, a file holds its item's own bytes, so it goes with the
    // item when another device trashes it.
    for (const [id, title, properties] of [
      [
        photo,
        "photo.png",
        { blob_ref: hashOf(photoBytes), mime_type: "image/png" },
      ],
      [words, "words", { body: "plain words\n" }],
    ] as const) {
      placed.edges.events.push(
        copyItemEvent(
          String(placed.edges.events.length + 2),
          "item.deleted",
          wireItem({
            id,
            type: id === photo ? "core.file.image" : "core.note",
            state: "trashed",
            properties: { title, ...properties },
          }),
        ),
      );
    }
    const trashed = await harness.folder.push();
    expect(trashed.ok, JSON.stringify(trashed)).toBe(true);
    if (!trashed.ok) return;
    expect(
      [trashed.value.pull?.removed, trashed.value.pull?.kept],
      "a file taken back by its bytes was kept as the person's when its item was trashed",
    ).toEqual([2, 0]);
    expect(existsSync(join(harness.dir, "Pictures", "photo.png"))).toBe(false);
    expect(existsSync(join(harness.dir, "words.txt"))).toBe(false);
  });

  it("takes back by placement and bytes only an item its search holds", async () => {
    const [archived, kept] = [
      "01a00000-0000-7000-8000-0000000016f5",
      "01a00000-0000-7000-8000-0000000016f6",
    ];
    const placed = await placedHarness(
      "placement-added-again-left",
      [
        {
          id: archived,
          title: "gone",
          properties: { title: "gone", body: "" },
          path: "gone.txt",
          state: "archived",
        },
        {
          id: kept,
          title: "kept",
          properties: { title: "kept", body: "" },
          path: "kept.txt",
        },
      ],
      { search: { types: ["core.note"], state: ["active"] } },
    );
    harness = placed.harness;
    // An empty text file at each placement, which is each item's body: the
    // witness is taken back, and the one whose item left by state is new.
    put(harness, "gone.txt", "");
    put(harness, "kept.txt", "");
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    if (!pushed.ok) return;
    expect(
      sentCreates(harness).length,
      "a file was taken as the file of an item its folder no longer holds",
    ).toBe(1);
    expect(sentUpdates(harness)).toEqual([]);
    const status = await harness.folder.status();
    expect(
      status.ok &&
        status.value.files
          .filter((file) => file.path !== "gone.txt")
          .map((file) => [file.path, file.item_id]),
    ).toEqual([["kept.txt", kept]]);
  });

  it("places a file whose placement another item holds beside it, and writes none where its placement is unsafe", async () => {
    const outside = mkdtempSync(join(tmpdir(), "marfa-folder-elsewhere-"));
    // Placed in this order, so each edge is older than the next.
    const notes: Placed[] = [
      {
        id: "01a00000-0000-7000-8000-0000000016c1",
        title: "A",
        path: "Shared.md",
      },
      {
        id: "01a00000-0000-7000-8000-0000000016c2",
        title: "B",
        path: "Shared (2).md",
      },
      {
        id: "01a00000-0000-7000-8000-0000000016c3",
        title: "C",
        path: "Shared (2).md",
      },
      {
        id: "01a00000-0000-7000-8000-0000000016c4",
        title: "D",
        path: "Shared.md",
      },
      {
        id: "01a00000-0000-7000-8000-0000000016c5",
        title: "Hidden",
        path: ".hidden/c.md",
      },
      {
        id: "01a00000-0000-7000-8000-0000000016c6",
        title: "Linked",
        path: "linked/d.md",
      },
      {
        id: "01a00000-0000-7000-8000-0000000016c7",
        title: "Climbing",
        path: "a/../e.md",
      },
    ];
    const placed = await placedHarness("placement-taken", notes);
    harness = placed.harness;
    // A directory that leads out of the folder.
    symlinkSync(outside, join(harness.dir, "linked"));
    const pulled = await harness.folder.pull();
    expect(pulled.ok, JSON.stringify(pulled)).toBe(true);
    if (!pulled.ok) return;
    const layout = [
      "Shared.md",
      "Shared (2).md",
      "Shared (3).md",
      "Shared (4).md",
    ].map((name) => idIn(harness!, name));
    expect(
      layout,
      "items placed at one path were not each given a file, the older placement at the path and the next at the first free number beside it",
    ).toEqual(notes.slice(0, 4).map((note) => note.id));
    expect(existsSync(join(harness.dir, "Shared (2) (2).md"))).toBe(false);
    expect(pulled.value.beside).toBe(2);
    expect(
      [pulled.value.outside, readdirSync(outside)],
      "a placement leading out of what the folder reads was written",
    ).toEqual([3, []]);
    for (const name of [".hidden", "Hidden.md", "Linked.md", "e.md", "a"]) {
      expect(existsSync(join(harness.dir, name)), name).toBe(false);
    }

    // Each one beside is placed where it now sits; an unsafe placement is
    // left as it says.
    expect((await harness.folder.push()).ok).toBe(true);
    const placements = placed.edges.placements(harness.settings.id);
    expect(
      notes.map((note) => placements.get(note.id)),
      "a placement moved beside was not recorded, or an unsafe one was changed",
    ).toEqual([
      "Shared.md",
      "Shared (2).md",
      "Shared (3).md",
      "Shared (4).md",
      ".hidden/c.md",
      "linked/d.md",
      "a/../e.md",
    ]);
    rmSync(outside, { recursive: true, force: true });
  });

  it("writes no file where its placement would make it another kind of file", async () => {
    const bytes = Buffer.from("bytes the server holds");
    const image = "01a00000-0000-7000-8000-0000000016h1";
    const note = "01a00000-0000-7000-8000-0000000016h2";
    const control = "01a00000-0000-7000-8000-0000000016h3";
    const placed = await placedHarness(
      "placement-unsuited",
      [
        {
          id: image,
          type: "core.file",
          title: "photo.png",
          properties: {
            title: "photo.png",
            blob_ref: hashOf(Buffer.from("not really a picture")),
            mime_type: "image/png",
          },
          path: "data.md",
        },
        { id: note, title: "Note", path: "picture.png" },
        { id: control, title: "Control", path: "notes/control.md" },
        {
          id: "01a00000-0000-7000-8000-0000000016h4",
          type: "core.file",
          title: "photo.png",
          properties: {
            title: "photo.png",
            blob_ref: hashOf(bytes),
            mime_type: "image/png",
          },
          path: "photo.data",
        },
        {
          id: "01a00000-0000-7000-8000-0000000016h5",
          type: "core.file",
          title: "blob",
          properties: { title: "blob", blob_ref: hashOf(bytes) },
          path: "blob.md",
        },
      ],
      { search: { types: ["core.note", "core.file"] } },
    );
    harness = placed.harness;
    scriptBlob(harness.server, bytes);
    const pulled = await harness.folder.pull();
    expect(pulled.ok, JSON.stringify(pulled)).toBe(true);
    if (!pulled.ok) return;
    // The witness: a placement of the item's own kind is written, and so
    // is one whose name names no MIME type, or whose item names none.
    expect(idIn(harness, "notes/control.md")).toBe(control);
    for (const name of ["photo.data", "blob.md"]) {
      expect(readFileSync(join(harness.dir, name)), name).toEqual(bytes);
    }
    expect(
      [
        pulled.value.unsuited,
        existsSync(join(harness.dir, "data.md")),
        existsSync(join(harness.dir, "picture.png")),
      ],
      "a placement wrote an item as another kind of file, which its next edit would send as that kind",
    ).toEqual([2, false, false]);
    const unsuited =
      "a file at the path would be another kind of file than the item";
    expect(
      pulled.value.flagged
        .filter((file) => file.flag === "unsuited")
        .sort((one, other) => one.path.localeCompare(other.path)),
      "the pull counted an item it did not write without naming it",
    ).toEqual([
      { path: "data.md", flag: "unsuited", reason: unsuited, item: image },
      { path: "picture.png", flag: "unsuited", reason: unsuited, item: note },
    ]);
    expect((await harness.folder.push()).ok).toBe(true);
    const placements = placed.edges.placements(harness.settings.id);
    expect([placements.get(image), placements.get(note)]).toEqual([
      "data.md",
      "picture.png",
    ]);
  });

  it("gives a path two Macs made a file at to the item placed there first, the same on every Mac", async () => {
    const edges = new EdgeDoor();
    harness = await folderHarness("placement-race-first", {
      events: [edges.stream()],
    });
    scriptFolderWrites(harness, { edges });
    second = await anotherMac(harness, "placement-race-second");
    put(harness, "Shared.md", "---\ntitle: Shared\n---\nfrom the first Mac\n");
    put(second, "Shared.md", "---\ntitle: Shared\n---\nfrom the second Mac\n");
    const layout = (mac: FolderHarness) =>
      readdirSync(mac.dir)
        .filter((name) => name.endsWith(".md"))
        .sort()
        .map((name) => [name, idIn(mac, name)]);
    expect((await harness.folder.push()).ok).toBe(true);
    const met = await second.folder.push();
    expect(met.ok, JSON.stringify(met)).toBe(true);
    if (!met.ok) return;
    // The second Mac's file moves beside, and the first Mac's item takes
    // the path it left in the same pull.
    expect([met.value.pull?.unwritten, met.value.pull?.beside]).toEqual([0, 1]);
    expect(layout(second).map(([name]) => name)).toEqual([
      "Shared (2).md",
      "Shared.md",
    ]);
    for (let round = 0; round < 3; round += 1) {
      for (const mac of [harness, second]) {
        const pushed = await mac.folder.push();
        expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
      }
    }
    const first = sentCreates(harness).find(
      (sent) =>
        (sent.properties as Record<string, unknown>).body ===
        "from the first Mac\n",
    )?.id;
    expect(
      layout(harness),
      "the two Macs did not settle on one file per item, the first placed at the path and the other beside it",
    ).toEqual([
      ["Shared (2).md", expect.any(String)],
      ["Shared.md", first],
    ]);
    expect(
      layout(second),
      "the two Macs lay the folder out differently",
    ).toEqual(layout(harness));

    // Settled: another round writes nothing anywhere.
    const before = harness.server.requests.filter(
      (request) => request.method !== "GET",
    ).length;
    for (const mac of [harness, second]) {
      expect((await mac.folder.push()).ok).toBe(true);
    }
    expect(
      harness.server.requests.filter((request) => request.method !== "GET")
        .length,
      "the Macs went on writing after they agreed",
    ).toBe(before);
    expect(layout(second)).toEqual(layout(harness));
  });

  it("follows another Mac's move of the same file, giving its own way", async () => {
    const id = "01a00000-0000-7000-8000-0000000016f1";
    const placed = await placedHarness("placement-moves-race", [
      { id, title: "Plan", path: "Plan.md" },
    ]);
    harness = placed.harness;
    second = await anotherMac(harness, "placement-moves-race-second");
    for (const mac of [harness, second]) {
      expect((await mac.folder.pull()).ok).toBe(true);
    }
    mkdirSync(join(harness.dir, "First"));
    renameSync(
      join(harness.dir, "Plan.md"),
      join(harness.dir, "First", "Plan.md"),
    );
    mkdirSync(join(second.dir, "Second"));
    renameSync(
      join(second.dir, "Plan.md"),
      join(second.dir, "Second", "Plan.md"),
    );
    expect((await harness.folder.push()).ok).toBe(true);
    // The second Mac hears of the first's move before its own is answered,
    // so its copy shows its own move over the server's.
    expect((await second.folder.scan()).ok).toBe(true);
    expect((await second.folder.device().catchUp()).ok).toBe(true);
    const late = await second.folder.push();
    expect(late.ok, JSON.stringify(late)).toBe(true);
    if (!late.ok) return;
    expect((await harness.folder.push()).ok).toBe(true);
    for (const mac of [harness, second]) {
      expect(
        idIn(mac, "First/Plan.md"),
        "the Mac whose move came second kept its own, so the two stay apart",
      ).toBe(id);
      expect(existsSync(join(mac.dir, "Second", "Plan.md"))).toBe(false);
    }
    const queued = await second.folder.device().queue();
    expect(
      queued.ok && queued.value.filter((row) => row.verdict === "blocked"),
    ).toEqual([]);
    expect(placed.edges.placements(harness.settings.id).get(id)).toBe(
      "First/Plan.md",
    );
    expect(late.value.drain.gave_way).toBe(1);
  });

  it("follows a move it heard of after the read it gives way from", async () => {
    const id = "01a00000-0000-7000-8000-0000000016q1";
    const placed = await placedHarness("placement-moves-behind", [
      { id, title: "Plan", path: "Plan.md" },
    ]);
    harness = placed.harness;
    second = await anotherMac(harness, "placement-moves-behind-second");
    for (const mac of [harness, second]) {
      expect((await mac.folder.pull()).ok).toBe(true);
    }
    mkdirSync(join(harness.dir, "First"));
    renameSync(
      join(harness.dir, "Plan.md"),
      join(harness.dir, "First", "Plan.md"),
    );
    mkdirSync(join(second.dir, "Second"));
    renameSync(
      join(second.dir, "Plan.md"),
      join(second.dir, "Second", "Plan.md"),
    );
    expect((await harness.folder.push()).ok).toBe(true);
    const edge = [...placed.edges.edges.values()].find(
      (held) => held.source_id === id && held.edge_type === "in-folder",
    )!;
    const read = { ...edge, properties: { ...edge.properties } };
    mkdirSync(join(harness.dir, "Third"));
    renameSync(
      join(harness.dir, "First", "Plan.md"),
      join(harness.dir, "Third", "Plan.md"),
    );
    expect((await harness.folder.push()).ok).toBe(true);
    // The second Mac hears of both moves before its own is answered; the
    // read it gives way from was answered before the later one.
    expect((await second.folder.scan()).ok).toBe(true);
    expect((await second.folder.device().catchUp()).ok).toBe(true);
    placed.edges.behind.set(edge.id, read);
    const late = await second.folder.push();
    expect(late.ok, JSON.stringify(late)).toBe(true);
    if (!late.ok) return;
    // The witness: it gave way, from the older read.
    expect(late.value.drain.gave_way).toBe(1);
    expect(placed.edges.behind.size).toBe(0);
    expect(
      idIn(second, "Third/Plan.md"),
      "giving way from an older read put back a placement the copy had already moved past",
    ).toBe(id);
    expect(existsSync(join(second.dir, "Second", "Plan.md"))).toBe(false);
    expect(existsSync(join(second.dir, "First", "Plan.md"))).toBe(false);
    expect(placed.edges.placements(harness.settings.id).get(id)).toBe(
      "Third/Plan.md",
    );
  });

  it("follows the placement another Mac made first, and leaves no refusal behind", async () => {
    const id = "01a00000-0000-7000-8000-0000000016g1";
    const placed = await placedHarness("placement-duplicate", [
      { id, title: "Idea" },
    ]);
    harness = placed.harness;
    second = await anotherMac(harness, "placement-duplicate-second");
    // Both Macs write the new item and queue its placement.
    for (const mac of [harness, second]) {
      expect((await mac.folder.pull()).ok).toBe(true);
    }
    expect((await harness.folder.push()).ok).toBe(true);
    mkdirSync(join(harness.dir, "Kept"));
    renameSync(
      join(harness.dir, "Idea.md"),
      join(harness.dir, "Kept", "Idea.md"),
    );
    expect((await harness.folder.push()).ok).toBe(true);

    // Before its own placement is answered, the second Mac follows the
    // older one the server holds.
    expect((await second.folder.device().catchUp()).ok).toBe(true);
    expect((await second.folder.pull()).ok).toBe(true);
    expect(
      idIn(second, "Kept/Idea.md"),
      "a Mac followed its own waiting placement over the older one another Mac made",
    ).toBe(id);
    // The drain's own read of the edges fails; giving way reads them again.
    placed.edges.failListings = 1;
    const late = await second.folder.push();
    expect(late.ok, JSON.stringify(late)).toBe(true);
    if (!late.ok) return;
    // The witness: the server refused the second Mac's placement as one it
    // already holds.
    expect(
      harness.server.requests.filter(
        (request) =>
          request.method === "POST" &&
          request.pathname === "/edges" &&
          (JSON.parse(request.body) as { edge_type?: string }).edge_type ===
            "in-folder",
      ).length,
    ).toBe(2);
    expect(
      late.value.drain.verdicts.filter((entry) => entry.verdict === "refused"),
    ).toEqual([]);
    const queued = await second.folder.device().queue();
    expect(
      queued.ok && queued.value.filter((row) => row.verdict === "refused"),
      "a placement another Mac made first was left behind as a refusal",
    ).toEqual([]);
    expect(
      idIn(second, "Kept/Idea.md"),
      "the second Mac did not follow the placement the server holds",
    ).toBe(id);
    expect(existsSync(join(second.dir, "Idea.md"))).toBe(false);
    expect(late.value.drain.gave_way).toBe(1);
    const held = await second.folder.device().edgesFrom(id);
    expect(
      held.ok &&
        held.value.filter((edge) => edge.edge_type === "in-folder").length,
      "the copy holds this Mac's refused placement beside the server's",
    ).toBe(1);
  });

  it("sends a placement the server refused once, until the settings or the key change", async () => {
    let keyId = "narrowed-key";
    let refusing = true;
    const edges = new EdgeDoor();
    edges.placing = (edge) =>
      refusing && edge.edge_type === "in-folder"
        ? refusal(
            403,
            "edge_permission_denied",
            "Write access to edge type denied",
          )
        : undefined;
    harness = await folderHarness("placement-refused", {
      key: [() => answers.currentKey(keyId, { "*": "write" })],
      events: [edges.stream()],
    });
    scriptFolderWrites(harness, { edges });
    for (const name of ["one.md", "two.md"]) {
      put(harness, name, `---\ntitle: ${name}\n---\nwords\n`);
    }
    const placings = () =>
      harness!.server.requests.filter(
        (request) =>
          request.method === "POST" &&
          request.pathname === "/edges" &&
          (JSON.parse(request.body) as { edge_type?: string }).edge_type ===
            "in-folder",
      ).length;
    const push = async (passes: number): Promise<PushReport | undefined> => {
      let last: PushReport | undefined;
      for (let pass = 0; pass < passes; pass += 1) {
        const pushed = await harness!.folder.push();
        expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
        if (pushed.ok) last = pushed.value;
      }
      return last;
    };
    await push(1);
    // Refused in a later pass than the first two.
    put(harness, "three.md", "---\ntitle: three.md\n---\nwords\n");
    const refused = await push(4);
    expect(
      placings(),
      "a placement the server refused was sent again pass after pass",
    ).toBe(3);
    expect(refused?.pull?.unplaced).toBe(3);

    // Moved after its refusal, a file is tried where it now sits, once.
    renameSync(join(harness.dir, "one.md"), join(harness.dir, "moved.md"));
    await push(3);
    expect(
      placings(),
      "a file moved after its placement was refused was not tried at its new path, or was tried again and again",
    ).toBe(4);

    // The settings change elsewhere: the placements go once more. A pull
    // queues them, and the push after it sends them.
    harness.settings.version += 1;
    harness.settings.settings = {
      ...harness.settings.settings,
      defaults: { tags: ["changed"] },
    };
    edges.logItem(
      "item.updated",
      answers.updated(folderItem(harness.settings)),
    );
    await push(4);
    expect(placings()).toBe(7);

    // Another key: they go again, and land.
    keyId = "another-key";
    refusing = false;
    await push(2);
    expect(placings()).toBe(10);
    expect(edges.placements(harness.settings.id).size).toBe(3);
  });

  it("keeps a file where the person moved it when the server refuses the move", async () => {
    let refusing = false;
    const edges = new EdgeDoor();
    edges.placing = () =>
      refusing
        ? refusal(
            403,
            "edge_permission_denied",
            "Write access to edge type denied",
          )
        : undefined;
    harness = await folderHarness("placement-move-refused");
    scriptFolderWrites(harness, { edges });
    put(harness, "one.md", "---\ntitle: One\n---\nwords\n");
    expect((await harness.folder.push()).ok).toBe(true);
    const id = idIn(harness, "one.md") ?? "";
    expect(edges.placements(harness.settings.id).get(id)).toBe("one.md");

    refusing = true;
    renameSync(join(harness.dir, "one.md"), join(harness.dir, "renamed.md"));
    for (let pass = 0; pass < 3; pass += 1) {
      expect((await harness.folder.push()).ok).toBe(true);
    }
    // The witness: the move was sent, and refused.
    expect(
      harness.server.requests.filter(
        (request) =>
          request.method === "PATCH" && request.pathname.startsWith("/edges/"),
      ).length,
    ).toBe(1);
    expect(edges.placements(harness.settings.id).get(id)).toBe("one.md");
    expect(
      idIn(harness, "renamed.md"),
      "a move the server refused took the file back to the path the server holds, undoing the rename",
    ).toBe(id);
    expect(existsSync(join(harness.dir, "one.md"))).toBe(false);
  });

  it("leaves the file a move would take away where the person saved it meanwhile", async () => {
    const moving = "01a00000-0000-7000-8000-00000000fa71";
    const placed = await placedHarness("placement-last-look", [
      { id: moving, title: "Moving", path: "moving.md" },
    ]);
    harness = placed.harness;
    expect((await harness.folder.pull()).ok).toBe(true);
    placed.edges.relocate(moving, harness.settings.id, "moved/moving.md");
    const pushed = await withFault("save-before-last-look", () =>
      harness!.folder.push(),
    );
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    // The witness: the move was written.
    expect(idIn(harness, "moved/moving.md")).toBe(moving);
    expect(
      read(harness, "moving.md"),
      "a move took away the file the person saved meanwhile",
    ).toContain("saved meanwhile");
  });

  it("skips a placement the filesystem refuses, and keeps the file where it was", async () => {
    const [blocker, victim, long, moving] = [
      "01a00000-0000-7000-8000-0000000016i1",
      "01a00000-0000-7000-8000-0000000016i2",
      "01a00000-0000-7000-8000-0000000016i3",
      "01a00000-0000-7000-8000-0000000016i4",
    ];
    const placed = await placedHarness("placement-unwritable", [
      { id: blocker, title: "Blocker", path: "Blocker.md" },
      { id: victim, title: "Victim", path: "Victim.md" },
      { id: long, title: "Long", path: "Long.md" },
      { id: moving, title: "Moving", path: "moving.md" },
    ]);
    harness = placed.harness;
    expect((await harness.folder.pull()).ok).toBe(true);
    // Another machine places one under a file, one at a name longer than
    // any filesystem takes, and moves a third.
    const folderId = harness.settings.id;
    placed.edges.relocate(victim, folderId, "Blocker.md/Victim.md");
    placed.edges.relocate(long, folderId, `${"x".repeat(300)}.md`);
    placed.edges.relocate(moving, folderId, "moved/moving.md");
    const pushed = await harness.folder.push();
    expect(
      pushed.ok,
      `a placement the filesystem refused stopped the pull: ${JSON.stringify(pushed)}`,
    ).toBe(true);
    if (!pushed.ok) return;
    expect(pushed.value.pull?.unwritten).toBe(2);
    expect(
      pushed.value.pull?.flagged
        .filter((file) => file.flag === "unwritten")
        .map((file) => [file.item, file.path]),
      "the pull counted a placement it could not write without naming the item",
    ).toEqual([
      [victim, "Blocker.md/Victim.md"],
      [long, `${"x".repeat(300)}.md`],
    ]);
    expect(
      [idIn(harness, "Victim.md"), idIn(harness, "Long.md")],
      "a file whose new placement could not be written was taken from where it was",
    ).toEqual([victim, long]);
    // The witness: every other file is pulled, a move among them.
    expect(idIn(harness, "moved/moving.md")).toBe(moving);
    expect(existsSync(join(harness.dir, "moving.md"))).toBe(false);
    // And the next pass goes on, sending nothing for them.
    const again = await harness.folder.push();
    expect(again.ok && again.value.drain.answered).toBe(0);
  });

  it("names a new item's file from its title, cut to the longest name a file system takes", async () => {
    const [first, second, lines, short] = [
      "01a00000-0000-7000-8000-0000000016n1",
      "01a00000-0000-7000-8000-0000000016n2",
      "01a00000-0000-7000-8000-0000000016n3",
      "01a00000-0000-7000-8000-0000000016n4",
    ];
    // 300 bytes of a three-byte character: the two titles differ only past
    // the cut, so their names meet.
    const long = "\u65e5".repeat(100);
    const placed = await placedHarness("placement-long-titles", [
      { id: first, title: long },
      { id: second, title: `${long} again` },
      { id: lines, title: "Line one\nLine two\tend" },
      // The control: a title that fits is its name whole.
      { id: short, title: "Short" },
    ]);
    harness = placed.harness;
    const pulled = await harness.folder.pull();
    expect(pulled.ok, JSON.stringify(pulled)).toBe(true);
    if (!pulled.ok) return;
    expect(
      [pulled.value.written, pulled.value.unwritten],
      "a long title's item got no file",
    ).toEqual([4, 0]);
    const cut = `${"\u65e5".repeat(84)}.md`;
    const numbered = `${"\u65e5".repeat(82)} (2).md`;
    expect(Buffer.byteLength(cut)).toBe(255);
    expect(
      [idIn(harness, cut), idIn(harness, numbered)].sort(),
      "two titles cut to one name were not set one beside the other",
    ).toEqual([first, second].sort());
    expect(idIn(harness, "Line one Line two end.md")).toBe(lines);
    expect(idIn(harness, "Short.md")).toBe(short);

    // Each placement is the name written, so the next pass sends nothing.
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    const placements = placed.edges.placements(harness.settings.id);
    expect(
      [first, second, lines, short].map((id) => placements.get(id)).sort(),
    ).toEqual([cut, numbered, "Line one Line two end.md", "Short.md"].sort());
    const before = harness.server.requests.filter(
      (request) => request.method !== "GET",
    ).length;
    expect((await harness.folder.push()).ok).toBe(true);
    expect(
      harness.server.requests.filter((request) => request.method !== "GET")
        .length,
      "a cut name kept being placed again",
    ).toBe(before);
  });

  it("reads a placement path with a leading separator from the folder's root", async () => {
    const [rooted, plain] = [
      "01a00000-0000-7000-8000-0000000016p1",
      "01a00000-0000-7000-8000-0000000016p2",
    ];
    // The edge door refuses such a path (`edges/folder-path`); one written past it
    // is served here.
    const placed = await placedHarness("placement-rooted", [
      { id: rooted, title: "Rooted", path: "/Abs//./Plan.md" },
      { id: plain, title: "Plain", path: "Plain.md" },
    ]);
    harness = placed.harness;
    const pulled = await harness.folder.pull();
    expect(pulled.ok, JSON.stringify(pulled)).toBe(true);
    if (!pulled.ok) return;
    expect(
      [pulled.value.outside, pulled.value.written],
      "a rooted placement was refused, or the pull wrote nothing at all",
    ).toEqual([0, 2]);
    expect(idIn(harness, "Abs/Plan.md")).toBe(rooted);
    expect(idIn(harness, "Plain.md")).toBe(plain);
  });

  it("reads no other edge to the folder as a placement", async () => {
    const edges = new EdgeDoor();
    // One file's default edge is refused, the other's already held.
    let answered = 0;
    edges.placing = (edge) => {
      if (edge.edge_type !== "references") return undefined;
      answered += 1;
      return answered === 1
        ? refusal(
            403,
            "edge_permission_denied",
            "Write access to edge type denied",
          )
        : answers.edgeDuplicate({
            source_id: edge.source_id,
            target_id: edge.target_id,
            edge_type: "references",
          });
    };
    harness = await folderHarness("placement-other-edges", {
      hydrate: false,
      events: [edges.stream()],
    });
    const folderId = harness.settings.id;
    harness.settings.settings = {
      ...harness.settings.settings,
      defaults: { edges: { references: [folderId] } },
    };
    harness.settings.version = 2;
    expect((await harness.folder.hydrate()).ok).toBe(true);
    scriptFolderWrites(harness, { edges });
    put(harness, "one.md", "---\ntitle: One\n---\nwords\n");
    put(harness, "two.md", "---\ntitle: Two\n---\nwords\n");
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    if (!pushed.ok) return;
    // The witness: both default edges were refused.
    expect(answered).toBe(2);
    expect(
      [pushed.value.drain.gave_way, pushed.value.pull?.unplaced],
      "a refusal of another edge to the folder was read as one of its placements",
    ).toEqual([0, 0]);

    // Another machine moves both files: this one follows, and sends nothing.
    const [one, two] = [idIn(harness, "one.md"), idIn(harness, "two.md")];
    edges.relocate(one ?? "", folderId, "moved/one.md");
    edges.relocate(two ?? "", folderId, "moved/two.md");
    const before = harness.server.requests.length;
    const followed = await harness.folder.push();
    expect(followed.ok, JSON.stringify(followed)).toBe(true);
    expect([
      idIn(harness, "moved/one.md"),
      idIn(harness, "moved/two.md"),
    ]).toEqual([one, two]);
    expect(
      harness.server.requests
        .slice(before)
        .filter((request) => request.pathname.startsWith("/edges")),
      "the folder pushed its own placement back over another machine's move",
    ).toEqual([]);
  });

  it("sends a refused placement again once the key's grant is restored, and not while the key cannot be read", async () => {
    let key: Answer = answers.currentKey("fixture-key", { "*": "write" });
    let refusing = false;
    const edges = new EdgeDoor();
    edges.placing = (edge) =>
      refusing && edge.edge_type === "in-folder"
        ? refusal(
            403,
            "edge_permission_denied",
            "Write access to edge type denied",
          )
        : undefined;
    harness = await folderHarness("placement-grant", { key: [() => key] });
    scriptFolderWrites(harness, { edges });
    const placings = () =>
      harness!.server.requests.filter(
        (request) =>
          request.method === "POST" &&
          request.pathname === "/edges" &&
          (JSON.parse(request.body) as { edge_type?: string }).edge_type ===
            "in-folder",
      ).length;
    const push = async (passes: number) => {
      for (let pass = 0; pass < passes; pass += 1) {
        const pushed = await harness!.folder.push();
        expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
      }
    };
    // The same key, its grant narrowed.
    key = answers.currentKey("fixture-key", { references: "write" });
    refusing = true;
    put(harness, "one.md", "---\ntitle: One\n---\nwords\n");
    await push(3);
    expect(placings()).toBe(1);

    // The key cannot be read: not a change.
    key = refusal(503, "unavailable", "Try again");
    await push(3);
    expect(
      placings(),
      "a key that could not be read was taken for another key",
    ).toBe(1);

    // The grant restored: the placement goes again, and lands.
    key = answers.currentKey("fixture-key", { "*": "write" });
    refusing = false;
    await push(2);
    expect(
      placings(),
      "a placement refused under a narrowed grant was not sent once the grant was restored",
    ).toBe(2);
    expect(edges.placements(harness.settings.id).size).toBe(1);
  });

  it("keeps a person's journaled delete when another item is placed at its path", async () => {
    const [gone, other] = [
      "01a00000-0000-7000-8000-0000000016k1",
      "01a00000-0000-7000-8000-0000000016k2",
    ];
    const placed = await placedHarness(
      "placement-over-journaled-delete",
      [
        { id: gone, title: "Gone", path: "Gone.md" },
        { id: other, title: "Other", path: "Other.md" },
      ],
      { search: { types: ["core.note"], state: ["active"] } },
    );
    harness = placed.harness;
    expect((await harness.folder.pull()).ok).toBe(true);
    rmSync(join(harness.dir, "Gone.md"));
    const journaled = await harness.folder.scan();
    expect(journaled.ok && journaled.value.missing).toBe(1);
    // Elsewhere the deleted file's item is archived, and the other item is
    // moved to the path it left.
    placed.edges.events.push(
      copyItemEvent(
        String(placed.edges.events.length + 2),
        "item.state_changed",
        wireItem({
          id: gone,
          properties: { title: "Gone", body: "Gone\n" },
          state: "archived",
        }),
      ),
    );
    placed.edges.relocate(other, harness.settings.id, "Gone.md");
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    // The witness: the other item's file now sits at the path.
    expect(idIn(harness, "Gone.md")).toBe(other);

    await new Promise((resolve) => setTimeout(resolve, 6_000));
    expect((await harness.folder.scan()).ok).toBe(true);
    const queued = await harness.folder.device().queue();
    expect(
      queued.ok &&
        queued.value
          .filter((row) => row.kind === "delete_item")
          .map((row) => row.item_id),
      "writing another item at a deleted file's path dropped that file's journaled delete",
    ).toEqual([gone]);
  });

  it("restores another item's binding and journal when a landing fails", async () => {
    const gone = "01a00000-0000-7000-8000-0000000016d8";
    const other = "01a00000-0000-7000-8000-0000000016d9";
    const placed = await placedHarness(
      "failed-placement-over-delete",
      [
        { id: gone, title: "Gone", path: "Gone.md" },
        { id: other, title: "Other", path: "Other.md" },
      ],
      { search: { types: ["core.note"], state: ["active"] } },
    );
    harness = placed.harness;
    expect((await harness.folder.pull()).ok).toBe(true);
    const source = read(harness, "Other.md");
    rmSync(join(harness.dir, "Gone.md"));
    const journaled = await harness.folder.scan();
    expect(journaled.ok && journaled.value.missing).toBe(1);
    placed.edges.events.push(
      copyItemEvent(
        String(placed.edges.events.length + 2),
        "item.state_changed",
        wireItem({
          id: gone,
          properties: { title: "Gone", body: "Gone\n" },
          state: "archived",
        }),
      ),
    );
    placed.edges.relocate(other, harness.settings.id, "Gone.md");
    const dir = harness.dir;
    const away = `${dir}-away`;
    try {
      const failed = await withFault("move-folder-before-write", () =>
        harness!.folder.push(),
      );
      expect(
        failed.ok && failed.value.pull?.unwritten,
        JSON.stringify(failed),
      ).toBe(1);
      expect(existsSync(away)).toBe(true);
    } finally {
      if (existsSync(away)) renameSync(away, dir);
    }
    expect(read(harness, "Other.md")).toBe(source);
    expect(existsSync(join(dir, "Gone.md"))).toBe(false);
    const status = await harness.folder.status();
    expect(
      status.ok &&
        status.value.files.find((file) => file.path === "Gone.md")?.item_id,
    ).toBe(gone);
    expect(
      status.ok &&
        status.value.files.find((file) => file.path === "Other.md")?.item_id,
    ).toBe(other);
    await new Promise((resolve) => setTimeout(resolve, 6_000));
    const scanned = await harness.folder.scan();
    expect(scanned.ok && scanned.value.created).toBe(0);
    const queued = await harness.folder.device().queue();
    expect(
      queued.ok &&
        queued.value
          .filter((row) => row.kind === "delete_item")
          .map((row) => row.item_id),
    ).toEqual([gone]);
    const retried = await harness.folder.pull();
    expect(retried.ok, JSON.stringify(retried)).toBe(true);
    expect(idIn(harness, "Gone.md")).toBe(other);
  });

  it("follows another Mac's move of an item whose move it was refused", async () => {
    let refusing = false;
    const edges = new EdgeDoor();
    edges.placing = () =>
      refusing
        ? refusal(
            403,
            "edge_permission_denied",
            "Write access to edge type denied",
          )
        : undefined;
    harness = await folderHarness("placement-refused-then-moved", {
      events: [edges.stream()],
    });
    scriptFolderWrites(harness, { edges });
    put(harness, "one.md", "---\ntitle: One\n---\nwords\n");
    expect((await harness.folder.push()).ok).toBe(true);
    const id = idIn(harness, "one.md") ?? "";
    const moves = () =>
      harness!.server.requests.filter(
        (request) =>
          request.method === "PATCH" && request.pathname.startsWith("/edges/"),
      ).length;

    refusing = true;
    renameSync(join(harness.dir, "one.md"), join(harness.dir, "renamed.md"));
    for (let pass = 0; pass < 2; pass += 1) {
      expect((await harness.folder.push()).ok).toBe(true);
    }
    // The witness: the move was refused, and the file kept where it was put.
    expect(moves()).toBe(1);
    expect(idIn(harness, "renamed.md")).toBe(id);

    // Another Mac, whose key may place, moves the item.
    edges.relocate(id, harness.settings.id, "moved/one.md");
    const followed = await harness.folder.push();
    expect(followed.ok, JSON.stringify(followed)).toBe(true);
    expect(
      existsSync(join(harness.dir, "moved/one.md")),
      "a refusal of this Mac's move kept the file where it sat, so another Mac's later move of the item was never followed",
    ).toBe(true);
    expect(idIn(harness, "moved/one.md")).toBe(id);
    expect(existsSync(join(harness.dir, "renamed.md"))).toBe(false);
    expect(followed.ok && followed.value.pull?.unplaced).toBe(0);
    expect(
      moves(),
      "the folder pushed its own move back over the other Mac's",
    ).toBe(1);
  });

  it("sends a refused move again once a later placement of the item lands", async () => {
    let refusals = 1;
    const edges = new EdgeDoor();
    edges.placing = () => {
      if (refusals === 0) return undefined;
      refusals -= 1;
      return refusal(422, "validation_failed", "Not there");
    };
    harness = await folderHarness("placement-refused-then-landed", {
      events: [edges.stream()],
    });
    scriptFolderWrites(harness, { edges });
    refusals = 0;
    put(harness, "one.md", "---\ntitle: One\n---\nwords\n");
    expect((await harness.folder.push()).ok).toBe(true);
    const id = idIn(harness, "one.md") ?? "";
    const folderId = harness.settings.id;
    const moveTo = async (from: string, to: string) => {
      renameSync(join(harness!.dir, from), join(harness!.dir, to));
      const pushed = await harness!.folder.push();
      expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    };

    refusals = 1;
    await moveTo("one.md", "there.md");
    // The witness: the move to there.md was refused.
    expect(edges.placements(folderId).get(id)).toBe("one.md");
    await moveTo("there.md", "elsewhere.md");
    expect(edges.placements(folderId).get(id)).toBe("elsewhere.md");

    await moveTo("elsewhere.md", "there.md");
    expect(
      edges.placements(folderId).get(id),
      "a move refused once was never sent again after a later placement of the item landed, so the server placed the file where it no longer sits",
    ).toBe("there.md");
    expect(idIn(harness, "there.md")).toBe(id);
  });

  it("sends a refused placement again while watching, once the key's grant is restored, reading the key at most once a minute", async () => {
    let key: Answer = answers.currentKey("fixture-key", { "*": "write" });
    let refusing = true;
    const edges = new EdgeDoor();
    edges.placing = (edge) =>
      refusing && edge.edge_type === "in-folder"
        ? refusal(
            403,
            "edge_permission_denied",
            "Write access to edge type denied",
          )
        : undefined;
    harness = await folderHarness("placement-grant-watch", {
      key: [() => key],
    });
    scriptFolderWrites(harness, { edges });
    // The same key, its grant narrowed once the folder is added.
    key = answers.currentKey("fixture-key", { references: "write" });
    const placings = () =>
      harness!.server.requests.filter(
        (request) =>
          request.method === "POST" &&
          request.pathname === "/edges" &&
          (JSON.parse(request.body) as { edge_type?: string }).edge_type ===
            "in-folder",
      ).length;
    const keyReads = () =>
      harness!.server.requests.filter(
        (request) =>
          request.method === "GET" && request.pathname === "/keys/current",
      ).length;
    const afterAdd = keyReads();
    put(harness, "one.md", "---\ntitle: One\n---\nwords\n");
    const watching = harness.folder.watchText();
    let restored = 0;
    try {
      await vi.waitFor(() => expect(placings()).toBe(1), {
        timeout: 20_000,
        interval: 100,
      });
      // The witness: the watch read the key, for the refusal to be recorded
      // under.
      await vi.waitFor(() => expect(keyReads()).toBeGreaterThan(afterAdd), {
        timeout: 20_000,
        interval: 100,
      });
      // Passes enough for a refused placement, or the key, to be asked again
      // at every one, were either.
      const readsAtRefusal = keyReads();
      await new Promise((resolve) => setTimeout(resolve, 5_000));
      expect(placings(), "a refused placement was sent pass after pass").toBe(
        1,
      );
      expect(
        keyReads() - readsAtRefusal,
        "a watch read the key at every pass while a refusal stood, which a server's rate limit does not allow",
      ).toBe(0);

      key = answers.currentKey("fixture-key", { "*": "write" });
      refusing = false;
      restored = Date.now();
      await vi.waitFor(
        () => expect(edges.placements(harness!.settings.id).size).toBe(1),
        { timeout: 70_000, interval: 250 },
      );
    } finally {
      await watching.stop();
    }
    expect(
      Date.now() - restored,
      "a restored grant was not met within the minute the key is read again in",
    ).toBeLessThan(65_000);
    expect(placings()).toBe(2);
  }, 110_000);

  it("asks a key it could not read again at most once a minute while watching", async () => {
    let key: Answer = answers.currentKey("fixture-key", { "*": "write" });
    const edges = new EdgeDoor();
    edges.placing = (edge) =>
      edge.edge_type === "in-folder"
        ? refusal(
            403,
            "edge_permission_denied",
            "Write access to edge type denied",
          )
        : undefined;
    harness = await folderHarness("placement-key-unreadable-watch", {
      key: [() => key],
    });
    scriptFolderWrites(harness, { edges });
    key = refusal(503, "unavailable", "Try again");
    const keyReads = () =>
      harness!.server.requests.filter(
        (request) =>
          request.method === "GET" && request.pathname === "/keys/current",
      ).length;
    const afterAdd = keyReads();
    put(harness, "one.md", "---\ntitle: One\n---\nwords\n");
    const watching = harness.folder.watchText();
    try {
      // The witness: the watch asked for the key, and was refused an answer.
      await vi.waitFor(() => expect(keyReads()).toBeGreaterThan(afterAdd), {
        timeout: 20_000,
        interval: 100,
      });
      const first = keyReads();
      await new Promise((resolve) => setTimeout(resolve, 5_000));
      expect(
        keyReads() - first,
        "a watch asked again at every pass for a key it could not read",
      ).toBe(0);
    } finally {
      await watching.stop();
    }
  });

  it("takes a key it could not read when a placement was refused as unchanged, and does not send the placement again", async () => {
    let key: Answer = answers.currentKey("fixture-key", { "*": "write" });
    const edges = new EdgeDoor();
    edges.placing = (edge) =>
      edge.edge_type === "in-folder"
        ? refusal(
            403,
            "edge_permission_denied",
            "Write access to edge type denied",
          )
        : undefined;
    harness = await folderHarness("placement-key-unread-at-refusal", {
      key: [() => key],
    });
    scriptFolderWrites(harness, { edges });
    const placings = () =>
      harness!.server.requests.filter(
        (request) =>
          request.method === "POST" &&
          request.pathname === "/edges" &&
          (JSON.parse(request.body) as { edge_type?: string }).edge_type ===
            "in-folder",
      ).length;
    // Refused while the key cannot be read.
    key = refusal(503, "unavailable", "Try again");
    put(harness, "one.md", "---\ntitle: One\n---\nwords\n");
    expect((await harness.folder.push()).ok).toBe(true);
    // The witness: the placement was sent and refused.
    expect(placings()).toBe(1);

    // The same key, readable again, with the grant it was refused under.
    key = answers.currentKey("fixture-key", { references: "write" });
    for (let pass = 0; pass < 2; pass += 1) {
      expect((await harness.folder.push()).ok).toBe(true);
    }
    expect(
      placings(),
      "a key that could not be read at the refusal was taken for another key once it could, and the placement was refused again",
    ).toBe(1);
  });

  it("says the placements it holds back once while watching", async () => {
    const edges = new EdgeDoor();
    edges.placing = (edge) =>
      edge.edge_type === "in-folder"
        ? refusal(
            403,
            "edge_permission_denied",
            "Write access to edge type denied",
          )
        : undefined;
    harness = await folderHarness("placement-unplaced-watch");
    scriptFolderWrites(harness, { edges });
    put(harness, "one.md", "---\ntitle: One\n---\nwords\n");
    const unplaced = "placement(s) the server refused";
    const watching = harness.folder.watchText();
    try {
      await vi.waitFor(() => expect(watching.stdout).toContain(unplaced), {
        timeout: 20_000,
        interval: 100,
      });
      // An eventful pass while the refusal stands: an edit of the file.
      put(harness, "one.md", read(harness, "one.md") + "more words\n");
      await vi.waitFor(() => expect(sentUpdates(harness!)).toHaveLength(1), {
        timeout: 20_000,
        interval: 100,
      });
      // Passes enough for the edit's own report to be printed.
      await new Promise((resolve) => setTimeout(resolve, 3_000));
    } finally {
      await watching.stop();
    }
    // The witness: the edit's pass was reported.
    expect(watching.stdout).toMatch(/0 created, 1 updated/);
    expect(
      watching.stdout.split(unplaced).length - 1,
      `a watch said the same placements held back at every pass that reported: ${watching.stdout}`,
    ).toBe(1);
  });

  it("gives a contested path to a placed item before an unplaced one, and to a file already there before a new one", async () => {
    const [placedId, fresh] = [
      "01a00000-0000-7000-8000-0000000016j1",
      "01a00000-0000-7000-8000-0000000016j2",
    ];
    const placed = await placedHarness("placement-ranks", [
      { id: placedId, title: "Placed", path: "Shared.md" },
      { id: fresh, title: "Note" },
    ]);
    harness = placed.harness;
    // Files made here whose placements the server refuses, so they sit at
    // their paths with none.
    const known = new Set([placedId, fresh]);
    placed.edges.placing = (edge) =>
      edge.edge_type === "in-folder" && !known.has(edge.source_id)
        ? refusal(400, "validation_error", "Not now")
        : undefined;
    put(harness, "Shared.md", "---\ntitle: Mine\n---\nmade here\n");
    put(harness, "Note.md", "---\ntitle: Also mine\n---\nmade here\n");
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    const made = (title: string) =>
      String(
        sentCreates(harness!).find(
          (sent) =>
            (sent.properties as Record<string, unknown>).title === title,
        )?.id,
      );
    const mine = [made("Mine"), made("Also mine")];
    expect(
      [idIn(harness, "Shared.md"), idIn(harness, "Note.md")],
      "an unplaced item kept a path over a placed one, or a new item took a path over the file already there",
    ).toEqual([placedId, mine[1]]);
    expect([
      idIn(harness, "Shared (2).md"),
      idIn(harness, "Note (2).md"),
    ]).toEqual([mine[0], fresh]);
  });

  it("counts the free number past a file on disk, a path another item is placed at, and its own file", async () => {
    const [first, second_, third] = [
      "01a00000-0000-7000-8000-0000000016k1",
      "01a00000-0000-7000-8000-0000000016k2",
      "01a00000-0000-7000-8000-0000000016k3",
    ];
    const placed = await placedHarness("placement-free", [
      { id: first, title: "First", path: "Shared.md" },
      { id: second_, title: "Second", path: "Shared.md" },
      { id: third, title: "Third", path: "Shared (2).md" },
    ]);
    harness = placed.harness;
    // A file nothing has scanned yet.
    put(harness, "Shared (3).md", "the person's own\n");
    const pulled = await harness.folder.pull();
    expect(pulled.ok, JSON.stringify(pulled)).toBe(true);
    expect(
      [
        idIn(harness, "Shared.md"),
        idIn(harness, "Shared (2).md"),
        idIn(harness, "Shared (4).md"),
      ],
      "the free number took a path another item is placed at, or a file on disk",
    ).toEqual([first, third, second_]);
    expect(read(harness, "Shared (3).md")).toBe("the person's own\n");
    expect((await harness.folder.push()).ok).toBe(true);

    // Another machine puts it back at the path it lost: it stays in its own
    // file, and once settled nothing more is written.
    placed.edges.relocate(second_, harness.settings.id, "Shared.md");
    expect((await harness.folder.push()).ok).toBe(true);
    expect((await harness.folder.push()).ok).toBe(true);
    expect(
      idIn(harness, "Shared (4).md"),
      "an item left its own file for another number",
    ).toBe(second_);
    expect(existsSync(join(harness.dir, "Shared (5).md"))).toBe(false);
    expect(placed.edges.placements(harness.settings.id).get(second_)).toBe(
      "Shared (4).md",
    );
    const before = harness.server.requests.filter(
      (request) => request.method !== "GET",
    ).length;
    expect((await harness.folder.push()).ok).toBe(true);
    expect(
      harness.server.requests.filter((request) => request.method !== "GET")
        .length,
    ).toBe(before);
  });

  it("places a new item under the most specific first placement naming its type", async () => {
    const image = Buffer.from("an image the server holds");
    const plain = Buffer.from("a file the server holds");
    harness = await folderHarness("placement-first-specific", {
      settings: {
        search: { types: ["core.file"] },
        first_placement: {
          "core.file": "Files/",
          "core.file.image": "Images/",
        },
      },
      rows: {
        "core.file": [
          {
            item: {
              id: "01a00000-0000-7000-8000-0000000016l1",
              type: "core.file.image",
              properties: {
                title: "photo.png",
                blob_ref: hashOf(image),
                mime_type: "image/png",
              },
            },
          },
          {
            item: {
              id: "01a00000-0000-7000-8000-0000000016l2",
              type: "core.file",
              properties: {
                title: "data.bin",
                blob_ref: hashOf(plain),
                mime_type: "application/octet-stream",
              },
            },
          },
        ],
      },
    });
    scriptFolderWrites(harness);
    scriptBlob(harness.server, image);
    scriptBlob(harness.server, plain);
    expect((await harness.folder.pull()).ok).toBe(true);
    expect(
      existsSync(join(harness.dir, "Images", "photo.png")),
      "an image went under its parent type's first placement over its own",
    ).toBe(true);
    expect(existsSync(join(harness.dir, "Files", "data.bin"))).toBe(true);
  });

  it("names the permission a key without in-folder write lacks, when it is added", async () => {
    // Each grant, and whether it writes `in-folder` as the server resolves it.
    const grants: Array<[Record<string, "read" | "write">, boolean]> = [
      [{ references: "write" }, false],
      [{ "*": "write", "in-folder": "read" }, false],
      [{ "*": "write", "in-folder.*": "read" }, false],
      [{ "in-folder.*": "write" }, true],
      [{ "*": "read", "in-folder.*": "write" }, true],
      [{ "*": "write" }, true],
    ];
    for (const [grant, places] of grants) {
      const server = await ScriptedServer.start();
      scriptHydration(server, {
        head: "1",
        key: [answers.currentKey("k", grant)],
      });
      const row = scriptFolderRow(server, {
        search: { types: ["core.note"] },
      });
      const dir = join(
        mkdtempSync(join(tmpdir(), "marfa-folder-no-placement-")),
        "notes",
      );
      const folder = new CliFolder(dir, {
        binary: requireBinary(),
        url: server.url,
        key: KEY,
      });
      try {
        const added = await folder.add(row.id);
        expect(added.ok, JSON.stringify(grant)).toBe(places);
        if (added.ok) continue;
        expect(added.refusal.raw).toContain("edge.in-folder:write");
        expect(
          existsSync(dir),
          "a refused add left its working copy behind",
        ).toBe(false);
      } finally {
        await server.stop();
      }
    }
  });

  it("does not let placement decide what it holds", async () => {
    const kept = "01a00000-0000-7000-8000-0000000016d1";
    const left = "01a00000-0000-7000-8000-0000000016d2";
    const unplaced = "01a00000-0000-7000-8000-0000000016d3";
    const placed = await placedHarness(
      "placement-not-membership",
      [
        { id: kept, title: "Kept", path: "Kept/one.md", tags: ["keep"] },
        { id: left, title: "Left", path: "Kept/out.md" },
        { id: unplaced, title: "Unplaced", tags: ["keep"] },
      ],
      { search: { types: ["core.note"], filter: 'tags contains "keep"' } },
    );
    harness = placed.harness;
    const pulled = await harness.folder.pull();
    expect(pulled.ok, JSON.stringify(pulled)).toBe(true);
    if (!pulled.ok) return;
    // The witness: a placement is followed for an item the search holds.
    expect(idIn(harness, "Kept/one.md")).toBe(kept);
    expect(
      existsSync(join(harness.dir, "Kept", "out.md")) ||
        existsSync(join(harness.dir, "Left.md")),
      "an item the search does not hold got a file because it has a placement here",
    ).toBe(false);
    expect(
      idIn(harness, "Unplaced.md"),
      "an item the search holds got no file because it has no placement here",
    ).toBe(unplaced);
    expect(pulled.value.written).toBe(2);
  });
});

describe("writing", () => {
  it("does not read its own writes back as changes", async () => {
    harness = await folderHarness("folder-echo", {
      rows: {
        "core.note": [
          {
            item: {
              id: "01a00000-0000-7000-8000-00000000000a",
              properties: { title: "Written", body: "by the folder\n" },
            },
          },
        ],
      },
    });
    scriptFolderWrites(harness);

    // The folder writes the file. The scan that follows must not read it
    // back as a change: a write the folder made never returns as one.
    const pulled = await harness.folder.pull();
    expect(pulled.ok).toBe(true);
    if (!pulled.ok) return;
    expect(pulled.value.written).toBe(1);

    const scanned = await harness.folder.scan();
    expect(scanned.ok).toBe(true);
    if (!scanned.ok) return;
    expect(
      [scanned.value.created, scanned.value.updated],
      "the folder read its own write back as a change, so every pull queues a push and the two never settle",
    ).toEqual([0, 0]);
    expect(
      scanned.value.unchanged,
      "the file the folder wrote was not recognized at all, so the absence above is the scan seeing nothing rather than seeing its own work",
    ).toBe(1);

    // The control: a change somebody else made is not suppressed.
    writeFileSync(
      join(harness.dir, "Written.md"),
      `${read(harness, "Written.md")}\nedited by a person\n`,
    );
    const edited = await harness.folder.scan();
    expect(edited.ok).toBe(true);
    if (!edited.ok) return;
    expect(
      edited.value.updated,
      "a change the folder did not make was suppressed too, so echo suppression is suppressing everything",
    ).toBe(1);
  });

  it("sends a file edited twice before a push as two edits, not a conflict with itself", async () => {
    const id = "01a00000-0000-7000-8000-00000000000a";
    harness = await folderHarness("folder-edit-twice", {
      rows: {
        "core.note": [
          {
            item: {
              id,
              properties: { title: "Twice", body: "as read\n" },
            },
          },
        ],
      },
    });
    const rows = scriptFolderWrites(harness);
    expect((await harness.folder.pull()).ok).toBe(true);

    // Two edits, each scanned before anything is sent: both are queued
    // against the version the copy holds, which the first does not move.
    for (const body of ["first edit", "second edit"]) {
      writeFileSync(
        join(harness.dir, "Twice.md"),
        `---\ntitle: Twice\n---\n${body}\n`,
      );
      const scanned = await harness.folder.scan();
      expect(scanned.ok, JSON.stringify(scanned)).toBe(true);
      if (!scanned.ok) return;
      expect(scanned.value.updated).toBe(1);
    }
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    if (!pushed.ok) return;

    expect(
      pushed.value.drain.verdicts
        .filter((entry) => entry.kind === "update_item")
        .map((entry) => entry.verdict),
      "the second edit of the file was not taken as sent: the server merged it against the folder's own first edit as though another machine had written it, and kept the first on the row with the second set aside in a copy",
    ).toEqual(["accepted", "accepted"]);
    expect(
      harness.server.requests
        .filter(
          (request) =>
            request.method === "PATCH" && request.pathname === `/items/${id}`,
        )
        .map(
          (request) =>
            (JSON.parse(request.body) as { version?: unknown }).version,
        ),
    ).toEqual([1, 2]);
    expect(String(rows.get(id)?.properties.body)).toContain("second edit");
  });

  it("sends a file saved twice as two edits where another machine retitled the note meanwhile", async () => {
    const noteId = "01a00000-0000-7000-8000-0000000000a1";
    const controlId = "01a00000-0000-7000-8000-0000000000a2";
    harness = await folderHarness("folder-save-twice-retitled", {
      rows: {
        "core.note": [
          {
            item: {
              id: noteId,
              properties: { title: "Note", body: "as read\n" },
            },
          },
          {
            item: {
              id: controlId,
              properties: { title: "Control", body: "as read\n" },
            },
          },
        ],
      },
    });
    let door: FolderDoor | undefined;
    const rows = scriptFolderWrites(harness, {
      door: (made) => {
        door = made;
      },
    });
    expect((await harness.folder.pull()).ok).toBe(true);
    // Two saves of each file, each scanned before anything is sent. A note
    // file carries its title, which the person leaves alone.
    for (const body of ["first save", "second save"]) {
      put(harness, "Note.md", `---\ntitle: Note\n---\n${body}\n`);
      put(harness, "Control.md", `---\ntitle: Control\n---\n${body}\n`);
      const scanned = await harness.folder.scan();
      expect(scanned.ok && scanned.value.updated).toBe(2);
    }
    // Another machine retitles the note, a property its file carries; and
    // sets notes on the control, a property its file does not.
    door?.update(noteId, { properties: { title: "Retitled" }, version: 1 });
    door?.update(controlId, { properties: { notes: "theirs" }, version: 1 });
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    if (!pushed.ok) return;

    const verdicts = (itemId: string) =>
      itemVerdicts(pushed.value.drain.verdicts)
        .filter((entry) => entry.item_id === itemId)
        .map((entry) => entry.verdict);
    // The control: what the other machine changed is nothing the file
    // carries, so both saves land.
    expect(verdicts(controlId)).toEqual(["accepted", "accepted"]);
    expect(
      verdicts(noteId),
      "the second save came back conflicted with the folder's own first, because the title the file carries unchanged was checked against the other machine's",
    ).toEqual(["accepted", "accepted"]);
    expect(rows.get(noteId)?.properties).toEqual({
      title: "Retitled",
      body: "second save\n",
    });
    expect(rows.get(controlId)?.properties).toEqual({
      title: "Control",
      body: "second save\n",
      notes: "theirs",
    });
    // The file ends on the second save, under the other machine's title.
    expect(read(harness, "Note.md")).toContain("second save");
    expect(read(harness, "Note.md")).toContain("title: Retitled");
    const copiesIn = (held: Iterable<DoorRow>) =>
      [...held].filter((row) => (row.tags ?? []).includes(CONFLICTED_COPY_TAG));
    // The witness: the same two saves, each sent on the version the file
    // was read at, leave a conflicted copy on this door, tagged.
    const control = new FolderDoor([
      [
        noteId,
        {
          properties: { title: "Note", body: "as read\n" },
          source_id: null,
          type: "core.note",
          version: 1,
        },
      ],
    ]);
    control.update(noteId, { properties: { title: "Retitled" }, version: 1 });
    for (const body of ["first save", "second save"]) {
      control.update(
        noteId,
        { properties: { title: "Note", body: `${body}\n` }, version: 1 },
        { resolve: true },
      );
    }
    expect(copiesIn(control.rows.values())).toHaveLength(1);
    expect(
      copiesIn(rows.values()),
      "a save was set aside in a conflicted copy",
    ).toEqual([]);
  });

  it("keeps a file whose newest save conflicted with its own earlier one, and sends it again", async () => {
    const id = "01a00000-0000-7000-8000-0000000000a3";
    harness = await folderHarness("folder-save-against-its-own", {
      rows: {
        "core.note": [
          {
            item: {
              id,
              properties: { title: "Note", body: "as read\n" },
            },
          },
        ],
      },
    });
    let door: FolderDoor | undefined;
    const rows = scriptFolderWrites(harness, {
      door: (made) => {
        door = made;
      },
    });
    expect((await harness.folder.pull()).ok).toBe(true);
    // The first save changes the body; the second the body and the title,
    // which another machine retitles meanwhile. The second cannot go on the
    // first's answer without taking its title over the other machine's, so
    // it goes on the first's base and collides with the first's body.
    put(harness, "Note.md", "---\ntitle: Note\n---\nfirst save\n");
    expect((await harness.folder.scan()).ok).toBe(true);
    put(harness, "Note.md", "---\ntitle: Mine\n---\nsecond save\n");
    expect((await harness.folder.scan()).ok).toBe(true);
    door?.update(id, { properties: { title: "Retitled" }, version: 1 });
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    if (!pushed.ok) return;
    // The witness: the second save was set aside in a copy, and the row
    // kept the first save's body.
    expect(
      itemVerdicts(pushed.value.drain.verdicts)
        .filter((entry) => entry.item_id === id)
        .map((entry) => entry.verdict),
    ).toEqual(["accepted", "conflicted"]);
    expect(rows.get(id)?.properties.body).toBe("first save\n");
    expect(
      read(harness, "Note.md"),
      "the pull wrote the row's older save over the file holding the newest one",
    ).toContain("second save");

    // The next push sends what the file holds as an edit of the row.
    const again = await harness.folder.push();
    expect(again.ok, JSON.stringify(again)).toBe(true);
    if (!again.ok) return;
    expect(
      itemVerdicts(again.value.drain.verdicts)
        .filter((entry) => entry.item_id === id)
        .map((entry) => entry.verdict),
    ).toEqual(["accepted"]);
    expect(rows.get(id)?.properties).toEqual({
      title: "Mine",
      body: "second save\n",
    });
    expect(read(harness, "Note.md")).toContain("second save");
  });

  /**
   * A note an editor holds as the pull wrote it, at version 1, while another
   * machine retitles it and the next push writes that out at version 2.
   * Answers the door, what it holds, and the text the editor still holds.
   */
  async function heldWhileRetitled(
    label: string,
    id: string,
    extra: Record<string, unknown> = {},
  ) {
    harness = await folderHarness(label, {
      rows: {
        "core.note": [
          {
            item: {
              id,
              version: 1,
              properties: { title: "Note", body: "as read\n", ...extra },
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
              properties: { title: "Retitled", body: "as read\n", ...extra },
            }),
          ),
        ]),
      ],
    });
    let door: FolderDoor | undefined;
    const rows = scriptFolderWrites(harness, {
      door: (made) => {
        door = made;
      },
    });
    expect((await harness.folder.pull()).ok).toBe(true);
    const held = read(harness, "Note.md");
    expect(held).toContain("marfa_version: 1");
    door?.update(id, { properties: { title: "Retitled" }, version: 1 });
    expect((await harness.folder.push()).ok).toBe(true);
    // The witness that the file was stale: the pull wrote the retitle out.
    expect(read(harness, "Note.md")).toContain("title: Retitled");
    expect(read(harness, "Note.md")).toContain("marfa_version: 2");
    return { door: door!, rows, held };
  }

  it("bases a stale file's edit on the version written in it", async () => {
    const id = "01a00000-0000-7000-8000-0000000000b1";
    const { rows, held } = await heldWhileRetitled("folder-version-base", id);
    // Saved twice before anything is sent: the second is made against the
    // first, not the version the line names.
    for (const body of ["my edit", "my edit, twice"]) {
      put(harness!, "Note.md", held.replace("as read", body));
      const scanned = await harness!.folder.scan();
      expect(scanned.ok && scanned.value.updated).toBe(1);
    }
    const pushed = await harness!.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    if (!pushed.ok) return;

    expect(
      sentUpdates(harness!).map((update) => update.body.version),
      "an edit went on a version it was not made against: the first on the version the copy holds puts the title it read over the other machine's, and the second on the line the first went on is merged against the first",
    ).toEqual([1, 3]);
    expect(
      pushed.value.drain.verdicts.map((entry) => entry.verdict),
      "the second edit went on the line the first already went on, and was merged against the first as though another machine had written it",
    ).toEqual(["accepted", "accepted"]);
    expect(rows.get(id)?.properties).toEqual({
      title: "Retitled",
      body: "my edit, twice\n",
    });
    expect(
      [...rows.values()].filter((row) =>
        (row.tags ?? []).includes(CONFLICTED_COPY_TAG),
      ),
    ).toEqual([]);
    // The pull writes the file anyway, and the line with it.
    const now = read(harness!, "Note.md");
    expect(now).toContain("title: Retitled");
    expect(now).toContain("my edit, twice");
    expect(now).toContain("marfa_version: 4");
  });

  it("folder rebase accounts for every unmade request", async () => {
    const id = "01a00000-0000-7000-8000-0000000000b2";
    const { door, held } = await heldWhileRetitled("folder-rebase-counts", id);
    door.thin(id, 1);
    put(harness!, "Note.md", held.replace("as read", "my edit"));
    expect((await harness!.folder.scan()).ok).toBe(true);
    const path = join(harness!.dir, ".invalid-upload");
    writeFileSync(path, "bytes");
    const queued = await harness!.folder
      .device()
      .putBlob(path, "text/plain\ninvalid");
    expect(queued.ok, JSON.stringify(queued)).toBe(true);
    const pushed = await harness!.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    if (!pushed.ok) return;
    const attempts = pushed.value.drain.verdicts.filter(
      (v) => v.kind === "upload_blob",
    );
    expect(attempts).toHaveLength(2);
    expect(pushed.value.drain.unmade).toBe(attempts.length);
  });

  it("folder rebase accounts for writes refused in its later pass", async () => {
    const id = "01a00000-0000-7000-8000-0000000000b2";
    const { door, held } = await heldWhileRetitled("folder-rebase-counts", id);
    door.thin(id, 1);
    put(harness!, "Note.md", held.replace("as read", "my edit"));
    expect((await harness!.folder.scan()).ok).toBe(true);
    const path = join(harness!.dir, ".invalid-upload");
    writeFileSync(path, "bytes");
    const queued = await harness!.folder
      .device()
      .attach(id, path, { mimeType: "text/plain\ninvalid" });
    expect(queued.ok, JSON.stringify(queued)).toBe(true);
    for (let n = 0; n < 3; n += 1)
      expect((await harness!.folder.device().drain()).ok).toBe(true);
    const pushed = await harness!.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    if (!pushed.ok) return;
    const attempts = pushed.value.drain.verdicts.filter(
      (v) => v.kind === "upload_blob",
    );
    expect(attempts).toHaveLength(2);
    expect(pushed.value.drain.unsent).toBe(2);
  });

  it("sends over a thinned version as a merge, and says so", async () => {
    const id = "01a00000-0000-7000-8000-0000000000b2";
    const { door, rows, held } = await heldWhileRetitled(
      "folder-version-thinned",
      id,
    );
    door.thin(id, 1);
    // Saved twice from the old buffer before anything is sent, so the
    // second goes after the first rather than beside it.
    for (const body of ["my edit", "my edit, twice"]) {
      put(harness!, "Note.md", held.replace("as read", body));
      expect((await harness!.folder.scan()).ok).toBe(true);
    }
    const pushed = await harness!.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    if (!pushed.ok) return;

    expect(
      sentUpdates(harness!).map((update) => update.body.version),
      "the edits were not sent again on the version the copy holds, one after the other, once the server said it no longer held the one the file names",
    ).toEqual([1, 1, 2, 3]);
    expect(
      pushed.value.drain.verdicts.map((entry) => [entry.verdict, entry.reason]),
    ).toEqual([
      ["blocked", "ancestor_unavailable"],
      ["blocked", "ancestor_unavailable"],
      ["accepted", null],
      ["accepted", null],
    ]);
    expect(
      pushed.value.drain.rebased,
      "the push did not say the edits went over whatever changed since their file was written",
    ).toBe(2);
    expect(
      sentUpdates(harness!).map(
        (update) => update.body.properties_mode ?? "merge",
      ),
      "an edit from a file behind the copy went whole, clearing whatever another machine added since",
    ).toEqual(["merge", "merge", "merge", "merge"]);
    // Not merged against what the file was read from, so the title it
    // carries went over the other machine's.
    expect(rows.get(id)?.properties).toEqual({
      title: "Note",
      body: "my edit, twice\n",
    });
    expect(door.conflictedCopies()).toEqual([]);
    expect(read(harness!, "Note.md")).toContain("marfa_version: 4");

    // The old text saved once more is on a spent line, so nothing is rebased.
    put(harness!, "Note.md", held.replace("as read", "my edit, again"));
    const again = await harness!.folder.push();
    expect(
      again.ok && [
        again.value.drain.rebased,
        sentUpdates(harness!).at(-1)?.body.version,
      ],
    ).toEqual([0, 4]);
    expect(rows.get(id)?.properties.body).toBe("my edit, again\n");
  });

  it("merges a file behind the copy, clearing nothing its lines left out", async () => {
    const id = "01a00000-0000-7000-8000-000000001491";
    const { door, held } = await heldWhileRetitled("folder-behind-merges", id, {
      status: "draft",
    });
    put(
      harness!,
      "Note.md",
      held.replace("status: draft\n", "").replace("as read", "my edit"),
    );
    const pushed = await harness!.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    const [edit] = sentUpdates(harness!).filter((sent) => sent.id === id);
    expect(
      [edit?.body.version, edit?.body.properties_mode],
      "a file behind the copy went whole, so a line it never showed another machine's change of was cleared",
    ).toEqual([1, undefined]);
    expect(door.rows.get(id)?.properties).toEqual({
      title: "Retitled",
      body: "my edit\n",
      status: "draft",
    });
    expect(read(harness!, "Note.md")).toMatch(/^status: draft$/m);
  });

  it("merges a file whose line names a version the copy skipped against that line", async () => {
    const id = "01a00000-0000-7000-8000-000000001493";
    harness = await folderHarness("folder-skipped-version", {
      rows: {
        "core.note": [
          {
            item: {
              id,
              version: 1,
              properties: { title: "Note", body: "as read\n" },
            },
          },
        ],
      },
      events: [
        copyLiveReplay("3", [
          copyItemEvent(
            "3",
            "item.updated",
            wireItem({
              id,
              version: 3,
              properties: { title: "Retitled", body: "as read\n" },
            }),
          ),
        ]),
      ],
    });
    let door: FolderDoor | undefined;
    scriptFolderWrites(harness, {
      door: (made) => {
        door = made;
      },
    });
    expect((await harness.folder.pull()).ok).toBe(true);
    door?.update(id, { properties: { title: "Titled" }, version: 1 });
    door?.update(id, { properties: { title: "Retitled" }, version: 2 });
    expect((await harness.folder.push()).ok).toBe(true);
    // The copy went from 1 to 3 and never held 2.
    const written = read(harness, "Note.md");
    expect(written).toContain("marfa_version: 3");
    put(
      harness,
      "Note.md",
      written
        .replace("marfa_version: 3", "marfa_version: 2")
        .replace("as read", "my edit"),
    );
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    if (!pushed.ok) return;
    const [edit] = sentUpdates(harness).filter((sent) => sent.id === id);
    expect(
      [edit?.body.version, edit?.body.properties_mode],
      "a line lower than the copy's that it never held went on the copy's version, or whole",
    ).toEqual([2, undefined]);
    expect(pushed.value.scan.flagged, "the merge was flagged").toEqual([]);
    expect(door?.rows.get(id)?.properties).toEqual({
      title: "Retitled",
      body: "my edit\n",
    });
  });

  it("sends a save after a refused edit as behind, keeping what another machine changed or added", async () => {
    const id = "01a00000-0000-7000-8000-000000001492";
    const edges = new EdgeDoor();
    harness = await folderHarness("folder-refused-then-behind", {
      settings: { search: { types: ["core.note", "core.bookmark"] } },
      rows: {
        "core.note": [
          {
            item: {
              id,
              properties: { title: "T", body: "as read\n", status: "draft" },
            },
          },
        ],
      },
      events: [edges.stream()],
    });
    let door: FolderDoor | undefined;
    scriptFolderWrites(harness, {
      edges,
      door: (made) => {
        door = made;
      },
    });
    const update = door!.update.bind(door!);
    door!.update = ((...args: Parameters<FolderDoor["update"]>) =>
      args[1].retype === true
        ? refusal(403, "type_not_permitted", "no bookmarks")
        : update(...args)) as FolderDoor["update"];
    expect((await harness.folder.pull()).ok).toBe(true);
    const retyped = read(harness, "T.md").replace(
      "type: core.note",
      "type: core.bookmark",
    );
    writeFileSync(join(harness.dir, "T.md"), retyped);
    expect((await harness.folder.push()).ok).toBe(true);
    // Another machine adds a property this file never showed.
    edges.logItem(
      "item.updated",
      update(id, {
        properties: { status: "done", extra: "theirs" },
        version: 1,
      }),
    );
    expect((await harness.folder.push()).ok).toBe(true);
    writeFileSync(
      join(harness.dir, "T.md"),
      retyped
        .replace("type: core.bookmark", "type: core.note")
        .replace("as read", "my edit"),
    );
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    expect(
      door!.rows.get(id)?.properties,
      "the save after the refusal went on a version the file never saw, reverting or clearing another machine's change",
    ).toEqual({
      title: "T",
      body: "my edit\n",
      status: "done",
      extra: "theirs",
    });
  });

  it("says in words that an edit went over a thinned version", async () => {
    const id = "01a00000-0000-7000-8000-0000000000b6";
    const { door, held } = await heldWhileRetitled(
      "folder-version-thinned-words",
      id,
    );
    // The witness: a push that rebases nothing says nothing of it.
    const quiet = await harness!.folder.pushText();
    expect(quiet.ok && quiet.value).not.toContain("no longer holds");
    door.thin(id, 1);
    put(harness!, "Note.md", held.replace("as read", "my edit"));
    const said = await harness!.folder.pushText();
    expect(said.ok, JSON.stringify(said)).toBe(true);
    expect(said.ok && said.value).toContain(
      "1 edit(s) written from a version the server no longer holds, sent again on the version this copy holds",
    );
  });

  it("stops at one resend where the server no longer holds the version the copy holds either", async () => {
    const id = "01a00000-0000-7000-8000-0000000000b8";
    const { door, rows, held } = await heldWhileRetitled(
      "folder-version-thinned-twice",
      id,
    );
    // The server moves on without the copy hearing, and thins both versions.
    door.update(id, { properties: { title: "Again" }, version: 2 });
    door.thin(id, 1);
    door.thin(id, 2);
    put(harness!, "Note.md", held.replace("as read", "my edit"));
    const pushed = await harness!.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    if (!pushed.ok) return;
    expect(
      sentUpdates(harness!).map((update) => update.body.version),
      "the edit was sent again past the one resend a pass allows",
    ).toEqual([1, 2]);
    expect(
      pushed.value.drain.verdicts.map((entry) => [entry.verdict, entry.reason]),
    ).toEqual([
      ["blocked", "ancestor_unavailable"],
      ["blocked", "ancestor_unavailable"],
    ]);
    expect([pushed.value.drain.answered, pushed.value.drain.rebased]).toEqual([
      2, 1,
    ]);
    expect(rows.get(id)?.properties.title).toBe("Again");
  });

  it("keeps a line spent where a pull writes the file over the edit that spent it", async () => {
    const id = "01a00000-0000-7000-8000-0000000000b9";
    harness = await folderHarness("folder-version-spent-under-pull", {
      rows: {
        "core.note": [
          {
            item: {
              id,
              version: 1,
              properties: { title: "Note", body: "as read\n" },
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
              properties: { title: "Note", body: "as read\n", extra: "theirs" },
            }),
          ),
        ]),
      ],
    });
    let door: FolderDoor | undefined;
    const rows = scriptFolderWrites(harness, {
      door: (made) => {
        door = made;
      },
    });
    expect((await harness.folder.pull()).ok).toBe(true);
    const held = read(harness, "Note.md");
    door!.update(id, { properties: { extra: "theirs" }, version: 1 });
    const update = door!.update.bind(door!);
    let failed = false;
    door!.update = ((...args: Parameters<FolderDoor["update"]>) => {
      if (failed) return update(...args);
      failed = true;
      return refusal(503, "service_unavailable", "later");
    }) as FolderDoor["update"];

    const first = held.replace("as read", "mine");
    put(harness, "Note.md", first);
    expect((await harness.folder.push()).ok).toBe(true);
    // The witness: the pull wrote the file over the waiting edit.
    expect(read(harness, "Note.md")).toContain("marfa_version: 2");

    // An editor that did not reload saves on from its first buffer.
    put(harness, "Note.md", first.replace("mine", "mine, more"));
    const more = await harness.folder.push();
    expect(more.ok, JSON.stringify(more)).toBe(true);
    expect(
      door!.conflictedCopies(),
      "a save made on from the first was merged against it as another machine's",
    ).toEqual([]);
    expect(rows.get(id)?.properties.body).toBe("mine, more\n");
  });

  it("sends nothing for a save that changes only the version line", async () => {
    const id = "01a00000-0000-7000-8000-0000000000ba";
    harness = await folderHarness("folder-version-line-only", {
      rows: {
        "core.note": [
          {
            item: {
              id,
              version: 1,
              properties: { title: "Note", body: "as read\n" },
            },
          },
        ],
      },
      events: [copyLiveReplay("1", [])],
    });
    const rows = scriptFolderWrites(harness);
    expect((await harness.folder.pull()).ok).toBe(true);
    const held = read(harness, "Note.md");
    const mine = held.replace("as read", "mine");
    put(harness, "Note.md", mine);
    expect((await harness.folder.push()).ok).toBe(true);
    // The witness: the line was rewritten under the editor.
    expect(read(harness, "Note.md")).toContain("marfa_version: 2");

    // The editor saves its buffer back, and a person types a line of their own.
    for (const saved of [
      mine,
      mine.replace("marfa_version: 1", "marfa_version: 99"),
    ]) {
      put(harness, "Note.md", saved);
      const pushed = await harness.folder.push();
      expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    }
    expect(
      sentUpdates(harness).map((update) => update.body.version),
      "a save that changed only the version line sent an edit, and each such save moves the version again",
    ).toEqual([1]);
    expect(rows.get(id)?.version).toBe(2);

    // A line naming a version the copy has not reached is no base.
    put(
      harness,
      "Note.md",
      mine
        .replace("marfa_version: 1", "marfa_version: 99")
        .replace("mine", "mine, more"),
    );
    expect((await harness.folder.push()).ok).toBe(true);
    expect(sentUpdates(harness).at(-1)?.body.version).toBe(2);
    expect(rows.get(id)?.properties.body).toBe("mine, more\n");
  });

  it("writes the line into a file saved without one, once its edit lands", async () => {
    const id = "01a00000-0000-7000-8000-0000000000bb";
    harness = await folderHarness("folder-version-line-restored", {
      rows: {
        "core.note": [
          {
            item: {
              id,
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
    const held = read(harness, "Note.md");
    // The witness: the pull wrote a line to take out.
    expect(held).toContain("marfa_version: 1\n");
    put(
      harness,
      "Note.md",
      held.replace("marfa_version: 1\n", "").replace("as read", "mine"),
    );
    expect((await harness.folder.push()).ok).toBe(true);
    expect(
      read(harness, "Note.md"),
      "a file saved without its line never got it back once its edit landed",
    ).toContain("marfa_version: 2");
  });

  it("says while watching that an edit went over a thinned version", async () => {
    const id = "01a00000-0000-7000-8000-0000000000b7";
    const { door, held } = await heldWhileRetitled(
      "folder-version-thinned-watched",
      id,
    );
    door.thin(id, 1);
    put(harness!, "Note.md", held.replace("as read", "my edit"));
    const watching = harness!.folder.watchText();
    try {
      await vi.waitFor(
        () =>
          expect(watching.stdout).toContain(
            "1 edit(s) written from a version the server no longer holds",
          ),
        { timeout: 20_000, interval: 100 },
      );
    } finally {
      await watching.stop();
    }
  });

  it("does not rewrite a file for its version line alone", async () => {
    const id = "01a00000-0000-7000-8000-0000000000b3";
    const row = (version: number, body: string, occurred_at?: string) =>
      copyItemEvent(
        String(version),
        "item.updated",
        wireItem({
          id,
          version,
          properties: { title: "Note", body },
          ...(occurred_at === undefined ? {} : { occurred_at }),
        }),
      );
    harness = await folderHarness("folder-version-line-alone", {
      rows: {
        "core.note": [
          {
            item: {
              id,
              version: 1,
              properties: { title: "Note", body: "as read\n" },
            },
          },
        ],
      },
      events: [
        // Another machine moves the item's own time, which no file carries.
        copyLiveReplay("2", [row(2, "as read\n", "2026-09-19T00:00:00.000Z")]),
        copyLiveReplay("2", []),
        copyLiveReplay("4", [row(4, "theirs\n", "2026-09-19T00:00:00.000Z")]),
      ],
    });
    let door: FolderDoor | undefined;
    scriptFolderWrites(harness, {
      door: (made) => {
        door = made;
      },
    });
    expect((await harness.folder.pull()).ok).toBe(true);
    const written = read(harness, "Note.md");
    expect(written).toContain("marfa_version: 1");

    door?.update(id, { properties: {}, version: 1 });
    const moved = await harness.folder.push();
    expect(moved.ok, JSON.stringify(moved)).toBe(true);
    if (!moved.ok) return;
    expect(
      moved.value.catch_up.caught_up?.applied,
      "the catch-up never moved the copy, so a file left alone proves nothing",
    ).toBe(1);
    expect(
      [read(harness, "Note.md"), moved.value.pull?.rewritten],
      "the pull wrote the file for its version line alone, which wakes every editor holding it for nothing",
    ).toEqual([written, 0]);

    // The file's own edit, not yet landed: the line stays.
    const mine = written.replace("as read", "mine");
    put(harness, "Note.md", mine);
    expect((await harness.folder.scan()).ok).toBe(true);
    const waiting = await harness.folder.pull();
    expect(
      [read(harness, "Note.md"), waiting.ok && waiting.value.rewritten],
      "the pull wrote the line before the file's own edit landed",
    ).toEqual([mine, 0]);

    // Landed, with the file unchanged since its scan.
    const landed = await harness.folder.push();
    expect(landed.ok, JSON.stringify(landed)).toBe(true);
    if (!landed.ok) return;
    expect(
      read(harness, "Note.md"),
      "the line was left behind the file's own edit, so the next edit is merged against this one as though another machine wrote it",
    ).toBe(
      written
        .replace("as read", "mine")
        .replace("marfa_version: 1", "marfa_version: 3"),
    );

    // And a pull that writes the file anyway writes the line with it.
    door?.update(id, { properties: { body: "theirs\n" }, version: 3 });
    const theirs = await harness.folder.push();
    expect(theirs.ok, JSON.stringify(theirs)).toBe(true);
    expect(read(harness, "Note.md")).toContain("theirs");
    expect(read(harness, "Note.md")).toContain("marfa_version: 4");
  });

  it("rewrites the line once its own edit lands, where a pull wrote the file while that edit waited", async () => {
    const id = "01a00000-0000-7000-8000-0000000000b4";
    harness = await folderHarness("folder-version-written-while-waiting", {
      rows: {
        "core.note": [
          {
            item: {
              id,
              version: 1,
              properties: { title: "Note", body: "as read\n" },
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
              properties: { title: "Note", body: "as read\n", extra: "theirs" },
            }),
          ),
        ]),
        copyLiveReplay("3", []),
      ],
    });
    let door: FolderDoor | undefined;
    const rows = scriptFolderWrites(harness, {
      door: (made) => {
        door = made;
      },
    });
    expect((await harness.folder.pull()).ok).toBe(true);
    const written = read(harness, "Note.md");
    door!.update(id, { properties: { extra: "theirs" }, version: 1 });
    // The first send meets a failing server, so the edit still waits when
    // the pull writes the other machine's change out.
    const update = door!.update.bind(door!);
    let failed = false;
    door!.update = ((...args: Parameters<FolderDoor["update"]>) => {
      if (failed) return update(...args);
      failed = true;
      return refusal(503, "service_unavailable", "later");
    }) as FolderDoor["update"];

    put(harness, "Note.md", written.replace("as read", "mine"));
    const waiting = await harness.folder.push();
    expect(waiting.ok, JSON.stringify(waiting)).toBe(true);
    // The witness: the pull wrote the file over the waiting edit.
    expect(read(harness, "Note.md")).toContain("extra: theirs");
    expect(read(harness, "Note.md")).toContain("mine");
    expect(read(harness, "Note.md")).toContain("marfa_version: 2");

    const landed = await harness.folder.push();
    expect(landed.ok, JSON.stringify(landed)).toBe(true);
    expect(rows.get(id)?.version).toBe(3);
    expect(
      read(harness, "Note.md"),
      "the line stayed behind the file's own edit, so the next edit is merged against it as though another machine wrote it",
    ).toContain("marfa_version: 3");

    put(
      harness,
      "Note.md",
      read(harness, "Note.md").replace("mine", "mine, more"),
    );
    const more = await harness.folder.push();
    expect(more.ok, JSON.stringify(more)).toBe(true);
    expect(more.ok && more.value.drain.verdicts.map((v) => v.verdict)).toEqual([
      "accepted",
    ]);
    expect(rows.get(id)?.properties.body).toBe("mine, more\n");
    expect(door!.conflictedCopies()).toEqual([]);
  });

  it("keeps the line a pull wrote over a waiting edit spent, once that edit lands", async () => {
    const id = "01a00000-0000-7000-8000-0000000000bd";
    const properties = { title: "Note", body: "as read\n" };
    harness = await folderHarness("folder-version-pulled-over-waiting", {
      rows: { "core.note": [{ item: { id, version: 1, properties } }] },
      events: [
        copyLiveReplay("2", [
          copyItemEvent(
            "2",
            "item.updated",
            wireItem({
              id,
              version: 2,
              properties: { ...properties, extra: "theirs" },
            }),
          ),
        ]),
        copyLiveReplay("2", []),
        copyLiveReplay("4", [
          copyItemEvent(
            "4",
            "item.updated",
            wireItem({
              id,
              version: 4,
              properties: {
                ...properties,
                body: "mine\n",
                extra: "theirs",
                later: "theirs too",
              },
            }),
          ),
        ]),
      ],
    });
    let door: FolderDoor | undefined;
    const rows = scriptFolderWrites(harness, {
      door: (made) => {
        door = made;
      },
    });
    expect((await harness.folder.pull()).ok).toBe(true);
    const written = read(harness, "Note.md");
    door!.update(id, { properties: { extra: "theirs" }, version: 1 });
    const update = door!.update.bind(door!);
    let failed = false;
    door!.update = ((...args: Parameters<FolderDoor["update"]>) => {
      if (failed) return update(...args);
      failed = true;
      return refusal(503, "service_unavailable", "later");
    }) as FolderDoor["update"];

    put(harness, "Note.md", written.replace("as read", "mine"));
    expect((await harness.folder.push()).ok).toBe(true);
    // The pull wrote the file over the waiting edit, and an editor holds
    // that buffer.
    const buffer = read(harness, "Note.md");
    expect(buffer).toContain("mine");
    expect(buffer).toContain("marfa_version: 2");

    const landed = await harness.folder.push();
    expect(landed.ok, JSON.stringify(landed)).toBe(true);
    expect(rows.get(id)?.version).toBe(3);
    // Another machine adds a property, and the pull writes the file past
    // the buffer's line.
    door!.update(id, { properties: { later: "theirs too" }, version: 3 });
    expect((await harness.folder.push()).ok).toBe(true);
    // The witness: the file on disk no longer shows the buffer's line.
    expect(read(harness, "Note.md")).toContain("marfa_version: 4");

    // The editor saves on from the buffer the pull wrote, without reloading.
    put(harness, "Note.md", buffer.replace("mine", "mine, more"));
    const more = await harness.folder.push();
    expect(more.ok, JSON.stringify(more)).toBe(true);
    expect(
      sentUpdates(harness).at(-1)?.body.version,
      "a save from the buffer the pull wrote over the waiting edit went on the line before that edit landed, and was merged against it as though another machine wrote it",
    ).toBe(4);
    expect(door!.conflictedCopies()).toEqual([]);
    expect(rows.get(id)?.properties).toMatchObject({
      body: "mine, more\n",
      later: "theirs too",
    });
  });

  /** A note at version 1 whose server logs every item write it takes as an
   *  event, with the door handed back for a fixture to answer in its place. */
  async function spentLineHarness(
    label: string,
    id: string,
  ): Promise<{
    door: FolderDoor;
    edges: EdgeDoor;
    rows: Map<string, DoorRow>;
    update: FolderDoor["update"];
  }> {
    const edges = new EdgeDoor();
    harness = await folderHarness(label, {
      rows: {
        "core.note": [
          {
            item: {
              id,
              version: 1,
              properties: { title: "Note", body: "as read\n" },
            },
          },
        ],
      },
      events: [edges.stream()],
    });
    let door: FolderDoor | undefined;
    const rows = scriptFolderWrites(harness, {
      edges,
      door: (made) => {
        door = made;
      },
    });
    expect((await harness.folder.pull()).ok).toBe(true);
    return { door: door!, edges, rows, update: door!.update.bind(door!) };
  }

  it("takes back the line a pull wrote over a waiting edit when that edit is refused", async () => {
    const id = "01a00000-0000-7000-8000-0000000000be";
    const { door, edges, update } = await spentLineHarness(
      "folder-version-pulled-then-refused",
      id,
    );
    const written = read(harness!, "Note.md");
    edges.logItem(
      "item.updated",
      update(id, { properties: { extra: "theirs" }, version: 1 }),
    );
    const answers_: Answer[] = [
      refusal(503, "service_unavailable", "later"),
      refusal(422, "validation_failed", "not this"),
    ];
    door.update = ((...args: Parameters<FolderDoor["update"]>) =>
      answers_.shift() ?? update(...args)) as FolderDoor["update"];

    put(harness!, "Note.md", written.replace("as read", "mine"));
    expect((await harness!.folder.push()).ok).toBe(true);
    // The witness: the pull wrote the file at v2 over the waiting edit.
    const buffer = read(harness!, "Note.md");
    expect(buffer).toContain("marfa_version: 2");
    expect(buffer).toContain("mine");
    const refused = await harness!.folder.push();
    expect(
      refused.ok && refused.value.drain.verdicts.map((entry) => entry.reason),
    ).toEqual(["validation_failed"]);

    // Another machine moves the item on, and the editor saves its buffer.
    edges.logItem(
      "item.updated",
      update(id, { properties: { later: "theirs too" }, version: 2 }),
    );
    expect((await harness!.folder.push()).ok).toBe(true);
    put(harness!, "Note.md", buffer.replace("mine", "mine, mended"));
    const mended = await harness!.folder.push();
    expect(mended.ok, JSON.stringify(mended)).toBe(true);
    expect(
      sentUpdates(harness!).at(-1)?.body.version,
      "the line the pull wrote over an edit the server then refused stayed spent, so a save from that buffer went over another machine's change unmerged",
    ).toBe(2);
  });

  it("lifts no answered edit's line when a pull writes over a waiting one, a conflicted edit's included", async () => {
    const id = "01a00000-0000-7000-8000-0000000000c2";
    const { door, edges, update } = await spentLineHarness(
      "folder-version-conflicted-not-lifted",
      id,
    );
    const lineOf = (text: string) =>
      Number(/^marfa_version: (\d+)$/m.exec(text)?.[1]);
    const held = read(harness!, "Note.md");
    // Another machine changes the body, and the pull writes it out.
    edges.logItem(
      "item.updated",
      update(id, { properties: { body: "theirs\n" }, version: 1 }),
    );
    expect((await harness!.folder.push()).ok).toBe(true);

    // An old buffer's save collides with it, and is set aside.
    put(harness!, "Note.md", held.replace("as read", "mine"));
    const collided = await harness!.folder.push();
    // The witness: the first edit was answered conflicted.
    expect(
      collided.ok &&
        collided.value.drain.verdicts.map((entry) => entry.verdict),
    ).toContain("conflicted");

    // A second edit meets a failing server, and the pull writes a change
    // another machine made over it; the server then refuses the edit.
    const answers_: Answer[] = [
      refusal(503, "service_unavailable", "later"),
      refusal(422, "validation_failed", "not this"),
    ];
    door.update = ((...args: Parameters<FolderDoor["update"]>) =>
      answers_.shift() ?? update(...args)) as FolderDoor["update"];
    const current = read(harness!, "Note.md");
    put(harness!, "Note.md", current.replace(/\n$/, "\nsecond\n"));
    const version = () => door.rows.get(id)?.version ?? 0;
    edges.logItem(
      "item.updated",
      update(id, { properties: { extra: "theirs" }, version: version() }),
    );
    expect((await harness!.folder.push()).ok).toBe(true);
    const buffer = read(harness!, "Note.md");
    expect(buffer).toContain("second");
    const refused = await harness!.folder.push();
    expect(
      refused.ok && refused.value.drain.verdicts.map((entry) => entry.reason),
    ).toEqual(["validation_failed"]);

    // Another machine moves the item on, and the editor saves its buffer.
    edges.logItem(
      "item.updated",
      update(id, { properties: { later: "theirs too" }, version: version() }),
    );
    expect((await harness!.folder.push()).ok).toBe(true);
    put(harness!, "Note.md", buffer.replace("second", "second, mended"));
    const mended = await harness!.folder.push();
    expect(mended.ok, JSON.stringify(mended)).toBe(true);
    expect(
      sentUpdates(harness!).at(-1)?.body.version,
      "a conflicted edit's line, lifted by a pull written over a later edit the server refused, stayed spent, so the mended save went over another machine's change unmerged",
    ).toBe(lineOf(buffer));
  });

  it("lifts no dead edit's line when a pull writes over a later waiting one", async () => {
    const id = "01a00000-0000-7000-8000-0000000000c3";
    const { door, edges, update } = await spentLineHarness(
      "folder-version-dead-not-lifted",
      id,
    );
    const lineOf = (text: string) =>
      Number(/^marfa_version: (\d+)$/m.exec(text)?.[1]);
    const version = () => door.rows.get(id)?.version ?? 0;
    const held = read(harness!, "Note.md");
    door.update = (() => ({
      kind: "json",
      status: 200,
      body: "not json at all",
    })) as unknown as FolderDoor["update"];
    put(harness!, "Note.md", held.replace("as read", "first"));
    let dead = false;
    for (let pass = 0; pass < 6 && !dead; pass += 1) {
      const pushed = await harness!.folder.push();
      expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
      dead =
        pushed.ok &&
        pushed.value.drain.verdicts.some((entry) => entry.verdict === "dead");
    }
    // The witness: the first edit died, its line kept spent.
    expect(dead).toBe(true);
    expect(read(harness!, "Note.md")).toContain("first");

    // A second edit meets a failing server, and the pull writes a change
    // another machine made over it; the server then refuses the edit.
    const answers_: Answer[] = [
      refusal(503, "service_unavailable", "later"),
      refusal(422, "validation_failed", "not this"),
    ];
    door.update = ((...args: Parameters<FolderDoor["update"]>) =>
      answers_.shift() ?? update(...args)) as FolderDoor["update"];
    put(
      harness!,
      "Note.md",
      read(harness!, "Note.md").replace(/\n$/, "\nsecond\n"),
    );
    edges.logItem(
      "item.updated",
      update(id, { properties: { extra: "theirs" }, version: version() }),
    );
    expect((await harness!.folder.push()).ok).toBe(true);
    const buffer = read(harness!, "Note.md");
    expect(buffer).toContain("second");
    expect(lineOf(buffer)).toBe(version());
    expect(buffer).toContain("first");
    const refused = await harness!.folder.push();
    expect(
      refused.ok && refused.value.drain.verdicts.map((entry) => entry.reason),
    ).toEqual(["validation_failed"]);

    edges.logItem(
      "item.updated",
      update(id, { properties: { later: "theirs too" }, version: version() }),
    );
    expect((await harness!.folder.push()).ok).toBe(true);
    put(harness!, "Note.md", buffer.replace("second", "second, mended"));
    const mended = await harness!.folder.push();
    expect(mended.ok, JSON.stringify(mended)).toBe(true);
    expect(
      sentUpdates(harness!).at(-1)?.body.version,
      "a dead edit's line, lifted by a pull written over a later edit the server refused, stayed spent, so the mended save went over another machine's change unmerged",
    ).toBe(lineOf(buffer));
  });

  it("keeps the line a pull wrote over an edit queued outside the file spent, once that edit lands", async () => {
    const id = "01a00000-0000-7000-8000-0000000000bf";
    const { door, edges, update } = await spentLineHarness(
      "folder-version-pulled-over-device-edit",
      id,
    );
    let failed = false;
    door.update = ((...args: Parameters<FolderDoor["update"]>) => {
      if (failed) return update(...args);
      failed = true;
      return refusal(503, "service_unavailable", "later");
    }) as FolderDoor["update"];
    // An edit queued through the device, not the file, waits on the server.
    const queued = await harness!.folder
      .device()
      .update(id, { properties: { status: "set here" }, version: 1 });
    expect(queued.ok, JSON.stringify(queued)).toBe(true);
    edges.logItem(
      "item.updated",
      update(id, { properties: { extra: "theirs" }, version: 1 }),
    );
    expect((await harness!.folder.push()).ok).toBe(true);
    // The witness: the pull wrote the file over the waiting edit.
    const buffer = read(harness!, "Note.md");
    expect(buffer).toContain("marfa_version: 2");
    expect(buffer).toContain("status: set here");
    const landed = await harness!.folder.push();
    expect(landed.ok, JSON.stringify(landed)).toBe(true);
    expect(read(harness!, "Note.md")).toContain("marfa_version: 3");

    put(harness!, "Note.md", buffer.replace("as read", "mine"));
    const saved = await harness!.folder.push();
    expect(saved.ok, JSON.stringify(saved)).toBe(true);
    expect(
      sentUpdates(harness!).at(-1)?.body.version,
      "a save from the buffer a pull wrote over an edit queued outside the file went on the line before that edit, as though another machine wrote it",
    ).toBe(3);
  });

  it("keeps a dead edit's line spent, since the server may have taken it", async () => {
    const id = "01a00000-0000-7000-8000-0000000000c0";
    const { door, edges, update } = await spentLineHarness(
      "folder-version-dead-spent",
      id,
    );
    const held = read(harness!, "Note.md");
    // The server takes the edit, and answers every attempt unreadably.
    let applied = false;
    door.update = ((...args: Parameters<FolderDoor["update"]>) => {
      if (!applied) {
        applied = true;
        edges.logItem("item.updated", update(...args));
      }
      return { kind: "json", status: 200, body: "not json at all" };
    }) as FolderDoor["update"];
    put(harness!, "Note.md", held.replace("as read", "first"));
    const verdicts: string[] = [];
    for (let pass = 0; pass < 6 && !verdicts.includes("dead"); pass += 1) {
      const pushed = await harness!.folder.push();
      expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
      if (pushed.ok) {
        verdicts.push(
          ...pushed.value.drain.verdicts.map((entry) => String(entry.verdict)),
        );
      }
    }
    // The witness: the edit died, and the server holds it.
    expect(verdicts).toContain("dead");
    door.update = update;
    // Another machine moves the item on, and the pull writes the file past
    // the editor's buffer.
    edges.logItem(
      "item.updated",
      update(id, { properties: { later: "theirs" }, version: 2 }),
    );
    expect((await harness!.folder.push()).ok).toBe(true);
    expect(read(harness!, "Note.md")).toContain("marfa_version: 3");

    put(harness!, "Note.md", held.replace("as read", "first, then more"));
    const more = await harness!.folder.push();
    expect(more.ok, JSON.stringify(more)).toBe(true);
    expect(
      sentUpdates(harness!).at(-1)?.body.version,
      "a save after an edit that died went on the line before it, and was merged against it as though another machine wrote it",
    ).toBe(3);
    expect(door.conflictedCopies()).toEqual([]);
  });

  it("takes back a dead edit's line once, released, the server refuses it", async () => {
    const id = "01a00000-0000-7000-8000-0000000000c1";
    const { door, edges, update } = await spentLineHarness(
      "folder-version-dead-released-refused",
      id,
    );
    const held = read(harness!, "Note.md");
    door.update = (() => ({
      kind: "json",
      status: 200,
      body: "not json at all",
    })) as unknown as FolderDoor["update"];
    put(harness!, "Note.md", held.replace("as read", "first"));
    let dead: string | undefined;
    for (let pass = 0; pass < 6 && dead === undefined; pass += 1) {
      const pushed = await harness!.folder.push();
      expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
      if (pushed.ok) {
        dead = pushed.value.drain.verdicts.find(
          (entry) => entry.verdict === "dead",
        )?.id;
      }
    }
    // The witness: the edit died, is released, and is then refused.
    expect(dead).toBeDefined();
    door.update = (() =>
      refusal(422, "validation_failed", "not this")) as FolderDoor["update"];
    const released = await harness!.folder.device().release({ id: dead! });
    expect(released.ok, JSON.stringify(released)).toBe(true);
    const refused = await harness!.folder.push();
    expect(
      refused.ok && refused.value.drain.verdicts.map((entry) => entry.reason),
    ).toEqual(["validation_failed"]);
    door.update = update;

    // Another machine moves the item on, and the editor saves its buffer.
    edges.logItem(
      "item.updated",
      update(id, { properties: { extra: "theirs" }, version: 1 }),
    );
    expect((await harness!.folder.push()).ok).toBe(true);
    put(harness!, "Note.md", held.replace("as read", "first, mended"));
    const mended = await harness!.folder.push();
    expect(mended.ok, JSON.stringify(mended)).toBe(true);
    expect(
      sentUpdates(harness!).at(-1)?.body.version,
      "a refused edit, released after it died, kept its line spent, so the next save went over another machine's change unmerged",
    ).toBe(1);
  });

  it("keeps a line an edit spent spent after the pull rewrites it", async () => {
    const id = "01a00000-0000-7000-8000-0000000000b5";
    harness = await folderHarness("folder-version-spent-rewritten", {
      rows: {
        "core.note": [
          {
            item: {
              id,
              version: 1,
              properties: { title: "Note", body: "as read\n" },
            },
          },
        ],
      },
      events: [copyLiveReplay("1", [])],
    });
    let door: FolderDoor | undefined;
    const rows = scriptFolderWrites(harness, {
      door: (made) => {
        door = made;
      },
    });
    expect((await harness.folder.pull()).ok).toBe(true);
    const held = read(harness, "Note.md");

    // An agent writes from what it read, and does not read the file again.
    put(harness, "Note.md", held.replace("as read", "first"));
    expect((await harness.folder.push()).ok).toBe(true);
    // The witness: the own edit landed and the pull wrote its line.
    expect(read(harness, "Note.md")).toContain("marfa_version: 2");

    put(harness, "Note.md", held.replace("as read", "first, then more"));
    const again = await harness.folder.push();
    expect(again.ok, JSON.stringify(again)).toBe(true);
    expect(
      sentUpdates(harness).map((update) => update.body.version),
      "the second save went on the line the first already spent, and was merged against the first as though another machine wrote it",
    ).toEqual([1, 2]);
    expect(rows.get(id)?.properties.body).toBe("first, then more\n");
    expect(door!.conflictedCopies()).toEqual([]);
  });

  it("keeps the line a landed edit spent when a later edit from the same buffer is refused", async () => {
    const id = "01a00000-0000-7000-8000-0000000000bc";
    harness = await folderHarness("folder-version-spent-refused", {
      rows: {
        "core.note": [
          {
            item: {
              id,
              version: 1,
              properties: { title: "Note", body: "as read\n" },
            },
          },
        ],
      },
      events: [copyLiveReplay("1", [])],
    });
    let door: FolderDoor | undefined;
    const rows = scriptFolderWrites(harness, {
      door: (made) => {
        door = made;
      },
    });
    expect((await harness.folder.pull()).ok).toBe(true);
    const held = read(harness, "Note.md");

    // An agent writes from what it read, and does not read the file again.
    put(harness, "Note.md", held.replace("as read", "first"));
    expect((await harness.folder.push()).ok).toBe(true);
    expect(read(harness, "Note.md")).toContain("marfa_version: 2");

    const update = door!.update.bind(door!);
    let refused = false;
    door!.update = ((...args: Parameters<FolderDoor["update"]>) => {
      if (refused) return update(...args);
      refused = true;
      return refusal(422, "validation_failed", "not this");
    }) as FolderDoor["update"];
    put(harness, "Note.md", held.replace("as read", "first, then wrong"));
    const wrong = await harness.folder.push();
    // The witness: the second save reached the server and was refused.
    expect(
      wrong.ok && wrong.value.drain.verdicts.map((entry) => entry.reason),
    ).toEqual(["validation_failed"]);

    put(harness, "Note.md", held.replace("as read", "first, then more"));
    const mended = await harness.folder.push();
    expect(mended.ok, JSON.stringify(mended)).toBe(true);
    expect(
      sentUpdates(harness).map((sent) => sent.body.version),
      "the refused save took away the line the landed first save spent, so the third went on the first's base and was merged against it as though another machine wrote it",
    ).toEqual([1, 2, 2]);
    expect(rows.get(id)?.properties.body).toBe("first, then more\n");
    expect(door!.conflictedCopies()).toEqual([]);
  });

  it("defers a delete past the rename grace", async () => {
    harness = await folderHarness("folder-delete-grace");
    scriptFolderWrites(harness);
    put(harness, "going.md", "---\ntitle: Going\n---\nbody\n");
    expect((await harness.folder.push()).ok).toBe(true);

    // The first half of a rename looks exactly like a delete: the old path
    // stops existing. A folder that sent a delete here would delete the item
    // it was about to rename.
    const graceStarted = Date.now();
    rmSync(join(harness.dir, "going.md"));
    const scanned = await harness.folder.scan();
    expect(scanned.ok).toBe(true);
    if (!scanned.ok) return;
    expect(
      scanned.value.missing,
      "the missing file was not journaled, so nothing is watching for the other half of the rename",
    ).toBe(1);
    expect(
      scanned.value.deleted,
      "the delete went at once, so every rename removes the item it renamed",
    ).toBe(0);
    const queued = await harness.folder.device().queue();
    expect(queued.ok).toBe(true);
    if (!queued.ok) return;
    expect(
      queued.value.some((row) => row.kind === "delete_item"),
      "a delete was queued inside the grace, so the queue holds it whether or not the rename completes",
    ).toBe(false);

    // The other half arrives inside the grace. **A real rename**, so the
    // identity carries over and the folder can recognize it: an earlier
    // version of this case created a new file, which can never match the
    // remembered identity, so the rename path was never reached and the
    // assertion below rode entirely on the grace not having elapsed.
    rmSync(join(harness.dir, "going.md"), { force: true });
    writeFileSync(
      join(harness.dir, "going.md"),
      "---\ntitle: Going\n---\nbody\n",
    );
    expect((await harness.folder.scan()).ok).toBe(true);
    renameSync(join(harness.dir, "going.md"), join(harness.dir, "arrived.md"));
    const renamed = await harness.folder.scan();
    expect(renamed.ok).toBe(true);
    if (!renamed.ok) return;
    expect(
      renamed.value.renamed,
      "the file was not followed as a rename, so the assertion below is about the grace rather than about the folder noticing the other half arrived",
    ).toBe(1);
    const after = await harness.folder.device().queue();
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(
      after.value.some((row) => row.kind === "delete_item"),
      "the rename completed and the delete went anyway, so the grace records the delete and sends it regardless",
    ).toBe(false);
    // **Past the grace**, which is what separates a journal row that was
    // cleared from one that is merely still waiting. The two look identical
    // until the grace runs out, so the scan above can only say that nothing
    // has been sent yet; this is the half that says nothing will be.
    await vi.waitFor(
      async () => {
        const swept = await harness?.folder.scan();
        expect(swept?.ok).toBe(true);
        const queue = await harness?.folder.device().queue();
        expect(queue?.ok).toBe(true);
        // The grace has run: any journal row left would have become a
        // delete by now.
        expect(
          (Date.now() - graceStarted) / 1000,
          "the grace has not run out yet, so a journal the rename failed to clear would not have become a delete",
        ).toBeGreaterThan(6);
        expect(
          queue?.ok === true &&
            queue.value.some((row) => row.kind === "delete_item"),
          "the rename completed and a delete went anyway once the grace ran out, so the journal the rename should have cleared survived it",
        ).toBe(false);
      },
      { timeout: 25_000, interval: 1_000 },
    );
  });

  it("takes the old path out of the journal when the file comes back under a new name", async () => {
    harness = await folderHarness("folder-rename-after-journal");
    scriptFolderWrites(harness);
    put(harness, "going.md", "---\ntitle: Going\n---\nbody\n");
    expect((await harness.folder.push()).ok).toBe(true);

    // The case above reaches the rename arm with an empty journal, because
    // the file is back at its own name for one scan first and the
    // came-back clear has already run. This is the other order, and the
    // only one in which the clear inside the rename arm is the thing under
    // test: the file leaves the folder, the scan journals the path it left,
    // and the file then arrives under a different name with that journal
    // row still standing.
    //
    // It moves into a dot-led directory rather than being deleted and
    // rewritten, because the device, inode and birth time have to survive
    // for the arrival to be a rename rather than a new file
    // (`folders/identity-rename`), and the walk does not enter a dot-led directory.
    const graceStarted = Date.now();
    mkdirSync(join(harness.dir, ".stash"), { recursive: true });
    renameSync(
      join(harness.dir, "going.md"),
      join(harness.dir, ".stash", "going.md"),
    );
    const missing = await harness.folder.scan();
    expect(missing.ok).toBe(true);
    if (!missing.ok) return;
    expect(
      missing.value.missing,
      "the path the file left was not journaled, so there is no journal row for the rename to clear and the rest of this is about nothing",
    ).toBe(1);

    renameSync(
      join(harness.dir, ".stash", "going.md"),
      join(harness.dir, "arrived.md"),
    );
    const renamed = await harness.folder.scan();
    expect(renamed.ok).toBe(true);
    if (!renamed.ok) return;
    expect(
      renamed.value.renamed,
      "the arrival was not followed as a rename, so nothing reached the arm that clears the old path's journal",
    ).toBe(1);

    // Past the grace, which is the only thing that tells a journal row that
    // was cleared from one that is still waiting.
    await vi.waitFor(
      async () => {
        const swept = await harness?.folder.scan();
        expect(swept?.ok).toBe(true);
        expect(
          (Date.now() - graceStarted) / 1000,
          "the grace has not run out yet, so a journal row the rename failed to clear would not have become a delete",
        ).toBeGreaterThan(6);
        const queue = await harness?.folder.device().queue();
        expect(queue?.ok).toBe(true);
        expect(
          queue?.ok === true &&
            queue.value.some((row) => row.kind === "delete_item"),
          "the rename left the old path in the journal, so the grace turned a move into a delete of the item that had just moved",
        ).toBe(false);
      },
      { timeout: 25_000, interval: 1_000 },
    );
    expect(
      existsSync(join(harness.dir, "arrived.md")),
      "the file is not in the folder, so the assertion above is about a delete that was right",
    ).toBe(true);
  });

  it("takes a file out of the journal when it comes back under its own name", async () => {
    harness = await folderHarness("folder-journal-return");
    scriptFolderWrites(harness);
    const text = "---\ntitle: Restored\n---\nbody\n";
    put(harness, "note.md", text);
    expect((await harness.folder.push()).ok).toBe(true);
    const bound = read(harness, "note.md");

    // Gone, then back at the same name inside the grace: an undo, a Put
    // Back, a cloud mount that dropped a listing for a second.
    const graceStarted = Date.now();
    rmSync(join(harness.dir, "note.md"));
    const missing = await harness.folder.scan();
    expect(missing.ok).toBe(true);
    if (!missing.ok) return;
    expect(
      missing.value.missing,
      "the file was not journaled at all, so the rest of this is about a journal row that was never written",
    ).toBe(1);

    writeFileSync(join(harness.dir, "note.md"), bound);
    expect((await harness.folder.scan()).ok).toBe(true);

    // Past the grace, and asserted rather than waited for: the scan that
    // sweeps is the one that would send the delete.
    await vi.waitFor(
      async () => {
        const swept = await harness!.folder.scan();
        expect(swept.ok).toBe(true);
        expect((Date.now() - graceStarted) / 1000).toBeGreaterThan(6);
      },
      { timeout: 20_000, interval: 500 },
    );

    const queued = await harness.folder.device().queue();
    expect(queued.ok).toBe(true);
    if (!queued.ok) return;
    expect(
      queued.value.filter((row) => row.kind === "delete_item"),
      "the folder deleted an item whose file is sitting on the disk, because nothing took the path out of the journal when it came back — and the next scan then makes the file a new item with none of its edges",
    ).toEqual([]);
    expect(
      existsSync(join(harness.dir, "note.md")),
      "the file is not there, so the assertion above is about a delete that was right",
    ).toBe(true);
  });

  it("journals a delete that happened while it was not running", async () => {
    harness = await folderHarness("folder-delete-offline");
    scriptFolderWrites(harness);
    put(harness, "gone.md", "---\ntitle: Gone\n---\nbody\n");
    expect((await harness.folder.push()).ok).toBe(true);

    // The file goes while nothing is watching, which for a folder that runs
    // a scan at a time is simply between two scans. It is journaled by the
    // same pass that would journal one that vanished while watching: a scan
    // does not know which it is looking at.
    rmSync(join(harness.dir, "gone.md"));
    const scanned = await harness.folder.scan();
    expect(scanned.ok).toBe(true);
    if (!scanned.ok) return;
    expect(
      scanned.value.missing,
      "a tracked file absent at startup was not journaled, so a delete made while the folder was off is never sent and the item stays forever",
    ).toBe(1);

    // And it becomes a delete once the grace has run. Waited for rather
    // than slept through: the grace is the folder's and a fixture that
    // guessed at it would pass on the guess.
    await vi.waitFor(
      async () => {
        const swept = await harness?.folder.scan();
        expect(swept?.ok).toBe(true);
        const queued = await harness?.folder.device().queue();
        expect(queued?.ok).toBe(true);
        expect(
          queued?.ok === true &&
            queued.value.some((row) => row.kind === "delete_item"),
          "the grace ran out and the journaled delete was never sent",
        ).toBe(true);
      },
      { timeout: 20_000, interval: 500 },
    );
  });
});

describe("a file that is not a document", () => {
  const photo = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1,
  ]);
  const settings = {
    search: { types: ["core.note", "core.file"] },
    defaults: { type: "core.note" },
  };

  it("pushes a file that is not a document as a file item, its bytes uploaded first", async () => {
    harness = await folderHarness("folder-file-push", { settings });
    const edges = new EdgeDoor();
    scriptFolderWrites(harness, { edges });
    acceptUploads(harness.server);
    writeFileSync(join(harness.dir, "photo.png"), photo);
    put(harness, "note.md", "---\ntitle: A note\n---\nbeside a photo\n");
    // Empty, so no blob the server holds: left alone rather than pushed.
    writeFileSync(join(harness.dir, "blank.png"), Buffer.alloc(0));
    // A subtype the server does not register: a file all the same.
    writeFileSync(join(harness.dir, "song.mp3"), Buffer.from("ID3 a song"));
    const scanned = await harness.folder.scan();
    expect(
      scanned.ok,
      `the folder could not scan: ${JSON.stringify(scanned)}`,
    ).toBe(true);
    if (!scanned.ok) return;
    expect(
      scanned.value.created,
      "the photo was not pushed, so a file dropped beside the notes never leaves the machine",
    ).toBe(3);
    expect(
      scanned.value.skipped,
      "an empty file was pushed, and the server refuses an empty blob",
    ).toBe(1);
    const waiting = await harness.folder.device().queue();
    expect(waiting.ok).toBe(true);
    if (!waiting.ok) return;
    const photoUpload = waiting.value.find(
      (row) => row.kind === "upload_blob" && row.blob === hashOf(photo),
    );
    expect(
      waiting.value.some(
        (row) =>
          row.kind === "create_item" &&
          row.depends_on.includes(photoUpload?.id ?? "none"),
      ),
      "the photo's file item does not wait on its upload, so it can reach the server naming bytes the server has not been sent",
    ).toBe(true);
    const pushed = await harness.folder.push();
    expect(
      pushed.ok,
      `the folder could not push: ${JSON.stringify(pushed)}`,
    ).toBe(true);
    if (!pushed.ok) return;
    expect(sentTitles(harness)).not.toContain("blank.png");
    expect(
      sentCreates(harness).find(
        (create) =>
          (create.properties as Record<string, unknown>).title === "song.mp3",
      )?.type,
      "a file whose subtype the server does not register was not pushed as a file",
    ).toBe("core.file");

    const file = sentCreates(harness).find(
      (create) =>
        (create.properties as Record<string, unknown>).title === "photo.png",
    );
    expect(
      file,
      "no item was created for the photo under its path",
    ).toBeDefined();
    expect(file?.type).toBe("core.file.image");
    expect(
      edges.placements(harness.settings.id).get(String(file?.id)),
      "a file item made in the folder went without its placement",
    ).toBe("photo.png");
    const fileId = String(file?.id);
    expect(
      [typeof file?.id, file?.source_id],
      "the file item's create carried no id of the device's own, or carried a natural key",
    ).toEqual(["string", undefined]);
    expect(file?.properties).toMatchObject({
      blob_ref: hashOf(photo),
      mime_type: "image/png",
      title: "photo.png",
    });
    const order = harness.server.requests
      .filter((request) => request.method === "POST")
      .map((request) =>
        request.pathname === "/items"
          ? `/items ${String((JSON.parse(request.body) as { properties: { title?: string } }).properties.title)}`
          : request.pathname,
      );
    expect(
      order.indexOf("/blobs"),
      "the file item went out before the bytes it names",
    ).toBeLessThan(order.indexOf("/items photo.png"));
    expect(
      harness.server.requests.find((request) => request.pathname === "/blobs")
        ?.raw,
    ).toEqual(photo);
    expect(
      readFileSync(join(harness.dir, "photo.png")),
      "the pull that ended the push rewrote the photo",
    ).toEqual(photo);

    // New bytes are a new upload and an update naming them, the update
    // waiting on the upload.
    const edited = Buffer.concat([photo, Buffer.from([2])]);
    writeFileSync(join(harness.dir, "photo.png"), edited);
    expect((await harness.folder.scan()).ok).toBe(true);
    const updating = await harness.folder.device().queue();
    expect(updating.ok).toBe(true);
    if (!updating.ok) return;
    const editUpload = updating.value.find(
      (row) => row.kind === "upload_blob" && row.blob === hashOf(edited),
    );
    expect(
      updating.value.find(
        (row) => row.kind === "update_item" && row.verdict === null,
      )?.depends_on,
      "the update naming new bytes does not wait on their upload",
    ).toContain(editUpload?.id);
    const again = await harness.folder.push();
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(
      harness.server.requests.filter((request) => request.method === "PATCH")
        .length,
    ).toBeGreaterThan(0);
    const uploads = harness.server.requests.filter(
      (request) => request.pathname === "/blobs",
    );
    expect(uploads.at(-1)?.raw).toEqual(edited);
    const patch = harness.server.requests.find(
      (request) =>
        request.method === "PATCH" && request.pathname === `/items/${fileId}`,
    );
    expect(
      (JSON.parse(patch?.body ?? "{}") as { properties?: unknown }).properties,
      "the update did not name the new bytes, so the item still names the old file",
    ).toMatchObject({ blob_ref: hashOf(edited) });

    // A move alone: the title the folder gave it follows the new name, and
    // the bytes, unchanged, are not sent again.
    const uploadsBefore = harness.server.requests.filter(
      (request) => request.pathname === "/blobs",
    ).length;
    renameSync(join(harness.dir, "photo.png"), join(harness.dir, "moved.png"));
    const moved = await harness.folder.push();
    expect(moved.ok).toBe(true);
    if (!moved.ok) return;
    expect(moved.value.scan.renamed).toBe(1);
    const rename = harness.server.requests
      .filter(
        (request) =>
          request.method === "PATCH" && request.pathname === `/items/${fileId}`,
      )
      .at(-1);
    const renamed = JSON.parse(rename?.body ?? "{}") as Record<string, unknown>;
    expect(
      renamed,
      "the move did not carry the title the folder gave the file",
    ).toMatchObject({ properties: { title: "moved.png" } });
    expect(renamed).not.toHaveProperty("source_id");
    expect(
      harness.server.requests.filter((request) => request.pathname === "/blobs")
        .length,
      "a move alone sent the unchanged bytes again",
    ).toBe(uploadsBefore);
  });

  it("writes a file item's bytes as its file, and reports them absent where it cannot fetch them", async () => {
    const bytes = photo;
    const hash = hashOf(bytes);
    const other = Buffer.from("the bytes another file item names\n");
    harness = await folderHarness("folder-file-pull", {
      settings,
      rows: {
        "core.file": [
          {
            item: {
              id: "01a00000-0000-7000-8000-0000000000f1",
              type: "core.file.image",
              properties: {
                title: "photo.png",
                blob_ref: hash,
                mime_type: "image/png",
              },
            },
          },
          // Its link serves bytes that are not the ones it names, so its
          // file can never be written; the photo beside it still is.
          {
            item: {
              id: "01a00000-0000-7000-8000-0000000000f2",
              type: "core.file",
              properties: {
                title: "broken.txt",
                blob_ref: hashOf(other),
                mime_type: "text/plain",
              },
            },
          },
        ],
      },
    });
    scriptBlob(harness.server, bytes);
    scriptBlob(harness.server, other, Buffer.from("not those bytes\n"));

    await harness.server.offline();
    const offline = await harness.folder.pull();
    expect(
      offline.ok,
      `a pull that could not fetch one file's bytes failed as a whole: ${JSON.stringify(offline)}`,
    ).toBe(true);
    if (!offline.ok) return;
    expect(
      offline.value.absent,
      "a file item whose bytes could not be had was not reported",
    ).toBe(2);
    expect(
      offline.value.flagged
        .filter((file) => file.flag === "absent")
        .map((file) => [file.item, file.path])
        .sort(),
      "the pull counted a file item whose bytes it could not have without naming it",
    ).toEqual([
      ["01a00000-0000-7000-8000-0000000000f1", "photo.png"],
      ["01a00000-0000-7000-8000-0000000000f2", "broken.txt"],
    ]);
    expect(
      existsSync(join(harness.dir, "photo.png")),
      "the pull wrote a file for bytes it does not have",
    ).toBe(false);

    // The witness: the same pull with the server back writes the bytes, so
    // the absence above was the bytes and not a pull that writes no files.
    await harness.server.online();
    const pulled = await harness.folder.pull();
    expect(
      pulled.ok,
      `one file whose bytes could not be written failed the whole pull: ${JSON.stringify(pulled)}`,
    ).toBe(true);
    if (!pulled.ok) return;
    expect(pulled.value.written).toBe(1);
    expect(pulled.value.absent).toBe(1);
    expect(readFileSync(join(harness.dir, "photo.png"))).toEqual(bytes);
    expect(existsSync(join(harness.dir, "broken.txt"))).toBe(false);

    // Its own write is not read back as a change (`folders/write-no-echo`).
    const scanned = await harness.folder.scan();
    expect(scanned.ok).toBe(true);
    if (!scanned.ok) return;
    expect(
      scanned.value.unchanged,
      "the file the pull wrote was read back as a change to push",
    ).toBe(1);
    expect(scanned.value.created + scanned.value.updated).toBe(0);

    // A file the folder already holds the bytes of needs no server at all,
    // nor a copy of them beside the working copy, which the pull let go.
    await harness.server.offline();
    const again = await harness.folder.pull();
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(
      again.value.unchanged,
      "a file already on the disk was fetched again, and reported absent with the server away",
    ).toBe(1);
    await harness.server.online();
  });

  it("keeps no copy beside the store of bytes its file holds, and fetches them again when asked", async () => {
    const hash = hashOf(photo);
    harness = await folderHarness("folder-file-let-go", {
      settings,
      rows: {
        "core.file": [
          {
            item: {
              id: "01a00000-0000-7000-8000-0000000000f6",
              type: "core.file.image",
              properties: {
                title: "photo.png",
                blob_ref: hash,
                mime_type: "image/png",
              },
            },
          },
        ],
      },
    });
    scriptBlob(harness.server, photo);
    const fetched = (): number =>
      harness!.server.requests.filter((request) =>
        request.pathname.startsWith("/links/"),
      ).length;

    const pulled = await harness.folder.pull();
    expect(pulled.ok, JSON.stringify(pulled)).toBe(true);
    if (!pulled.ok) return;
    expect(readFileSync(join(harness.dir, "photo.png"))).toEqual(photo);
    // The witness: the bytes came through the copy beside the store, so its
    // absence below is the pull letting them go.
    expect(fetched(), "the pull wrote the file without fetching it").toBe(1);
    const device = harness.folder.device();
    const copy = `${device.store}.blobs/${hash.slice("sha256:".length)}`;
    expect(
      existsSync(copy),
      "the folder kept a second copy of bytes its file already holds, so every file it pulls takes twice its size on the disk",
    ).toBe(false);

    // Named by their content, the bytes let go are fetched again when asked.
    const asked = await device.blob(hash);
    expect(asked.ok, JSON.stringify(asked)).toBe(true);
    if (!asked.ok) return;
    expect(readFileSync(asked.value.path)).toEqual(photo);
    expect(fetched(), "bytes let go were answered without a fetch").toBe(2);
  });

  it("ends a pull whose credential is refused, rather than counting each file absent", async () => {
    const hash = hashOf(photo);
    harness = await folderHarness("folder-file-credential", {
      settings,
      rows: {
        "core.file": [
          {
            item: {
              id: "01a00000-0000-7000-8000-0000000000f3",
              type: "core.file.image",
              properties: {
                title: "photo.png",
                blob_ref: hash,
                mime_type: "image/png",
              },
            },
          },
        ],
      },
    });
    harness.server.copyAnswer(
      "GET",
      `/blobs/${hash}/url`,
      refusal(401, "unauthorized", "no credential"),
    );
    const refused = await harness.folder.pull();
    expect(
      refused.ok,
      "a refused credential was counted as one absent file, and every other file would be too",
    ).toBe(false);
    if (!refused.ok) expect(refused.refusal.code).toBe("unauthorized");
  });

  it("writes an item carrying a blob_ref outside the file types as a document", async () => {
    const unfetched = hashOf(Buffer.from("not fetched"));
    const bytes = Buffer.from("the bytes a file item names\n");
    harness = await folderHarness("folder-file-not-a-file", {
      settings: {
        search: { types: ["core.note", "core.bookmark", "core.file"] },
        defaults: { type: "core.note" },
      },
      rows: {
        "core.bookmark": [
          {
            item: {
              id: "01a00000-0000-7000-8000-0000000000b1",
              type: "core.bookmark",
              properties: { title: "Budget.xlsx", blob_ref: unfetched },
            },
          },
        ],
        // A file item beside it, whose bytes the same pull fetches.
        "core.file": [
          {
            item: {
              id: "01a00000-0000-7000-8000-0000000000b2",
              type: "core.file",
              properties: {
                title: "notes.txt",
                blob_ref: hashOf(bytes),
                mime_type: "text/plain",
              },
            },
          },
        ],
      },
    });
    scriptBlob(harness.server, bytes);
    const pulled = await harness.folder.pull();
    expect(pulled.ok).toBe(true);
    if (!pulled.ok) return;
    expect(pulled.value.written).toBe(2);
    expect(
      existsSync(join(harness.dir, "Budget.xlsx.md")),
      "an item of a type that is not a file was written under a file's name, so the next scan would not read it as the document it is",
    ).toBe(true);
    const fetched = (hash: string) =>
      harness!.server.requests.some((request) =>
        request.pathname.startsWith(`/blobs/${hash}`),
      );
    // The witness: the same pull fetched the file item's bytes.
    expect(
      fetched(hashOf(bytes)),
      "the pull fetched no bytes at all, so nothing here is about the bookmark",
    ).toBe(true);
    expect(readFileSync(join(harness.dir, "notes.txt"))).toEqual(bytes);
    expect(
      fetched(unfetched),
      "the pull fetched bytes for an item that is not a file",
    ).toBe(false);
  });

  it("keeps a title somebody set when the file moves", async () => {
    const id = "01a00000-0000-7000-8000-0000000000f4";
    const row = {
      id,
      type: "core.file.image",
      properties: {
        title: "photo.png",
        blob_ref: hashOf(photo),
        mime_type: "image/png",
      },
    };
    harness = await folderHarness("folder-file-titled", {
      settings,
      rows: { "core.file": [{ item: row }] },
      // Somebody retitles the item once its file is written.
      events: [
        copyReplay("2", [
          copyItemEvent(
            "2",
            "item.updated",
            wireItem({
              ...row,
              version: 2,
              properties: { ...row.properties, title: "Holiday" },
            }),
          ),
        ]),
      ],
    });
    scriptBlob(harness.server, photo);
    const edges = new EdgeDoor();
    scriptFolderWrites(harness, { edges });
    expect((await harness.folder.pull()).ok).toBe(true);
    const caught = await harness.folder.device().catchUp();
    expect(caught.ok ? caught.value.applied : 0).toBe(1);
    expect((await harness.folder.pull()).ok).toBe(true);
    // The file keeps its name, which is no longer the item's title.
    expect(readFileSync(join(harness.dir, "photo.png"))).toEqual(photo);
    expect((await harness.folder.push()).ok).toBe(true);
    expect(edges.placements(harness.settings.id).get(id)).toBe("photo.png");
    renameSync(join(harness.dir, "photo.png"), join(harness.dir, "moved.png"));
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    if (!pushed.ok) return;
    // The witness: the move was followed.
    expect(pushed.value.scan.renamed).toBe(1);
    expect(
      sentUpdates(harness),
      "a move wrote the file's name over a title somebody gave the item",
    ).toEqual([]);
    expect(
      edges.placements(harness.settings.id).get(id),
      "a file item's move did not move its placement",
    ).toBe("moved.png");
  });

  it("keeps the file of an item whose new bytes cannot be had", async () => {
    const hash = hashOf(photo);
    const later = Buffer.concat([photo, Buffer.from("later")]);
    const row = {
      id: "01a00000-0000-7000-8000-0000000000f5",
      type: "core.file.image",
      properties: {
        title: "photo.png",
        blob_ref: hash,
        mime_type: "image/png",
      },
    };
    harness = await folderHarness("folder-file-kept", {
      settings,
      rows: { "core.file": [{ item: row }] },
      events: [
        copyReplay("2", [
          copyItemEvent(
            "2",
            "item.updated",
            wireItem({
              ...row,
              version: 2,
              properties: { ...row.properties, blob_ref: hashOf(later) },
            }),
          ),
        ]),
      ],
    });
    scriptBlob(harness.server, photo);
    expect((await harness.folder.pull()).ok).toBe(true);
    expect((await harness.folder.device().catchUp()).ok).toBe(true);

    await harness.server.offline();
    const pulled = await harness.folder.pull();
    await harness.server.online();
    expect(pulled.ok).toBe(true);
    if (!pulled.ok) return;
    expect(pulled.value.absent).toBe(1);
    expect(
      readFileSync(join(harness.dir, "photo.png")),
      "the file of an item still held was taken away because its new bytes could not be fetched",
    ).toEqual(photo);
  });

  it("counts absent the bytes a failing server, a rate limit or an unreadable held copy cannot give", async () => {
    const image = (id: string, title: string, bytes: Buffer) => ({
      item: {
        id,
        type: "core.file.image",
        properties: { title, blob_ref: hashOf(bytes), mime_type: "image/png" },
      },
    });
    const [failing, limited, held] = [2, 3, 4].map((last) =>
      Buffer.concat([photo, Buffer.from([last])]),
    ) as [Buffer, Buffer, Buffer];
    harness = await folderHarness("folder-file-absent", {
      settings,
      rows: {
        "core.file": [
          image("01a00000-0000-7000-8000-0000000000fa", "failing.png", failing),
          image("01a00000-0000-7000-8000-0000000000fb", "limited.png", limited),
          image("01a00000-0000-7000-8000-0000000000fc", "held.png", held),
        ],
      },
    });
    for (const [bytes, answer] of [
      [failing, refusal(503, "service_unavailable", "try again")],
      [limited, answers.rateLimited()],
    ] as const) {
      harness.server.copyAnswer("GET", `/blobs/${hashOf(bytes)}/url`, answer);
      scriptBlob(harness.server, bytes);
    }
    // Held beside the copy already, and unreadable there.
    const blobs = join(harness.dir, ".marfa", "core.sqlite.blobs");
    mkdirSync(blobs, { recursive: true });
    const copy = join(blobs, hashOf(held).slice("sha256:".length));
    writeFileSync(copy, held);
    chmodSync(copy, 0o000);
    try {
      const pulled = await harness.folder.pull();
      expect(
        pulled.ok,
        `a file whose bytes could not be had ended the pull: ${JSON.stringify(pulled)}`,
      ).toBe(true);
      if (!pulled.ok) return;
      expect(pulled.value.absent).toBe(3);
      expect(pulled.value.written).toBe(0);
    } finally {
      chmodSync(copy, 0o600);
    }
    // The witness: with the server answering and the copy readable, each is
    // written.
    const again = await harness.folder.pull();
    expect(again.ok && [again.value.absent, again.value.written]).toEqual([
      0, 3,
    ]);
    expect(readFileSync(join(harness.dir, "held.png"))).toEqual(held);
  });

  it("holds a file's move behind an edit of its bytes that waits on their upload", async () => {
    const id = "01a00000-0000-7000-8000-0000000000f7";
    const text = Buffer.from("plain text a server holds as a file\n");
    harness = await folderHarness("folder-file-move-behind-bytes", {
      settings,
      rows: {
        "core.file": [
          {
            item: {
              id,
              type: "core.file",
              properties: {
                title: "notes.txt",
                blob_ref: hashOf(text),
                mime_type: "text/plain",
              },
            },
          },
        ],
      },
    });
    scriptBlob(harness.server, text);
    const rows = scriptFolderWrites(harness);
    // The first upload fails the way a busy server does; the rest land.
    harness.server.answer("POST", "/blobs", answers.serverFault());
    acceptUploads(harness.server);
    expect((await harness.folder.pull()).ok).toBe(true);

    // New bytes, whose edit waits on their upload, then a move of the same
    // file, which is an edit of the same row waiting on nothing.
    const edited = Buffer.from("plain text, edited\n");
    writeFileSync(join(harness.dir, "notes.txt"), edited);
    expect((await harness.folder.scan()).ok).toBe(true);
    renameSync(join(harness.dir, "notes.txt"), join(harness.dir, "moved.txt"));
    expect((await harness.folder.scan()).ok).toBe(true);

    expect((await harness.folder.push()).ok).toBe(true);
    const held = await harness.folder.device().queue();
    expect(held.ok).toBe(true);
    if (!held.ok) return;
    expect(
      held.value
        .filter((row) => row.kind === "update_item")
        .map((row) => [row.verdict, row.reason]),
      "the move went out ahead of the edit of the bytes, which was waiting on their upload",
    ).toEqual([
      ["blocked", "awaiting_dependency"],
      ["blocked", "awaiting_dependency"],
    ]);

    expect((await harness.folder.push()).ok).toBe(true);
    expect(
      harness.server.requests
        .filter(
          (request) =>
            request.method === "PATCH" && request.pathname === `/items/${id}`,
        )
        .map(
          (request) =>
            (JSON.parse(request.body) as { version?: unknown }).version,
        ),
    ).toEqual([1, 2]);
    expect([
      rows.get(id)?.properties.title,
      rows.get(id)?.properties.blob_ref,
    ]).toEqual(["moved.txt", hashOf(edited)]);
  });

  it("holds a file's second move behind its first, which had no answer, though the bytes between them are refused", async () => {
    const id = "01a00000-0000-7000-8000-0000000000f8";
    const text = Buffer.from("plain text a server holds as a file\n");
    harness = await folderHarness("folder-move-behind-refused-bytes", {
      settings,
      rows: {
        "core.file": [
          {
            item: {
              id,
              type: "core.file",
              properties: {
                title: "notes.txt",
                blob_ref: hashOf(text),
                mime_type: "text/plain",
              },
            },
          },
        ],
      },
    });
    scriptBlob(harness.server, text);
    // The first edit meets a busy server; the rest reach the door. The
    // server refuses the new bytes outright.
    harness.server.answer("PATCH", /^\/items\/[^/]+$/, answers.serverFault());
    const rows = scriptFolderWrites(harness);
    harness.server.answer(
      "POST",
      "/blobs",
      refusal(400, "validation_error", "not bytes this server takes"),
    );
    expect((await harness.folder.pull()).ok).toBe(true);

    // A move, new bytes, and a second move, each scanned before any drain.
    renameSync(join(harness.dir, "notes.txt"), join(harness.dir, "first.txt"));
    expect((await harness.folder.scan()).ok).toBe(true);
    writeFileSync(join(harness.dir, "first.txt"), "plain text, edited\n");
    expect((await harness.folder.scan()).ok).toBe(true);
    renameSync(join(harness.dir, "first.txt"), join(harness.dir, "second.txt"));
    expect((await harness.folder.scan()).ok).toBe(true);

    const device = harness.folder.device();
    expect((await device.drain()).ok).toBe(true);
    const patches = (): unknown[] =>
      harness?.server.requests
        .filter(
          (request) =>
            request.method === "PATCH" && request.pathname === `/items/${id}`,
        )
        .map(
          (request) =>
            (JSON.parse(request.body) as { version?: unknown }).version,
        ) ?? [];
    const edits = async () => {
      const queued = await device.queue();
      expect(queued.ok).toBe(true);
      return queued.ok
        ? queued.value
            .filter((row) => row.kind === "update_item")
            .map((row) => [row.verdict, row.reason])
        : [];
    };
    expect(
      await edits(),
      "the second move went out beside the first, which had no answer, because the edit of the bytes between them was refused and stepped out of line",
    ).toEqual([
      [null, null],
      ["blocked", "awaiting_dependency"],
      ["blocked", "awaiting_dependency"],
    ]);
    expect(patches()).toEqual([1]);

    // With the first answered, the bytes' edit is refused with its upload
    // and the second move goes, on the first's answer.
    expect((await device.drain()).ok).toBe(true);
    expect((await edits()).map(([verdict]) => verdict)).toEqual([
      "accepted",
      "refused",
      "accepted",
    ]);
    expect(patches()).toEqual([1, 1, 2]);
    expect(rows.get(id)?.properties.title).toBe("second.txt");
  });

  it("holds a file's move behind an edit of its bytes that cannot be opened for now", async () => {
    const id = "01a00000-0000-7000-8000-0000000000f9";
    const text = Buffer.from("plain text a server holds as a file\n");
    harness = await folderHarness("folder-file-move-behind-locked-bytes", {
      settings,
      rows: {
        "core.file": [
          {
            item: {
              id,
              type: "core.file",
              properties: {
                title: "notes.txt",
                blob_ref: hashOf(text),
                mime_type: "text/plain",
              },
            },
          },
        ],
      },
    });
    scriptBlob(harness.server, text);
    const rows = scriptFolderWrites(harness);
    acceptUploads(harness.server);
    expect((await harness.folder.pull()).ok).toBe(true);

    // New bytes, whose edit waits on their upload, then a move of the file.
    const edited = Buffer.from("plain text, edited and locked\n");
    writeFileSync(join(harness.dir, "notes.txt"), edited);
    expect((await harness.folder.scan()).ok).toBe(true);
    renameSync(join(harness.dir, "notes.txt"), join(harness.dir, "moved.txt"));
    expect((await harness.folder.scan()).ok).toBe(true);

    // The bytes held beside the store cannot be opened for this drain.
    const device = harness.folder.device();
    const heldAt = `${device.store}.blobs/${hashOf(edited).slice("sha256:".length)}`;
    chmodSync(heldAt, 0o000);
    try {
      const drained = await device.drain();
      expect(drained.ok, JSON.stringify(drained)).toBe(true);
      if (!drained.ok) return;
      const held = await device.queue();
      expect(held.ok).toBe(true);
      if (!held.ok) return;
      // The witness: the upload was tried, met bytes it could not open, and
      // was left unanswered.
      expect(
        drained.value.verdicts.find((row) => row.kind === "upload_blob")
          ?.reason ?? "",
        "the upload was never tried, so nothing here waited on bytes that could not be opened",
      ).toContain(`the bytes of ${hashOf(edited)} could not be opened`);
      expect(
        held.value.find((row) => row.kind === "upload_blob")?.verdict,
      ).toBe(null);
      expect(
        held.value
          .filter((row) => row.kind === "update_item")
          .map((row) => [row.verdict, row.reason]),
        "the move went out ahead of the edit of the bytes, which waits on bytes that could not be opened",
      ).toEqual([
        ["blocked", "awaiting_dependency"],
        ["blocked", "awaiting_dependency"],
      ]);
    } finally {
      chmodSync(heldAt, 0o644);
    }

    expect((await device.drain()).ok).toBe(true);
    expect([
      rows.get(id)?.properties.title,
      rows.get(id)?.properties.blob_ref,
    ]).toEqual(["moved.txt", hashOf(edited)]);
  });

  it("sends an edited file item named like a document as bytes", async () => {
    const text = Buffer.from("plain text a server holds as a file\n");
    const hash = hashOf(text);
    harness = await folderHarness("folder-file-text", {
      settings,
      rows: {
        "core.file": [
          {
            item: {
              id: "01a00000-0000-7000-8000-0000000000f6",
              type: "core.file",
              properties: {
                title: "notes.txt",
                blob_ref: hash,
                mime_type: "text/plain",
              },
            },
          },
        ],
      },
    });
    scriptBlob(harness.server, text);
    scriptFolderWrites(harness);
    acceptUploads(harness.server);
    expect((await harness.folder.pull()).ok).toBe(true);
    expect(readFileSync(join(harness.dir, "notes.txt"))).toEqual(text);

    const edited = Buffer.from("plain text, edited\n");
    writeFileSync(join(harness.dir, "notes.txt"), edited);
    expect((await harness.folder.push()).ok).toBe(true);
    const upload = harness.server.requests.find(
      (request) => request.pathname === "/blobs",
    );
    expect(
      upload?.raw,
      "an edited file item named like a document was not sent as bytes",
    ).toEqual(edited);
    const patch = JSON.parse(
      harness.server.requests.find((request) => request.method === "PATCH")
        ?.body ?? "{}",
    ) as { properties?: Record<string, unknown> };
    expect(patch.properties).toMatchObject({ blob_ref: hashOf(edited) });
    expect(
      patch.properties?.body,
      "the file's text was sent as a document's body",
    ).toBeUndefined();
  });
});
