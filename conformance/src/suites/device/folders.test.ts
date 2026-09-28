import {
  chmodSync,
  existsSync,
  linkSync,
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
  catchupTooOld,
  connected,
  edgeEvent,
  edgesPage,
  headRead,
  itemEvent,
  itemsPage,
  liveReplay,
  streamCursor,
  refusal,
  replay,
  SCRIPTED_EDGE_TYPES,
  wireEdge,
  wireItem,
  writeAnswers,
  SCRIPTED_TYPES,
  wireType,
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
  scriptWrites,
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
  type DoorCreate,
  type DoorRow,
} from "../../device/folder-door.js";
import type { FolderHarness } from "./harness.js";
import type { DrainVerdict, QueuedWrite } from "../../device/protocol.js";
import type {
  Answer,
  RecordedRequest,
  Responder,
  SseFrame,
} from "../../device/scripted-server.js";
import type {
  WireEdgeOptions,
  WireItemOptions,
} from "../../device/marfa-answers.js";
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

/** A file in the folder. */
function put(harness: FolderHarness, name: string, text: string): string {
  const path = join(harness.dir, name);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
  return path;
}

function read(harness: FolderHarness, name: string): string {
  return readFileSync(join(harness.dir, name), "utf8");
}

/** The folder's settings file. */
function settingsFile(harness: FolderHarness): string {
  return join(harness.dir, ".marfa", "folder.yaml");
}

/**
 * The folder door's change, as the server takes it at the version the row
 * is at: each named setting replaced whole. `answer` overrides, for a
 * refusal.
 */
function scriptFolderChanges(
  harness: FolderHarness,
  answer?: Answer,
  options: { once?: boolean } = {},
): Array<Record<string, unknown>> {
  const sent: Array<Record<string, unknown>> = [];
  harness.server.answer(
    "PATCH",
    `/folders/${harness.settings.id}`,
    (request) => {
      const body = JSON.parse(request.body) as Record<string, unknown>;
      sent.push(body);
      if (
        answer !== undefined &&
        (options.once !== true || sent.length === 1)
      ) {
        return answer;
      }
      const { version: _version, ...changed } = body;
      harness.settings.settings = { ...harness.settings.settings, ...changed };
      harness.settings.version += 1;
      return answers.updated(folderItem(harness.settings));
    },
  );
  return sent;
}

/** The `marfa_id` a file's frontmatter carries, if any. */
function idIn(harness: FolderHarness, name: string): string | undefined {
  return /marfa_id:\s*(\S+)/.exec(read(harness, name))?.[1];
}

/** Replaces a file as an editor's atomic save does: the bytes are written
 *  beside it and renamed over it, so the path holds a new inode with a new
 *  birth time. */
function saveAtomically(
  harness: FolderHarness,
  name: string,
  text: string | Buffer,
): void {
  const beside = join(harness.dir, `.saving-${name.replaceAll("/", "-")}`);
  writeFileSync(beside, text);
  renameSync(beside, join(harness.dir, name));
}

/**
 * Answers for every door a folder's drain can reach, the item doors deciding
 * as the real server does (`FolderDoor`, which `fidelity.test.ts` holds to the
 * server's decisions).
 *
 * Returns what the door holds for each item, so a fixture can ask what each
 * ended up holding rather than only what was sent.
 */
function scriptFolderWrites(
  harness: FolderHarness,
  options: {
    /** Handed the door, for a fixture that has another machine write. */
    door?: (door: FolderDoor) => void;
    /** The edge door, for a fixture that reads what it holds. */
    edges?: EdgeDoor;
    /** An answer standing in for the tag doors', a refusal say. */
    tagging?: (request: RecordedRequest) => Answer | undefined;
  } = {},
): Map<string, DoorRow> {
  // What the hydration served, so a write to one of those rows is answered
  // with what the real server keeps rather than a default.
  const door = new FolderDoor(
    Object.values(harness.rows)
      .flat()
      .map((row): [string, DoorRow] => {
        const item = wireItem(row.item);
        return [
          row.item.id,
          {
            properties: item.properties as Record<string, unknown>,
            type: String(item.type),
            source: String(item.source),
            source_id:
              typeof item.source_id === "string" ? item.source_id : null,
            version: Number(item.version),
            tier: item.tier as "library" | "feed",
            ...(item.state === "active" ? {} : { state: String(item.state) }),
            ...(row.tags === undefined ? {} : { tags: row.tags }),
          },
        ];
      }),
  );
  options.door?.(door);
  const edges = options.edges ?? new EdgeDoor();
  scriptWrites(harness.server, {
    create: [
      (request) => {
        const { answer } = door.create(JSON.parse(request.body) as DoorCreate);
        edges.logItem("item.created", answer);
        return answer;
      },
    ],
    update: [
      (request) => {
        const answer = door.update(
          request.pathname.split("/").at(-1) ?? "unknown",
          JSON.parse(request.body) as Parameters<FolderDoor["update"]>[1],
          { resolve: request.query.get("conflict") === "auto" },
        );
        edges.logItem("item.updated", answer);
        return answer;
      },
    ],
    // A device reads a row by id to reconcile after a refusal.
    read: [(request) => door.read(request.pathname.split("/").at(-1) ?? "")],
    // The tags a row holds move as the tag doors are told.
    tags: [
      (request) => {
        const standIn = options.tagging?.(request);
        if (standIn !== undefined) return standIn;
        const [, , id = "", door_, tag] = request.pathname.split("/");
        const row = door.rows.get(id);
        if (row !== undefined && door_ === "tags") {
          const held = row.tags ?? [];
          const tags =
            request.method === "POST"
              ? [
                  ...new Set([
                    ...held,
                    ...(JSON.parse(request.body) as { tags: string[] }).tags,
                  ]),
                ]
              : held.filter((named) => named !== decodeURIComponent(tag ?? ""));
          door.rows.set(id, { ...row, tags });
        }
        return writeAnswers.metadata(id, door.rows.get(id)?.tags ?? []);
      },
    ],
    extensions: [{ kind: "json", status: 200, body: {} }],
  });
  harness.server.answer("DELETE", /^\/items\/[^/]+$/, {
    kind: "json",
    status: 204,
    body: {},
  });
  harness.server.answer("POST", /^\/items\/[^/]+\/transition$/, (request) =>
    door.transition(
      request.pathname.split("/").at(-2) ?? "",
      String((JSON.parse(request.body) as { state?: unknown }).state),
    ),
  );
  edges.script(harness.server);
  return door.rows;
}

/**
 * The edge doors, holding what they are sent as the server does: a create
 * answered at version 1 and refused where the same edge is held already, an
 * update on the version held moving it on, and each change, with the item
 * writes it is told of, logged as the event the stream would carry.
 */
class EdgeDoor {
  readonly edges = new Map<string, WireEdgeOptions & { version: number }>();
  /** Every change as its event, ids counting on from the head read's `1`. */
  readonly events: SseFrame[] = [];
  /** An answer standing in for the server's to an edge written or
   *  changed, a refusal say; the door decides where it answers `undefined`. */
  placing?: (edge: WireEdgeOptions) => Answer | undefined;
  /** The same, for an edge's delete. */
  deleting?: (edge: WireEdgeOptions) => Answer | undefined;
  /** Listings of an item's edges still to fail, as a server failing now. */
  failListings = 0;
  private minted = 0;

  /** An edge the server holds already, one a hydration serves. */
  hold(edge: WireEdgeOptions): this {
    this.edges.set(edge.id, {
      ...edge,
      version: edge.version ?? 1,
      created_at: edge.created_at ?? this.stamp(),
    });
    return this;
  }

  script(server: ScriptedServer): void {
    server.answer("POST", "/edges", (request) => {
      const body = JSON.parse(request.body) as WireEdgeOptions;
      const standIn = this.placing?.(body);
      if (standIn !== undefined) return standIn;
      const held = [...this.edges.values()].some(
        (edge) =>
          edge.source_id === body.source_id &&
          edge.target_id === body.target_id &&
          edge.edge_type === body.edge_type,
      );
      if (held) {
        return answers.edgeDuplicate({
          source_id: body.source_id,
          target_id: body.target_id,
          edge_type: body.edge_type ?? "references",
        });
      }
      // One parent a child, as the server refuses a second (`edges.md` 14).
      if (
        body.edge_type === "parent-of" &&
        [...this.edges.values()].some(
          (edge) =>
            edge.edge_type === "parent-of" && edge.target_id === body.target_id,
        )
      ) {
        return answers.edgeCardinality({
          target_id: body.target_id,
          edge_type: "parent-of",
        });
      }
      const edge = { ...body, version: 1, created_at: this.stamp() };
      this.edges.set(edge.id, edge);
      this.log("edge.created", edge);
      return writeAnswers.edge(edge, 201);
    });
    server.answer("PATCH", /^\/edges\/[^/]+$/, (request) => {
      const held = this.edges.get(request.pathname.split("/").at(-1) ?? "");
      const body = JSON.parse(request.body) as {
        properties?: Record<string, unknown>;
        version: number;
      };
      if (held === undefined) {
        return refusal(404, "edge_not_found", "No such edge");
      }
      if (body.version !== held.version) {
        return answers.edgeVersionConflict(wireEdge(held));
      }
      const standIn = this.placing?.({
        ...held,
        properties: { ...held.properties, ...body.properties },
      });
      if (standIn !== undefined) return standIn;
      const edge = {
        ...held,
        properties: { ...held.properties, ...body.properties },
        version: held.version + 1,
        updated_at: this.stamp(),
      };
      this.edges.set(edge.id, edge);
      this.log("edge.updated", edge);
      return writeAnswers.edge(edge, 200);
    });
    // A refused edge write is reconciled by reading its source's edges.
    server.answer("GET", /^\/items\/[^/]+\/edges$/, (request) => {
      if (this.failListings > 0) {
        this.failListings -= 1;
        return refusal(503, "unavailable", "Try again");
      }
      const source = request.pathname.split("/").at(-2);
      const type = request.query.get("edge_type");
      return edgesPage(
        [...this.edges.values()]
          .filter(
            (edge) =>
              edge.source_id === source &&
              (type === null || edge.edge_type === type),
          )
          .map((edge) => wireEdge(edge)),
      );
    });
    server.answer("DELETE", /^\/edges\/[^/]+$/, (request) => {
      const id = request.pathname.split("/").at(-1) ?? "";
      const held = this.edges.get(id);
      if (held === undefined) {
        return refusal(404, "edge_not_found", "No such edge");
      }
      const standIn = this.deleting?.(held);
      if (standIn !== undefined) return standIn;
      this.edges.delete(id);
      this.log("edge.deleted", held);
      return writeAnswers.ok();
    });
  }

  /** Another machine moving an item's placement in a folder to `path`. */
  relocate(source: string, folderId: string, path: string): void {
    const held = [...this.edges.values()].find(
      (edge) =>
        edge.edge_type === "in-folder" &&
        edge.source_id === source &&
        edge.target_id === folderId,
    );
    if (held === undefined) throw new Error(`${source} has no placement`);
    const edge = {
      ...held,
      properties: { path },
      version: held.version + 1,
      updated_at: this.stamp(),
    };
    this.edges.set(edge.id, edge);
    this.log("edge.updated", edge);
  }

  /** The folder's placements, as `path` by source. */
  placements(folderId: string): Map<string, unknown> {
    return new Map(
      [...this.edges.values()]
        .filter(
          (edge) =>
            edge.edge_type === "in-folder" && edge.target_id === folderId,
        )
        .map((edge) => [edge.source_id, edge.properties?.path]),
    );
  }

  /** The stream as the server's log serves it: a head read where no cursor
   *  is named, and every change after the cursor otherwise. */
  stream(): (request: RecordedRequest) => Answer {
    return (request) => {
      const after = request.headers["last-event-id"];
      const head = String(this.events.length + 1);
      if (after === undefined) return headRead(head);
      return liveReplay(
        head,
        this.events.filter((frame) => Number(frame.id) > Number(after)),
      );
    };
  }

  /** An item write the door's server took, logged as its event. */
  logItem(kind: string, answer: Answer): void {
    if (answer.kind !== "json" || answer.status >= 300) return;
    const { item, metadata } = answer.body as {
      item?: Record<string, unknown>;
      metadata?: { tags?: string[] };
    };
    if (item === undefined) return;
    this.events.push(
      itemEvent(String(this.events.length + 2), kind, item, {
        tags: metadata?.tags ?? [],
      }),
    );
  }

  private log(kind: string, edge: WireEdgeOptions): void {
    this.events.push(
      edgeEvent(String(this.events.length + 2), kind, wireEdge(edge)),
    );
  }

  /** A moment later than every one before it, so an older edge reads older. */
  private stamp(): string {
    this.minted += 1;
    return new Date(Date.UTC(2026, 8, 18) + this.minted * 1000).toISOString();
  }
}

/** What the folder sent to the items door, parsed. */
function sentCreates(harness: FolderHarness): Array<Record<string, unknown>> {
  return harness.server.requests
    .filter(
      (request) => request.method === "POST" && request.pathname === "/items",
    )
    .map((request) => JSON.parse(request.body) as Record<string, unknown>);
}

/** The titles the folder's creates carried, in the order sent. */
function sentTitles(harness: FolderHarness): string[] {
  return sentCreates(harness).map((sent) =>
    String((sent.properties as Record<string, unknown>).title),
  );
}

/** The item updates the folder sent, each with the id it went to. */
function sentUpdates(
  harness: FolderHarness,
): Array<{ id: string; body: Record<string, unknown> }> {
  return harness.server.requests
    .filter(
      (request) =>
        request.method === "PATCH" && /^\/items\/[^/]+$/.test(request.pathname),
    )
    .map((request) => ({
      id: request.pathname.split("/").at(-1) ?? "",
      body: JSON.parse(request.body) as Record<string, unknown>,
    }));
}

/** A queue without the folder's placements, for a fixture about the other
 *  writes a file makes (`folders.md` 19). */
function withoutPlacements(
  harness: FolderHarness,
  rows: QueuedWrite[],
): QueuedWrite[] {
  return rows.filter(
    (row) =>
      !(row.kind.endsWith("_edge") && row.target_id === harness.settings.id),
  );
}

/** The verdicts on writes of items, without the placements a push also
 *  sends (`folders.md` 19). */
function itemVerdicts(verdicts: DrainVerdict[]): DrainVerdict[] {
  return verdicts.filter((entry) => !entry.kind.endsWith("_edge"));
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
        (): Answer => replay("2", [itemEvent("2", "item.updated", changed)]),
        liveReplay("2", []),
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
          (): Answer => replay("2", [itemEvent("2", "item.updated", changed)]),
          headRead("3"),
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
    for (const { what, row } of [
      {
        what: "an item of another type",
        row: (id: string) =>
          wireItem({ id, properties: { title: "a note", body: "x\n" } }),
      },
      {
        what: "a revoked folder",
        row: (id: string) =>
          wireItem({
            id,
            type: "system.folder",
            state: "revoked",
            properties: {
              title: "gone",
              revoked_at: "2026-09-01T00:00:00.000Z",
            },
          }),
      },
    ]) {
      const server = await ScriptedServer.start();
      scriptHydration(server, { head: "1" });
      const id = "01a00000-0000-7000-8000-0000000001f2";
      server.answer("GET", `/items/${id}`, answers.updated(row(id)));
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
        expect(added.ok, `a directory was bound to ${what}`).toBe(false);
      } finally {
        await server.stop();
      }
    }
  });

  it("refuses to follow settings its key cannot read, naming the permission", async () => {
    const server = await ScriptedServer.start();
    const id = "01a00000-0000-7000-8000-0000000001f1";
    server.answer(
      "GET",
      `/items/${id}`,
      refusal(403, "type_not_permitted", "Read access to type denied"),
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
      expect(added.refusal.raw).toContain("system.folder:read");
      // Written by every add that succeeds (`› writes its settings out as one
      // file in .marfa/`).
      expect(existsSync(join(dir, ".marfa", "folder.yaml"))).toBe(false);
    } finally {
      await server.stop();
    }
  });

  it("refuses a folder whose settings are kept on this machine, and says to add it again", async () => {
    harness = await folderHarness("folder-old-record");
    writeFileSync(
      join(harness.dir, ".marfa", "folder.json"),
      JSON.stringify({
        types: ["core.note"],
        tier: "library",
        default_type: "core.note",
      }),
    );
    const pushed = await harness.folder.push();
    expect(pushed.ok, "a folder read settings kept on this machine").toBe(
      false,
    );
    if (pushed.ok) return;
    expect(pushed.refusal.raw).toContain("folders add");
    // Added again, as the refusal says, it is a folder once more.
    expect((await harness.folder.add(harness.settings.id)).ok).toBe(true);
    scriptFolderWrites(harness);
    const again = await harness.folder.push();
    expect(
      again.ok,
      `a folder added again still refused its old record: ${JSON.stringify(again)}`,
    ).toBe(true);
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
      events: [liveReplay("1", [])],
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
  });

  it("sends a settings edit the folder door could not take for now at the next push", async () => {
    harness = await folderHarness("folder-settings-retried", {
      events: [liveReplay("1", [])],
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

  it("sends an edit to its settings file through the folder door", async () => {
    harness = await folderHarness("folder-settings-edit", {
      events: [liveReplay("1", [])],
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
        (): Answer => replay("2", [itemEvent("2", "item.updated", changed)]),
        liveReplay("2", []),
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
        (): Answer => replay("2", [itemEvent("2", "item.updated", changed)]),
        liveReplay("2", []),
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
        (): Answer => replay("2", [itemEvent("2", "item.updated", changed)]),
        liveReplay("2", []),
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
    for (const { what, settings } of [
      {
        what: "a type",
        settings: {
          search: { types: ["core.note"] },
          defaults: { type: "core.bookmark" },
        },
      },
      {
        what: "a tier",
        settings: {
          search: { types: ["core.note"] },
          defaults: { tier: "feed" as const },
        },
      },
    ]) {
      const server = await ScriptedServer.start();
      scriptHydration(server, { head: "1" });
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
        (): Answer => replay("2", [itemEvent("2", "item.updated", changed)]),
        liveReplay("2", []),
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
          properties: { language: "en", status: "draft" },
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
    second = await folderHarness("folder-two", {
      settings: { search: { types: ["core.bookmark"] } },
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
      pushed.value.drain.sent,
      "the folder queued the work and sent none of it, so discarding the container would lose it",
    ).toBeGreaterThan(0);

    // Discarded. Nothing outside the directory held anything.
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
        (): Answer => replay("2", [itemEvent("2", "item.updated", changed)]),
        liveReplay("2", []),
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
    change: () => ReturnType<typeof itemEvent>;
  }> = [
    {
      condition: "tag",
      settings: {
        search: { types: ["core.note"], filter: 'tags contains "keep"' },
      },
      item: note(joining, "joining"),
      change: () =>
        itemEvent(
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
        itemEvent(
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
        itemEvent(
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
        events: [replay("2", [change()]), liveReplay("2", [])],
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
        replay("3", [
          itemEvent(
            "2",
            "item.created",
            wireItem({
              id: system,
              type: "system.connection",
              properties: { title: "c" },
            }),
          ),
          itemEvent(
            "3",
            "item.created",
            wireItem({ id: note, properties: { title: "n", body: "b\n" } }),
          ),
        ]),
        liveReplay("3", []),
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
      "---\ntitle: A note\ncount: 3\nundeclared_field: kept\nnested:\n  deep: true\n---\nThe body.\n",
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
    put(harness, "target.md", "---\ntitle: Target\n---\nthe other end\n");
    expect((await harness.folder.scan()).ok).toBe(true);
    put(
      harness,
      "source.md",
      "---\ntitle: Source\n---\nsee [[target]] for more\n",
    );
    expect((await harness.folder.push()).ok).toBe(true);

    const device = harness.folder.device();
    const before = await device.queue();
    expect(before.ok).toBe(true);
    if (!before.ok) return;
    expect(
      withoutPlacements(harness, before.value).filter(
        (row) => row.kind === "create_edge",
      ).length,
      "the link never became an edge, so there is nothing here for a later scan to remove",
    ).toBe(1);

    // Tidying: the target is renamed and the source is edited in one window,
    // which is what people do. The link still says `target` and now resolves
    // to nothing — and a link that names nothing looks exactly like a link
    // that has gone.
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
      "the folder destroyed the edge because the link stopped resolving, so renaming a file while editing another quietly cuts the connection between them and the line stays in the body saying otherwise",
    ).toEqual([]);
  });

  it("remembers a link it stood down over, so a later removal still lands", async () => {
    harness = await folderHarness("folder-stand-down-memory");
    scriptFolderWrites(harness);
    put(harness, "one.md", "---\ntitle: One\n---\nfirst\n");
    put(harness, "two.md", "---\ntitle: Two\n---\nsecond\n");
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
        liveReplay("2", [
          itemEvent(
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
    expect(
      read(harness, "elsewhere.md"),
      "a push wrote the folder out from a copy that never heard of the change another device made",
    ).toContain("changed on another device");
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
        liveReplay("2", [
          itemEvent(
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

  describe("a copy that falls behind the log", () => {
    const id = "01a00000-0000-7000-8000-0000000000c3";
    const agedOut: Answer = {
      kind: "sse",
      frames: [connected, streamCursor("900"), catchupTooOld("500", "1")],
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
        headRead("900"),
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
        headRead("900"),
        liveReplay("900", []),
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
        headRead("900"),
        liveReplay("900", []),
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
        timed(headRead("900")),
        liveReplay("900", []),
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
        headRead("900"),
        liveReplay("900", []),
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
        liveReplay("2", [
          itemEvent(
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

  it("makes an edge between two files that arrive together", async () => {
    harness = await folderHarness("folder-links-same-scan");
    scriptFolderWrites(harness);
    // Both new in one scan, each naming the other. The walk returns them
    // sorted, so one is reached before the other is bound.
    put(harness, "alpha.md", "---\ntitle: Alpha\n---\nsee [[omega]]\n");
    put(harness, "omega.md", "---\ntitle: Omega\n---\nsee [[alpha]]\n");
    expect((await harness.folder.push()).ok).toBe(true);

    const queued = await harness.folder.device().queue();
    expect(queued.ok).toBe(true);
    if (!queued.ok) return;
    const edges = withoutPlacements(harness, queued.value).filter(
      (row) => row.kind === "create_edge",
    );
    const creates = sentCreates(harness);
    expect(
      creates.length,
      "the two files never became items, so there is nothing for an edge to join",
    ).toBe(2);
    expect(
      edges.length,
      "a link to a file that arrived in the same scan never became an edge, and no later scan retries it because both files are unchanged from then on",
    ).toBe(2);
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

/** A row the hydration serves, with the edges it draws hydrated onto it. */
function edgeRows(
  items: WireItemOptions[],
  edges: WireEdgeOptions[],
): Record<string, Array<{ item: WireItemOptions }>> {
  const rows: Record<string, Array<{ item: WireItemOptions }>> = {};
  for (const item of items) {
    const drawn: Record<string, { data: unknown[]; next_cursor: null }> = {};
    for (const edge of edges.filter((held) => held.source_id === item.id)) {
      const type = edge.edge_type ?? "references";
      (drawn[type] ??= { data: [], next_cursor: null }).data.push(
        wireEdge(edge),
      );
    }
    // Under the type a hydration asks for, whose subtree it holds.
    const asked = (item.type ?? "core.note").split(".").slice(0, 2).join(".");
    (rows[asked] ??= []).push({
      item: { ...item, edges: drawn },
    });
  }
  return rows;
}

/** A note titled `title`, its body the title. */
function titled(
  id: string,
  title: string,
  type = "core.note",
): WireItemOptions {
  return { id, type, properties: { title, body: `${title}\n` } };
}

/** A folder whose server holds `items` and `edges` wherever the real one
 *  would serve them: on the source's row, listed whole, and at the edge door. */
async function edgeHarness(
  label: string,
  items: WireItemOptions[],
  edges: WireEdgeOptions[],
  options: {
    settings?: FolderSettings;
    events?: Responder[];
    lookup?: (text: string) => Answer | undefined;
  } = {},
): Promise<{ harness: FolderHarness; door: EdgeDoor }> {
  const whole = (type: string) =>
    edges.filter((edge) => edge.edge_type === type);
  const made = await folderHarness(label, {
    settings: options.settings,
    rows: edgeRows(items, edges),
    edges: {
      "parent-of": whole("parent-of"),
      "attached-to": whole("attached-to"),
    },
    events: options.events,
    lookup: options.lookup,
  });
  const door = new EdgeDoor();
  for (const edge of edges) door.hold(edge);
  scriptFolderWrites(made, { edges: door });
  return { harness: made, door };
}

/** The frontmatter a file opens with, fences and all. */
function frontOf(harness: FolderHarness, name: string): string {
  return /^---\n[\s\S]*?\n---\n/.exec(read(harness, name))?.[0] ?? "";
}

/** What follows a file's frontmatter. */
function bodyOf(harness: FolderHarness, name: string): string {
  return read(harness, name).slice(frontOf(harness, name).length);
}

/** The edges the door holds, placements aside, as `source type target`. */
function heldEdges(door: EdgeDoor): string[] {
  return [...door.edges.values()]
    .filter((edge) => edge.edge_type !== "in-folder")
    .map(
      (edge) =>
        `${edge.source_id} ${edge.edge_type ?? "references"} ${edge.target_id}`,
    )
    .sort();
}

/** The edge writes the folder sent, placements aside, in order. */
function sentEdgeWrites(harness: FolderHarness): string[] {
  return harness.server.requests.flatMap((request) => {
    if (request.method === "POST" && request.pathname === "/edges") {
      const edge = JSON.parse(request.body) as WireEdgeOptions;
      return edge.edge_type === "in-folder"
        ? []
        : [`create ${edge.source_id} ${edge.edge_type} ${edge.target_id}`];
    }
    if (request.method === "DELETE" && request.pathname.startsWith("/edges/")) {
      return [`delete ${request.pathname.split("/").at(-1) ?? ""}`];
    }
    return [];
  });
}

/** Replaces a line of a file's text, failing where it is not there. */
function edit(
  harness: FolderHarness,
  name: string,
  from: string | RegExp,
  to: string,
): void {
  const text = read(harness, name);
  const next = text.replace(from, to);
  if (next === text) {
    throw new Error(`${name} does not carry ${String(from)}:\n${text}`);
  }
  writeFileSync(join(harness.dir, name), next);
}

describe("edges in frontmatter", () => {
  const project = "01a00000-0000-7000-8000-00000000e101";
  const child = "01a00000-0000-7000-8000-00000000e102";
  const other = "01a00000-0000-7000-8000-00000000e103";
  const alpha = "01a00000-0000-7000-8000-00000000e104";
  const beta = "01a00000-0000-7000-8000-00000000e105";
  const gamma = "01a00000-0000-7000-8000-00000000e106";
  const third = "01a00000-0000-7000-8000-00000000e10a";

  it("writes an edge in one file only", async () => {
    const made = await edgeHarness(
      "folder-edge-one-file",
      [titled(alpha, "Alpha"), titled(beta, "Beta")],
      [
        {
          id: "01a00000-0000-7000-8000-00000000e1e1",
          source_id: alpha,
          target_id: beta,
          edge_type: "about",
        },
      ],
    );
    harness = made.harness;
    const pulled = await harness.folder.pull();
    expect(pulled.ok, JSON.stringify(pulled)).toBe(true);
    expect(
      frontOf(harness, "Alpha.md"),
      "the edge is not a line in its source's frontmatter",
    ).toContain('about:\n  - "[[Beta]]"');
    expect(
      bodyOf(harness, "Alpha.md"),
      "the edge was written into the body as well as, or instead of, the frontmatter",
    ).not.toContain("[[Beta]]");
    expect(
      read(harness, "Beta.md"),
      "the edge was written in its target's file too, so one edge is in two files",
    ).not.toContain("Alpha");

    // Read back, both files change nothing.
    expect((await harness.folder.push()).ok).toBe(true);
    expect(sentEdgeWrites(harness)).toEqual([]);
  });

  it("writes parent-of as child-of in the child", async () => {
    const made = await edgeHarness(
      "folder-edge-child-of",
      [titled(project, "Project"), titled(child, "Child")],
      [
        {
          id: "01a00000-0000-7000-8000-00000000e1e2",
          source_id: project,
          target_id: child,
          edge_type: "parent-of",
        },
      ],
    );
    harness = made.harness;
    expect(
      [
        ...new Set(
          harness.server.requests
            .filter((request) => request.pathname === "/edges")
            .map((request) => request.query.get("edge_type")),
        ),
      ],
      "the copy held whole an edge type that neither a child's file nor a host's embeds need",
    ).toEqual(["attached-to", "parent-of"]);
    expect((await harness.folder.pull()).ok).toBe(true);
    expect(
      frontOf(harness, "Child.md"),
      "the child's file does not name its parent under the reverse name",
    ).toContain('child-of: "[[Project]]"');
    expect(
      read(harness, "Project.md"),
      "the parent's file lists its child, so a parent-of edge is written at the end its type does not name",
    ).not.toMatch(/parent-of|\[\[Child\]\]/);

    // A new child's file names its parent the same way.
    put(harness, "Second.md", '---\nchild-of: "[[Project]]"\n---\nanother\n');
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    const [created] = sentCreates(harness);
    expect(
      sentEdgeWrites(harness),
      "a child-of line did not become the parent's parent-of edge",
    ).toEqual([`create ${project} parent-of ${String(created?.id)}`]);
  });

  it("writes attached-to in the attachment's file, and has-attachment in an image's host", async () => {
    const host = "01a00000-0000-7000-8000-00000000e111";
    const log = "01a00000-0000-7000-8000-00000000e112";
    const image = "01a00000-0000-7000-8000-00000000e113";
    const bytes = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 2,
    ]);
    const made = await edgeHarness(
      "folder-edge-attachments",
      [
        titled(host, "Host"),
        titled(log, "Log"),
        {
          id: image,
          type: "core.file.image",
          properties: {
            title: "picture.png",
            blob_ref: hashOf(bytes),
            mime_type: "image/png",
          },
        },
      ],
      [
        {
          id: "01a00000-0000-7000-8000-00000000e1e3",
          source_id: log,
          target_id: host,
          edge_type: "attached-to",
        },
        {
          id: "01a00000-0000-7000-8000-00000000e1e4",
          source_id: image,
          target_id: host,
          edge_type: "attached-to",
        },
      ],
      {
        settings: {
          search: { types: ["core.note", "core.file"] },
          defaults: { type: "core.note" },
        },
      },
    );
    harness = made.harness;
    scriptBlob(harness.server, bytes);
    const pulled = await harness.folder.pull();
    expect(pulled.ok, JSON.stringify(pulled)).toBe(true);
    expect(
      frontOf(harness, "Log.md"),
      "an attachment that carries frontmatter does not say what it is attached to",
    ).toContain('attached-to:\n  - "[[Host]]"');
    expect(
      frontOf(harness, "Host.md"),
      "the host of an image does not name it, so an attachment that cannot carry frontmatter is written nowhere",
    ).toContain('has-attachment:\n  - "[[picture.png]]"');
    expect(
      read(harness, "Host.md"),
      "the host names an attachment whose own file already writes the edge",
    ).not.toContain("Log");
  });

  it("resolves a target written by id", async () => {
    // A bookmark this folder of notes does not hold, so only its id, which
    // the server answers for, names it.
    const made = await edgeHarness(
      "folder-edge-by-id",
      [titled(alpha, "Alpha"), titled(gamma, "Kept", "core.bookmark")],
      [],
    );
    harness = made.harness;
    put(harness, "New.md", `---\nabout: "[[${gamma}]]"\n---\nnew\n`);
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    const [created] = sentCreates(harness);
    expect(
      sentEdgeWrites(harness),
      "a line naming its target by id made no edge to it",
    ).toEqual([`create ${String(created?.id)} about ${gamma}`]);
    expect(pushed.ok && pushed.value.scan.flagged).toEqual([]);
  });

  it("writes the id form where a name is repeated", async () => {
    const twin = "01a00000-0000-7000-8000-00000000e107";
    const made = await edgeHarness(
      "folder-edge-id-form",
      [titled(alpha, "Alpha"), titled(beta, "Same"), titled(twin, "Same")],
      [
        {
          id: "01a00000-0000-7000-8000-00000000e1e5",
          source_id: alpha,
          target_id: beta,
          edge_type: "about",
        },
      ],
    );
    harness = made.harness;
    expect((await harness.folder.pull()).ok).toBe(true);
    expect(
      frontOf(harness, "Alpha.md"),
      "a target whose title another item shares was written by that title, which names two items",
    ).toContain(`about:\n  - "[[${beta}]]"`);

    // And it reads back as the item it names.
    edit(harness, "Alpha.md", "Alpha\n", "Alpha, edited\n");
    expect((await harness.folder.push()).ok).toBe(true);
    expect(sentEdgeWrites(harness)).toEqual([]);
  });

  it("removes the edge whose line was taken out", async () => {
    const edge = "01a00000-0000-7000-8000-00000000e1e6";
    const made = await edgeHarness(
      "folder-edge-line-removed",
      [titled(alpha, "Alpha"), titled(beta, "Beta"), titled(gamma, "Gamma")],
      [
        { id: edge, source_id: alpha, target_id: beta, edge_type: "about" },
        {
          id: "01a00000-0000-7000-8000-00000000e1e7",
          source_id: alpha,
          target_id: gamma,
          edge_type: "about",
        },
      ],
    );
    harness = made.harness;
    expect((await harness.folder.pull()).ok).toBe(true);
    edit(harness, "Alpha.md", '  - "[[Beta]]"\n', "");
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    expect(
      sentEdgeWrites(harness),
      "taking a line out left its edge, or took another with it",
    ).toEqual([`delete ${edge}`]);
    expect(heldEdges(made.door)).toEqual([`${alpha} about ${gamma}`]);
    expect(
      sentUpdates(harness),
      "a line taken out was sent as an edit of the item, when it changes only an edge",
    ).toEqual([]);
  });

  it("changes no edge of a type whose target it cannot resolve", async () => {
    const edge = "01a00000-0000-7000-8000-00000000e1e8";
    const made = await edgeHarness(
      "folder-edge-stand-down",
      [titled(alpha, "Alpha"), titled(beta, "Beta"), titled(gamma, "Gamma")],
      [
        {
          id: "01a00000-0000-7000-8000-00000000e1e9",
          source_id: alpha,
          target_id: beta,
          edge_type: "about",
        },
        { id: edge, source_id: alpha, target_id: gamma, edge_type: "about" },
      ],
    );
    harness = made.harness;
    expect((await harness.folder.pull()).ok).toBe(true);
    // Gamma taken out beside a name that matches nothing, and a line of
    // another type that does resolve.
    edit(
      harness,
      "Alpha.md",
      /about:\n(?: {2}- .*\n)+/,
      'about:\n  - "[[Beta]]"\n  - "[[Nowhere]]"\nreferences: "[[Beta]]"\n',
    );
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    if (!pushed.ok) return;
    expect(
      pushed.value.scan.flagged.map((file) => [file.path, file.flag]),
      "a name that resolves to nothing was not flagged",
    ).toEqual([["Alpha.md", "edges"]]);
    expect(pushed.value.scan.flagged[0]?.reason).toContain("[[Nowhere]]");
    expect(
      sentEdgeWrites(harness),
      "an edge type with a name it cannot resolve changed anyway, or a type beside it did not",
    ).toEqual([`create ${alpha} references ${beta}`]);
    expect(
      read(harness, "Alpha.md"),
      "the pull wrote over a file whose line it could not resolve",
    ).toContain("[[Nowhere]]");

    // The witness: without the name, the same removal lands.
    edit(harness, "Alpha.md", '  - "[[Nowhere]]"\n', "");
    expect((await harness.folder.push()).ok).toBe(true);
    expect(sentEdgeWrites(harness).at(-1)).toBe(`delete ${edge}`);
  });

  it("writes and reads back by title a link to an item with no file on this Mac", async () => {
    // A bookmark a folder of notes does not hold: it has no file here.
    const made = await edgeHarness(
      "folder-edge-no-file",
      [
        titled(alpha, "Alpha"),
        titled(gamma, "Kept elsewhere", "core.bookmark"),
      ],
      [
        {
          id: "01a00000-0000-7000-8000-00000000e1ea",
          source_id: alpha,
          target_id: gamma,
          edge_type: "about",
        },
      ],
    );
    harness = made.harness;
    const pulled = await harness.folder.pull();
    expect(pulled.ok, JSON.stringify(pulled)).toBe(true);
    expect(existsSync(join(harness.dir, "Kept elsewhere.md"))).toBe(false);
    expect(
      frontOf(harness, "Alpha.md"),
      "an edge to an item with no file on this Mac was not written, or not by its title",
    ).toContain('about:\n  - "[[Kept elsewhere]]"');

    edit(harness, "Alpha.md", "Alpha\n", "Alpha, edited\n");
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    expect(
      sentEdgeWrites(harness),
      "a line naming its target by title did not read back as that target",
    ).toEqual([]);
    expect(pushed.ok && pushed.value.scan.flagged).toEqual([]);
  });

  it("flags an ambiguous name and leaves it as typed", async () => {
    // One Twin in this folder and one only the server holds: the copy alone
    // would read the name as the first.
    const twin = "01a00000-0000-7000-8000-00000000e108";
    const made = await edgeHarness(
      "folder-edge-ambiguous",
      [titled(beta, "Twin"), titled(twin, "twin", "core.bookmark")],
      [],
    );
    harness = made.harness;
    const text = '---\nabout: "[[Twin]]"\n---\nwhich one\n';
    put(harness, "New.md", text);
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    if (!pushed.ok) return;
    expect(
      pushed.value.scan.flagged.map((file) => [file.path, file.flag]),
      "a name two items answer to was not flagged",
    ).toEqual([["New.md", "edges"]]);
    expect(pushed.value.scan.flagged[0]?.reason).toContain("more than one");
    expect(
      sentEdgeWrites(harness),
      "a name two items answer to was guessed",
    ).toEqual([]);
    expect(read(harness, "New.md"), "the file was not left as typed").toBe(
      text,
    );
    expect(
      harness.server.requests.some(
        (request) =>
          request.pathname === "/items" &&
          (request.query.get("filter") ?? "").includes('contains "Twin"'),
      ),
      "the server was not asked for the name",
    ).toBe(true);

    // The witness: the id form names one of the two, and the edge is made.
    edit(harness, "New.md", "[[Twin]]", `[[${twin}]]`);
    expect((await harness.folder.push()).ok).toBe(true);
    expect(sentEdgeWrites(harness)).toEqual([
      `create ${String(sentCreates(harness)[0]?.id)} about ${twin}`,
    ]);
  });

  it("flags an unmatched name and leaves it as typed", async () => {
    const made = await edgeHarness(
      "folder-edge-unmatched",
      [titled(alpha, "Alpha")],
      [],
    );
    harness = made.harness;
    const text = '---\nabout: "[[Nobody]]"\n---\nnamed\n';
    put(harness, "New.md", text);
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    if (!pushed.ok) return;
    expect(
      pushed.value.scan.flagged.map((file) => [file.path, file.flag]),
      "a name nothing answers to was not flagged",
    ).toEqual([["New.md", "edges"]]);
    expect(pushed.value.scan.flagged[0]?.reason).toContain("matches no item");
    expect(sentEdgeWrites(harness)).toEqual([]);
    expect(read(harness, "New.md"), "the file was not left as typed").toBe(
      text,
    );

    // The witness: a name that matches makes the edge.
    edit(harness, "New.md", "[[Nobody]]", "[[Alpha]]");
    expect((await harness.folder.push()).ok).toBe(true);
    expect(sentEdgeWrites(harness)).toEqual([
      `create ${String(sentCreates(harness)[0]?.id)} about ${alpha}`,
    ]);
  });

  it("leaves an existing link unchanged when a same-named item appears", async () => {
    const newcomer = "01a00000-0000-7000-8000-00000000e109";
    let appeared: Record<string, unknown> = {};
    const made = await edgeHarness(
      "folder-edge-stable",
      [titled(alpha, "Alpha"), titled(beta, "Beta")],
      [
        {
          id: "01a00000-0000-7000-8000-00000000e1eb",
          source_id: alpha,
          target_id: beta,
          edge_type: "about",
        },
      ],
      {
        events: [
          (): Answer => replay("2", [itemEvent("2", "item.created", appeared)]),
          headRead("3"),
        ],
      },
    );
    harness = made.harness;
    expect((await harness.folder.pull()).ok).toBe(true);
    expect(frontOf(harness, "Alpha.md")).toContain('about:\n  - "[[Beta]]"');

    // Another Beta arrives; then the person edits the file naming the first.
    appeared = wireItem(titled(newcomer, "Beta"));
    expect((await harness.folder.push()).ok).toBe(true);
    expect(
      existsSync(join(harness.dir, "Beta (2).md")),
      "the second Beta never reached the folder, so nothing here shares the name",
    ).toBe(true);
    edit(harness, "Alpha.md", "Alpha\n", "Alpha, edited\n");
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    if (!pushed.ok) return;
    expect(
      sentEdgeWrites(harness),
      "an edge moved because another item took its target's name",
    ).toEqual([]);
    expect(pushed.value.scan.flagged).toEqual([]);
    expect(
      frontOf(harness, "Alpha.md"),
      "a line that still names its item was not left as typed",
    ).toContain('about:\n  - "[[Beta]]"');
  });

  it("flags a reverse-named edge stated at the wrong end, and changes nothing", async () => {
    const made = await edgeHarness(
      "folder-edge-wrong-end",
      [titled(project, "Project"), titled(child, "Child")],
      [],
    );
    harness = made.harness;
    expect((await harness.folder.pull()).ok).toBe(true);
    const childBefore = read(harness, "Child.md");
    edit(
      harness,
      "Project.md",
      /marfa_id:/,
      'parent-of: "[[Child]]"\nmarfa_id:',
    );
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    if (!pushed.ok) return;
    expect(
      pushed.value.scan.flagged.map((file) => [file.path, file.flag]),
      "a parent-of line in the parent's file was not flagged",
    ).toEqual([["Project.md", "edges"]]);
    expect(pushed.value.scan.flagged[0]?.reason).toContain("child-of");
    expect(
      sentEdgeWrites(harness),
      "a line at the wrong end made an edge",
    ).toEqual([]);
    expect(sentUpdates(harness)).toEqual([]);
    expect(
      read(harness, "Child.md"),
      "the other end's file was rewritten for a line it does not carry",
    ).toBe(childBefore);

    // The witness: the same edge, stated at its end, is made.
    edit(
      harness,
      "Child.md",
      /marfa_id:/,
      'child-of: "[[Project]]"\nmarfa_id:',
    );
    expect((await harness.folder.push()).ok).toBe(true);
    expect(sentEdgeWrites(harness)).toEqual([
      `create ${project} parent-of ${child}`,
    ]);
  });

  it("learns an edge type the server registers, and reads its line as an edge", async () => {
    let registered = false;
    let later = false;
    const catalog = (): Answer => ({
      kind: "json",
      status: 200,
      body: {
        data: [
          ...SCRIPTED_EDGE_TYPES,
          ...(registered
            ? [
                {
                  id: "cites",
                  cardinality: "many-to-many",
                  written_at: "source",
                },
                {
                  id: "mentor-of",
                  cardinality: "one-to-many",
                  reverse_name: "mentored-by",
                  written_at: "target",
                },
              ]
            : []),
          ...(later
            ? [
                {
                  id: "sponsor-of",
                  cardinality: "one-to-many",
                  reverse_name: "sponsored-by",
                  written_at: "target",
                },
              ]
            : []),
        ],
        next_cursor: null,
      },
    });
    harness = await folderHarness("folder-edge-registered", {
      rows: edgeRows([titled(alpha, "Alpha"), titled(beta, "Beta")], []),
      edgeTypes: catalog,
    });
    const door = new EdgeDoor();
    scriptFolderWrites(harness, { edges: door });
    expect((await harness.folder.pull()).ok).toBe(true);

    // Registered after the folder read its list.
    registered = true;
    put(harness, "New.md", '---\ncites: "[[Beta]]"\n---\nciting\n');
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    if (!pushed.ok) return;
    const [created] = sentCreates(harness);
    expect(
      Object.keys((created?.properties ?? {}) as Record<string, unknown>),
      "a line for a type the server registered went up as a property",
    ).not.toContain("cites");
    expect(sentEdgeWrites(harness)).toEqual([
      `create ${String(created?.id)} cites ${beta}`,
    ]);
    expect(
      pushed.value.catch_up.hydrated,
      "a type written at its target, registered since, did not bring a hydration that holds it whole",
    ).not.toBeNull();
    expect(
      harness.server.requests.some(
        (request) =>
          request.pathname === "/edges" &&
          request.query.get("edge_type") === "mentor-of",
      ),
    ).toBe(true);

    // Registered with no file changed: the catch-up reads it, and holds it.
    later = true;
    const quiet = await harness.folder.push();
    expect(quiet.ok, JSON.stringify(quiet)).toBe(true);
    if (!quiet.ok) return;
    expect(
      quiet.value.catch_up.hydrated,
      "a type registered while no file changed was never read",
    ).not.toBeNull();
  });

  it("flags only the file whose name cannot be looked up, and goes on with the rest", async () => {
    const back = "01a00000-0000-7000-8000-00000000e10b";
    harness = await folderHarness("folder-edge-lookup-fails", {
      rows: edgeRows(
        [titled(alpha, "Alpha"), titled(back, "Back\\", "core.bookmark")],
        [],
      ),
      lookup: (text) =>
        text === "Denied"
          ? refusal(403, "forbidden", "This key may not list here")
          : undefined,
    });
    scriptFolderWrites(harness);
    // YAML reads `\\` in a quoted string as one backslash.
    put(harness, "One.md", '---\nabout: "[[Back\\\\]]"\n---\none\n');
    put(harness, "Two.md", '---\nabout: "[[Alpha]]"\n---\ntwo\n');
    put(harness, "Three.md", '---\nabout: "[[Denied]]"\n---\nthree\n');
    const pushed = await harness.folder.push();
    expect(
      pushed.ok,
      `a lookup the server could not answer ended the push: ${JSON.stringify(pushed)}`,
    ).toBe(true);
    if (!pushed.ok) return;
    const id = (title: string) =>
      String(
        sentCreates(harness!).find(
          (sent) =>
            (sent.properties as Record<string, unknown>).title === title,
        )?.id,
      );
    expect(sentEdgeWrites(harness).sort()).toEqual(
      [
        `create ${id("One")} about ${back}`,
        `create ${id("Two")} about ${alpha}`,
      ].sort(),
    );
    expect(
      pushed.value.scan.flagged.map((file) => [file.path, file.flag]),
    ).toEqual([["Three.md", "edges"]]);
    expect(pushed.value.scan.flagged[0]?.reason).toContain("forbidden");
    expect(
      frontOf(harness, "Two.md"),
      "a line that made its edge was erased by the pull",
    ).toContain("[[Alpha]]");

    // A refusal is an answer: it is not asked again until the file changes.
    const asked = () =>
      harness!.server.requests.filter((request) =>
        (request.query.get("filter") ?? "").includes('"Denied"'),
      ).length;
    const before = asked();
    expect((await harness.folder.push()).ok).toBe(true);
    expect(asked()).toBe(before);
  });

  it("flags a new target for an end whose edge the file never showed, and deletes nothing", async () => {
    const parentEdge = {
      id: "01a00000-0000-7000-8000-00000000e1ed",
      source_id: project,
      target_id: child,
      edge_type: "parent-of",
    };
    harness = await folderHarness("folder-edge-unshown", {
      rows: edgeRows(
        [titled(project, "One"), titled(other, "Two"), titled(child, "Child")],
        [],
      ),
      events: [
        (): Answer =>
          replay("2", [edgeEvent("2", "edge.created", wireEdge(parentEdge))]),
        headRead("3"),
      ],
    });
    const door = new EdgeDoor();
    scriptFolderWrites(harness, { edges: door });
    expect((await harness.folder.pull()).ok).toBe(true);
    // Another machine gives the child a parent; no pull has shown it.
    door.hold(parentEdge);
    expect((await harness.folder.device().catchUp()).ok).toBe(true);
    edit(harness, "Child.md", /marfa_id:/, 'child-of: "[[Two]]"\nmarfa_id:');
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    if (!pushed.ok) return;
    expect(
      pushed.value.scan.flagged.map((file) => [file.path, file.flag]),
      "a second parent was not flagged",
    ).toEqual([["Child.md", "edges"]]);
    expect(
      sentEdgeWrites(harness),
      "a parent the file never showed was replaced unseen",
    ).toEqual([]);
    expect(heldEdges(door)).toEqual([`${project} parent-of ${child}`]);

    // The witness: once the file shows the parent, the same change replaces it.
    edit(harness, "Child.md", 'child-of: "[[Two]]"\n', "");
    expect((await harness.folder.push()).ok).toBe(true);
    expect(frontOf(harness, "Child.md")).toContain('child-of: "[[One]]"');
    edit(harness, "Child.md", "[[One]]", "[[Two]]");
    expect((await harness.folder.push()).ok).toBe(true);
    expect(heldEdges(door)).toEqual([`${other} parent-of ${child}`]);
  });

  it("keeps a typed has-attachment to an image the copy does not hold", async () => {
    const image = "01a00000-0000-7000-8000-00000000e10c";
    const made = await edgeHarness(
      "folder-edge-typed-attachment",
      [
        titled(alpha, "Host"),
        {
          id: image,
          type: "core.file.image",
          properties: {
            title: "picture.png",
            blob_ref: hashOf(Buffer.from("a picture")),
            mime_type: "image/png",
          },
        },
      ],
      [],
    );
    harness = made.harness;
    expect((await harness.folder.pull()).ok).toBe(true);
    edit(
      harness,
      "Host.md",
      /marfa_id:/,
      'has-attachment: "[[picture.png]]"\nmarfa_id:',
    );
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    expect(heldEdges(made.door)).toEqual([`${image} attached-to ${alpha}`]);
    expect(
      frontOf(harness, "Host.md"),
      "the pull erased a line whose edge it made, so the edge is shown in no file",
    ).toContain("has-attachment");
    expect(existsSync(join(harness.dir, "picture.png"))).toBe(false);
  });

  it("resolves a name by its file's name, and keeps it as typed", async () => {
    const made = await edgeHarness(
      "folder-edge-file-name",
      [titled(alpha, "Alpha")],
      [],
    );
    harness = made.harness;
    put(harness, "notes/g-file.md", "---\ntitle: Different\n---\nnamed so\n");
    expect((await harness.folder.push()).ok).toBe(true);
    const target = String(sentCreates(harness)[0]?.id);
    put(harness, "New.md", '---\nabout: "[[g-file]]"\n---\nby its file\n');
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    expect(
      sentEdgeWrites(harness),
      "a name matching a file here, and no title, was not read as that file's item",
    ).toEqual([
      `create ${String(sentCreates(harness)[1]?.id)} about ${target}`,
    ]);
    expect(
      frontOf(harness, "New.md"),
      "the pull wrote the target's title over the file name the person typed",
    ).toContain('"[[g-file]]"');
  });

  it("flags a name more common than the lookup reads", async () => {
    let page = 0;
    harness = await folderHarness("folder-edge-common", {
      rows: edgeRows([titled(alpha, "Alpha")], []),
      lookup: (text) => {
        if (text !== "Common") return undefined;
        page += 1;
        return itemsPage([{ item: wireItem(titled(gamma, "Common one")) }], {
          nextCursor: `page-${String(page)}`,
        });
      },
    });
    scriptFolderWrites(harness);
    put(harness, "New.md", '---\nabout: "[[Common]]"\n---\nso common\n');
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    if (!pushed.ok) return;
    expect(pushed.value.scan.flagged[0]?.reason).toContain("more than 5 pages");
    // Five pages for each property a title lives in: `title` and `text`.
    expect(page, "the lookup read past its cap").toBe(10);
    expect(sentEdgeWrites(harness)).toEqual([]);
  });

  it("counts an archived match only the server holds, and none in the bin", async () => {
    const filed = "01a00000-0000-7000-8000-00000000e10d";
    const binned = "01a00000-0000-7000-8000-00000000e10e";
    const made = await edgeHarness(
      "folder-edge-states",
      [
        titled(alpha, "Alpha"),
        { ...titled(filed, "Filed away", "core.bookmark"), state: "archived" },
        { ...titled(binned, "Binned", "core.bookmark"), state: "trashed" },
      ],
      [],
    );
    harness = made.harness;
    put(harness, "One.md", '---\nabout: "[[Filed away]]"\n---\none\n');
    put(harness, "Two.md", '---\nabout: "[[Binned]]"\n---\ntwo\n');
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    if (!pushed.ok) return;
    expect(
      sentEdgeWrites(harness),
      "an archived item only the server holds was not found, or one in the bin was",
    ).toEqual([`create ${String(sentCreates(harness)[0]?.id)} about ${filed}`]);
    expect(pushed.value.scan.flagged.map((file) => file.path)).toEqual([
      "Two.md",
    ]);
  });

  it("matches a title only in the property its type keeps it in", async () => {
    const highlight = "01a00000-0000-7000-8000-00000000e10f";
    const made = await edgeHarness(
      "folder-edge-title-field",
      [
        titled(beta, "Solo"),
        {
          id: highlight,
          type: "core.highlight",
          properties: { text: "a passage", title: "Solo", note: "n" },
        },
      ],
      [],
    );
    harness = made.harness;
    put(harness, "New.md", '---\nabout: "[[Solo]]"\n---\nwhich\n');
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    expect(
      sentEdgeWrites(harness),
      "a property named title on a type whose title lives elsewhere was read as its title",
    ).toEqual([`create ${String(sentCreates(harness)[0]?.id)} about ${beta}`]);
  });

  it("waits for the server to resolve a name, and resolves it at the next pass that reaches it", async () => {
    const made = await edgeHarness(
      "folder-edge-waits",
      [titled(alpha, "Alpha")],
      [],
    );
    harness = made.harness;
    put(harness, "New.md", '---\nabout: "[[Alpha]]"\n---\nsoon\n');
    const scanned = await harness.folder.scan();
    expect(scanned.ok && scanned.value.flagged[0]?.reason).toContain(
      "once the server can be asked",
    );
    await harness.server.offline();
    const offline = await harness.folder.push();
    await harness.server.online();
    expect(offline.ok, JSON.stringify(offline)).toBe(true);
    expect(sentEdgeWrites(harness)).toEqual([]);
    const online = await harness.folder.push();
    expect(online.ok, JSON.stringify(online)).toBe(true);
    expect(
      sentEdgeWrites(harness),
      "a name that waited for the server was never asked again",
    ).toEqual([`create ${String(sentCreates(harness)[0]?.id)} about ${alpha}`]);
  });

  it("writes by id a title a link cannot hold", async () => {
    const made = await edgeHarness(
      "folder-edge-unlinkable",
      [titled(alpha, "Alpha"), titled(beta, "C# notes")],
      [
        {
          id: "01a00000-0000-7000-8000-00000000e1f1",
          source_id: alpha,
          target_id: beta,
          edge_type: "about",
        },
      ],
    );
    harness = made.harness;
    expect((await harness.folder.pull()).ok).toBe(true);
    expect(
      frontOf(harness, "Alpha.md"),
      "a title a link reads otherwise was written as a link",
    ).toContain(`"[[${beta}]]"`);
  });

  it("flags an in-folder line and a line naming its own item", async () => {
    const made = await edgeHarness(
      "folder-edge-own-item",
      [titled(alpha, "Alpha")],
      [],
    );
    harness = made.harness;
    put(
      harness,
      "New.md",
      '---\nin-folder: "[[Alpha]]"\nabout: "[[New]]"\n---\nitself\n',
    );
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    if (!pushed.ok) return;
    const reason = pushed.value.scan.flagged[0]?.reason ?? "";
    expect(reason).toContain("in-folder line is not read");
    expect(reason).toContain("names this file's own item");
    expect(sentEdgeWrites(harness)).toEqual([]);
  });

  it("holds a file whose line's edge is refused, and says it beside a name it cannot resolve", async () => {
    const made = await edgeHarness(
      "folder-edge-both-flags",
      [titled(alpha, "Alpha"), titled(beta, "Beta")],
      [],
    );
    harness = made.harness;
    made.door.placing = (edge) =>
      edge.edge_type === "about"
        ? refusal(403, "edge_permission_denied", "No about here")
        : undefined;
    put(
      harness,
      "New.md",
      '---\nabout: "[[Beta]]"\nreferences: "[[Nowhere]]"\n---\ntwo ways\n',
    );
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    if (!pushed.ok) return;
    expect(
      pushed.value.pull?.flagged
        .filter((file) => file.path === "New.md")
        .map((file) => file.flag)
        .sort(),
      "a refused edge, beside a name that resolves to nothing, was not both said",
    ).toEqual(["edges", "refused"]);
  });

  it("holds a pin while a line names its row, and lets go only a pin it made", async () => {
    const kept = "01a00000-0000-7000-8000-00000000e110";
    const manual = "01a00000-0000-7000-8000-00000000e111";
    let archived: Record<string, unknown> = {};
    const made = await edgeHarness(
      "folder-edge-pins",
      [
        titled(alpha, "Alpha"),
        titled(beta, "Beta"),
        titled(kept, "Kept", "core.bookmark"),
        titled(manual, "Manual", "core.bookmark"),
      ],
      [alpha, kept, manual, beta].slice(1).map((target, at) => ({
        id: `01a00000-0000-7000-8000-00000000e1f${String(at + 2)}`,
        source_id: alpha,
        target_id: target,
        edge_type: "about",
      })),
      {
        settings: { search: { types: ["core.note"], state: ["active"] } },
        events: [
          (): Answer => replay("2", [itemEvent("2", "item.updated", archived)]),
          headRead("3"),
        ],
      },
    );
    harness = made.harness;
    const device = harness.folder.device();
    expect((await device.pin(manual)).ok).toBe(true);
    expect((await harness.folder.pull()).ok).toBe(true);
    const pinned = async () => {
      const status = await device.status();
      return status.ok ? status.value.pinned : [];
    };
    expect(await pinned()).toEqual(expect.arrayContaining([kept, manual]));

    // Beta leaves by state and its file goes: Alpha's line still holds it.
    archived = wireItem({ ...titled(beta, "Beta"), state: "archived" });
    expect((await harness.folder.push()).ok).toBe(true);
    expect(existsSync(join(harness.dir, "Beta.md"))).toBe(false);
    expect(
      await pinned(),
      "the binding took a pin a line still holds",
    ).toContain(beta);

    // Taking the lines out lets the folder's own pin go, and no other.
    edit(harness, "Alpha.md", '  - "[[Kept]]"\n', "");
    edit(harness, "Alpha.md", '  - "[[Manual]]"\n', "");
    expect((await harness.folder.push()).ok).toBe(true);
    const after = await pinned();
    expect(after, "a pin no line holds was kept").not.toContain(kept);
    expect(after, "a line let go of a pin somebody else made").toContain(
      manual,
    );
  });

  it("keeps a typed alias as typed, and flags a name that reads two ways", async () => {
    const hash = "01a00000-0000-7000-8000-00000000e112";
    const made = await edgeHarness(
      "folder-edge-alias",
      [
        titled(alpha, "Alpha"),
        titled(beta, "Beta"),
        titled(gamma, "C"),
        titled(hash, "C# notes"),
      ],
      [],
    );
    harness = made.harness;
    put(harness, "One.md", '---\nabout: "[[Beta|the beta]]"\n---\none\n');
    put(harness, "Two.md", '---\nabout: "[[C# notes]]"\n---\ntwo\n');
    put(
      harness,
      "Three.md",
      `---\nchild-of:\n  - "[[Alpha]]"\n  - "[[${alpha}]]"\n---\nthree\n`,
    );
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    if (!pushed.ok) return;
    const id = (title: string) =>
      String(
        sentCreates(harness!).find(
          (sent) =>
            (sent.properties as Record<string, unknown>).title === title,
        )?.id,
      );
    expect(sentEdgeWrites(harness).sort()).toEqual(
      [
        `create ${id("One")} about ${beta}`,
        `create ${alpha} parent-of ${id("Three")}`,
      ].sort(),
    );
    expect(
      pushed.value.scan.flagged.map((file) => [file.path, file.flag]),
      "a name read two ways was guessed",
    ).toEqual([["Two.md", "edges"]]);
    expect(
      frontOf(harness, "One.md"),
      "the pull rewrote the alias the person typed",
    ).toContain('"[[Beta|the beta]]"');
  });

  it("takes a delete of an edge already gone as done", async () => {
    const gone = "01a00000-0000-7000-8000-00000000e1f6";
    const made = await edgeHarness(
      "folder-edge-gone",
      [titled(alpha, "Alpha"), titled(beta, "Beta"), titled(gamma, "Gamma")],
      [
        {
          id: "01a00000-0000-7000-8000-00000000e1f5",
          source_id: alpha,
          target_id: beta,
          edge_type: "about",
        },
        { id: gone, source_id: alpha, target_id: gamma, edge_type: "about" },
      ],
    );
    harness = made.harness;
    expect((await harness.folder.pull()).ok).toBe(true);
    // Another machine took the same line out first.
    made.door.edges.delete(gone);
    edit(harness, "Alpha.md", '  - "[[Gamma]]"\n', "");
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    expect(sentEdgeWrites(harness)).toEqual([`delete ${gone}`]);
    expect(
      pushed.ok && pushed.value.pull?.flagged,
      "a delete of an edge already gone held its file for good",
    ).toEqual([]);
  });

  it("puts back an edge whose successor died, or whose answer was cleared first", async () => {
    const made = await edgeHarness(
      "folder-edge-put-back-kept",
      [titled(project, "One"), titled(other, "Two"), titled(child, "Child")],
      [
        {
          id: "01a00000-0000-7000-8000-00000000e1f7",
          source_id: project,
          target_id: child,
          edge_type: "parent-of",
        },
      ],
    );
    harness = made.harness;
    const door = made.door;
    expect((await harness.folder.pull()).ok).toBe(true);

    // Refused under a plain device drain whose answers are then cleared.
    door.placing = (edge) =>
      edge.edge_type === "parent-of" && edge.source_id === other
        ? refusal(403, "edge_permission_denied", "No parent here")
        : undefined;
    edit(harness, "Child.md", "[[One]]", `[[${other}]]`);
    expect((await harness.folder.scan()).ok).toBe(true);
    expect((await harness.folder.device().drain()).ok).toBe(true);
    expect((await harness.folder.device().text(["forget"])).ok).toBe(true);
    expect(heldEdges(door)).toEqual([]);
    const cleared = await harness.folder.push();
    expect(cleared.ok, JSON.stringify(cleared)).toBe(true);
    expect(
      heldEdges(door),
      "a replacement whose answers were cleared left the child with no parent",
    ).toEqual([`${project} parent-of ${child}`]);

    // A successor that dies after its retries is put back the same way.
    door.placing = (edge) =>
      edge.edge_type === "parent-of" && edge.source_id === other
        ? { kind: "json", status: 200, body: "not json at all" }
        : undefined;
    edit(harness, "Child.md", `[[${other}]]`, "[[Two]]");
    for (let pass = 0; pass < 6; pass += 1) {
      expect((await harness.folder.push()).ok).toBe(true);
    }
    expect(
      heldEdges(door),
      "a successor that died left the child with no parent",
    ).toEqual([`${project} parent-of ${child}`]);
  });

  it("replaces a one-target edge's target as one step, and keeps the old edge if the write fails", async () => {
    const made = await edgeHarness(
      "folder-edge-replace",
      [
        titled(project, "One"),
        titled(other, "Two"),
        titled(third, "Three"),
        titled(child, "Child"),
      ],
      [
        {
          id: "01a00000-0000-7000-8000-00000000e1ec",
          source_id: project,
          target_id: child,
          edge_type: "parent-of",
          properties: { since: "spring" },
        },
      ],
    );
    harness = made.harness;
    const door = made.door;
    expect((await harness.folder.pull()).ok).toBe(true);
    edit(harness, "Child.md", "[[One]]", "[[Two]]");
    const moved = await harness.folder.push();
    expect(moved.ok, JSON.stringify(moved)).toBe(true);
    if (!moved.ok) return;
    expect(
      moved.value.drain.verdicts
        .filter((entry) => entry.kind.endsWith("_edge"))
        .map((entry) => entry.verdict),
      "a new parent was sent as a second one, and refused",
    ).not.toContain("refused");
    expect(
      heldEdges(door),
      "the child did not move to its new parent in one step",
    ).toEqual([`${other} parent-of ${child}`]);
    expect(sentEdgeWrites(harness).map((write) => write.split(" ")[0])).toEqual(
      ["delete", "create"],
    );

    // The edge that will be put back carries a property of its own.
    const two = [...door.edges.values()].find(
      (edge) => edge.edge_type === "parent-of",
    );
    const noted = await harness.folder.device().updateEdge(String(two?.id), {
      properties: { since: "spring" },
      version: two?.version ?? 1,
    });
    expect(noted.ok, JSON.stringify(noted)).toBe(true);
    expect((await harness.folder.device().drain()).ok).toBe(true);

    // The new parent is refused this time: the child keeps the one it had.
    door.placing = (edge) =>
      edge.edge_type === "parent-of" && edge.source_id === project
        ? refusal(403, "edge_permission_denied", "No write on parent-of here")
        : undefined;
    edit(harness, "Child.md", "[[Two]]", "[[One]]");
    const refused = await harness.folder.push();
    expect(refused.ok, JSON.stringify(refused)).toBe(true);
    if (!refused.ok) return;
    expect(
      heldEdges(door),
      "a refused new parent left the child with none",
    ).toEqual([`${other} parent-of ${child}`]);
    expect(
      [...door.edges.values()].find((edge) => edge.edge_type === "parent-of")
        ?.properties,
      "the edge put back lost the properties the old one carried",
    ).toEqual({ since: "spring" });
    expect(
      refused.value.pull?.flagged.map((file) => [file.path, file.flag]),
      "the file whose line was refused was not flagged",
    ).toEqual([["Child.md", "refused"]]);
    expect(read(harness, "Child.md")).toContain('child-of: "[[One]]"');

    // Drained by the device alone, the put-back waits in the store for the
    // folder's next pass.
    const refuse = door.placing;
    door.placing = undefined;
    edit(harness, "Child.md", "[[One]]", "[[Three]]");
    expect((await harness.folder.push()).ok).toBe(true);
    expect(heldEdges(door)).toEqual([`${third} parent-of ${child}`]);
    door.placing = refuse;
    // By id, which a scan with no server resolves from the copy.
    edit(harness, "Child.md", "[[Three]]", `[[${project}]]`);
    expect((await harness.folder.scan()).ok).toBe(true);
    expect((await harness.folder.device().drain()).ok).toBe(true);
    expect(
      heldEdges(door),
      "the refused replacement's delete did not land, so there is nothing to put back",
    ).toEqual([]);
    const later = await harness.folder.push();
    expect(later.ok, JSON.stringify(later)).toBe(true);
    expect(
      heldEdges(door),
      "a replacement refused under a plain device drain was never put back",
    ).toEqual([`${third} parent-of ${child}`]);

    // The record names the edge put back, so the next change replaces it.
    door.placing = undefined;
    edit(harness, "Child.md", `[[${project}]]`, "[[Two]]");
    expect((await harness.folder.push()).ok).toBe(true);
    expect(heldEdges(door)).toEqual([`${other} parent-of ${child}`]);

    // A refused delete refuses the new edge with it, and nothing is put back.
    const putBack = () =>
      sentEdgeWrites(harness!).filter(
        (write) => write === `create ${other} parent-of ${child}`,
      ).length;
    const before = putBack();
    door.deleting = () => refusal(403, "edge_permission_denied", "Not here");
    edit(harness, "Child.md", "[[Two]]", "[[Three]]");
    const kept = await harness.folder.push();
    expect(kept.ok, JSON.stringify(kept)).toBe(true);
    expect(heldEdges(door)).toEqual([`${other} parent-of ${child}`]);
    expect(
      putBack(),
      "an edge whose delete was refused was put back beside itself",
    ).toBe(before);
  });

  it("flags a line naming too many targets for its edge type, and changes nothing", async () => {
    const made = await edgeHarness(
      "folder-edge-too-many",
      [titled(project, "One"), titled(other, "Two"), titled(child, "Child")],
      [],
    );
    harness = made.harness;
    expect((await harness.folder.pull()).ok).toBe(true);
    edit(
      harness,
      "Child.md",
      /marfa_id:/,
      'child-of:\n  - "[[One]]"\n  - "[[Two]]"\nmarfa_id:',
    );
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    if (!pushed.ok) return;
    expect(
      pushed.value.scan.flagged.map((file) => [file.path, file.flag]),
      "a child-of line naming two parents was not flagged",
    ).toEqual([["Child.md", "edges"]]);
    expect(pushed.value.scan.flagged[0]?.reason).toContain("one at most");
    expect(
      sentEdgeWrites(harness),
      "a line naming more targets than its end holds made an edge",
    ).toEqual([]);

    // The witness: one parent is made.
    edit(harness, "Child.md", '  - "[[Two]]"\n', "");
    expect((await harness.folder.push()).ok).toBe(true);
    expect(sentEdgeWrites(harness)).toEqual([
      `create ${project} parent-of ${child}`,
    ]);
  });
});

/** The tag writes the folder sent, as `add <id> <tag>` and `remove <id> <tag>`. */
function sentTags(harness: FolderHarness): string[] {
  return harness.server.requests.flatMap((request) => {
    const [, items, id, tags, tag] = request.pathname.split("/");
    if (items !== "items" || tags !== "tags") return [];
    if (request.method === "POST") {
      const sent = JSON.parse(request.body) as { tags: string[] };
      return sent.tags.map((named) => `add ${id} ${named}`);
    }
    return request.method === "DELETE"
      ? [`remove ${id} ${decodeURIComponent(tag ?? "")}`]
      : [];
  });
}

/** The lifecycle moves the folder sent, as `<id> <state>`. */
function sentTransitions(harness: FolderHarness): string[] {
  return harness.server.requests
    .filter(
      (request) =>
        request.method === "POST" && request.pathname.endsWith("/transition"),
    )
    .map(
      (request) =>
        `${request.pathname.split("/").at(-2)} ${String((JSON.parse(request.body) as { state: string }).state)}`,
    );
}

describe("embedded files", () => {
  const host = "01a00000-0000-7000-8000-00000000e201";
  const pic = "01a00000-0000-7000-8000-00000000e202";
  const chart = "01a00000-0000-7000-8000-00000000e203";
  const scan = "01a00000-0000-7000-8000-00000000e204";
  const other = "01a00000-0000-7000-8000-00000000e205";
  const png = (last: number): Buffer =>
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, last]);

  /** A file item the server holds, named by its title. */
  function fileRow(id: string, title: string, bytes: Buffer): WireItemOptions {
    return {
      id,
      type: "core.file.image",
      properties: { title, blob_ref: hashOf(bytes), mime_type: "image/png" },
    };
  }

  /** An `attached-to` edge from a file to the note that embeds it. */
  function attached(id: string, file: string, to: string): WireEdgeOptions {
    return { id, source_id: file, target_id: to, edge_type: "attached-to" };
  }

  /** The item the folder created for a file, by the title it sent. */
  function createdFor(harness: FolderHarness, title: string): string {
    const sent = sentCreates(harness).find(
      (create) =>
        (create.properties as Record<string, unknown>).title === title,
    );
    return String(sent?.id);
  }

  /**
   * A folder whose server already places `items` where another machine put
   * them, each row carrying its placement and the attachments it draws.
   */
  async function placedEmbeds(
    label: string,
    items: WireItemOptions[],
    attachments: WireEdgeOptions[],
    paths: Record<string, string>,
    types: string[] = ["core.note", "core.file"],
  ): Promise<{
    harness: FolderHarness;
    door: EdgeDoor;
    placements: Record<string, string>;
  }> {
    const door = new EdgeDoor();
    const rows: Record<string, Array<{ item: WireItemOptions }>> = {};
    for (const item of items) {
      const asked = (item.type ?? "core.note").split(".").slice(0, 2).join(".");
      (rows[asked] ??= []).push({ item });
    }
    const made = await folderHarness(label, {
      settings: { search: { types } },
      rows,
      edges: { "attached-to": attachments },
      hydrate: false,
      events: [door.stream()],
    });
    for (const edge of attachments) door.hold(edge);
    const placements: Record<string, string> = {};
    for (const [id, path] of Object.entries(paths)) {
      const edge: WireEdgeOptions = {
        id: randomUUID(),
        source_id: id,
        target_id: made.settings.id,
        edge_type: "in-folder",
        properties: { path },
      };
      door.hold(edge);
      placements[id] = edge.id;
    }
    for (const item of items) {
      const drawn: Record<string, { data: unknown[]; next_cursor: null }> = {};
      for (const edge of door.edges.values()) {
        if (edge.source_id !== item.id) continue;
        (drawn[edge.edge_type ?? "references"] ??= {
          data: [],
          next_cursor: null,
        }).data.push(wireEdge(edge));
      }
      item.edges = drawn;
    }
    scriptFolderWrites(made, { edges: door });
    const hydrated = await made.folder.hydrate();
    if (!hydrated.ok) {
      await made.stop();
      throw new Error(
        `the fixture could not hydrate: ${JSON.stringify(hydrated)}`,
      );
    }
    return { harness: made, door, placements };
  }

  it("sends an embedded file with its file", async () => {
    // A folder of notes, whose search holds no file type.
    harness = await folderHarness("folder-embed-push");
    const edges = new EdgeDoor();
    scriptFolderWrites(harness, { edges });
    acceptUploads(harness.server);
    mkdirSync(join(harness.dir, "img"), { recursive: true });
    writeFileSync(join(harness.dir, "img", "pic.png"), png(1));
    mkdirSync(join(harness.dir, "charts"), { recursive: true });
    writeFileSync(join(harness.dir, "charts", "chart.png"), png(2));
    // Beside them and embedded by nothing, so left alone as before.
    writeFileSync(join(harness.dir, "loose.png"), png(3));
    put(
      harness,
      "Note.md",
      "---\ntitle: Note\n---\na picture ![](img/pic.png) and a chart ![[chart.png|300]]\n",
    );
    // Lists the picture without showing it, so a line is written here.
    put(
      harness,
      "Other.md",
      '---\ntitle: Other\nhas-attachment: "[[pic.png]]"\n---\nabout it\n',
    );
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    if (!pushed.ok) return;
    expect(
      sentTitles(harness).sort(),
      "an embedded file was not sent with the note that embeds it, or a file nothing embeds was sent",
    ).toEqual(["Note", "Other", "chart.png", "pic.png"]);
    expect(pushed.value.scan.skipped).toBe(1);
    const note = createdFor(harness, "Note");
    const picId = createdFor(harness, "pic.png");
    const chartId = createdFor(harness, "chart.png");
    expect(
      sentCreates(harness).find((create) => create.id === picId)?.type,
      "the embedded file did not go as a file item",
    ).toBe("core.file.image");
    expect(
      heldEdges(edges),
      "an embed did not become its file's attached-to edge to the note",
    ).toEqual(
      [
        `${picId} attached-to ${note}`,
        `${chartId} attached-to ${note}`,
        `${picId} attached-to ${createdFor(harness, "Other")}`,
      ].sort(),
    );
    const order = harness.server.requests
      .filter((request) => request.method === "POST")
      .map((request) =>
        request.pathname === "/items"
          ? `/items ${String((JSON.parse(request.body) as { properties: { title?: string } }).properties.title)}`
          : request.pathname,
      );
    expect(
      order.indexOf("/blobs"),
      "the embedded file's item went out before its bytes",
    ).toBeLessThan(order.indexOf("/items pic.png"));
    expect(
      pushed.value.pull?.unmatched,
      "an embedded file outside the search was flagged as an item the folder no longer holds",
    ).toBe(0);
    expect(
      frontOf(harness, "Other.md"),
      "a has-attachment line was not written at all, so its absence below says nothing",
    ).toContain("has-attachment");
    expect(
      read(harness, "Note.md"),
      "the note repeats in a line an attachment its body already shows",
    ).not.toContain("has-attachment");

    // Read back, the files change nothing.
    const writes = sentEdgeWrites(harness).length;
    expect((await harness.folder.push()).ok).toBe(true);
    expect(sentEdgeWrites(harness)).toHaveLength(writes);

    // Embedded no longer, the chart's file is one the folder no longer holds.
    edit(harness, "Note.md", " and a chart ![[chart.png|300]]", "");
    const dropped = await harness.folder.push();
    expect(dropped.ok, JSON.stringify(dropped)).toBe(true);
    expect(
      dropped.ok && dropped.value.pull?.unmatched,
      "a file no longer embedded was not counted, so the count of none above says nothing",
    ).toBe(1);
  });

  it("writes an embedded file where its link says", async () => {
    const made = await edgeHarness(
      "folder-embed-pull",
      [
        {
          id: host,
          properties: {
            title: "Host",
            body: "a picture ![](img/pic.png), a chart ![[chart.png]], a logo ![[art/logo.png]] and ![](../../away.png)\n",
          },
        },
        fileRow(pic, "pic.png", png(1)),
        fileRow(chart, "chart.png", png(2)),
        fileRow(scan, "logo.png", png(3)),
      ],
      [
        attached("01a00000-0000-7000-8000-00000000e2e1", pic, host),
        attached("01a00000-0000-7000-8000-00000000e2e2", chart, host),
        attached("01a00000-0000-7000-8000-00000000e2e9", scan, host),
      ],
      {
        settings: {
          search: { types: ["core.note"] },
          first_placement: { "core.note": "notes" },
        },
      },
    );
    harness = made.harness;
    scriptBlob(harness.server, png(1));
    scriptBlob(harness.server, png(2));
    scriptBlob(harness.server, png(3));
    const pulled = await harness.folder.pull();
    expect(pulled.ok, JSON.stringify(pulled)).toBe(true);
    if (!pulled.ok) return;
    expect(existsSync(join(harness.dir, "notes", "Host.md"))).toBe(true);
    expect(
      readFileSync(join(harness.dir, "art", "logo.png")),
      "a file embedded by a name carrying a directory was not written from the folder's root",
    ).toEqual(png(3));

    expect(
      readFileSync(join(harness.dir, "notes", "img", "pic.png")),
      "an embedded file was not written at its path read from the note that embeds it",
    ).toEqual(png(1));
    expect(
      readFileSync(join(harness.dir, "notes", "chart.png")),
      "a file embedded by name was not written beside the note that embeds it",
    ).toEqual(png(2));
    expect(
      pulled.value.embeds,
      "an embed was reported that names its file, or the one leading out was not",
    ).toEqual([
      expect.objectContaining({
        path: "notes/Host.md",
        reason: expect.stringContaining(
          "![](../../away.png) leads out",
        ) as unknown,
      }),
    ]);
    // The placements the pull wrote go at the next drain.
    expect((await harness.folder.push()).ok).toBe(true);
    expect(
      made.door.placements(harness.settings.id),
      "an embedded file's placement is not the path its link says",
    ).toEqual(
      new Map([
        [host, "notes/Host.md"],
        [pic, "notes/img/pic.png"],
        [chart, "notes/chart.png"],
        [scan, "art/logo.png"],
      ]),
    );

    // Moved where a name still finds it, a file embedded by name stays; one
    // embedded by path goes back where its link says, its placement with it.
    mkdirSync(join(harness.dir, "charts"));
    renameSync(
      join(harness.dir, "notes", "chart.png"),
      join(harness.dir, "charts", "chart.png"),
    );
    renameSync(
      join(harness.dir, "notes", "img", "pic.png"),
      join(harness.dir, "notes", "pic.png"),
    );
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    expect(existsSync(join(harness.dir, "charts", "chart.png"))).toBe(true);
    expect(existsSync(join(harness.dir, "notes", "chart.png"))).toBe(false);
    expect(
      existsSync(join(harness.dir, "notes", "img", "pic.png")),
      "a file embedded by path was left where its link no longer finds it",
    ).toBe(true);
    expect(existsSync(join(harness.dir, "notes", "pic.png"))).toBe(false);
    expect((await harness.folder.push()).ok).toBe(true);
    expect(made.door.placements(harness.settings.id)).toEqual(
      new Map([
        [host, "notes/Host.md"],
        [pic, "notes/img/pic.png"],
        [chart, "charts/chart.png"],
        [scan, "art/logo.png"],
      ]),
    );
    expect(
      heldEdges(made.door),
      "moving an embedded file changed an edge",
    ).toEqual(
      [
        `${chart} attached-to ${host}`,
        `${pic} attached-to ${host}`,
        `${scan} attached-to ${host}`,
      ].sort(),
    );
  });

  it("reports an embed pointing outside the folder", async () => {
    harness = await folderHarness("folder-embed-outside");
    const edges = new EdgeDoor();
    scriptFolderWrites(harness, { edges });
    acceptUploads(harness.server);
    // A real file there, so only the folder's rule keeps it from being sent.
    writeFileSync(join(harness.dir, "..", "away.png"), png(1));
    writeFileSync(join(harness.dir, "near.png"), png(2));
    writeFileSync(join(harness.dir, "far.png"), png(3));
    put(
      harness,
      "Note.md",
      "---\ntitle: Note\n---\n![](../away.png) beside ![](near.png) and ![](far.png)\n",
    );
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    if (!pushed.ok) return;
    expect(
      sentTitles(harness).sort(),
      "a file outside the folder was sent, or the ones inside were not",
    ).toEqual(["Note", "far.png", "near.png"]);
    expect(
      pushed.value.scan.embeds,
      "an embed leading out of the folder was not reported",
    ).toEqual([
      expect.objectContaining({
        path: "Note.md",
        flag: "embed",
        reason: expect.stringContaining("![](../away.png)") as unknown,
      }),
    ]);
    // It names no file here that could be one taken out, so it holds back
    // no removal.
    const note = createdFor(harness, "Note");
    edit(harness, "Note.md", " and ![](far.png)", "");
    expect((await harness.folder.push()).ok).toBe(true);
    expect(
      heldEdges(edges),
      "an embed leading out of the folder held back the removal of another",
    ).toEqual([`${createdFor(harness, "near.png")} attached-to ${note}`]);

    // Pulled on another machine, the file is not written out there either.
    const elsewhere = await edgeHarness(
      "folder-embed-outside-pull",
      [
        {
          id: host,
          properties: {
            title: "Host",
            body: "![](../away.png) beside ![](near.png)\n",
          },
        },
        fileRow(pic, "away.png", png(1)),
        fileRow(chart, "near.png", png(2)),
      ],
      [
        attached("01a00000-0000-7000-8000-00000000e2e3", pic, host),
        attached("01a00000-0000-7000-8000-00000000e2e4", chart, host),
      ],
    ).then((made) => made.harness);
    second = elsewhere;
    scriptBlob(elsewhere.server, png(1));
    scriptBlob(elsewhere.server, png(2));
    const pulled = await elsewhere.folder.pull();
    expect(pulled.ok, JSON.stringify(pulled)).toBe(true);
    if (!pulled.ok) return;
    expect(
      readFileSync(join(elsewhere.dir, "near.png")),
      "the pull wrote no embedded file at all, so the one below is absent for nothing",
    ).toEqual(png(2));
    expect(existsSync(join(elsewhere.dir, "..", "away.png"))).toBe(false);
    expect(existsSync(join(elsewhere.dir, "away.png"))).toBe(false);
    expect(
      pulled.value.embeds,
      "a pull did not report an embed leading out of the folder",
    ).toEqual([
      expect.objectContaining({
        path: "Host.md",
        flag: "embed",
        reason: expect.stringContaining("![](../away.png)") as unknown,
      }),
    ]);
  });

  it("writes an item embedded at two paths at the first, and reports the other", async () => {
    const made = await edgeHarness(
      "folder-embed-two-paths",
      [
        {
          id: host,
          properties: { title: "First", body: "![](img/pic.png)\n" },
        },
        {
          id: other,
          properties: { title: "Second", body: "![](art/pic.png)\n" },
        },
        fileRow(pic, "pic.png", png(1)),
      ],
      [
        attached("01a00000-0000-7000-8000-00000000e2e5", pic, host),
        attached("01a00000-0000-7000-8000-00000000e2e6", pic, other),
      ],
    );
    harness = made.harness;
    scriptBlob(harness.server, png(1));
    const pulled = await harness.folder.pull();
    expect(pulled.ok, JSON.stringify(pulled)).toBe(true);
    if (!pulled.ok) return;
    expect(
      readFileSync(join(harness.dir, "art", "pic.png")),
      "an item embedded at two paths was not written at the first in path order",
    ).toEqual(png(1));
    expect(
      existsSync(join(harness.dir, "img", "pic.png")),
      "an item embedded at two paths was written twice, as two files of one item",
    ).toBe(false);
    expect(
      pulled.value.embeds,
      "the link naming the other path was not reported",
    ).toEqual([
      expect.objectContaining({
        path: "First.md",
        flag: "embed",
        reason: expect.stringContaining("art/pic.png") as unknown,
      }),
    ]);
    expect((await harness.folder.push()).ok).toBe(true);
    expect(made.door.placements(harness.settings.id).get(pic)).toBe(
      "art/pic.png",
    );
  });

  it("removes the edge when the embed is taken out", async () => {
    harness = await folderHarness("folder-embed-removed");
    const edges = new EdgeDoor();
    scriptFolderWrites(harness, { edges });
    acceptUploads(harness.server);
    writeFileSync(join(harness.dir, "a.png"), png(1));
    writeFileSync(join(harness.dir, "b.png"), png(2));
    put(
      harness,
      "Note.md",
      "---\ntitle: Note\n---\nfirst ![](a.png) and more\n![[b.png]]\nthe end\n",
    );
    expect((await harness.folder.push()).ok).toBe(true);
    const note = createdFor(harness, "Note");
    const a = createdFor(harness, "a.png");
    const b = createdFor(harness, "b.png");
    expect(
      heldEdges(edges),
      "an embed made no edge, so there is nothing for taking it out to remove",
    ).toEqual([`${a} attached-to ${note}`, `${b} attached-to ${note}`].sort());

    // The embed taken out of its line, and a line holding one taken out.
    edit(harness, "Note.md", " ![](a.png)", "");
    const once = await harness.folder.push();
    expect(once.ok, JSON.stringify(once)).toBe(true);
    expect(
      heldEdges(edges),
      "the edge stayed when its embed was taken out of the body",
    ).toEqual([`${b} attached-to ${note}`]);
    edit(harness, "Note.md", "![[b.png]]\n", "");
    const twice = await harness.folder.push();
    expect(twice.ok, JSON.stringify(twice)).toBe(true);
    expect(
      heldEdges(edges),
      "the edge stayed when the line holding its embed was taken out",
    ).toEqual([]);
    expect(
      existsSync(join(harness.dir, "b.png")),
      "the file an embed named went with the embed",
    ).toBe(true);
  });

  it("removes no attachment while an embed names nothing, and removes it once none does", async () => {
    harness = await folderHarness("folder-embed-stand-down");
    const edges = new EdgeDoor();
    scriptFolderWrites(harness, { edges });
    acceptUploads(harness.server);
    writeFileSync(join(harness.dir, "a.png"), png(1));
    writeFileSync(join(harness.dir, "b.png"), png(2));
    // Beside the embed that names it with a raw space, so only the space
    // keeps it from being read.
    writeFileSync(join(harness.dir, "raw x.png"), png(3));
    writeFileSync(join(harness.dir, "empty.png"), Buffer.alloc(0));
    put(harness, "Note.md", "---\ntitle: Note\n---\n![](a.png)\n![](b.png)\n");
    expect((await harness.folder.push()).ok).toBe(true);
    const note = createdFor(harness, "Note");
    const a = createdFor(harness, "a.png");
    const b = createdFor(harness, "b.png");
    expect(heldEdges(edges)).toEqual(
      [`${a} attached-to ${note}`, `${b} attached-to ${note}`].sort(),
    );
    const deletes = async (): Promise<number> => {
      const queued = await harness!.folder.device().queue();
      if (!queued.ok) throw new Error(JSON.stringify(queued));
      return withoutPlacements(harness!, queued.value).filter(
        (row) => row.kind === "delete_edge",
      ).length;
    };

    // One embed taken out while another names no file: an embed gone and an
    // embed that names nothing look the same, so nothing is removed.
    edit(harness, "Note.md", "![](a.png)\n![](b.png)", "![](gone.png)");
    const gone = await harness.folder.scan();
    expect(gone.ok, JSON.stringify(gone)).toBe(true);
    if (!gone.ok) return;
    expect(
      await deletes(),
      "an attachment was removed while an embed in the same file named nothing",
    ).toBe(0);
    expect(
      gone.value.embeds,
      "an embed holding back removals was not reported, with its file and its text",
    ).toEqual([
      expect.objectContaining({
        path: "Note.md",
        flag: "embed",
        reason: expect.stringContaining(
          "![](gone.png) names no file",
        ) as unknown,
      }),
    ]);

    // A raw space ends a Markdown path, so it names no file either.
    edit(harness, "Note.md", "![](gone.png)", "![](raw x.png)");
    const spaced = await harness.folder.scan();
    expect(spaced.ok, JSON.stringify(spaced)).toBe(true);
    if (!spaced.ok) return;
    expect(
      await deletes(),
      "an attachment was removed while an embed with a raw space named nothing",
    ).toBe(0);
    expect(spaced.value.embeds).toEqual([
      expect.objectContaining({
        path: "Note.md",
        reason: expect.stringContaining(
          "![](raw x.png) has a raw space",
        ) as unknown,
      }),
    ]);
    expect(
      sentTitles(harness),
      "a file named by an embed with a raw space was sent",
    ).not.toContain("raw x.png");

    // An empty file is never sent, so an embed of it names no file sent.
    edit(harness, "Note.md", "![](raw x.png)", "![](empty.png)");
    const empty = await harness.folder.scan();
    expect(empty.ok, JSON.stringify(empty)).toBe(true);
    if (!empty.ok) return;
    expect(
      await deletes(),
      "an attachment was removed while an embed of an empty file named nothing sent",
    ).toBe(0);
    expect(empty.value.embeds).toEqual([
      expect.objectContaining({
        path: "Note.md",
        reason: expect.stringContaining(
          "![](empty.png) names no file",
        ) as unknown,
      }),
    ]);

    // Once it names a file again, the removal the file held back lands.
    edit(harness, "Note.md", "![](empty.png)", "![](b.png)");
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    expect(
      await deletes(),
      "no removal was queued at all, so the one held back above is absent for nothing",
    ).toBe(1);
    expect(
      heldEdges(edges),
      "the removal held back while an embed named nothing never landed",
    ).toEqual([`${b} attached-to ${note}`]);
  });

  it("lists under has-attachment only what the body does not embed", async () => {
    const made = await edgeHarness(
      "folder-embed-has-attachment",
      [
        {
          id: host,
          properties: { title: "Host", body: "shown ![](pic.png)\n" },
        },
        fileRow(pic, "pic.png", png(1)),
        fileRow(scan, "scan.png", png(2)),
      ],
      [
        attached("01a00000-0000-7000-8000-00000000e2e7", pic, host),
        attached("01a00000-0000-7000-8000-00000000e2e8", scan, host),
      ],
    );
    harness = made.harness;
    scriptBlob(harness.server, png(1));
    const pulled = await harness.folder.pull();
    expect(pulled.ok, JSON.stringify(pulled)).toBe(true);
    expect(
      frontOf(harness, "Host.md"),
      "an attachment the body does not embed is not listed, so its edge is shown in no file",
    ).toContain('has-attachment:\n  - "[[scan.png]]"');
    expect(
      frontOf(harness, "Host.md"),
      "an attachment the body embeds is listed under has-attachment too, so one edge is said twice",
    ).not.toContain("pic.png");
    expect(existsSync(join(harness.dir, "pic.png"))).toBe(true);
    expect(
      existsSync(join(harness.dir, "scan.png")),
      "an attachment nothing embeds was written as a file",
    ).toBe(false);

    // Read back, nothing changes; the line taken out removes only its edge.
    expect((await harness.folder.push()).ok).toBe(true);
    expect(sentEdgeWrites(harness)).toEqual([]);
    edit(
      harness,
      "Host.md",
      /has-attachment:\n {2}- "\[\[scan\.png\]\]"\n/,
      "",
    );
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    expect(heldEdges(made.door)).toEqual([`${pic} attached-to ${host}`]);
  });

  it("reads an embed of a note, even one with a dot in its name, as text", async () => {
    harness = await folderHarness("folder-embed-dotted-note");
    const edges = new EdgeDoor();
    scriptFolderWrites(harness, { edges });
    acceptUploads(harness.server);
    writeFileSync(join(harness.dir, "a.png"), png(1));
    writeFileSync(join(harness.dir, "b.png"), png(2));
    put(harness, "Dr. Smith.md", "---\ntitle: Dr. Smith\n---\na person\n");
    put(
      harness,
      "Note.md",
      "---\ntitle: Note\n---\n![](a.png)\n![](b.png)\n![[Dr. Smith]] ![[v1.2 plan]] ![[2024.05.01]] ![](Dr.%20Smith.md) ![](Other Note.md) ![](../away.png)\n",
    );
    const first = await harness.folder.push();
    expect(first.ok, JSON.stringify(first)).toBe(true);
    if (!first.ok) return;
    const note = createdFor(harness, "Note");
    const b = createdFor(harness, "b.png");
    expect(heldEdges(edges)).toHaveLength(2);
    // Only the embed leading out, which is reported, so the notes are not.
    const outside = [
      expect.objectContaining({
        path: "Note.md",
        reason: expect.stringContaining(
          "![](../away.png) leads out",
        ) as unknown,
      }),
    ];
    expect(
      first.value.scan.embeds,
      "an embed of a note was read as an embed of a file that names nothing",
    ).toEqual(outside);
    expect(
      first.value.pull?.embeds,
      "a pull read an embed of a note as an embed of a file",
    ).toEqual(outside);

    edit(harness, "Note.md", "![](a.png)\n", "");
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    expect(
      heldEdges(edges),
      "an embed of a note with a dot in its name held back the removal of a taken-out embed",
    ).toEqual([`${b} attached-to ${note}`]);
  });

  it("reads embeds in a Markdown body only, and none shown in code", async () => {
    harness = await folderHarness("folder-embed-code");
    const edges = new EdgeDoor();
    scriptFolderWrites(harness, { edges });
    acceptUploads(harness.server);
    for (const [name, last] of [
      ["a.png", 1],
      ["fenced.png", 2],
      ["inline.png", 3],
      ["plain.png", 4],
    ] as const) {
      writeFileSync(join(harness.dir, name), png(last));
    }
    put(
      harness,
      "Note.md",
      [
        "---\ntitle: Note\n---",
        "![](a.png) ![](../away.png)",
        "```md\n![](fenced.png) ![](../hidden.png)\n```",
        "write `![[inline.png]]` to show one",
        "````\n```\n![](long.png)\n````",
        "%% ![](obsidian.png) %% and <!-- ![](html.png)",
        "--> after",
        "",
      ].join("\n"),
    );
    for (const [name, last] of [
      ["long.png", 5],
      ["obsidian.png", 6],
      ["html.png", 7],
    ] as const) {
      writeFileSync(join(harness.dir, name), png(last));
    }
    put(harness, "plain.txt", "![](plain.png)\n");
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    if (!pushed.ok) return;
    expect(
      sentTitles(harness).sort(),
      "an embed shown in code, or one in a file that is not Markdown, sent its file",
    ).toEqual(["Note", "a.png", "plain"]);
    expect(heldEdges(edges)).toEqual([
      `${createdFor(harness, "a.png")} attached-to ${createdFor(harness, "Note")}`,
    ]);
    expect(
      pushed.value.scan.embeds,
      "an embed in code was reported, or the one outside code was not",
    ).toEqual([
      expect.objectContaining({
        path: "Note.md",
        reason: expect.stringContaining(
          "![](../away.png) leads out",
        ) as unknown,
      }),
    ]);
  });

  it("reads an embed's path as Obsidian reads one", async () => {
    harness = await folderHarness("folder-embed-paths");
    const edges = new EdgeDoor();
    scriptFolderWrites(harness, { edges });
    acceptUploads(harness.server);
    const files: Array<[string, number]> = [
      ["my image.png", 1],
      ["img/query.png", 2],
      ["img/rooted.png", 3],
      ["sub/near.png", 4],
      ["far.png", 5],
      ["sub/x.png", 6],
    ];
    for (const [name, last] of files) {
      mkdirSync(join(harness.dir, name, ".."), { recursive: true });
      writeFileSync(join(harness.dir, name), png(last));
    }
    put(
      harness,
      "sub/Note.md",
      [
        "---\ntitle: Note\n---",
        "![](../my%20image.png)",
        "![](../img/query.png?v=2)",
        "![](/img/rooted.png#part)",
        "![[./near.png]]",
        "![[../far.png]]",
        // Addresses, never a file here, though a file of the name is.
        "![](https://example.com/x.png) ![](//cdn.example.com/x.png) ![](#x.png)",
        "![](../../away.png)",
        "",
      ].join("\n"),
    );
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    if (!pushed.ok) return;
    expect(
      sentTitles(harness).sort(),
      "an embed's path was not read as Obsidian reads it, or an address was read as a file here",
    ).toEqual([
      "Note",
      "far.png",
      "my image.png",
      "near.png",
      "query.png",
      "rooted.png",
    ]);
    expect(heldEdges(edges)).toHaveLength(5);
    expect(
      pushed.value.scan.embeds,
      "a path read as Obsidian reads it was reported, or the one leading out was not",
    ).toEqual([
      expect.objectContaining({
        path: "sub/Note.md",
        reason: expect.stringContaining(
          "![](../../away.png) leads out",
        ) as unknown,
      }),
    ]);
  });

  it("reads an embed by name as Obsidian resolves a name", async () => {
    harness = await folderHarness("folder-embed-names");
    const edges = new EdgeDoor();
    scriptFolderWrites(harness, { edges });
    acceptUploads(harness.server);
    // Deeper but first in path order, then two as shallow as each other.
    const files: Array<[string, number]> = [
      ["a/z/pic.png", 1],
      ["b/pic.png", 2],
      ["notes/pic.png", 3],
      ["a/b/pic.png", 4],
      // Ends in `z/pic.png` but not at a directory's edge.
      ["bz/pic.png", 5],
    ];
    for (const [name, last] of files) {
      mkdirSync(join(harness.dir, name, ".."), { recursive: true });
      writeFileSync(join(harness.dir, name), png(last));
    }
    put(harness, "notes/Near.md", "---\ntitle: Near\n---\n![[pic.png]]\n");
    put(harness, "x/Far.md", "---\ntitle: Far\n---\n![[pic.png]]\n");
    put(harness, "x/Deep.md", "---\ntitle: Deep\n---\n![[z/pic.png]]\n");
    // The path from the root over the file beside the note.
    put(harness, "a/b/Rooted.md", "---\ntitle: Rooted\n---\n![[b/pic.png]]\n");
    // A name matches at a directory's edge, and whatever its case.
    put(harness, "x/Edge.md", "---\ntitle: Edge\n---\n![[c.png]]\n");
    put(harness, "x/Case.md", "---\ntitle: Case\n---\n![[PIC.PNG]]\n");
    // Two attachments of one name, each read by the path it is bound at.
    put(
      harness,
      "x/Both.md",
      "---\ntitle: Both\n---\n![](../a/z/pic.png) ![](../b/pic.png)\n",
    );
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    if (!pushed.ok) return;
    const edge = [
      expect.objectContaining({
        path: "x/Edge.md",
        reason: expect.stringContaining("![[c.png]] names no") as unknown,
      }),
    ];
    expect(
      pushed.value.scan.embeds,
      "a name was read as matching inside a file's name",
    ).toEqual(edge);
    expect(
      pushed.value.pull?.embeds,
      "a path embed was not read as the attachment bound at its path",
    ).toEqual(edge);
    const at = new Map(
      [...edges.placements(harness.settings.id)].map(([id, path]) => [
        String(path),
        id,
      ]),
    );
    expect(heldEdges(edges)).toEqual(
      [
        `${at.get("notes/pic.png")} attached-to ${createdFor(harness, "Near")}`,
        `${at.get("b/pic.png")} attached-to ${createdFor(harness, "Far")}`,
        `${at.get("a/z/pic.png")} attached-to ${createdFor(harness, "Deep")}`,
        `${at.get("b/pic.png")} attached-to ${createdFor(harness, "Rooted")}`,
        `${at.get("b/pic.png")} attached-to ${createdFor(harness, "Case")}`,
        `${at.get("a/z/pic.png")} attached-to ${createdFor(harness, "Both")}`,
        `${at.get("b/pic.png")} attached-to ${createdFor(harness, "Both")}`,
      ].sort(),
    );
  });

  it("writes a file embedded by name where its placement already answers to the name", async () => {
    // Placed by another machine: the note in notes/, its chart in charts/,
    // and its logo under a name the embed does not answer to.
    const made = await placedEmbeds(
      "folder-embed-named-placed",
      [
        {
          id: host,
          properties: {
            title: "Host",
            body: "a chart ![[chart.png]] and a logo ![[logo.png]]\n",
          },
        },
        fileRow(chart, "chart.png", png(2)),
        fileRow(scan, "logo.png", png(3)),
      ],
      [
        attached("01a00000-0000-7000-8000-00000000e2ea", chart, host),
        attached("01a00000-0000-7000-8000-00000000e2ed", scan, host),
      ],
      {
        [host]: "notes/Host.md",
        [chart]: "charts/chart.png",
        [scan]: "art/other.png",
      },
    );
    harness = made.harness;
    scriptBlob(harness.server, png(2));
    scriptBlob(harness.server, png(3));
    const pulled = await harness.folder.pull();
    expect(pulled.ok, JSON.stringify(pulled)).toBe(true);
    expect(
      readFileSync(join(harness.dir, "charts", "chart.png")),
      "a file embedded by name was not written where its placement already answers to the name",
    ).toEqual(png(2));
    expect(existsSync(join(harness.dir, "notes", "chart.png"))).toBe(false);
    expect(
      readFileSync(join(harness.dir, "notes", "logo.png")),
      "a placement the name does not answer to was taken for it",
    ).toEqual(png(3));
    expect((await harness.folder.push()).ok).toBe(true);
    expect(
      harness.server.requests
        .filter(
          (request) =>
            request.pathname.startsWith("/edges") && request.method !== "GET",
        )
        .map((request) => `${request.method} ${request.pathname}`),
      "a fresh machine moved a placement the name answers to, or not the one it does not",
    ).toEqual([`PATCH /edges/${made.placements[scan] ?? ""}`]);
    expect(made.door.placements(harness.settings.id)).toEqual(
      new Map([
        [host, "notes/Host.md"],
        [chart, "charts/chart.png"],
        [scan, "notes/logo.png"],
      ]),
    );
  });

  it("follows an embedded file renamed away from its link, and says the link names nothing", async () => {
    harness = await folderHarness("folder-embed-renamed");
    const edges = new EdgeDoor();
    scriptFolderWrites(harness, { edges });
    acceptUploads(harness.server);
    writeFileSync(join(harness.dir, "a.png"), png(1));
    put(harness, "Note.md", "---\ntitle: Note\n---\n![](a.png)\n");
    expect((await harness.folder.push()).ok).toBe(true);
    const before = heldEdges(edges);
    expect(before).toHaveLength(1);

    renameSync(join(harness.dir, "a.png"), join(harness.dir, "renamed.png"));
    const renamed = await harness.folder.push();
    expect(renamed.ok, JSON.stringify(renamed)).toBe(true);
    if (!renamed.ok) return;
    expect(renamed.value.scan.renamed).toBe(1);
    expect(existsSync(join(harness.dir, "renamed.png"))).toBe(true);
    expect(
      existsSync(join(harness.dir, "a.png")),
      "a file renamed away from its link was moved back",
    ).toBe(false);
    expect(heldEdges(edges), "the rename changed an edge").toEqual(before);
    expect(
      renamed.value.pull?.embeds,
      "a link that no longer names its file was not reported",
    ).toEqual([
      expect.objectContaining({
        path: "Note.md",
        flag: "embed",
        reason: expect.stringContaining(
          "![](a.png) names no attachment",
        ) as unknown,
      }),
    ]);
    expect(
      frontOf(harness, "Note.md"),
      "an attachment the body no longer shows is not listed",
    ).toContain('has-attachment:\n  - "[[renamed.png]]"');
    expect(renamed.value.pull?.unmatched).toBe(1);

    // The link mended, the body shows it again.
    edit(harness, "Note.md", "![](a.png)", "![](renamed.png)");
    const mended = await harness.folder.push();
    expect(mended.ok, JSON.stringify(mended)).toBe(true);
    if (!mended.ok) return;
    expect(mended.value.pull?.embeds).toEqual([]);
    expect(mended.value.pull?.unmatched).toBe(0);
    expect(frontOf(harness, "Note.md")).not.toContain("has-attachment");
    expect(heldEdges(edges)).toEqual(before);
    expect(sentTitles(harness)).toEqual(["Note", "a.png"]);
  });

  it("reports an embed of a file the key cannot read, and writes nothing for it", async () => {
    const secret = "01a00000-0000-7000-8000-00000000e2ff";
    const made = await edgeHarness(
      "folder-embed-unreadable",
      [
        {
          id: host,
          properties: {
            title: "Host",
            body: "![](shown.png) ![](secret.png)\n",
          },
        },
        fileRow(pic, "shown.png", png(1)),
      ],
      [
        attached("01a00000-0000-7000-8000-00000000e2eb", pic, host),
        attached("01a00000-0000-7000-8000-00000000e2ec", secret, host),
      ],
    );
    harness = made.harness;
    scriptBlob(harness.server, png(1));
    const pulled = await harness.folder.pull();
    expect(pulled.ok, JSON.stringify(pulled)).toBe(true);
    if (!pulled.ok) return;
    expect(
      readFileSync(join(harness.dir, "shown.png")),
      "the pull wrote no embedded file at all, so the one below is absent for nothing",
    ).toEqual(png(1));
    expect(existsSync(join(harness.dir, "secret.png"))).toBe(false);
    expect(
      pulled.value.embeds,
      "an embed of a file the key cannot read was not reported",
    ).toEqual([
      expect.objectContaining({
        path: "Host.md",
        flag: "embed",
        reason: expect.stringContaining(
          "![](secret.png) names no attachment",
        ) as unknown,
      }),
    ]);
  });

  it("holds attachments whole only where its search holds a document", async () => {
    const wholeTypes = (made: FolderHarness): Array<string | null> => [
      ...new Set(
        made.server.requests
          .filter((request) => request.pathname === "/edges")
          .map((request) => request.query.get("edge_type")),
      ),
    ];
    harness = await folderHarness("folder-embed-whole-notes");
    expect(
      wholeTypes(harness),
      "a folder of notes did not hold attached-to whole, so the check below is about nothing",
    ).toContain("attached-to");
    second = await folderHarness("folder-embed-whole-files", {
      settings: { search: { types: ["core.file"] } },
    });
    expect(
      wholeTypes(second),
      "a folder of files alone, which embeds nothing, held every attachment whole",
    ).not.toContain("attached-to");
    const every = await folderHarness("folder-embed-whole-every", {
      settings: { search: {} },
    });
    try {
      expect(
        wholeTypes(every),
        "a search naming no type, which holds notes, did not hold attachments whole",
      ).toContain("attached-to");
    } finally {
      await every.stop();
    }
  });

  it("keeps an embedded file archived elsewhere where its search holds active items only", async () => {
    const gone = "01a00000-0000-7000-8000-00000000e2f1";
    const picRow = fileRow(pic, "pic.png", png(1));
    const goneRow: WireItemOptions = {
      id: gone,
      properties: { title: "Gone", body: "archived too\n" },
    };
    const made = await edgeHarness(
      "folder-embed-archived",
      [
        { id: host, properties: { title: "Host", body: "![](pic.png)\n" } },
        goneRow,
        picRow,
      ],
      [attached("01a00000-0000-7000-8000-00000000e2f2", pic, host)],
      {
        settings: { search: { types: ["core.note"], state: ["active"] } },
        events: [
          replay("3", [
            itemEvent(
              "2",
              "item.state_changed",
              wireItem({ ...picRow, state: "archived" }),
            ),
            itemEvent(
              "3",
              "item.state_changed",
              wireItem({ ...goneRow, state: "archived" }),
            ),
          ]),
        ],
      },
    );
    harness = made.harness;
    scriptBlob(harness.server, png(1));
    expect((await harness.folder.pull()).ok).toBe(true);
    expect(existsSync(join(harness.dir, "pic.png"))).toBe(true);
    const caught = await harness.folder.device().catchUp();
    expect(
      caught.ok ? caught.value.applied : 0,
      "the archives never reached the copy",
    ).toBe(2);
    const pulled = await harness.folder.pull();
    expect(pulled.ok, JSON.stringify(pulled)).toBe(true);
    if (!pulled.ok) return;
    expect(
      [pulled.value.removed, existsSync(join(harness.dir, "Gone.md"))],
      "a note archived beside it kept its file, so the one below is kept for nothing",
    ).toEqual([1, false]);
    expect(
      readFileSync(join(harness.dir, "pic.png")),
      "a file the note still embeds was taken away because it was archived",
    ).toEqual(png(1));
    expect(pulled.value.unmatched).toBe(0);
  });

  it("lists a trashed embedded file under has-attachment no more than a held one", async () => {
    const picRow = fileRow(pic, "pic.png", png(1));
    const made = await edgeHarness(
      "folder-embed-trashed",
      [
        { id: host, properties: { title: "Host", body: "![](pic.png)\n" } },
        picRow,
      ],
      [attached("01a00000-0000-7000-8000-00000000e2f3", pic, host)],
      {
        events: [
          replay("2", [
            itemEvent(
              "2",
              "item.deleted",
              wireItem({ ...picRow, state: "trashed" }),
            ),
          ]),
        ],
      },
    );
    harness = made.harness;
    scriptBlob(harness.server, png(1));
    expect((await harness.folder.pull()).ok).toBe(true);
    const caught = await harness.folder.device().catchUp();
    expect(caught.ok ? caught.value.applied : 0).toBe(1);
    const pulled = await harness.folder.pull();
    expect(pulled.ok, JSON.stringify(pulled)).toBe(true);
    if (!pulled.ok) return;
    expect(
      [pulled.value.removed, existsSync(join(harness.dir, "pic.png"))],
      "the trash never reached the folder, so what the note says below is about nothing",
    ).toEqual([1, false]);
    expect(
      frontOf(harness, "Host.md"),
      "an embedded file in the bin was listed under has-attachment beside its embed",
    ).not.toContain("has-attachment");
  });

  it("reads an embed's path whatever its case, and keeps the file's own name", async () => {
    harness = await folderHarness("folder-embed-case");
    const edges = new EdgeDoor();
    scriptFolderWrites(harness, { edges });
    acceptUploads(harness.server);
    writeFileSync(join(harness.dir, "t10.png"), png(1));
    writeFileSync(join(harness.dir, "b.png"), png(2));
    put(harness, "Note.md", "---\ntitle: Note\n---\n![](T10.PNG) ![](b.png)\n");
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    if (!pushed.ok) return;
    const note = createdFor(harness, "Note");
    const t10 = createdFor(harness, "t10.png");
    expect(
      heldEdges(edges),
      "an embed differing from its file only in case named nothing",
    ).toEqual(
      [
        `${t10} attached-to ${note}`,
        `${createdFor(harness, "b.png")} attached-to ${note}`,
      ].sort(),
    );
    expect(pushed.value.scan.embeds).toHaveLength(0);
    edit(harness, "Note.md", " ![](b.png)", "");
    const again = await harness.folder.push();
    expect(again.ok, JSON.stringify(again)).toBe(true);
    if (!again.ok) return;
    expect(
      heldEdges(edges),
      "an embed differing from its file in case held back a removal",
    ).toEqual([`${t10} attached-to ${note}`]);
    expect(again.value.pull?.unwritten).toBe(0);
    expect(
      readdirSync(harness.dir)
        .filter((name) => name.endsWith(".png"))
        .sort(),
      "the pull wrote the file under the link's case beside its own",
    ).toEqual(["b.png", "t10.png"]);

    // A fresh machine writes it under its own name too.
    const fresh = await placedEmbeds(
      "folder-embed-case-fresh",
      [
        { id: host, properties: { title: "Host", body: "![](T10.PNG)\n" } },
        fileRow(pic, "t10.png", png(1)),
      ],
      [attached("01a00000-0000-7000-8000-00000000e2f4", pic, host)],
      { [host]: "Host.md", [pic]: "t10.png" },
    );
    const elsewhere = fresh.harness;
    second = elsewhere;
    scriptBlob(elsewhere.server, png(1));
    expect((await elsewhere.folder.pull()).ok).toBe(true);
    expect(
      readdirSync(elsewhere.dir)
        .filter((name) => !name.startsWith("."))
        .sort(),
      "a fresh machine wrote the file under the link's case",
    ).toEqual(["Host.md", "t10.png"]);
  });

  it("writes nothing for a name two attachments share, and says so", async () => {
    const twin = "01a00000-0000-7000-8000-00000000e2f5";
    const made = await edgeHarness(
      "folder-embed-shared-name",
      [
        {
          id: host,
          properties: { title: "Host", body: "![[dup.png]] ![[one.png]]\n" },
        },
        fileRow(pic, "dup.png", png(1)),
        fileRow(twin, "dup.png", png(2)),
        fileRow(chart, "one.png", png(3)),
      ],
      [
        attached("01a00000-0000-7000-8000-00000000e2f6", pic, host),
        attached("01a00000-0000-7000-8000-00000000e2f7", twin, host),
        attached("01a00000-0000-7000-8000-00000000e2f8", chart, host),
      ],
    );
    harness = made.harness;
    for (const last of [1, 2, 3]) scriptBlob(harness.server, png(last));
    const pulled = await harness.folder.pull();
    expect(pulled.ok, JSON.stringify(pulled)).toBe(true);
    if (!pulled.ok) return;
    expect(
      readFileSync(join(harness.dir, "one.png")),
      "the pull wrote no embedded file at all, so the one below is absent for nothing",
    ).toEqual(png(3));
    expect(
      existsSync(join(harness.dir, "dup.png")),
      "a name two attachments share was read as one of them",
    ).toBe(false);
    expect(pulled.value.embeds).toEqual([
      expect.objectContaining({
        path: "Host.md",
        reason: expect.stringContaining(
          "![[dup.png]] names no attachment",
        ) as unknown,
      }),
    ]);
  });

  it("writes no file a .txt file's text embeds", async () => {
    const plain = "01a00000-0000-7000-8000-00000000e2f9";
    const made = await placedEmbeds(
      "folder-embed-txt-pull",
      [
        { id: host, properties: { title: "Shown", body: "![](y.png)\n" } },
        { id: plain, properties: { title: "Plain", body: "![](x.png)\n" } },
        fileRow(pic, "y.png", png(1)),
        fileRow(chart, "x.png", png(2)),
      ],
      [
        attached("01a00000-0000-7000-8000-00000000e2fa", pic, host),
        attached("01a00000-0000-7000-8000-00000000e2fb", chart, plain),
      ],
      { [host]: "Shown.md", [plain]: "Plain.txt" },
      ["core.note"],
    );
    harness = made.harness;
    scriptBlob(harness.server, png(1));
    scriptBlob(harness.server, png(2));
    const pulled = await harness.folder.pull();
    expect(pulled.ok, JSON.stringify(pulled)).toBe(true);
    expect(read(harness, "Plain.txt")).toBe("![](x.png)\n");
    expect(
      readFileSync(join(harness.dir, "y.png")),
      "a Markdown file's embed wrote nothing, so the absence below says nothing",
    ).toEqual(png(1));
    expect(
      existsSync(join(harness.dir, "x.png")),
      "a .txt file's text was read as embedding a file",
    ).toBe(false);
  });

  it("removes the edge of an embed taken out between two scans before a push", async () => {
    harness = await folderHarness("folder-embed-two-scans");
    const edges = new EdgeDoor();
    scriptFolderWrites(harness, { edges });
    acceptUploads(harness.server);
    writeFileSync(join(harness.dir, "a.png"), png(1));
    writeFileSync(join(harness.dir, "b.png"), png(2));
    put(harness, "Note.md", "---\ntitle: Note\n---\n![](a.png)\n![](b.png)\n");
    expect((await harness.folder.scan()).ok).toBe(true);
    edit(harness, "Note.md", "![](a.png)\n", "");
    expect((await harness.folder.scan()).ok).toBe(true);
    expect((await harness.folder.push()).ok).toBe(true);
    expect(
      heldEdges(edges),
      "an embed taken out before any pull left its edge, since the scan kept no record of it",
    ).toEqual([
      `${createdFor(harness, "b.png")} attached-to ${createdFor(harness, "Note")}`,
    ]);
  });
});

describe("what frontmatter says", () => {
  it("reads type, tags, tier and state as the item's own", async () => {
    const id = "01a00000-0000-7000-8000-0000000013a1";
    harness = await folderHarness("folder-own-fields", {
      settings: {
        search: { types: ["core.note", "core.bookmark"] },
        defaults: { tags: ["inbox"] },
      },
      rows: {
        "core.note": [
          {
            item: { id, properties: { title: "Held", body: "held\n" } },
            tags: ["old", "kept"],
          },
        ],
      },
    });
    const rows = scriptFolderWrites(harness);
    expect((await harness.folder.pull()).ok).toBe(true);

    // A pull writes them as lines of their own, the type and tier always and
    // the tags where there are any.
    const held = read(harness, "Held.md");
    expect(held).toMatch(/^type: core\.note$/m);
    expect(held).toMatch(/^tier: library$/m);
    expect(held).toContain("tags:\n  - kept\n  - old\n");
    expect(held, "an active item's file said its state").not.toMatch(
      /^state:/m,
    );

    // A new file names its own, and one naming none takes the defaults'.
    put(
      harness,
      "Saved.md",
      '---\ntype: core.bookmark\ntier: library\ntags: [read-later, web]\nstate: archived\nchild-of: "[[Held]]"\nurl: https://example.com\n---\nA page.\n',
    );
    put(harness, "Plain.md", "---\nurl: https://example.org\n---\nA note.\n");
    // A file already bound trades one tag for another.
    writeFileSync(
      join(harness.dir, "Held.md"),
      held.replace("  - old\n", "  - new\n"),
    );
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);

    const creates = sentCreates(harness);
    const saved = creates.find(
      (sent) => (sent.properties as Record<string, unknown>).title === "Saved",
    );
    const plain = creates.find(
      (sent) => (sent.properties as Record<string, unknown>).title === "Plain",
    );
    expect(
      [saved?.type, saved?.tier],
      "the file's type or tier was not the item's, so the frontmatter says one thing and the item is another",
    ).toEqual(["core.bookmark", "library"]);
    expect(
      saved?.properties,
      "an own field travelled as a property, where every later pull writes it twice and a search never finds it",
    ).toEqual({
      url: "https://example.com",
      body: "A page.\n",
      title: "Saved",
    });
    expect(plain?.type, "a file naming no type took none of the defaults").toBe(
      "core.note",
    );
    const [savedId, plainId] = [String(saved?.id), String(plain?.id)];
    expect(
      sentTags(harness).sort(),
      "the tags a file names were not the item's, or a file naming its own tags took the defaults' as well, or a bound file's tag change went nowhere",
    ).toEqual(
      [
        `add ${savedId} read-later`,
        `add ${savedId} web`,
        `add ${plainId} inbox`,
        `add ${id} new`,
        `remove ${id} old`,
      ].sort(),
    );
    expect(
      sentTransitions(harness),
      "a file naming its state archived made an active item",
    ).toEqual([`${savedId} archived`]);
    expect(
      sentUpdates(harness).filter((sent) => sent.id === id),
      "a change of tags alone went as an edit of the item's properties",
    ).toEqual([]);
    expect(rows.get(id)?.properties).toEqual({ title: "Held", body: "held\n" });
  });

  it("clears a property whose line was taken out of a versioned file", async () => {
    const id = "01a00000-0000-7000-8000-0000000013b1";
    harness = await folderHarness("folder-clears-a-line", {
      rows: {
        "core.note": [
          {
            item: {
              id,
              properties: {
                title: "Status",
                body: "the text\n",
                status: "draft",
                language: "en",
              },
            },
          },
        ],
      },
    });
    const rows = scriptFolderWrites(harness);
    expect((await harness.folder.pull()).ok).toBe(true);
    const written = read(harness, "Status.md");
    // The witness: a versioned file carrying the line to take out.
    expect(written).toMatch(/^status: draft$/m);
    expect(written).toMatch(/^marfa_version: 1$/m);

    writeFileSync(
      join(harness.dir, "Status.md"),
      written.replace("status: draft\n", ""),
    );
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    const [edit] = sentUpdates(harness).filter((sent) => sent.id === id);
    expect(
      edit?.body.properties_mode,
      "a versioned file's edit was merged, so a line taken out of it clears nothing",
    ).toBe("replace");
    expect(
      rows.get(id)?.properties,
      "the property whose line was taken out is still on the item, and the next pull writes it back",
    ).toEqual({ title: "Status", body: "the text\n", language: "en" });
    expect(read(harness, "Status.md")).not.toMatch(/^status:/m);
  });

  it("merges an edit from a file with no version line", async () => {
    const id = "01a00000-0000-7000-8000-0000000013c1";
    harness = await folderHarness("folder-merges-a-lineless-file", {
      rows: {
        "core.note": [
          {
            item: {
              id,
              properties: {
                title: "Loose",
                body: "as it was\n",
                status: "draft",
              },
            },
          },
        ],
      },
    });
    const rows = scriptFolderWrites(harness);
    expect((await harness.folder.pull()).ok).toBe(true);
    // An editor that keeps no version line, and no status line either.
    writeFileSync(
      join(harness.dir, "Loose.md"),
      read(harness, "Loose.md")
        .replace(/^marfa_version: \d+\n/m, "")
        .replace("status: draft\n", "")
        .replace("as it was", "edited"),
    );
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    const [edit] = sentUpdates(harness).filter((sent) => sent.id === id);
    expect(edit, "the edit was not sent").toBeDefined();
    expect(
      edit?.body.properties_mode,
      "a file with no version line was sent as the item's whole properties, clearing every line its editor happened not to keep",
    ).toBeUndefined();
    expect(rows.get(id)?.properties).toEqual({
      title: "Loose",
      body: "edited\n",
      status: "draft",
    });
  });

  it("takes body and title from the type's display hints", async () => {
    const event = "01a00000-0000-7000-8000-0000000013d1";
    const highlight = "01a00000-0000-7000-8000-0000000013d2";
    harness = await folderHarness("folder-display-hints", {
      settings: { search: { types: ["core.event", "core.highlight"] } },
      rows: {
        "core.event": [
          {
            item: {
              id: event,
              type: "core.event",
              properties: {
                title: "Launch",
                description: "Doors at six.\n",
                starts_at: "2026-10-01T18:00:00.000Z",
              },
            },
          },
        ],
        "core.highlight": [
          {
            item: {
              id: highlight,
              type: "core.highlight",
              properties: {
                text: "A line worth keeping",
                note: "Why it matters.\n",
              },
            },
          },
        ],
      },
    });
    scriptFolderWrites(harness);
    expect((await harness.folder.pull()).ok).toBe(true);
    const launch = read(harness, "Launch.md");
    expect(launch, "an event's description was not its file's body").toMatch(
      /\n---\nDoors at six\.\n$/,
    );
    expect(launch).not.toMatch(/^description:/m);
    expect(
      read(harness, "A line worth keeping.md"),
      "a highlight's file was not named by its text or its body was not its note",
    ).toMatch(/\n---\nWhy it matters\.\n$/);

    put(
      harness,
      "Party.md",
      "---\nstarts_at: 2026-10-02T18:00:00.000Z\n---\nBring food.\n",
    );
    put(
      harness,
      "Quote.md",
      "---\ntype: core.highlight\n---\nWorth a second read.\n",
    );
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    const creates = sentCreates(harness);
    expect(
      creates.map((sent) => [sent.type, sent.properties]),
      "a file's body or name went to a fixed property rather than the one its type names",
    ).toEqual([
      [
        "core.event",
        {
          starts_at: "2026-10-02T18:00:00.000Z",
          description: "Bring food.\n",
          title: "Party",
        },
      ],
      ["core.highlight", { note: "Worth a second read.\n", text: "Quote" }],
    ]);
  });

  it("reports a type that declares a property no file can carry, and keeps it", async () => {
    const id = "01a00000-0000-7000-8000-0000000013e1";
    harness = await folderHarness("folder-uncarried-property", {
      settings: { search: { types: ["user.ticket"] } },
      catalog: {
        kind: "json",
        status: 200,
        body: {
          data: [
            ...SCRIPTED_TYPES,
            wireType("user.ticket", {
              bodyField: "body",
              fields: {
                title: { type: "string" },
                body: { type: "string" },
                state: { type: "string" },
                "parent-of": { type: "string" },
              },
            }),
          ],
          next_cursor: null,
        },
      },
      rows: {
        "user.ticket": [
          {
            item: {
              id,
              type: "user.ticket",
              properties: { title: "Ticket", body: "to do\n", state: "open" },
            },
          },
        ],
      },
    });
    const rows = scriptFolderWrites(harness);
    const pulled = await harness.folder.pull();
    expect(pulled.ok).toBe(true);
    if (!pulled.ok) return;
    expect(
      pulled.value.uncarried,
      "a property a file reads as the item's own field or an edge went unreported, so it silently never appears in a file",
    ).toEqual([
      { type: "user.ticket", property: "parent-of" },
      { type: "user.ticket", property: "state" },
    ]);
    const written = read(harness, "Ticket.md");
    expect(
      written,
      "the property was written as a line the next read takes as the item's state",
    ).not.toMatch(/^state:/m);

    // An edit of a versioned file leaves it on the item: no file carries it,
    // so no line was taken out.
    writeFileSync(
      join(harness.dir, "Ticket.md"),
      written.replace("to do", "done"),
    );
    expect((await harness.folder.push()).ok).toBe(true);
    expect(rows.get(id)?.properties).toEqual({
      title: "Ticket",
      body: "done\n",
      state: "open",
    });
  });

  it("retypes an item whose frontmatter changes its type", async () => {
    const id = "01a00000-0000-7000-8000-0000000013f1";
    harness = await folderHarness("folder-retype", {
      settings: { search: { types: ["core.note", "core.bookmark"] } },
      rows: {
        "core.note": [
          { item: { id, properties: { title: "Link", body: "a page\n" } } },
        ],
      },
    });
    const rows = scriptFolderWrites(harness);
    expect((await harness.folder.pull()).ok).toBe(true);
    writeFileSync(
      join(harness.dir, "Link.md"),
      read(harness, "Link.md").replace(
        "type: core.note",
        "type: core.bookmark",
      ),
    );
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    const [edit] = sentUpdates(harness).filter((sent) => sent.id === id);
    expect(
      [edit?.body.type, edit?.body.retype],
      "the type line did not move the item, so the frontmatter names one type and the item is another",
    ).toEqual(["core.bookmark", true]);
    expect(
      (edit?.body.properties as Record<string, unknown> | undefined)?.type,
      "the type travelled as a property",
    ).toBeUndefined();
    expect(rows.get(id)?.type).toBe("core.bookmark");
    expect(read(harness, "Link.md")).toMatch(/^type: core\.bookmark$/m);
  });

  it("flags a refused retype and keeps the file", async () => {
    const id = "01a00000-0000-7000-8000-000000001401";
    const tagged = "01a00000-0000-7000-8000-000000001402";
    const shelving = "01a00000-0000-7000-8000-000000001403";
    harness = await folderHarness("folder-retype-refused", {
      settings: { search: { types: ["core.note", "core.bookmark"] } },
      rows: {
        "core.note": [
          { item: { id, properties: { title: "Link", body: "a page\n" } } },
          {
            item: { id: tagged, properties: { title: "Tagged", body: "t\n" } },
          },
          {
            item: {
              id: shelving,
              properties: { title: "Shelving", body: "s\n" },
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
      tagging: (request) =>
        request.pathname.includes(tagged)
          ? refusal(403, "type_not_permitted", "No tags here")
          : undefined,
    });
    const update = door!.update.bind(door!);
    door!.update = ((...args: Parameters<FolderDoor["update"]>) =>
      args[1].retype === true
        ? refusal(
            403,
            "type_not_permitted",
            "This credential may not write core.bookmark",
          )
        : update(...args)) as FolderDoor["update"];
    door!.transition = () =>
      refusal(400, "invalid_transition", "Not from here");
    expect((await harness.folder.pull()).ok).toBe(true);
    const retyped = read(harness, "Link.md")
      .replace("type: core.note", "type: core.bookmark")
      .replace("a page", "a page, bookmarked");
    writeFileSync(join(harness.dir, "Link.md"), retyped);
    // Any other write from a file the server refuses holds it the same way.
    const tagging = read(harness, "Tagged.md").replace(
      "tier: library\n",
      "tier: library\ntags:\n  - secret\n",
    );
    writeFileSync(join(harness.dir, "Tagged.md"), tagging);
    const shelved = read(harness, "Shelving.md").replace(
      "tier: library\n",
      "tier: library\nstate: archived\n",
    );
    writeFileSync(join(harness.dir, "Shelving.md"), shelved);

    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    if (!pushed.ok) return;
    expect(
      sentUpdates(harness).filter((sent) => sent.id === id).length,
      "the retype never reached the server, so nothing here was refused",
    ).toBe(1);
    expect(rows.get(id)?.type).toBe("core.note");
    expect(
      read(harness, "Link.md"),
      "the pull wrote the item over the person's retype, so what they wrote is gone and nothing says why",
    ).toBe(retyped);
    expect(
      pushed.value.pull?.flagged,
      "the file was kept without saying why",
    ).toEqual([
      expect.objectContaining({
        path: "Link.md",
        flag: "refused",
        reason:
          "type_not_permitted: This credential may not write core.bookmark",
      }),
      expect.objectContaining({ path: "Shelving.md", flag: "refused" }),
      expect.objectContaining({ path: "Tagged.md", flag: "refused" }),
    ]);
    expect(read(harness, "Tagged.md")).toBe(tagging);
    expect(read(harness, "Shelving.md")).toBe(shelved);

    // Not sent again while the file stays as it is.
    const again = await harness.folder.push();
    expect(again.ok).toBe(true);
    expect(sentUpdates(harness).filter((sent) => sent.id === id).length).toBe(
      1,
    );
    expect(read(harness, "Link.md")).toBe(retyped);
  });

  it("holds a file whose frontmatter does not parse", async () => {
    const id = "01a00000-0000-7000-8000-000000001411";
    harness = await folderHarness("folder-unreadable-frontmatter", {
      rows: {
        "core.note": [
          { item: { id, properties: { title: "Held", body: "as it was\n" } } },
        ],
      },
    });
    const rows = scriptFolderWrites(harness);
    expect((await harness.folder.pull()).ok).toBe(true);
    const written = read(harness, "Held.md");
    const broken = written
      .replace("title: Held", "title: [Held")
      .replace("as it was", "edited");
    writeFileSync(join(harness.dir, "Held.md"), broken);
    put(harness, "New.md", "---\ntitle: New\n  bad: indent\n---\nbody\n");
    put(harness, "Tier.md", "---\ntitle: Tier\ntier: attic\n---\nbody\n");
    put(
      harness,
      "Merged.md",
      "---\nbase: &b {x: 1}\nmerged:\n  <<: *b\n---\nbody\n",
    );
    put(harness, "Keyed.md", "---\n1: one\n---\nbody\n");

    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    if (!pushed.ok) return;
    expect(
      [sentUpdates(harness).length, sentCreates(harness).length],
      "frontmatter that does not parse was sent, its lines as body text or its fields lost",
    ).toEqual([0, 0]);
    expect(
      pushed.value.scan.flagged.map((file) => [file.path, file.flag]),
    ).toEqual([
      ["Held.md", "unreadable"],
      ["Keyed.md", "unreadable"],
      ["Merged.md", "unreadable"],
      ["New.md", "unreadable"],
      ["Tier.md", "unreadable"],
    ]);
    expect(
      pushed.value.scan.flagged.find((file) => file.path === "Tier.md")?.reason,
    ).toContain("attic");
    // Every pull says so while the file is held, with the reason.
    const pulled = await harness.folder.pull();
    expect(pulled.ok && pulled.value.flagged).toEqual([
      expect.objectContaining({
        path: "Held.md",
        flag: "unreadable",
        reason: expect.any(String) as unknown,
      }),
    ]);
    expect(
      read(harness, "Held.md"),
      "the pull wrote the item over the person's unreadable file",
    ).toBe(broken);
    expect(rows.get(id)?.properties.body).toBe("as it was\n");

    // Moved while unreadable, it is still that item's file.
    renameSync(join(harness.dir, "Held.md"), join(harness.dir, "Moved.md"));
    const moved = await harness.folder.push();
    expect(moved.ok).toBe(true);
    if (!moved.ok) return;
    expect(moved.value.scan.missing).toBe(0);

    // Mended, it is sent.
    writeFileSync(
      join(harness.dir, "Moved.md"),
      broken.replace("title: [Held", "title: Held"),
    );
    const mended = await harness.folder.push();
    expect(mended.ok, JSON.stringify(mended)).toBe(true);
    expect(rows.get(id)?.properties.body).toBe("edited\n");
    expect(
      mended.ok && mended.value.pull?.flagged,
      "a mended file stayed flagged",
    ).toEqual([]);
    expect(
      read(harness, "Moved.md"),
      "the pull did not write the mended file again",
    ).toMatch(/^marfa_version: 2$/m);
  });

  it("sends no own-field change from an old buffer, and flags the lines it would have changed", async () => {
    const id = "01a00000-0000-7000-8000-000000001431";
    const moved = {
      id,
      version: 2,
      type: "core.bookmark",
      properties: { title: "Link", body: "as read\n" },
    };
    harness = await folderHarness("folder-own-fields-stale", {
      settings: { search: { types: ["core.note", "core.bookmark"] } },
      rows: {
        "core.note": [
          {
            item: { id, properties: { title: "Link", body: "as read\n" } },
            tags: ["a"],
          },
        ],
      },
      events: [
        liveReplay("2", [
          itemEvent("2", "item.updated", wireItem(moved), { tags: ["a", "b"] }),
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
    const held = read(harness, "Link.md");
    // Another machine retypes it and tags it meanwhile.
    door!.update(id, {
      properties: {},
      type: "core.bookmark",
      retype: true,
      version: 1,
    });
    expect((await harness.folder.push()).ok).toBe(true);
    // The witness: the pull wrote the other machine's type and tag out.
    expect(read(harness, "Link.md")).toMatch(/^type: core\.bookmark$/m);
    expect(read(harness, "Link.md")).toContain("  - b\n");

    // An editor that never reloaded saves its old buffer, with an edit.
    put(harness, "Link.md", held.replace("as read", "my edit"));
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    if (!pushed.ok) return;
    expect(
      pushed.value.scan.flagged.map((file) => [file.path, file.flag]),
      "the old buffer's own-field lines went unsent without a word",
    ).toEqual([["Link.md", "behind"]]);
    expect(pushed.value.scan.flagged[0]?.reason).toMatch(/type, tags/);
    const [edit] = sentUpdates(harness).filter((sent) => sent.id === id);
    expect(
      edit?.body.version,
      "the edit went on a version it was not made against",
    ).toBe(1);
    expect(
      edit?.body.retype,
      "the old buffer's type line moved the item back over the other machine's retype",
    ).toBeUndefined();
    expect(
      sentTags(harness),
      "the old buffer took away a tag another machine added, which it never saw",
    ).toEqual([]);
    expect(rows.get(id)).toMatchObject({
      type: "core.bookmark",
      properties: { title: "Link", body: "my edit\n" },
    });
  });

  it("keeps an archived item's file with its state in the frontmatter", async () => {
    const archived = "01a00000-0000-7000-8000-000000001421";
    const active = "01a00000-0000-7000-8000-000000001422";
    harness = await folderHarness("folder-archived-state", {
      rows: {
        "core.note": [
          {
            item: {
              id: archived,
              state: "archived",
              properties: { title: "Shelved", body: "old\n" },
            },
            tags: ["kept"],
          },
          {
            item: {
              id: active,
              properties: { title: "Current", body: "new\n" },
            },
          },
        ],
      },
    });
    scriptFolderWrites(harness);
    expect((await harness.folder.pull()).ok).toBe(true);
    const shelved = read(harness, "Shelved.md");
    expect(
      shelved,
      "an archived item's file does not say so, so an edit of it cannot tell an archived item from an active one",
    ).toMatch(/^state: archived$/m);
    expect(
      [...shelved.matchAll(/^([a-z_]+):/gm)].map((found) => found[1]),
      "the item's own fields were not written first, in their order",
    ).toEqual([
      "type",
      "tier",
      "tags",
      "state",
      "title",
      "marfa_id",
      "marfa_version",
    ]);
    expect(read(harness, "Current.md")).not.toMatch(/^state:/m);

    // Taking the line out restores it, and writing it archives the other.
    writeFileSync(
      join(harness.dir, "Shelved.md"),
      shelved.replace("state: archived\n", ""),
    );
    writeFileSync(
      join(harness.dir, "Current.md"),
      read(harness, "Current.md").replace(
        "tier: library\n",
        "tier: library\nstate: archived\n",
      ),
    );
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    expect(sentTransitions(harness).sort()).toEqual(
      [`${archived} active`, `${active} archived`].sort(),
    );
    expect(
      existsSync(join(harness.dir, "Current.md")),
      "the file of an item archived from it went",
    ).toBe(true);
    expect(read(harness, "Current.md")).toMatch(/^state: archived$/m);
  });

  it("keeps every save of three scanned before one drain", async () => {
    const id = "01a00000-0000-7000-8000-000000001441";
    harness = await folderHarness("folder-three-saves", {
      rows: {
        "core.note": [
          { item: { id, properties: { title: "Three", body: "one\n" } } },
        ],
      },
    });
    const rows = scriptFolderWrites(harness);
    expect((await harness.folder.pull()).ok).toBe(true);
    const written = read(harness, "Three.md");
    // Each save scanned on its own, so three whole edits wait together.
    for (const text of [
      written.replace("one\n", "two\n"),
      written
        .replace("one\n", "two\n")
        .replace("title: Three\n", "title: Three\nlang: fr\n"),
      written
        .replace("one\n", "three\n")
        .replace("title: Three\n", "title: Three\nlang: fr\n"),
    ]) {
      put(harness, "Three.md", text);
      expect((await harness.folder.scan()).ok).toBe(true);
    }
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    expect(
      sentUpdates(harness).filter((sent) => sent.id === id).length,
      "the three saves did not go as three edits, so nothing here moved one onto another",
    ).toBe(3);
    expect(
      rows.get(id)?.properties,
      "a later save moved onto an earlier one's answer undid a line the person wrote",
    ).toEqual({ title: "Three", body: "three\n", lang: "fr" });
    expect(read(harness, "Three.md")).toMatch(/^lang: fr$/m);
  });

  it("leaves a tag and an archive made elsewhere alone when an old buffer is saved", async () => {
    const id = "01a00000-0000-7000-8000-000000001451";
    const edges = new EdgeDoor();
    harness = await folderHarness("folder-old-buffer-tags", {
      rows: {
        "core.note": [
          {
            item: { id, properties: { title: "Kept", body: "as read\n" } },
            tags: ["a"],
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
    expect((await harness.folder.pull()).ok).toBe(true);
    const held = read(harness, "Kept.md");
    // Another machine tags it and archives it, neither a version step.
    const row = door!.rows.get(id)!;
    door!.rows.set(id, { ...row, tags: ["a", "b"] });
    edges.logItem(
      "metadata.changed",
      answers.updated(door!.wire(id), ["a", "b"]),
    );
    edges.logItem("item.state_changed", door!.transition(id, "archived"));
    expect((await harness.folder.push()).ok).toBe(true);
    // The witness: the pull wrote the tag and the state out at one version.
    const rewritten = read(harness, "Kept.md");
    expect(rewritten).toContain("  - b\n");
    expect(rewritten).toMatch(/^state: archived$/m);
    expect(rewritten).toMatch(/^marfa_version: 1$/m);

    put(harness, "Kept.md", held.replace("as read", "my edit"));
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    expect(
      sentUpdates(harness).filter((sent) => sent.id === id).length,
      "the old buffer's edit never went, so nothing here was read against it",
    ).toBe(1);
    expect(
      sentTags(harness),
      "the old buffer took away a tag another machine added, which it never saw",
    ).toEqual([]);
    expect(
      sentTransitions(harness),
      "the old buffer brought back an item another machine archived",
    ).toEqual([]);
    expect(door!.rows.get(id)?.properties.body).toBe("my edit\n");
    expect(
      pushed.ok && pushed.value.scan.flagged.map((file) => file.reason),
      "the old buffer's own-field lines went unsent without a word",
    ).toEqual([expect.stringMatching(/tag b, state not sent/)]);
  });

  it("keeps both body fields' text when a retype moves the body to another", async () => {
    const bookmark = "01a00000-0000-7000-8000-000000001471";
    const event = "01a00000-0000-7000-8000-000000001472";
    const plain = "01a00000-0000-7000-8000-000000001473";
    harness = await folderHarness("folder-retype-body-fields", {
      settings: {
        search: { types: ["core.note", "core.bookmark", "core.event"] },
      },
      rows: {
        "core.bookmark": [
          {
            item: {
              id: bookmark,
              type: "core.bookmark",
              properties: {
                title: "Mark",
                description: "what the page says",
                body: "my notes\n",
              },
            },
          },
        ],
        "core.event": [
          {
            item: {
              id: event,
              type: "core.event",
              properties: {
                title: "Meet",
                description: "the details\n",
                body: "an old note",
              },
            },
          },
        ],
        "core.note": [
          {
            item: { id: plain, properties: { title: "Plain", body: "text\n" } },
          },
        ],
      },
    });
    const rows = scriptFolderWrites(harness);
    expect((await harness.folder.pull()).ok).toBe(true);
    for (const [name, from, to] of [
      ["Mark.md", "core.bookmark", "core.event"],
      ["Meet.md", "core.event", "core.note"],
      ["Plain.md", "core.note", "core.event"],
    ]) {
      writeFileSync(
        join(harness.dir, name),
        read(harness, name).replace(`type: ${from}`, `type: ${to}`),
      );
    }
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    expect(
      [rows.get(bookmark)?.type, rows.get(event)?.type],
      "the retypes did not land, so nothing here moved a body",
    ).toEqual(["core.event", "core.note"]);
    expect(
      rows.get(bookmark)?.properties,
      "the file's body went over the line the new type keeps its body in, or left the old body field",
    ).toEqual({
      title: "Mark",
      description: "what the page says",
      body: "my notes\n",
    });
    expect(
      rows.get(event)?.properties,
      "the file's body went over the line the new type keeps its body in, or left the old body field",
    ).toEqual({
      title: "Meet",
      description: "the details\n",
      body: "an old note",
    });
    expect(
      rows.get(plain)?.properties,
      "with no line of its own, the new body field did not take the body",
    ).toEqual({ title: "Plain", body: "text\n", description: "text\n" });
  });

  it("reads a file the folder never wrote own lines into as leaving them as they are", async () => {
    const id = "01a00000-0000-7000-8000-000000001481";
    const named = "01a00000-0000-7000-8000-000000001482";
    harness = await folderHarness("folder-own-lines-unwritten", {
      settings: { search: { types: ["core.note", "core.bookmark"] } },
      rows: {
        "core.note": [
          {
            item: {
              id,
              state: "archived",
              properties: { title: "Older", body: "as it was\n" },
            },
            tags: ["a"],
          },
          { item: { id: named, properties: { title: "Named", body: "n\n" } } },
        ],
      },
    });
    scriptFolderWrites(harness);
    // A file written before its folder wrote own lines, with a version line
    // and none of them.
    put(
      harness,
      "Older.md",
      `---\ntitle: Older\nmarfa_id: ${id}\nmarfa_version: 1\n---\nedited\n`,
    );
    // One that names its own fields sends them, as a current file does.
    put(
      harness,
      "Named.md",
      `---\ntype: core.bookmark\ntags: [fresh]\ntitle: Named\nmarfa_id: ${named}\nmarfa_version: 1\n---\nn\n`,
    );
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    expect(
      sentUpdates(harness).filter((sent) => sent.id === id).length,
      "the edit was not sent, so nothing here was read",
    ).toBe(1);
    expect(
      [sentTags(harness), sentTransitions(harness)],
      "lines the file never carried took the item's tags away or brought it back from the archive",
    ).toEqual([[`add ${named} fresh`], []]);
    expect(
      sentUpdates(harness).find((sent) => sent.id === named)?.body.retype,
      "a current file's type line, never written by this folder, did not retype",
    ).toBe(true);
  });

  it("reads own-field lines in each form a file can hold them", async () => {
    const shelved = "01a00000-0000-7000-8000-0000000014d1";
    const trashing = "01a00000-0000-7000-8000-0000000014d2";
    harness = await folderHarness("folder-own-forms", {
      rows: {
        "core.note": [
          {
            item: {
              id: shelved,
              state: "archived",
              properties: { title: "Shelved", body: "s\n" },
            },
          },
          {
            item: { id: trashing, properties: { title: "Trash", body: "t\n" } },
          },
        ],
      },
    });
    scriptFolderWrites(harness);
    expect((await harness.folder.pull()).ok).toBe(true);
    put(harness, "One.md", "---\ntags: solo\n---\nbody\n");
    put(harness, "Commas.md", "---\ntags: x, y\n---\nbody\n");
    put(harness, "None.md", "---\ntags:\n---\nbody\n");
    for (const [name, line] of [
      ["Shape.md", "tags: {a: 1}"],
      ["Number.md", "tags: [1]"],
      ["Untyped.md", "type:"],
    ]) {
      put(harness, name!, `---\n${line}\n---\nbody\n`);
    }
    writeFileSync(
      join(harness.dir, "Shelved.md"),
      read(harness, "Shelved.md").replace("state: archived", "state:"),
    );
    writeFileSync(
      join(harness.dir, "Trash.md"),
      read(harness, "Trash.md").replace(
        "tier: library\n",
        "tier: library\nstate: trashed\n",
      ),
    );
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    if (!pushed.ok) return;
    const byTitle = new Map(
      sentCreates(harness).map((sent) => [
        String((sent.properties as Record<string, unknown>).title),
        String(sent.id),
      ]),
    );
    expect(
      sentTags(harness).sort(),
      "a tags line of one tag, of tags separated by commas, or empty was misread",
    ).toEqual(
      [
        `add ${byTitle.get("One")} solo`,
        `add ${byTitle.get("Commas")} x`,
        `add ${byTitle.get("Commas")} y`,
      ].sort(),
    );
    expect(
      sentTransitions(harness),
      "an empty state line did not bring the item back to active, or a trashed state line moved the item",
    ).toEqual([`${shelved} active`]);
    expect(
      harness.server.requests.filter((request) =>
        request.pathname.endsWith("/restore"),
      ),
      "a state line naming the bin restored or trashed something",
    ).toEqual([]);
    expect(
      pushed.value.scan.flagged.map((file) => [file.path, file.flag]).sort(),
    ).toEqual(
      [
        ["Number.md", "unreadable"],
        ["Shape.md", "unreadable"],
        ["Trash.md", "unreadable"],
        ["Untyped.md", "unreadable"],
      ].sort(),
    );
  });

  it("sends nothing for a save that only reformats the frontmatter", async () => {
    const id = "01a00000-0000-7000-8000-0000000014e1";
    harness = await folderHarness("folder-reformat", {
      rows: {
        "core.note": [
          {
            item: { id, properties: { title: "T", body: "b\n", status: "s" } },
            tags: ["a"],
          },
        ],
      },
    });
    scriptFolderWrites(harness);
    expect((await harness.folder.pull()).ok).toBe(true);
    const lines = read(harness, "T.md").split("\n");
    const end = lines.indexOf("---", 1);
    const front = lines.slice(1, end);
    const own = (line: string) => /^(type|tier|tags|  - )/.test(line);
    writeFileSync(
      join(harness.dir, "T.md"),
      [
        "---",
        ...front
          .filter((line) => !own(line))
          .map((line) => line.replace("title: T", 'title: "T"')),
        ...front.filter(own),
        ...lines.slice(end),
      ].join("\n"),
    );
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    expect(
      [sentUpdates(harness), sentTags(harness)],
      "a save that only moved and quoted lines sent an edit",
    ).toEqual([[], []]);
  });

  it("sends a tag the person adds and then takes out again at one version", async () => {
    const id = "01a00000-0000-7000-8000-0000000014f1";
    harness = await folderHarness("folder-tag-add-remove", {
      rows: {
        "core.note": [
          {
            item: { id, properties: { title: "T", body: "b\n" } },
            tags: ["a"],
          },
        ],
      },
    });
    scriptFolderWrites(harness);
    expect((await harness.folder.pull()).ok).toBe(true);
    const written = read(harness, "T.md");
    writeFileSync(
      join(harness.dir, "T.md"),
      written.replace("  - a\n", "  - a\n  - x\n"),
    );
    expect((await harness.folder.push()).ok).toBe(true);
    writeFileSync(join(harness.dir, "T.md"), written);
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    expect(
      sentTags(harness),
      "the person's own tag, added and taken out at one version, was not taken out",
    ).toEqual([`add ${id} x`, `remove ${id} x`]);
    expect(pushed.ok && pushed.value.scan.flagged).toEqual([]);
  });

  it("does not re-archive from a buffer written before a restore elsewhere", async () => {
    const id = "01a00000-0000-7000-8000-000000001501";
    const edges = new EdgeDoor();
    harness = await folderHarness("folder-restore-elsewhere", {
      rows: {
        "core.note": [
          { item: { id, properties: { title: "T", body: "as read\n" } } },
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
    expect((await harness.folder.pull()).ok).toBe(true);
    const oldest = read(harness, "T.md");
    edges.logItem("item.state_changed", door!.transition(id, "archived"));
    expect((await harness.folder.push()).ok).toBe(true);
    const archivedBuffer = read(harness, "T.md");
    expect(archivedBuffer).toMatch(/^state: archived$/m);
    edges.logItem("item.state_changed", door!.transition(id, "active"));
    expect((await harness.folder.push()).ok).toBe(true);
    // A buffer of each write saved over the file, one after the other.
    put(harness, "T.md", oldest.replace("as read", "edit one"));
    expect((await harness.folder.push()).ok).toBe(true);
    put(harness, "T.md", archivedBuffer.replace("as read", "edit two"));
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    expect(
      sentTransitions(harness),
      "a buffer written before the restore archived the item again",
    ).toEqual([]);
    expect(door!.rows.get(id)?.state).toBe("active");
    expect(
      pushed.ok && pushed.value.scan.flagged.map((file) => file.flag),
    ).toEqual(["behind"]);
  });

  it("sends no tag change from an old buffer however many tag writes came at one version", async () => {
    const id = "01a00000-0000-7000-8000-000000001511";
    const edges = new EdgeDoor();
    harness = await folderHarness("folder-many-tag-writes", {
      rows: {
        "core.note": [
          {
            item: { id, properties: { title: "T", body: "as read\n" } },
            tags: ["a"],
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
    expect((await harness.folder.pull()).ok).toBe(true);
    const held = read(harness, "T.md");
    const tags = ["a"];
    for (let n = 1; n <= 9; n += 1) {
      tags.push(`c${n}`);
      const row = door!.rows.get(id)!;
      door!.rows.set(id, { ...row, tags: [...tags] });
      edges.logItem(
        "metadata.changed",
        answers.updated(door!.wire(id), [...tags]),
      );
      expect((await harness.folder.push()).ok).toBe(true);
    }
    put(harness, "T.md", held.replace("as read", "my edit"));
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    expect(
      sentTags(harness),
      "an old buffer took away tags another machine added at its version",
    ).toEqual([]);
    expect(door!.rows.get(id)?.tags).toEqual(tags);
  });

  it("reads a quoted version line as the version, and a removed one as no version", async () => {
    const quoted = "01a00000-0000-7000-8000-000000001521";
    const removed = "01a00000-0000-7000-8000-000000001522";
    const decimal = "01a00000-0000-7000-8000-000000001523";
    const ahead = "01a00000-0000-7000-8000-000000001524";
    const edges = new EdgeDoor();
    harness = await folderHarness("folder-quoted-version", {
      settings: { search: { types: ["core.note", "core.bookmark"] } },
      rows: {
        "core.note": [
          {
            item: { id: quoted, properties: { title: "Q", body: "as read\n" } },
          },
          {
            item: {
              id: removed,
              properties: { title: "R", body: "as read\n" },
            },
          },
          {
            item: {
              id: decimal,
              properties: { title: "D", body: "as read\n" },
            },
          },
          {
            item: { id: ahead, properties: { title: "A", body: "as read\n" } },
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
    const buffers = {
      "Q.md": read(harness, "Q.md").replace(
        /^marfa_version: (\d+)$/m,
        'marfa_version: "$1"',
      ),
      "R.md": read(harness, "R.md").replace(/^marfa_version: \d+\n/m, ""),
    };
    const own = {
      "D.md": read(harness, "D.md").replace(
        /^marfa_version: (\d+)$/m,
        "marfa_version: $1.0",
      ),
      "A.md": read(harness, "A.md")
        .replace(/^marfa_version: \d+$/m, "marfa_version: 7")
        .replace("type: core.note", "type: core.bookmark"),
    };
    for (const id of [quoted, removed]) {
      edges.logItem(
        "item.updated",
        door!.update(id, {
          properties: {},
          type: "core.bookmark",
          retype: true,
          version: 1,
        }),
      );
    }
    expect((await harness.folder.push()).ok).toBe(true);
    for (const [name, text] of Object.entries({ ...buffers, ...own })) {
      put(harness, name, text.replace("as read", "my edit"));
    }
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    expect(
      sentUpdates(harness).filter((sent) => sent.body.retype === true),
      "an old buffer whose version line was quoted or taken out moved the item back to the type it showed",
    ).toEqual([]);
    expect([rows.get(quoted)?.type, rows.get(removed)?.type]).toEqual([
      "core.bookmark",
      "core.bookmark",
    ]);
    expect(
      sentUpdates(harness).find((sent) => sent.id === quoted)?.body.version,
      "a quoted version line was not read as the version the edit was based on",
    ).toBe(1);
    expect(
      sentUpdates(harness).find((sent) => sent.id === decimal)?.body
        .properties_mode,
      "a version line written 1.0 was not read as the version the copy holds",
    ).toBe("replace");
    expect(
      pushed.ok &&
        pushed.value.scan.flagged.find((file) => file.path === "A.md")?.reason,
      "a line ahead of the copy was not said to be one",
    ).toMatch(/names a version this copy does not hold/);
  });

  it("lets a file go once a later save lands after a refused one", async () => {
    const id = "01a00000-0000-7000-8000-000000001531";
    harness = await folderHarness("folder-refused-then-landed", {
      settings: { search: { types: ["core.note", "core.bookmark"] } },
      rows: {
        "core.note": [
          { item: { id, properties: { title: "T", body: "as read\n" } } },
        ],
      },
    });
    let door: FolderDoor | undefined;
    scriptFolderWrites(harness, {
      door: (made) => {
        door = made;
      },
    });
    const update = door!.update.bind(door!);
    door!.update = ((...args: Parameters<FolderDoor["update"]>) =>
      args[1].retype === true && args[1].type === "core.bookmark"
        ? refusal(403, "type_not_permitted", "no bookmarks")
        : update(...args)) as FolderDoor["update"];
    expect((await harness.folder.pull()).ok).toBe(true);
    const written = read(harness, "T.md");
    put(
      harness,
      "T.md",
      written.replace("type: core.note", "type: core.bookmark"),
    );
    expect((await harness.folder.scan()).ok).toBe(true);
    put(harness, "T.md", written.replace("as read", "my edit"));
    expect((await harness.folder.scan()).ok).toBe(true);
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    expect(
      pushed.ok && pushed.value.drain.verdicts.map((entry) => entry.verdict),
      "the first save was not refused, so nothing here is held",
    ).toContain("refused");
    expect(
      pushed.ok && pushed.value.pull?.flagged,
      "the file stayed held for a save its person had already replaced",
    ).toEqual([]);
    expect(door!.rows.get(id)?.properties.body).toBe("my edit\n");
    expect(read(harness, "T.md")).toMatch(/^marfa_version: 2$/m);
  });

  describe("a refused change holds its file", () => {
    const refusingStatus = (made: FolderDoor): void => {
      const update = made.update.bind(made);
      made.update = ((...args: Parameters<FolderDoor["update"]>) =>
        (args[1].properties as Record<string, unknown> | undefined)?.status ===
        "bad"
          ? refusal(422, "validation_failed", "status is draft or done")
          : update(...args)) as FolderDoor["update"];
    };
    async function refused(
      label: string,
      tags: string[] = [],
    ): Promise<{ id: string; bad: string; door: FolderDoor }> {
      const id = "01a00000-0000-7000-8000-000000001541";
      harness = await folderHarness(label, {
        rows: {
          "core.note": [
            {
              item: {
                id,
                properties: { title: "T", body: "as read\n", status: "draft" },
              },
              tags,
            },
          ],
        },
      });
      let door: FolderDoor | undefined;
      scriptFolderWrites(harness, {
        door: (made) => {
          door = made;
          refusingStatus(made);
        },
        tagging: (request) =>
          request.method === "POST" && request.body.includes("forbidden")
            ? refusal(422, "validation_failed", "no such tag")
            : undefined,
      });
      expect((await harness.folder.pull()).ok).toBe(true);
      const bad = read(harness, "T.md").replace("status: draft", "status: bad");
      put(harness, "T.md", bad);
      expect((await harness.folder.scan()).ok).toBe(true);
      return { id, bad, door: door! };
    }
    const heldAs = (pushed: Awaited<ReturnType<CliFolder["push"]>>) =>
      pushed.ok
        ? pushed.value.pull?.flagged.map((file) => [file.path, file.flag])
        : [];

    it("through a rename before the drain", async () => {
      const { bad } = await refused("folder-refused-renamed-before");
      renameSync(join(harness!.dir, "T.md"), join(harness!.dir, "Renamed.md"));
      const pushed = await harness!.folder.push();
      expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
      expect(
        heldAs(pushed),
        "a rename cut the file off from its refused edit",
      ).toEqual([["Renamed.md", "refused"]]);
      expect(read(harness!, "Renamed.md")).toBe(bad);
    });

    it("through a save that only reformats it before the drain", async () => {
      const { bad } = await refused("folder-refused-reformatted");
      const reformatted = bad.replace("title: T", 'title: "T"');
      put(harness!, "T.md", reformatted);
      const pushed = await harness!.folder.push();
      expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
      expect(
        heldAs(pushed),
        "a reformat cut the file off from its refused edit",
      ).toEqual([["T.md", "refused"]]);
      expect(read(harness!, "T.md")).toBe(reformatted);
    });

    it("through a later save that only adds a tag", async () => {
      const { bad } = await refused("folder-refused-then-tag", ["a"]);
      const tagged = bad.replace("  - a\n", "  - a\n  - t\n");
      put(harness!, "T.md", tagged);
      const pushed = await harness!.folder.push();
      expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
      expect(
        heldAs(pushed),
        "a tag that landed let go of a refused property it does not touch",
      ).toEqual([["T.md", "refused"]]);
      expect(read(harness!, "T.md")).toBe(tagged);
    });

    it("through a later save that only edits the body, where a tag was refused", async () => {
      const id = "01a00000-0000-7000-8000-000000001542";
      harness = await folderHarness("folder-refused-tag-then-body", {
        rows: {
          "core.note": [
            {
              item: { id, properties: { title: "T", body: "as read\n" } },
              tags: ["a"],
            },
          ],
        },
      });
      scriptFolderWrites(harness, {
        tagging: (request) =>
          request.method === "POST" && request.body.includes("forbidden")
            ? refusal(422, "validation_failed", "no such tag")
            : undefined,
      });
      expect((await harness.folder.pull()).ok).toBe(true);
      const tagged = read(harness, "T.md").replace(
        "  - a\n",
        "  - a\n  - forbidden\n",
      );
      put(harness, "T.md", tagged);
      expect((await harness.folder.scan()).ok).toBe(true);
      const edited = tagged.replace("as read", "second save");
      put(harness, "T.md", edited);
      const pushed = await harness.folder.push();
      expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
      expect(
        heldAs(pushed),
        "a body edit that landed let go of a refused tag it does not touch",
      ).toEqual([["T.md", "refused"]]);
      expect(read(harness, "T.md")).toBe(edited);
    });

    it("through a rename after the refusal", async () => {
      const { bad } = await refused("folder-refused-renamed-after");
      expect(heldAs(await harness!.folder.push())).toEqual([
        ["T.md", "refused"],
      ]);
      renameSync(join(harness!.dir, "T.md"), join(harness!.dir, "Renamed.md"));
      const pushed = await harness!.folder.push();
      expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
      expect(heldAs(pushed), "a rename let go of the refused edit").toEqual([
        ["Renamed.md", "refused"],
      ]);
      expect(read(harness!, "Renamed.md")).toBe(bad);
    });
  });

  it("sends a mended tag from a file whose edit landed beside the refused one", async () => {
    const id = "01a00000-0000-7000-8000-000000001551";
    harness = await folderHarness("folder-refused-tag-mended", {
      rows: {
        "core.note": [
          {
            item: { id, properties: { title: "T", body: "as read\n" } },
            tags: ["a"],
          },
        ],
      },
    });
    let door: FolderDoor | undefined;
    scriptFolderWrites(harness, {
      door: (made) => {
        door = made;
      },
      tagging: (request) =>
        request.method === "POST" && request.body.includes("forbidden")
          ? refusal(422, "validation_failed", "no such tag")
          : undefined,
    });
    expect((await harness.folder.pull()).ok).toBe(true);
    const first = read(harness, "T.md")
      .replace("  - a\n", "  - a\n  - forbidden\n")
      .replace("as read", "edited");
    put(harness, "T.md", first);
    expect((await harness.folder.push()).ok).toBe(true);
    put(harness, "T.md", first.replace("forbidden", "good"));
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    expect(
      door!.rows.get(id)?.tags,
      "the mended tag went unsent, the file read as behind although its body edit landed",
    ).toEqual(["a", "good"]);
    expect(pushed.ok && pushed.value.scan.flagged).toEqual([]);
    expect(pushed.ok && pushed.value.pull?.flagged).toEqual([]);
  });

  it("sends a save right after its own edit lands as current", async () => {
    const id = "01a00000-0000-7000-8000-000000001561";
    harness = await folderHarness("folder-save-after-landing", {
      rows: {
        "core.note": [
          {
            item: {
              id,
              properties: { title: "T", body: "as read\n", lang: "en" },
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
    const one = read(harness, "T.md").replace("as read", "one");
    put(harness, "T.md", one);
    expect((await harness.folder.scan()).ok).toBe(true);
    expect((await harness.folder.device().drain()).ok).toBe(true);
    // Saved again before any pull has written the new line.
    put(harness, "T.md", one.replace("lang: en\n", ""));
    expect((await harness.folder.push()).ok).toBe(true);
    expect(
      door!.rows.get(id)?.properties,
      "a line taken out right after the file's own edit landed was not cleared",
    ).toEqual({ title: "T", body: "one\n" });
  });

  it("takes an own-field change after a version step no file shows", async () => {
    const id = "01a00000-0000-7000-8000-000000001571";
    const edges = new EdgeDoor();
    harness = await folderHarness("folder-invisible-step", {
      rows: {
        "core.note": [
          {
            item: { id, properties: { title: "T", body: "as read\n" } },
            tags: ["a"],
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
    expect((await harness.folder.pull()).ok).toBe(true);
    // An edit whose values the file already shows: the version moves, and
    // the file is not written again for its line alone (`folders.md` 24).
    edges.logItem(
      "item.updated",
      door!.update(id, { properties: { title: "T" }, version: 1 }),
    );
    expect((await harness.folder.push()).ok).toBe(true);
    const shown = read(harness, "T.md");
    expect(shown).toMatch(/^marfa_version: 1$/m);
    put(harness, "T.md", shown.replace("  - a\n", "  - a\n  - n\n"));
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    expect(
      sentTags(harness),
      "the person's tag, in a file only its line kept from current, was flagged behind rather than sent",
    ).toEqual([`add ${id} n`]);
    expect(pushed.ok && pushed.value.scan.flagged).toEqual([]);
  });

  it("does not re-archive from the buffer of an archive restored elsewhere", async () => {
    const id = "01a00000-0000-7000-8000-000000001581";
    const edges = new EdgeDoor();
    harness = await folderHarness("folder-restored-single-buffer", {
      rows: {
        "core.note": [
          { item: { id, properties: { title: "T", body: "as read\n" } } },
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
    expect((await harness.folder.pull()).ok).toBe(true);
    edges.logItem("item.state_changed", door!.transition(id, "archived"));
    expect((await harness.folder.push()).ok).toBe(true);
    const archived = read(harness, "T.md");
    expect(archived).toMatch(/^state: archived$/m);
    edges.logItem("item.state_changed", door!.transition(id, "active"));
    expect((await harness.folder.push()).ok).toBe(true);
    put(harness, "T.md", archived.replace("as read", "edit"));
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    expect(
      sentTransitions(harness),
      "the one buffer, written while the item was archived, archived it again after a restore elsewhere",
    ).toEqual([]);
    expect(door!.rows.get(id)?.state).toBe("active");
  });

  it("keeps an unreadable file's item when it moves with no identity", async () => {
    const id = "01a00000-0000-7000-8000-0000000014a1";
    harness = await folderHarness("folder-unreadable-no-identity", {
      rows: {
        "core.note": [
          { item: { id, properties: { title: "Held", body: "as it was\n" } } },
        ],
      },
    });
    scriptFolderWrites(harness);
    expect((await harness.folder.pull()).ok).toBe(true);
    writeFileSync(
      join(harness.dir, "Held.md"),
      read(harness, "Held.md").replace("title: Held", "title: [Held"),
    );
    // A hard link leaves both paths with no identity of their own.
    linkSync(join(harness.dir, "Held.md"), join(harness.dir, "Linked.md"));
    renameSync(join(harness.dir, "Held.md"), join(harness.dir, "Moved.md"));
    const scanned = await harness.folder.scan();
    expect(scanned.ok).toBe(true);
    if (!scanned.ok) return;
    expect(
      scanned.value.missing,
      "the moved file lost its item, whose delete is now journaled",
    ).toBe(0);
    expect(scanned.value.flagged.map((file) => file.path).sort()).toEqual([
      "Linked.md",
      "Moved.md",
    ]);
  });

  it("refuses a type no document can be, before sending anything", async () => {
    const id = "01a00000-0000-7000-8000-0000000014b1";
    harness = await folderHarness("folder-type-unsuited", {
      rows: {
        "core.note": [
          { item: { id, properties: { title: "Typed", body: "text\n" } } },
        ],
      },
    });
    scriptFolderWrites(harness);
    expect((await harness.folder.pull()).ok).toBe(true);
    const typed = read(harness, "Typed.md").replace(
      "type: core.note",
      "type: user.nothing",
    );
    writeFileSync(join(harness.dir, "Typed.md"), typed);
    put(harness, "Bytes.md", "---\ntype: core.file\n---\nnot bytes\n");
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    if (!pushed.ok) return;
    expect(
      [sentUpdates(harness).length, sentCreates(harness).length],
      "a type no document can be was sent",
    ).toEqual([0, 0]);
    expect(
      pushed.value.scan.flagged.map((file) => [file.path, file.flag]),
    ).toEqual([
      ["Bytes.md", "refused"],
      ["Typed.md", "refused"],
    ]);
    expect(read(harness, "Typed.md")).toBe(typed);
  });

  it("takes a versioned file's missing tags line as no tags, and a lineless file's as no change", async () => {
    const versioned = "01a00000-0000-7000-8000-0000000014c1";
    const lineless = "01a00000-0000-7000-8000-0000000014c2";
    harness = await folderHarness("folder-missing-tags-line", {
      rows: {
        "core.note": [
          {
            item: { id: versioned, properties: { title: "V", body: "v\n" } },
            tags: ["a"],
          },
          {
            item: { id: lineless, properties: { title: "L", body: "l\n" } },
            tags: ["a"],
          },
        ],
      },
    });
    scriptFolderWrites(harness);
    expect((await harness.folder.pull()).ok).toBe(true);
    writeFileSync(
      join(harness.dir, "V.md"),
      read(harness, "V.md").replace("tags:\n  - a\n", ""),
    );
    writeFileSync(
      join(harness.dir, "L.md"),
      read(harness, "L.md")
        .replace("tags:\n  - a\n", "")
        .replace(/^marfa_version: \d+\n/m, "")
        .replace("l\n", "edited\n"),
    );
    expect((await harness.folder.push()).ok).toBe(true);
    expect(
      sentTags(harness),
      "a versioned file's tags line taken out left the tag, or a file with no version line took one away",
    ).toEqual([`remove ${versioned} a`]);
  });
});

describe("identity", () => {
  it("creates a file under the device's id and writes the id back once it lands", async () => {
    harness = await folderHarness("folder-id-create");
    const rows = scriptFolderWrites(harness);
    const text = "---\ntitle: New\n---\nwritten here\n";
    put(harness, "new.md", text);
    expect((await harness.folder.scan()).ok).toBe(true);
    // Queued and not yet landed: a pull leaves the person's file as it is.
    expect((await harness.folder.pull()).ok).toBe(true);
    expect(
      read(harness, "new.md"),
      "the id was written into the file before its create landed, so a create the server refuses leaves the file naming nothing",
    ).toBe(text);

    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    const [sent] = sentCreates(harness);
    expect(
      typeof sent?.id,
      "the create carried no id of the device's own, so the file has nothing to name until the server answers",
    ).toBe("string");
    expect(
      [sent?.source, sent?.source_id, sent?.version],
      "the create carried a natural key or a version, which nothing the server holds can give a file",
    ).toEqual([undefined, undefined, undefined]);
    expect(rows.has(String(sent?.id))).toBe(true);
    expect(
      idIn(harness, "new.md"),
      "the id was not written back once the create landed, so nothing in the file names its item",
    ).toBe(sent?.id);
    expect(read(harness, "new.md")).toContain("written here");
    const settled = await harness.folder.scan();
    expect(
      settled.ok && [settled.value.created, settled.value.updated],
      "the folder read its own write-back as a change",
    ).toEqual([0, 0]);
  });

  it("keeps the item when a save drops the id line", async () => {
    harness = await folderHarness("folder-id-dropped");
    const rows = scriptFolderWrites(harness);
    put(harness, "note.md", "---\ntitle: Note\n---\nfirst\n");
    expect((await harness.folder.push()).ok).toBe(true);
    const id = idIn(harness, "note.md");
    expect(
      id,
      "no id was written back, so there is no line to drop",
    ).toBeDefined();

    // An editor that does not keep the line saves without it, as a new file
    // at the same path.
    saveAtomically(harness, "note.md", "---\ntitle: Note\n---\nsecond\n");
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    if (!pushed.ok) return;
    expect(
      [pushed.value.scan.created, pushed.value.scan.updated],
      "a save that dropped the id line made the file a second item",
    ).toEqual([0, 1]);
    expect(sentUpdates(harness).map((update) => update.id)).toEqual([id]);
    expect(rows.get(id ?? "")?.properties.body).toBe("second\n");
    expect(idIn(harness, "note.md")).toBe(id);
  });

  it("does not write back into a file changed since its scan", async () => {
    harness = await folderHarness("folder-id-changed-since");
    scriptFolderWrites(harness);
    put(harness, "note.md", "---\ntitle: Note\n---\nscanned\n");
    expect((await harness.folder.scan()).ok).toBe(true);
    expect((await harness.folder.device().drain()).ok).toBe(true);
    // The person saves again after the scan read the file and before the
    // pull that would write the id back.
    const typed = "---\ntitle: Note\n---\nscanned, and typed since\n";
    put(harness, "note.md", typed);
    const pulled = await harness.folder.pull();
    expect(pulled.ok).toBe(true);
    if (!pulled.ok) return;
    expect(
      read(harness, "note.md"),
      "the id was written back over bytes the scan never read, and the person's latest words went with it",
    ).toBe(typed);
    expect(pulled.value.unwritten).toBe(1);

    // The next scan meets the change, and the binding keeps the item.
    const scanned = await harness.folder.scan();
    expect(
      scanned.ok && [scanned.value.created, scanned.value.updated],
    ).toEqual([0, 1]);
    // The witness: left alone, the file does take the id back.
    expect((await harness.folder.push()).ok).toBe(true);
    expect(idIn(harness, "note.md")).toBe(sentCreates(harness)[0]?.id);
  });

  it("follows a rename by the id the file carries, and sends no edit of the item for it", async () => {
    harness = await folderHarness("folder-rename-by-id");
    scriptFolderWrites(harness);
    put(harness, "before.md", "---\ntitle: Before\n---\nsame bytes\n");
    expect((await harness.folder.push()).ok).toBe(true);
    const id = idIn(harness, "before.md");
    expect(id).toBeDefined();

    // Moved as some tools move a file, by a copy and a delete: a new inode,
    // so only the id says which item this is.
    writeFileSync(join(harness.dir, "after.md"), read(harness, "before.md"));
    rmSync(join(harness.dir, "before.md"));
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    if (!pushed.ok) return;
    expect(
      [
        pushed.value.scan.renamed,
        pushed.value.scan.created,
        pushed.value.scan.missing,
      ],
      "the moved file was not followed by its id, so the note is two items and the old one is about to be deleted",
    ).toEqual([1, 0, 0]);
    expect(
      sentUpdates(harness),
      "a move sent an edit of the item, though only its placement moved",
    ).toEqual([]);

    // And the file stays where the person put it, on this pull and the next.
    expect((await harness.folder.push()).ok).toBe(true);
    expect(existsSync(join(harness.dir, "after.md"))).toBe(true);
    expect(
      existsSync(join(harness.dir, "before.md")),
      "the old name came back, so the folder now holds the note twice",
    ).toBe(false);
    expect(idIn(harness, "after.md")).toBe(id);
  });

  it("does not write a new file's body onto the item whose name it took", async () => {
    harness = await folderHarness("folder-name-handover");
    const held = scriptFolderWrites(harness);
    put(harness, "a-note.md", "---\ntitle: A\n---\nthe real note\n");
    expect((await harness.folder.push()).ok).toBe(true);
    const incumbent = idIn(harness, "a-note.md") ?? "";
    expect(incumbent, "the file never became an item").not.toBe("");

    // The moved file frees `a-note.md`, and a brand new file takes it in the
    // same scan, where the binding still names the moved one.
    renameSync(join(harness.dir, "a-note.md"), join(harness.dir, "z-note.md"));
    put(harness, "a-note.md", "---\ntitle: A\n---\nbrand new\n");
    const handedOver = await harness.folder.push();
    expect(handedOver.ok, JSON.stringify(handedOver)).toBe(true);
    if (!handedOver.ok) return;
    expect([
      handedOver.value.scan.created,
      handedOver.value.scan.renamed,
    ]).toEqual([1, 1]);
    expect(
      held.get(incumbent)?.properties?.body,
      "the note the person moved was overwritten by an unrelated new file that took the name it was leaving",
    ).toBe("the real note\n");
    expect(idIn(harness, "z-note.md")).toBe(incumbent);
    const newcomer = idIn(harness, "a-note.md") ?? "";
    expect(newcomer).not.toBe(incumbent);
    expect(
      held.get(newcomer)?.properties?.body,
      "the new file never became an item of its own",
    ).toBe("brand new\n");
  });

  it("keeps a binding for every file after a swap that also edits both", async () => {
    harness = await folderHarness("folder-swap-and-edit");
    scriptFolderWrites(harness);
    put(harness, "one.md", "---\ntitle: One\n---\nfirst\n");
    put(harness, "two.md", "---\ntitle: Two\n---\nsecond\n");
    expect((await harness.folder.push()).ok).toBe(true);

    // Swapped and edited, and the edits drop the id lines, so only the
    // binding's record of each file says which item it is.
    renameSync(join(harness.dir, "one.md"), join(harness.dir, ".swap"));
    renameSync(join(harness.dir, "two.md"), join(harness.dir, "one.md"));
    renameSync(join(harness.dir, ".swap"), join(harness.dir, "two.md"));
    writeFileSync(
      join(harness.dir, "one.md"),
      "---\ntitle: Two\n---\nsecond, and a word the person typed\n",
    );
    writeFileSync(
      join(harness.dir, "two.md"),
      "---\ntitle: One\n---\nfirst, and another\n",
    );
    expect((await harness.folder.push()).ok).toBe(true);

    // After the scan, does the folder still know what each file is? A row
    // lost here is a file the next scan pushes as a second item.
    const scanned = await harness.folder.scan();
    expect(scanned.ok).toBe(true);
    if (!scanned.ok) return;
    expect(
      scanned.value.created,
      "a file came out of the swap with no binding, so the next scan made it a second item",
    ).toBe(0);
    expect(
      scanned.value.missing,
      "a path came out of the swap bound to nothing that is there, so the grace is now counting down on an item whose file is on the disk",
    ).toBe(0);
    expect(
      [scanned.value.updated, scanned.value.renamed],
      "the scan after the swap still had something to say about these files, so the swap did not come to rest",
    ).toEqual([0, 0]);
  });

  it("keeps its id line out of what it sends the server", async () => {
    harness = await folderHarness("folder-record-not-sent");
    scriptFolderWrites(harness);
    put(harness, "note.md", "---\ntitle: Recorded\n---\nbody\n");
    expect((await harness.folder.push()).ok).toBe(true);

    // The folder wrote the id into the file, so this is what a person
    // opening the file and typing a line actually edits.
    const written = read(harness, "note.md");
    expect(
      written,
      "the folder wrote no id into the file, so the rest of this is about a file that carries nothing to leak",
    ).toMatch(/marfa_id:\s*\S+/);
    writeFileSync(join(harness.dir, "note.md"), `${written}and a line more\n`);
    expect((await harness.folder.push()).ok).toBe(true);
    const sent = sentUpdates(harness).map(
      (update) => update.body.properties as Record<string, unknown>,
    );
    expect(
      sent.length,
      "the edit never reached the server, so this asserts nothing about what it carried",
    ).toBeGreaterThan(0);
    expect(
      sent.filter((properties) => "marfa_id" in properties),
      "the folder sent the id as a property of the item, so every later render writes it out twice over",
    ).toEqual([]);

    // And a create: a copy carries the id of the item it was copied from.
    writeFileSync(join(harness.dir, "copy.md"), written);
    expect((await harness.folder.push()).ok).toBe(true);
    const creates = sentCreates(harness);
    expect(
      creates.length,
      "no create reached the server, so the assertion below is about an empty list",
    ).toBeGreaterThan(1);
    expect(
      creates.filter(
        (create) =>
          "marfa_id" in (create.properties as Record<string, unknown>),
      ),
      "a copied file carried the id of the item it was copied from onto a new item as a property",
    ).toEqual([]);
  });

  it("keeps an agent's whole-file rewrite the same item", async () => {
    harness = await folderHarness("folder-agent-rewrite");
    const rows = scriptFolderWrites(harness);
    put(harness, "plan.md", "---\ntitle: Plan\n---\nthe first draft\n");
    expect((await harness.folder.push()).ok).toBe(true);
    const id = idIn(harness, "plan.md") ?? "";
    expect(id).not.toBe("");

    // An agent writes the whole file anew, as a new file renamed over the
    // old one, with nothing the folder wrote into it.
    saveAtomically(
      harness,
      "plan.md",
      "---\ntitle: Plan\nstatus: rewritten\n---\nan agent's whole new text\n",
    );
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    if (!pushed.ok) return;
    expect(
      [
        pushed.value.scan.created,
        pushed.value.scan.updated,
        pushed.value.scan.missing,
      ],
      "an agent's rewrite at the same path became a second item",
    ).toEqual([0, 1, 0]);
    expect(sentUpdates(harness).map((update) => update.id)).toEqual([id]);
    expect(rows.get(id)?.properties).toMatchObject({
      status: "rewritten",
      body: "an agent's whole new text\n",
    });
    expect(idIn(harness, "plan.md")).toBe(id);
  });

  it("keeps an unchanged rewrite the same item", async () => {
    harness = await folderHarness("folder-unchanged-rewrite");
    scriptFolderWrites(harness);
    put(harness, "note.md", "---\ntitle: Note\n---\nthe same words\n");
    expect((await harness.folder.push()).ok).toBe(true);
    const id = idIn(harness, "note.md");
    expect(id).toBeDefined();

    // Saved again with the same bytes, as a new inode.
    saveAtomically(harness, "note.md", read(harness, "note.md"));
    const quiet = await harness.folder.push();
    expect(quiet.ok, JSON.stringify(quiet)).toBe(true);
    if (!quiet.ok) return;
    expect(
      [
        quiet.value.scan.unchanged,
        quiet.value.scan.created,
        quiet.value.scan.updated,
        quiet.value.scan.missing,
      ],
      "a save of the same bytes read as something other than the file the folder already holds",
    ).toEqual([1, 0, 0, 0]);
    expect(sentUpdates(harness)).toEqual([]);

    // Still that item wherever it goes next.
    renameSync(join(harness.dir, "note.md"), join(harness.dir, "moved.md"));
    const moved = await harness.folder.push();
    expect(moved.ok, JSON.stringify(moved)).toBe(true);
    if (!moved.ok) return;
    expect(
      [moved.value.scan.renamed, moved.value.scan.created],
      "the file saved with the same bytes was not followed when it moved",
    ).toEqual([1, 0]);
    expect(idIn(harness, "moved.md")).toBe(id);
    expect(sentCreates(harness)).toHaveLength(1);
  });

  it("makes a copy a new item with a fresh id", async () => {
    harness = await folderHarness("folder-copy");
    const rows = scriptFolderWrites(harness);
    put(harness, "note.md", "---\ntitle: Note\n---\nthe original\n");
    expect((await harness.folder.push()).ok).toBe(true);
    const id = idIn(harness, "note.md") ?? "";
    expect(id).not.toBe("");

    // A copy carries the original's frontmatter, id and all.
    writeFileSync(join(harness.dir, "copy.md"), read(harness, "note.md"));
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    if (!pushed.ok) return;
    expect([pushed.value.scan.created, pushed.value.scan.updated]).toEqual([
      1, 0,
    ]);
    const copy = String(sentCreates(harness)[1]?.id);
    expect(
      copy,
      "the copy was created under the original's id, so two files claim one item",
    ).not.toBe(id);
    expect(
      idIn(harness, "copy.md"),
      "the copy still carries the original's id, so the next scan meets two files claiming one item",
    ).toBe(copy);
    expect(idIn(harness, "note.md")).toBe(id);
    expect(rows.get(id)?.properties.body).toBe("the original\n");

    // Edited apart, each goes to its own item.
    put(
      harness,
      "copy.md",
      read(harness, "copy.md").replace("the original", "the copy, edited"),
    );
    expect((await harness.folder.push()).ok).toBe(true);
    expect(sentUpdates(harness).map((update) => update.id)).toEqual([copy]);
    expect(rows.get(copy)?.properties.body).toBe("the copy, edited\n");
    expect(rows.get(id)?.properties.body).toBe("the original\n");
  });

  it("keeps the id with the file its binding names", async () => {
    harness = await folderHarness("folder-copy-binding");
    scriptFolderWrites(harness);
    put(harness, "b.md", "---\ntitle: B\n---\nthe original\n");
    expect((await harness.folder.push()).ok).toBe(true);
    const id = idIn(harness, "b.md");
    const bytes = read(harness, "b.md");

    // A copy that sorts first, then the original saved again with the same
    // bytes: the copy is now the older file and first in path order, so only
    // the binding says which of the two is the original.
    writeFileSync(join(harness.dir, "a.md"), bytes);
    await new Promise((resolve) => setTimeout(resolve, 20));
    saveAtomically(harness, "b.md", bytes);
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    if (!pushed.ok) return;
    expect(pushed.value.scan.created).toBe(1);
    const copy = sentCreates(harness)[1]?.id;
    expect(
      idIn(harness, "b.md"),
      "the id left the file the binding names for a copy made from it",
    ).toBe(id);
    expect(idIn(harness, "a.md")).toBe(copy);
    expect(copy).not.toBe(id);
  });

  it("keeps the id with the older of two unbound files that carry it", async () => {
    const held = "01a00000-0000-7000-8000-00000000000b";
    harness = await folderHarness("folder-copy-unbound", {
      rows: {
        "core.note": [
          { item: { id: held, properties: { title: "Held", body: "held\n" } } },
        ],
      },
    });
    scriptFolderWrites(harness);
    // The row is held and no file is bound to it yet: neither file is the
    // binding's.
    const bytes = `---\nmarfa_id: ${held}\ntitle: Held\n---\nheld\n`;
    put(harness, "z-older.md", bytes);
    await new Promise((resolve) => setTimeout(resolve, 20));
    put(harness, "a-newer.md", bytes);
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    if (!pushed.ok) return;
    expect(pushed.value.scan.created).toBe(1);
    const [copy] = sentCreates(harness);
    expect(copy?.id).not.toBe(held);
    expect(
      idIn(harness, "z-older.md"),
      "the id went to the newer file because it sorts first",
    ).toBe(held);
    expect(idIn(harness, "a-newer.md")).toBe(copy?.id);
  });

  it("keeps the id with the original an editor saved without its line, over a copy carrying it", async () => {
    harness = await folderHarness("folder-copy-original-dropped-line");
    const rows = scriptFolderWrites(harness);
    put(harness, "b.md", "---\ntitle: B\n---\nthe original\n");
    expect((await harness.folder.push()).ok).toBe(true);
    const id = idIn(harness, "b.md") ?? "";
    // The witness: the copy carries the id and is the older file.
    writeFileSync(
      join(harness.dir, "z-copy.md"),
      read(harness, "b.md").replace("the original", "the copy"),
    );
    expect(idIn(harness, "z-copy.md")).toBe(id);
    await new Promise((resolve) => setTimeout(resolve, 20));
    saveAtomically(
      harness,
      "b.md",
      "---\ntitle: B\n---\nthe original, edited\n",
    );
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    expect(
      idIn(harness, "b.md"),
      "the original lost its item to a copy because its editor dropped the line",
    ).toBe(id);
    expect(rows.get(id)?.properties.body).toBe("the original, edited\n");
    expect(idIn(harness, "z-copy.md")).not.toBe(id);
  });

  it("keeps a copy its own item once the original goes, before its id line is rewritten", async () => {
    harness = await folderHarness("folder-copy-original-gone");
    const rows = scriptFolderWrites(harness);
    put(harness, "n.md", "---\ntitle: Note\n---\nthe original\n");
    expect((await harness.folder.push()).ok).toBe(true);
    const id = idIn(harness, "n.md") ?? "";
    writeFileSync(
      join(harness.dir, "copy.md"),
      read(harness, "n.md").replace("the original", "the copy"),
    );
    const copied = await harness.folder.scan();
    // The witness: the copy was made a new item while it still carries the id.
    expect(copied.ok && copied.value.created).toBe(1);
    expect(idIn(harness, "copy.md")).toBe(id);

    rmSync(join(harness.dir, "n.md"));
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    expect(
      sentUpdates(harness).map((update) => update.id),
      "the copy took the original's item once the original went, and sent its words over it",
    ).toEqual([]);
    expect(rows.get(id)?.properties.body).toBe("the original\n");
    const copy = sentCreates(harness)[1]?.id;
    expect(copy).toBeDefined();
    expect(idIn(harness, "copy.md")).toBe(copy);
  });

  it("sends nothing for a save that only drops the id line", async () => {
    harness = await folderHarness("folder-id-dropped-only");
    scriptFolderWrites(harness);
    const text = "---\ntitle: Note\n---\nbody\n";
    put(harness, "note.md", text);
    expect((await harness.folder.push()).ok).toBe(true);
    const id = idIn(harness, "note.md");
    // The witness is `› keeps the item when a save drops the id line`: the
    // same save with a new body is sent.
    saveAtomically(harness, "note.md", text);
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    expect(
      sentUpdates(harness),
      "a save that changed nothing but the id line sent an edit",
    ).toEqual([]);
    expect(idIn(harness, "note.md")).toBe(id);
  });

  it("sends a checked-out file's edits to the item its id names, and nothing for one in step", async () => {
    const [edited, same] = [
      "01a00000-0000-7000-8000-00000000000c",
      "01a00000-0000-7000-8000-00000000000d",
    ];
    harness = await folderHarness("folder-id-checked-out", {
      rows: {
        "core.note": [
          {
            item: {
              id: edited,
              properties: { title: "Edited", body: "server\n" },
            },
          },
          {
            item: { id: same, properties: { title: "Same", body: "server\n" } },
          },
        ],
      },
    });
    const rows = scriptFolderWrites(harness);
    // A fresh folder over files from a checkout: nothing is bound yet.
    put(
      harness,
      "edited.md",
      `---\nmarfa_id: ${edited}\ntitle: Edited\n---\nin a checkout\n`,
    );
    put(
      harness,
      "same.md",
      `---\nmarfa_id: ${same}\ntitle: Same\n---\nserver\n`,
    );
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    expect(sentCreates(harness)).toEqual([]);
    expect(
      sentUpdates(harness).map((update) => update.id),
      "a checked-out file's edit never reached its item, or one in step was sent",
    ).toEqual([edited]);
    expect(rows.get(edited)?.properties.body).toBe("in a checkout\n");
  });

  it("reads the id of a Markdown file whatever the case of its extension", async () => {
    harness = await folderHarness("folder-id-extensions");
    const rows = scriptFolderWrites(harness);
    put(harness, "UP.MD", "---\ntitle: Up\n---\nupper\n");
    put(harness, "long.Markdown", "---\ntitle: Long\n---\nlong\n");
    expect((await harness.folder.push()).ok).toBe(true);
    const up = idIn(harness, "UP.MD");
    expect(up).toBeDefined();
    expect(idIn(harness, "long.Markdown")).toBeDefined();
    // Moved by copy and delete, so only the id can follow them.
    writeFileSync(join(harness.dir, "moved.MD"), read(harness, "UP.MD"));
    rmSync(join(harness.dir, "UP.MD"));
    writeFileSync(
      join(harness.dir, "moved.markdown"),
      read(harness, "long.Markdown"),
    );
    rmSync(join(harness.dir, "long.Markdown"));
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    expect(
      pushed.ok && [pushed.value.scan.renamed, pushed.value.scan.created],
      "a moved file's id went unread for the case of its extension",
    ).toEqual([2, 0]);
    expect(idIn(harness, "moved.MD")).toBe(up);
    expect(rows.size).toBe(2);
  });

  it("reads no id from a .txt file or from a document naming a file item", async () => {
    const fileId = "01a00000-0000-7000-8000-0000000000f1";
    const bytes = Buffer.from("bytes\n");
    harness = await folderHarness("folder-id-not-read", {
      settings: {
        search: { types: ["core.note", "core.file"] },
        defaults: { type: "core.note" },
      },
      rows: {
        "core.file": [
          {
            item: {
              id: fileId,
              type: "core.file",
              properties: {
                title: "x.bin",
                blob_ref: hashOf(bytes),
                mime_type: "application/octet-stream",
              },
            },
          },
        ],
      },
    });
    const rows = scriptFolderWrites(harness);
    acceptUploads(harness.server);
    scriptBlob(harness.server, bytes);
    put(harness, "n.md", "---\ntitle: N\n---\nbody\n");
    expect((await harness.folder.push()).ok).toBe(true);
    const id = idIn(harness, "n.md") ?? "";
    // Both files go, so the .txt and the document are each the only file
    // carrying their id.
    expect(existsSync(join(harness.dir, "x.bin"))).toBe(true);
    rmSync(join(harness.dir, "n.md"));
    rmSync(join(harness.dir, "x.bin"));
    put(harness, "t.txt", `---\nmarfa_id: ${id}\n---\ntext\n`);
    put(harness, "doc.md", `---\nmarfa_id: ${fileId}\ntitle: Doc\n---\nbody\n`);
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    expect(
      sentUpdates(harness),
      "a .txt file or a document naming a file item was read as that item's file",
    ).toEqual([]);
    expect(pushed.ok && pushed.value.scan.created).toBe(2);
    expect(rows.get(id)?.properties.body).toBe("body\n");
  });

  it("reads a .txt file that opens with a --- block as a body", async () => {
    harness = await folderHarness("folder-txt-fence");
    scriptFolderWrites(harness);
    const text = "---\ntitle: Fenced\n---\nafter the fence\n";
    // The witness: the same bytes in a Markdown file are frontmatter.
    put(harness, "fenced.md", text);
    put(harness, "fenced.txt", text);
    expect((await harness.folder.push()).ok).toBe(true);
    const sent = sentCreates(harness).map(
      (create) => create.properties as Record<string, unknown>,
    );
    const md = sent.find((properties) => properties.title === "Fenced");
    expect(md?.body).toBe("after the fence\n");
    const txt = sent.find((properties) => properties !== md);
    expect(
      txt?.body,
      "a .txt file's opening block was read as frontmatter and left its body",
    ).toBe(text);
    expect(read(harness, "fenced.txt")).toBe(text);
  });

  it("reads no id from a file naming the folder's own settings", async () => {
    harness = await folderHarness("folder-id-of-settings");
    scriptFolderWrites(harness);
    const settings = harness.settings.id;
    put(
      harness,
      "taken.md",
      `---\nmarfa_id: ${settings}\ntitle: Taken\n---\nbody\n`,
    );
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    expect(
      sentTitles(harness),
      "a file naming the folder's settings was taken as their file",
    ).toEqual(["Taken"]);
    expect(
      harness.server.requests.filter(
        (request) =>
          request.method === "PATCH" &&
          request.pathname === `/items/${settings}`,
      ),
    ).toEqual([]);
    expect(idIn(harness, "taken.md")).not.toBe(settings);
  });

  it("lets go of the pin of an item whose file's path another item takes", async () => {
    const x = "01a00000-0000-7000-8000-0000000002d1";
    const y = "01a00000-0000-7000-8000-0000000002d2";
    harness = await folderHarness("folder-path-taken", {
      rows: {
        "core.note": [
          { item: { id: x, properties: { title: "ex", body: "x\n" } } },
          { item: { id: y, properties: { title: "why", body: "y\n" } } },
        ],
      },
    });
    scriptFolderWrites(harness);
    expect((await harness.folder.pull()).ok).toBe(true);
    const pinned = await harness.folder.device().status();
    expect(pinned.ok && pinned.value.pinned).toContain(x);
    // y's file moves onto x's path, replacing it.
    const why = read(harness, "why.md");
    rmSync(join(harness.dir, "why.md"));
    saveAtomically(harness, "ex.md", why);
    expect((await harness.folder.scan()).ok).toBe(true);
    const status = await harness.folder.device().status();
    expect(status.ok && status.value.pinned).toContain(y);
    expect(
      status.ok && status.value.pinned,
      "an item whose path another item took stayed pinned with no file",
    ).not.toContain(x);
  });

  it("gives a fresh id to a file whose id names nothing", async () => {
    harness = await folderHarness("folder-id-names-nothing");
    const rows = scriptFolderWrites(harness);
    const nothing = "01a00000-0000-7000-8000-0000000000ff";
    put(
      harness,
      "invented.md",
      `---\nmarfa_id: ${nothing}\ntitle: Invented\n---\nbody\n`,
    );
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    const [sent] = sentCreates(harness);
    expect(typeof sent?.id).toBe("string");
    expect(
      sent?.id,
      "a file was created under an id it carried and nothing held, so anybody can name an item by typing an id",
    ).not.toBe(nothing);
    expect(sent?.properties).not.toHaveProperty("marfa_id");
    expect(rows.has(nothing)).toBe(false);
    expect(idIn(harness, "invented.md")).toBe(sent?.id);
  });

  it("follows a rename by device, inode and birth time", async () => {
    harness = await folderHarness("folder-rename");
    scriptFolderWrites(harness);
    put(harness, "before.txt", "same bytes\n");
    expect((await harness.folder.push()).ok).toBe(true);
    expect(
      read(harness, "before.txt"),
      "the folder wrote frontmatter into a file that cannot carry it",
    ).toBe("same bytes\n");

    // A rename keeps the inode and the birth time, so it is the same file.
    renameSync(join(harness.dir, "before.txt"), join(harness.dir, "after.txt"));
    const scanned = await harness.folder.scan();
    expect(scanned.ok).toBe(true);
    if (!scanned.ok) return;
    expect(
      scanned.value.renamed,
      "a renamed file was not followed, so the item is now two items and the old one is about to be deleted",
    ).toBe(1);
    expect(scanned.value.created).toBe(0);
    const after = await harness.folder.device().queue();
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(
      after.value.filter((row) => row.kind === "create_item").length,
      "a second create was queued for a file that only moved",
    ).toBe(1);
    expect(
      after.value.some((row) => row.kind === "delete_item"),
      "the folder queued a delete for the path the file moved off",
    ).toBe(false);
  });

  it("treats a file with no usable identity as new rather than guessing", async () => {
    harness = await folderHarness("folder-no-identity");
    scriptFolderWrites(harness);
    put(harness, "first.txt", "one\n");
    expect((await harness.folder.push()).ok).toBe(true);

    // The control: a file the folder remembers, moved, is followed. Without
    // it the cases below hold as well against a folder that follows nothing.
    renameSync(join(harness.dir, "first.txt"), join(harness.dir, "moved.txt"));
    const followed = await harness.folder.scan();
    expect(followed.ok && followed.value.renamed).toBe(1);

    // A different file, where the folder last saw one. A filesystem that
    // reuses inodes may give it the old one, and the birth time is what
    // tells them apart.
    rmSync(join(harness.dir, "moved.txt"));
    put(harness, "second.txt", "two\n");
    const scanned = await harness.folder.scan();
    expect(scanned.ok).toBe(true);
    if (!scanned.ok) return;
    expect(
      scanned.value.created,
      "a file that is not the one the folder remembers was bound to its item",
    ).toBe(1);
    expect(scanned.value.renamed).toBe(0);

    // Two files that share an identity yield none for either: a hard link is
    // one inode, device and birth time on two paths.
    put(harness, "original.txt", "linked\n");
    expect((await harness.folder.scan()).ok).toBe(true);
    linkSync(join(harness.dir, "original.txt"), join(harness.dir, "hard.txt"));
    renameSync(
      join(harness.dir, "original.txt"),
      join(harness.dir, "moved.txt"),
    );
    const shared = await harness.folder.scan();
    expect(shared.ok).toBe(true);
    if (!shared.ok) return;
    expect(
      shared.value.renamed,
      "a file whose identity two paths share was followed as a rename, and the folder cannot know which of the two it remembers",
    ).toBe(0);
  });

  it("resolves identity over the files it holds, not every file in the tree", async () => {
    harness = await folderHarness("folder-unheld-identity");
    scriptFolderWrites(harness);
    put(harness, "note.txt", "same bytes\n");
    expect((await harness.folder.push()).ok).toBe(true);

    // A hard link under a name the folder does not hold: one identity on two
    // paths, one of which the folder never touches.
    linkSync(join(harness.dir, "note.txt"), join(harness.dir, "clip.mov"));
    renameSync(join(harness.dir, "note.txt"), join(harness.dir, "moved.txt"));
    const scanned = await harness.folder.scan();
    expect(scanned.ok).toBe(true);
    if (!scanned.ok) return;
    expect(
      scanned.value.skipped,
      "the walk never saw the unheld file, so nothing here could have taken the identity",
    ).toBeGreaterThan(0);
    expect(
      [scanned.value.renamed, scanned.value.created],
      "a file the folder does not hold took the identity of one it does, so renaming it made a second item",
    ).toEqual([1, 0]);
  });

  it("follows the rename of a file saved again with the same bytes", async () => {
    harness = await folderHarness("folder-stale-inode");
    scriptFolderWrites(harness);
    put(harness, "note.txt", "plain words\n");
    expect((await harness.folder.push()).ok).toBe(true);

    // Saved again with the same bytes, as a new inode: nothing to send, and
    // the folder's record of the file has to move to the new inode.
    saveAtomically(harness, "note.txt", read(harness, "note.txt"));
    const quiet = await harness.folder.scan();
    expect(quiet.ok && [quiet.value.unchanged, quiet.value.created]).toEqual([
      1, 0,
    ]);
    renameSync(join(harness.dir, "note.txt"), join(harness.dir, "moved.txt"));
    const moved = await harness.folder.scan();
    expect(moved.ok).toBe(true);
    if (!moved.ok) return;
    expect(
      [moved.value.renamed, moved.value.created, moved.value.missing],
      "the folder kept the inode the file had before its save, so the rename after it made a second item and journaled the first for deletion",
    ).toEqual([1, 0, 0]);
  });

  it("binds the same file to the same item whether it was present at start or arrived while running", async () => {
    // One of these is a real watcher, and the other pushes a file that was
    // there before anything ran: two identity rules would make the same bytes
    // two different kinds of create depending on when they appeared.
    const text = "---\ntitle: Same bytes\n---\nidentical\n";
    harness = await folderHarness("folder-at-start");
    second = await folderHarness("folder-while-running");
    scriptFolderWrites(harness);
    scriptFolderWrites(second);

    put(harness, "note.md", text);
    expect((await harness.folder.push()).ok).toBe(true);

    const watching = second.folder.watch();
    try {
      await vi.waitFor(
        () => {
          expect(
            watching.running(),
            `the watcher exited before it could see anything: ${watching.stderr}`,
          ).toBe(true);
          expect(
            second?.server.requests.some(
              (request) => request.pathname === "/types",
            ),
            "the watcher has not opened the folder yet",
          ).toBe(true);
        },
        { timeout: 15_000, interval: 100 },
      );
      put(second, "note.md", text);
      await vi.waitFor(
        () => {
          expect(
            sentCreates(second!),
            `the watcher never pushed the file that arrived while it was running: ${watching.stderr}`,
          ).toHaveLength(1);
        },
        { timeout: 20_000, interval: 250 },
      );
    } finally {
      await watching.stop();
    }

    // Each create carries an id its own device minted, so what must agree is
    // everything else it says.
    const shape = (folder: FolderHarness) =>
      sentCreates(folder).map(({ id, ...rest }) => ({
        minted: typeof id === "string",
        ...rest,
      }));
    expect(
      shape(harness),
      "the file present at start became a different create than the same file arriving to a running watcher",
    ).toEqual(shape(second));
    expect(shape(harness)).toHaveLength(1);
  });

  it("queues a file whose row the copy lost again once it changes, and says so", async () => {
    harness = await folderHarness("folder-lost-row");
    // The first create is refused and the drain forgets its row; everything
    // after answers by the server's rules.
    const door = new FolderDoor();
    scriptWrites(harness.server, {
      create: [
        refusal(400, "invalid_properties", "the body is not allowed"),
        (request) => door.create(JSON.parse(request.body) as DoorCreate).answer,
      ],
      update: [
        (request) =>
          door.update(
            request.pathname.split("/").at(-1) ?? "",
            JSON.parse(request.body) as { version: number },
          ),
      ],
      read: [(request) => door.read(request.pathname.split("/").at(-1) ?? "")],
    });
    new EdgeDoor().script(harness.server);
    put(harness, "mine.md", "---\ntitle: Mine\n---\nnot allowed\n");
    const refused = await harness.folder.push();
    expect(refused.ok, JSON.stringify(refused)).toBe(true);
    if (!refused.ok) return;
    expect(refused.value.drain.verdicts[0]?.verdict).toBe("refused");

    // Unchanged: those are the bytes the server refused, so nothing is sent,
    // and the scan says why rather than counting the file unchanged.
    const unchanged = await harness.folder.scan();
    expect(unchanged.ok).toBe(true);
    if (!unchanged.ok) return;
    expect([
      unchanged.value.created,
      unchanged.value.requeued,
      unchanged.value.lost,
    ]).toEqual([0, 0, 1]);

    // Changed: the file is bound to nothing, so it is queued as a new item
    // and reported as queued again, rather than stopping the scan.
    writeFileSync(
      join(harness.dir, "mine.md"),
      "---\ntitle: Mine\n---\nallowed\n",
    );
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    if (!pushed.ok) return;
    expect(
      [pushed.value.scan.created, pushed.value.scan.requeued],
      "a file bound to a row the copy lost was not queued again once it changed",
    ).toEqual([1, 1]);
    expect(
      itemVerdicts(pushed.value.drain.verdicts).map((entry) => entry.verdict),
    ).toEqual(["accepted"]);
    const made = String(sentCreates(harness).at(-1)?.id);
    expect(door.rows.get(made)?.properties.body).toBe("allowed\n");
    expect(read(harness, "mine.md")).toContain(`marfa_id: ${made}`);

    // And the folder carries on as any other: the next edit is an edit.
    writeFileSync(
      join(harness.dir, "mine.md"),
      `${read(harness, "mine.md")}more\n`,
    );
    const edited = await harness.folder.push();
    expect(edited.ok, JSON.stringify(edited)).toBe(true);
    expect(edited.ok && edited.value.scan.updated).toBe(1);
  });

  it("keeps a live file's binding when it takes a lost file's old name", async () => {
    // A file bound to a row the copy lost moves off its name, and a live
    // file moves onto that name, in one scan. The walk meets the live file
    // first and binds it there; queuing the lost file again must not then
    // take that binding away as the lost file's old one, or the live item is
    // left with no file and the next scan makes a second item of it.
    harness = await folderHarness("folder-lost-swap");
    const door = new FolderDoor();
    scriptWrites(harness.server, {
      create: [
        refusal(400, "invalid_properties", "the body is not allowed"),
        (request) => door.create(JSON.parse(request.body) as DoorCreate).answer,
      ],
      update: [
        (request) =>
          door.update(
            request.pathname.split("/").at(-1) ?? "",
            JSON.parse(request.body) as { version: number },
            { resolve: true },
          ),
      ],
      read: [(request) => door.read(request.pathname.split("/").at(-1) ?? "")],
    });
    new EdgeDoor().script(harness.server);
    put(harness, "a.md", "---\ntitle: Lost\n---\nnot allowed\n");
    expect((await harness.folder.push()).ok).toBe(true);
    put(harness, "b.md", "---\ntitle: Live\n---\nlive\n");
    expect((await harness.folder.push()).ok).toBe(true);
    const live = idIn(harness, "b.md") ?? "";
    expect(live, "the live file never became an item").not.toBe("");

    renameSync(join(harness.dir, "a.md"), join(harness.dir, "c.md"));
    writeFileSync(
      join(harness.dir, "c.md"),
      "---\ntitle: Lost\n---\nallowed now\n",
    );
    renameSync(join(harness.dir, "b.md"), join(harness.dir, "a.md"));
    const scanned = await harness.folder.scan();
    expect(scanned.ok, JSON.stringify(scanned)).toBe(true);
    if (!scanned.ok) return;
    // The witnesses: the live file's move and the lost file's re-queue both
    // happened in this scan.
    expect([scanned.value.renamed, scanned.value.requeued]).toEqual([1, 1]);
    // Asked again before any pull, which would take the file back by its
    // bytes and hide a binding lost here.
    const again = await harness.folder.scan();
    expect(again.ok).toBe(true);
    expect(
      again.ok && again.value.created,
      "the live file lost its binding to the lost file queued from its new name, and became a second item",
    ).toBe(0);
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    expect(door.rows.get(live)?.properties.body).toBe("live\n");
    expect(idIn(harness, "a.md")).toBe(live);
  });

  it("keeps a live file's binding when it takes a lost file's old name, across a push", async () => {
    // As above, with a push in place of the scans: the pull must not find the
    // live item without a file and write it a second one.
    harness = await folderHarness("folder-lost-swap-pushed");
    const door = new FolderDoor();
    scriptWrites(harness.server, {
      create: [
        refusal(400, "invalid_properties", "the body is not allowed"),
        (request) => door.create(JSON.parse(request.body) as DoorCreate).answer,
      ],
      update: [
        (request) =>
          door.update(
            request.pathname.split("/").at(-1) ?? "",
            JSON.parse(request.body) as { version: number },
            { resolve: true },
          ),
      ],
      read: [(request) => door.read(request.pathname.split("/").at(-1) ?? "")],
    });
    new EdgeDoor().script(harness.server);
    put(harness, "a.md", "---\ntitle: Lost\n---\nnot allowed\n");
    expect((await harness.folder.push()).ok).toBe(true);
    put(harness, "b.md", "---\ntitle: Live\n---\nlive\n");
    expect((await harness.folder.push()).ok).toBe(true);
    const live = idIn(harness, "b.md") ?? "";

    renameSync(join(harness.dir, "a.md"), join(harness.dir, "c.md"));
    writeFileSync(
      join(harness.dir, "c.md"),
      "---\ntitle: Found\n---\nallowed now\n",
    );
    renameSync(join(harness.dir, "b.md"), join(harness.dir, "a.md"));
    expect((await harness.folder.push()).ok).toBe(true);
    const again = await harness.folder.push();
    expect(again.ok, JSON.stringify(again)).toBe(true);
    expect(
      readdirSync(harness.dir)
        .filter((name) => !name.startsWith("."))
        .sort(),
      "the live item lost its file's binding and was written a second file",
    ).toEqual(["a.md", "c.md"]);
    expect(idIn(harness, "a.md")).toBe(live);
    expect(again.ok && again.value.scan.created).toBe(0);
  });

  it("queues a file whose row the copy lost again once it moves", async () => {
    // A move is the person acting on the file, as an edit is, so a file
    // bound to a row the copy lost is queued again when it moves, bytes
    // unchanged; left where it was, it is only reported.
    harness = await folderHarness("folder-lost-moved");
    const door = new FolderDoor();
    scriptWrites(harness.server, {
      create: [
        refusal(400, "invalid_properties", "the body is not allowed"),
        (request) => door.create(JSON.parse(request.body) as DoorCreate).answer,
      ],
      read: [(request) => door.read(request.pathname.split("/").at(-1) ?? "")],
    });
    new EdgeDoor().script(harness.server);
    put(harness, "mine.md", "---\ntitle: Mine\n---\nnot allowed\n");
    expect((await harness.folder.push()).ok).toBe(true);
    const stayed = await harness.folder.scan();
    expect(stayed.ok && [stayed.value.requeued, stayed.value.lost]).toEqual([
      0, 1,
    ]);

    renameSync(join(harness.dir, "mine.md"), join(harness.dir, "moved.md"));
    const moved = await harness.folder.scan();
    expect(moved.ok).toBe(true);
    if (!moved.ok) return;
    expect(
      [moved.value.created, moved.value.requeued, moved.value.lost],
      "a lost file that moved was left as lost, though the person acted on it",
    ).toEqual([1, 1, 0]);
  });

  it("says in words when a file is bound to an item that is gone, once while watching", async () => {
    harness = await folderHarness("folder-lost-words");
    // The one file's create is refused and its row read back as gone; any
    // other file's create is taken, so a file added later is a pass the
    // watcher is seen to run.
    const door = new FolderDoor();
    scriptWrites(harness.server, {
      create: [
        (request) => {
          const sent = JSON.parse(request.body) as DoorCreate;
          return sent.properties.title === "Mine"
            ? refusal(400, "invalid_properties", "the body is not allowed")
            : door.create(sent).answer;
        },
      ],
      read: [(request) => door.read(request.pathname.split("/").at(-1) ?? "")],
    });
    new EdgeDoor().script(harness.server);
    put(harness, "mine.md", "---\ntitle: Mine\n---\nnot allowed\n");
    const lost = "bound to an item that is gone";
    const createsOf = (title: string) =>
      sentTitles(harness!).filter((sent) => sent === title).length;
    const watching = harness.folder.watchText();
    let quiet = "";
    try {
      await vi.waitFor(() => expect(watching.stdout).toContain(`1 ${lost}`), {
        timeout: 20_000,
        interval: 100,
      });
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      quiet = watching.stdout;
      put(harness, "later.md", "---\ntitle: Later\n---\nallowed\n");
      await vi.waitFor(
        () => {
          expect(createsOf("Later")).toBe(1);
          expect(watching.stdout.length).toBeGreaterThan(quiet.length);
        },
        { timeout: 20_000, interval: 100 },
      );
      // Passes enough for a line printed one pass after the push to show.
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      expect(watching.running(), watching.stderr).toBe(true);
    } finally {
      await watching.stop();
    }
    // The passes between the first report and the later file said nothing,
    // and the watcher was passing through them: it saw the later file.
    expect(
      quiet.split(lost).length - 1,
      `a watcher said the same lost file on every pass: ${quiet}`,
    ).toBe(1);
    // After it, one line: the push's summary, which carries the lost count
    // as every summary line does. That count is the only later mention of
    // the lost file, and no pass after the push printed anything.
    const later = watching.stdout.slice(quiet.length).trim().split("\n");
    expect(
      later,
      `a watcher printed a pass where nothing happened: ${watching.stdout}`,
    ).toHaveLength(1);
    // Sent 2: the later file's create and its placement.
    expect(later[0]).toMatch(
      /^1 created, 0 updated, 0 renamed, 0 deleted; sent 2; \d+ file\(s\) written, 1 bound to an item that is gone$/,
    );
  });
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
      [idIn(harness, "Victim.md"), idIn(harness, "Long.md")],
      "a file whose new placement could not be written was taken from where it was",
    ).toEqual([victim, long]);
    // The witness: every other file is pulled, a move among them.
    expect(idIn(harness, "moved/moving.md")).toBe(moving);
    expect(existsSync(join(harness.dir, "moving.md"))).toBe(false);
    // And the next pass goes on, sending nothing for them.
    const again = await harness.folder.push();
    expect(again.ok && again.value.drain.sent).toBe(0);
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
      scriptHydration(server, { head: "1" });
      const row = scriptFolderRow(server, {
        search: { types: ["core.note"] },
      });
      server.answer("GET", "/keys/current", answers.currentKey("k", grant));
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
        liveReplay("2", [
          itemEvent(
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
    expect([pushed.value.drain.sent, pushed.value.drain.rebased]).toEqual([
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
        liveReplay("2", [
          itemEvent(
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
      events: [liveReplay("1", [])],
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
      events: [liveReplay("1", [])],
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
      itemEvent(
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
        liveReplay("2", [row(2, "as read\n", "2026-09-19T00:00:00.000Z")]),
        liveReplay("2", []),
        liveReplay("4", [row(4, "theirs\n", "2026-09-19T00:00:00.000Z")]),
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
        liveReplay("2", [
          itemEvent(
            "2",
            "item.updated",
            wireItem({
              id,
              version: 2,
              properties: { title: "Note", body: "as read\n", extra: "theirs" },
            }),
          ),
        ]),
        liveReplay("3", []),
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
      events: [liveReplay("1", [])],
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
    // (`folders.md` 13), and the walk does not enter a dot-led directory.
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

describe("what a folder does not watch", () => {
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

  it("keeps its own state in .marfa and never pushes it", async () => {
    harness = await folderHarness("folder-state");
    scriptFolderWrites(harness);
    put(harness, "note.md", "---\ntitle: A note\n---\nbody\n");
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
    const pushed = await harness.folder.push();
    expect(pushed.ok).toBe(true);
    if (!pushed.ok) return;
    expect(
      pushed.value.scan.skipped,
      "a file outside the folder's slice was pushed as a note, so anything dropped in the directory becomes an item of whatever type the folder defaults to",
    ).toBe(1);
    expect(
      sentTitles(harness),
      "the file outside the slice reached the server",
    ).toEqual(["Inside"]);
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

/** An edit of `going.md` goes to the item it is bound to, not a new one. */
async function editedReachesItsItem(
  harness: FolderHarness,
  item: string,
  id: string | undefined,
): Promise<void> {
  writeFileSync(
    join(harness.dir, "going.md"),
    read(harness, "going.md") + "an edit after it left\n",
  );
  const creates = sentCreates(harness).length;
  const pushed = await harness.folder.push();
  expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
  expect(
    sentCreates(harness).length,
    "an edit of the file made a new item of it",
  ).toBe(creates);
  expect(sentUpdates(harness).map((sent) => sent.id)).toContain(item);
  expect(idIn(harness, "going.md")).toBe(id);
}

describe("what a pull does with a file whose item stops matching", () => {
  const departed = {
    id: "01a00000-0000-7000-8000-0000000000d1",
    properties: { title: "going", body: "body\n" },
  };

  /** A folder holding one item, and a stream that trashes it and then
   *  restores it. */
  async function departure(label: string): Promise<FolderHarness> {
    return folderHarness(label, {
      rows: { "core.note": [{ item: departed }] },
      events: [
        replay("2", [
          itemEvent(
            "2",
            "item.deleted",
            wireItem({ ...departed, state: "trashed" }),
          ),
        ]),
        replay("3", [itemEvent("3", "item.restored", wireItem(departed))]),
      ],
    });
  }

  it("removes a trashed item's file and brings it back on restore", async () => {
    harness = await departure("folder-trashed");
    scriptFolderWrites(harness);
    const first = await harness.folder.pull();
    expect(first.ok && first.value.written).toBe(1);
    expect(existsSync(join(harness.dir, "going.md"))).toBe(true);
    const pinned = await harness.folder.device().status();
    expect(pinned.ok && pinned.value.pinned).toContain(departed.id);

    const caught = await harness.folder.device().catchUp();
    expect(
      caught.ok ? caught.value.applied : 0,
      `the trash event was not applied, so nothing below is about a departure: ${JSON.stringify(caught)}`,
    ).toBe(1);

    const second = await harness.folder.pull();
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(
      second.value.removed,
      "the item was trashed and its file stayed, bound and unmaintained, for the next scan to push back as an edit to a row the person cannot see",
    ).toBe(1);
    expect(second.value.kept).toBe(0);
    expect(existsSync(join(harness.dir, "going.md"))).toBe(false);
    const unpinned = await harness.folder.device().status();
    expect(
      unpinned.ok && unpinned.value.pinned,
      "a file's row stayed pinned once its binding went",
    ).not.toContain(departed.id);

    // The journal was not involved and nothing was queued. A journaled
    // path becomes a delete once the grace runs out (`folders.md` 21), so
    // the absence is asserted after it: the grace is the folder's five
    // seconds, and nothing shorter can show a delete not being sent.
    await new Promise((resolve) => setTimeout(resolve, 6_000));
    const scanned = await harness.folder.scan();
    expect(scanned.ok).toBe(true);
    if (!scanned.ok) return;
    expect([
      scanned.value.created,
      scanned.value.missing,
      scanned.value.deleted,
    ]).toEqual([0, 0, 0]);
    const queued = await harness.folder.device().queue();
    expect(queued.ok).toBe(true);
    if (!queued.ok) return;
    expect(
      queued.value.filter((row) => row.kind === "delete_item"),
      "the removed file was journaled, and the grace turned it into a delete of an item in the bin",
    ).toEqual([]);

    const restored = await harness.folder.device().catchUp();
    expect(restored.ok ? restored.value.applied : 0).toBe(1);
    const third = await harness.folder.pull();
    expect(third.ok && third.value.written).toBe(1);
    expect(
      read(harness, "going.md"),
      "a restored item did not come back as a file",
    ).toContain("body");
  });

  it("removes the file of an item that leaves by state", async () => {
    harness = await folderHarness("folder-leaves-by-state", {
      settings: { search: { types: ["core.note"], state: ["active"] } },
      rows: { "core.note": [{ item: departed }] },
      events: [
        replay("2", [
          itemEvent(
            "2",
            "item.state_changed",
            wireItem({ ...departed, state: "archived" }),
          ),
        ]),
      ],
    });
    scriptFolderWrites(harness);
    expect((await harness.folder.pull()).ok).toBe(true);
    expect(existsSync(join(harness.dir, "going.md"))).toBe(true);
    const caught = await harness.folder.device().catchUp();
    expect(caught.ok ? caught.value.applied : 0).toBe(1);
    const pulled = await harness.folder.pull();
    expect(pulled.ok).toBe(true);
    if (!pulled.ok) return;
    expect(pulled.value.removed).toBe(1);
    expect(pulled.value.unmatched).toBe(0);
    expect(existsSync(join(harness.dir, "going.md"))).toBe(false);
  });

  it("keeps an unmatched file current, so its second edit keeps another device's change", async () => {
    const item = {
      id: "01a00000-0000-7000-8000-0000000000f1",
      properties: { title: "going", body: "body\n", status: "a" },
    };
    const theirs = {
      ...item,
      version: 2,
      properties: { ...item.properties, status: "b" },
    };
    harness = await folderHarness("folder-unmatched-current", {
      settings: {
        search: { types: ["core.note"], filter: 'tags contains "keep"' },
      },
      rows: { "core.note": [{ item, tags: ["keep"] }] },
      events: [
        replay("2", [
          itemEvent("2", "item.updated", wireItem(theirs), { tags: [] }),
        ]),
        liveReplay("2", []),
      ],
    });
    let door: FolderDoor | undefined;
    const rows = scriptFolderWrites(harness, {
      door: (made) => {
        door = made;
      },
    });
    expect((await harness.folder.pull()).ok).toBe(true);
    // Another device sets `status: b`, and the item leaves the search.
    door?.update(item.id, { properties: { status: "b" }, version: 1 });
    expect((await harness.folder.device().catchUp()).ok).toBe(true);
    const pulled = await harness.folder.pull();
    expect(pulled.ok && pulled.value.unmatched).toBe(1);
    expect(read(harness, "going.md")).toContain("status: b");

    for (const edit of ["first edit", "second edit"]) {
      writeFileSync(
        join(harness.dir, "going.md"),
        read(harness, "going.md") + `${edit}\n`,
      );
      const pushed = await harness.folder.push();
      expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    }
    expect(
      rows.get(item.id)?.properties.status,
      "a later edit of an unmatched file put back a value another device had changed",
    ).toBe("b");
  });

  it("keeps a file whose item no longer matches, flagged", async () => {
    harness = await folderHarness("folder-unmatched", {
      settings: {
        search: { types: ["core.note"], filter: 'tags contains "keep"' },
      },
      rows: { "core.note": [{ item: departed, tags: ["keep"] }] },
      events: [
        replay("2", [
          itemEvent("2", "metadata.changed", wireItem(departed), { tags: [] }),
        ]),
      ],
    });
    scriptFolderWrites(harness);
    expect((await harness.folder.pull()).ok).toBe(true);
    const caught = await harness.folder.device().catchUp();
    expect(caught.ok ? caught.value.applied : 0).toBe(1);
    const pulled = await harness.folder.pull();
    expect(pulled.ok).toBe(true);
    if (!pulled.ok) return;
    expect(
      pulled.value.removed,
      "the pull took away the file of an item that only stopped matching, which says nothing of whether the file is wanted",
    ).toBe(0);
    expect(pulled.value.unmatched).toBe(1);
    expect(existsSync(join(harness.dir, "going.md"))).toBe(true);
    // Still bound: an edit to it goes to its item.
    writeFileSync(
      join(harness.dir, "going.md"),
      read(harness, "going.md") + "still the same item\n",
    );
    const scanned = await harness.folder.scan();
    expect(scanned.ok).toBe(true);
    if (!scanned.ok) return;
    expect([scanned.value.created, scanned.value.updated]).toEqual([0, 1]);
  });

  it("keeps the file of an item a narrowed search leaves out, flagged, and sends its edits to it", async () => {
    let changed: Record<string, unknown> = {};
    harness = await folderHarness("folder-narrowed-out", {
      rows: { "core.note": [{ item: departed }] },
      events: [
        (): Answer => replay("2", [itemEvent("2", "item.updated", changed)]),
        headRead("3"),
        liveReplay("3", []),
      ],
    });
    scriptFolderWrites(harness);
    expect((await harness.folder.pull()).ok).toBe(true);
    const id = idIn(harness, "going.md");
    harness.settings.settings = { search: { types: ["core.bookmark"] } };
    harness.settings.version = 2;
    changed = folderItem(harness.settings);
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    if (!pushed.ok) return;
    expect(pushed.value.catch_up.hydrated).not.toBeNull();
    expect(
      pushed.value.pull?.unmatched,
      "the copy let go of a bound file's row when the search narrowed, so the file is bound to nothing",
    ).toBe(1);
    await editedReachesItsItem(harness, departed.id, id);
  });

  it("keeps the file of an item retyped out of its search elsewhere, flagged, and sends its edits to it", async () => {
    const retyped = { ...departed, type: "core.bookmark", version: 2 };
    harness = await folderHarness("folder-retyped-out", {
      rows: { "core.note": [{ item: departed }] },
      events: [
        replay("2", [itemEvent("2", "item.updated", wireItem(retyped))]),
        liveReplay("2", []),
      ],
    });
    scriptFolderWrites(harness, {
      door: (door) => {
        door.rows.set(departed.id, {
          properties: departed.properties,
          type: "core.bookmark",
          source_id: null,
          version: 2,
        });
      },
    });
    expect((await harness.folder.pull()).ok).toBe(true);
    const id = idIn(harness, "going.md");
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    expect(
      pushed.ok && pushed.value.pull?.unmatched,
      "the copy let go of a bound file's row retyped out of the search, so the file is bound to nothing",
    ).toBe(1);
    await editedReachesItsItem(harness, departed.id, id);
  });

  it("keeps a file the folder never wrote whose create was refused, inside one push", async () => {
    // The scan binds the person's own bytes and queues the create; the
    // server refuses it; the drain reads the row back, finds nothing and
    // forgets it; the pull that ends the same push then meets a bound file
    // whose item the copy no longer holds.
    harness = await folderHarness("folder-refused-create");
    scriptWrites(harness.server, {
      create: [refusal(400, "invalid_properties", "the body is not allowed")],
      read: [refusal(404, "item_not_found", "no such item")],
    });
    new EdgeDoor().script(harness.server);
    put(harness, "mine.md", "---\ntitle: Mine\n---\nthe person's own words\n");
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    if (!pushed.ok) return;
    expect(pushed.value.drain.verdicts[0]?.verdict).toBe("refused");
    expect(
      pushed.value.pull?.removed,
      "the pull took away a file the folder never wrote, and the person's words with it",
    ).toBe(0);
    expect(read(harness, "mine.md")).toContain("the person's own words");
    // Its placement was refused with the create, not by an answer of its own.
    expect(
      pushed.value.drain.verdicts.some((entry) => entry.kind === "create_edge"),
    ).toBe(true);
    expect(
      pushed.value.pull?.unplaced,
      "a placement refused with the create it waited on was held back as refused itself",
    ).toBe(0);

    // Still bound, so the next scan neither makes a second item of it nor
    // queues the refused create again, and it says so; the push's own report
    // is what said the create was refused, and an edit to the file queues it
    // again (`folders.md` 36).
    const before = sentCreates(harness).length;
    expect(before, "the create was never sent, so nothing was refused").toBe(1);
    const scanned = await harness.folder.scan();
    expect(scanned.ok).toBe(true);
    if (!scanned.ok) return;
    expect([scanned.value.created, scanned.value.lost]).toEqual([0, 1]);
    expect((await harness.folder.push()).ok).toBe(true);
    expect(sentCreates(harness).length).toBe(before);
  });

  it("keeps a file the person changed after its item left, and says so", async () => {
    harness = await departure("folder-departed-edited");
    scriptFolderWrites(harness);
    expect((await harness.folder.pull()).ok).toBe(true);
    writeFileSync(
      join(harness.dir, "going.md"),
      read(harness, "going.md") + "an edit the person made\n",
    );
    const caught = await harness.folder.device().catchUp();
    expect(caught.ok ? caught.value.applied : 0).toBe(1);

    const pulled = await harness.folder.pull();
    expect(pulled.ok).toBe(true);
    if (!pulled.ok) return;
    expect(
      pulled.value.kept,
      "the pull took away a file the person had changed, and their edit with it",
    ).toBe(1);
    expect(pulled.value.removed).toBe(0);
    expect(read(harness, "going.md")).toContain("an edit the person made");
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

    // Its own write is not read back as a change (`folders.md` 20).
    const scanned = await harness.folder.scan();
    expect(scanned.ok).toBe(true);
    if (!scanned.ok) return;
    expect(
      scanned.value.unchanged,
      "the file the pull wrote was read back as a change to push",
    ).toBe(1);
    expect(scanned.value.created + scanned.value.updated).toBe(0);

    // A file the folder already holds the bytes of needs no server at all,
    // nor the copy of them beside the working copy.
    rmSync(
      join(
        harness.dir,
        ".marfa",
        "core.sqlite.blobs",
        hash.slice("sha256:".length),
      ),
    );
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
    harness.server.answer(
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
        replay("2", [
          itemEvent(
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
        replay("2", [
          itemEvent(
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
