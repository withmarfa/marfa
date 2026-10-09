import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  answers,
  edgeEvent,
  edgesPage,
  copyHeadRead,
  copyItemEvent,
  copyLiveReplay,
  refusal,
  SCRIPTED_EDGE_TYPES,
  wireEdge,
  wireItem,
  writeAnswers,
} from "../../device/marfa-answers.js";
import { folderItem, scriptWrites } from "./harness.js";
import { ScriptedServer } from "../../device/scripted-server.js";
import {
  FolderDoor,
  type DoorCreate,
  type DoorRow,
} from "../../device/folder-door.js";
import type { FolderHarness } from "./harness.js";
import type { DrainVerdict, QueuedWrite } from "../../device/protocol.js";
import type {
  Answer,
  RecordedRequest,
  SseFrame,
} from "../../device/scripted-server.js";
import type { WireEdgeOptions } from "../../device/marfa-answers.js";
/**
 * What the folder fixtures in this directory share: the scripted server's doors
 * and the helpers that read and write a folder. It is not a test file, so the
 * `include` globs in `vitest.config.ts` do not run it.
 */

/** A file in the folder. */
export function put(
  harness: FolderHarness,
  name: string,
  text: string,
): string {
  const path = join(harness.dir, name);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
  return path;
}

export function read(harness: FolderHarness, name: string): string {
  return readFileSync(join(harness.dir, name), "utf8");
}

/** The folder's settings file. */
export function settingsFile(harness: FolderHarness): string {
  return join(harness.dir, ".marfa", "folder.yaml");
}

/**
 * The folder door's change, as the server takes it at the version the row
 * is at: each named setting replaced whole. `answer` overrides, for a
 * refusal.
 */
export function scriptFolderChanges(
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
export function idIn(harness: FolderHarness, name: string): string | undefined {
  return /marfa_id:\s*(\S+)/.exec(read(harness, name))?.[1];
}

/** Replaces a file as an editor's atomic save does: the bytes are written
 *  beside it and renamed over it, so the path holds a new inode with a new
 *  birth time. */
export function saveAtomically(
  harness: FolderHarness,
  name: string,
  text: string | Buffer,
): void {
  const beside = join(harness.dir, `.saving-${name.replaceAll("/", "-")}`);
  writeFileSync(beside, text);
  renameSync(beside, join(harness.dir, name));
}

/**
 * Runs a command with a fault a debug build injects (`fault.rs` in the
 * core): a crash, or another process's change, at the one moment a fixture
 * cannot time from outside.
 */
export async function withFault<T>(
  fault: string,
  run: () => Promise<T>,
): Promise<T> {
  process.env.MARFA_TEST_FAULT = fault;
  try {
    return await run();
  } finally {
    delete process.env.MARFA_TEST_FAULT;
  }
}

/**
 * Answers for every door a folder's drain can reach, the item doors deciding
 * as the real server does (`FolderDoor`, which `fidelity.test.ts` holds to the
 * server's decisions).
 *
 * Returns what the door holds for each item, so a fixture can ask what each
 * ended up holding rather than only what was sent.
 */
export function scriptFolderWrites(
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
  edges.holds = (id) => door.rows.has(id);
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
    // Reconciliation reads the current server row after each settled write.
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
  harness.server.answer("DELETE", /^\/items\/[^/]+$/, (request) => {
    door.rows.delete(request.pathname.split("/").at(-1) ?? "");
    return { kind: "json", status: 204, body: {} };
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
 * update on the version held moving it on, and moving an end where the end
 * that stays holds one, and each change, with the item writes it is told of,
 * logged as the event the stream would carry.
 */
export class EdgeDoor {
  readonly edges = new Map<string, WireEdgeOptions & { version: number }>();
  /** Every change as its event, ids counting on from the head read's `1`. */
  readonly events: SseFrame[] = [];
  /** What the door held after each change, as `heldEdges` reads it, so a
   *  fixture can ask whether any reader could have found an end empty. */
  readonly history: string[][] = [];
  /** An answer standing in for the server's to an edge written or
   *  changed, a refusal say; the door decides where it answers `undefined`. */
  placing?: (edge: WireEdgeOptions) => Answer | undefined;
  /** The same, for an edge's delete. */
  deleting?: (edge: WireEdgeOptions) => Answer | undefined;
  /** Listings of an item's edges still to fail, as a server failing now. */
  failListings = 0;
  /** Edges an item's listing serves as they were, once each: a read answered
   *  before a change the copy has since taken (`device.md`, What the real
   *  server cannot be made to produce). */
  readonly behind = new Map<string, WireEdgeOptions & { version: number }>();
  /** Whether the item door holds a row, which an end moved to must be. */
  holds: (id: string) => boolean = () => true;
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
      // One parent a child, as the server refuses a second (`edges/card-target-held`).
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
        source_id?: string;
        target_id?: string;
        version: number;
      };
      if (held === undefined) {
        return refusal(404, "edge_not_found", "No such edge");
      }
      // The real door's order: the version, then the ends, then the body.
      if (body.version !== held.version) {
        return answers.edgeVersionConflict(wireEdge(held));
      }
      const ends = {
        source_id: body.source_id ?? held.source_id,
        target_id: body.target_id ?? held.target_id,
      };
      const refused = moveRefusal(held, ends);
      if (refused !== undefined) return refused;
      const moves =
        ends.source_id !== held.source_id || ends.target_id !== held.target_id;
      for (const end of ["source", "target"] as const) {
        const id = ends[`${end}_id`];
        if (moves && !this.holds(id)) return answers.edgeEndNotFound(end, id);
      }
      if (!moves && body.properties === undefined) {
        return answers.edgeChangesNothing();
      }
      const standIn = this.placing?.({
        ...held,
        ...ends,
        properties: { ...held.properties, ...body.properties },
      });
      if (standIn !== undefined) return standIn;
      const edge = {
        ...held,
        ...ends,
        properties: { ...held.properties, ...body.properties },
        version: held.version + 1,
        updated_at: this.stamp(),
      };
      this.edges.set(edge.id, edge);
      this.log("edge.updated", edge);
      return writeAnswers.edge(edge, 200);
    });
    server.copyAnswer("GET", /^\/edges\/[^/]+$/, (request) => {
      if (this.failListings > 0) {
        this.failListings -= 1;
        return refusal(503, "unavailable", "Try again");
      }
      const edge = this.edges.get(request.pathname.split("/").at(-1) ?? "");
      return edge === undefined
        ? refusal(404, "edge_not_found", "No such edge")
        : writeAnswers.edge(edge, 200);
    });
    server.copyAnswer("GET", /^\/items\/[^/]+\/edges$/, (request) => {
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
          .map((edge) => {
            const older = this.behind.get(edge.id);
            this.behind.delete(edge.id);
            return wireEdge(older ?? edge);
          }),
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
      if (after === undefined) return copyHeadRead(head);
      return copyLiveReplay(
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
      copyItemEvent(String(this.events.length + 2), kind, item, {
        tags: metadata?.tags ?? [],
      }),
    );
  }

  private log(kind: string, edge: WireEdgeOptions): void {
    this.events.push(
      edgeEvent(String(this.events.length + 2), kind, wireEdge(edge)),
    );
    this.history.push(heldEdges(this));
  }

  /** A moment later than every one before it, so an older edge reads older. */
  private stamp(): string {
    this.minted += 1;
    return new Date(Date.UTC(2026, 8, 18) + this.minted * 1000).toISOString();
  }
}

/**
 * The server's refusal of a move of an edge's end, where the end that stays
 * holds more than one of its type or both ends move; `undefined` where it
 * moves nothing or may move.
 */
export function moveRefusal(
  held: WireEdgeOptions,
  ends: { source_id: string; target_id: string },
): Answer | undefined {
  const movesSource = ends.source_id !== held.source_id;
  const movesTarget = ends.target_id !== held.target_id;
  if (!movesSource && !movesTarget) return undefined;
  const edgeType = held.edge_type ?? "references";
  if (movesSource && movesTarget) {
    return answers.edgeMoveRefused(
      "source_id",
      "An update moves one end of an edge at a time; delete it and create the edge wanted",
    );
  }
  const cardinality =
    SCRIPTED_EDGE_TYPES.find((type) => type.id === edgeType)?.cardinality ??
    "many-to-many";
  const keptHoldsOne = movesSource
    ? cardinality === "one-to-one" || cardinality === "one-to-many"
    : cardinality === "one-to-one" || cardinality === "many-to-one";
  if (keptHoldsOne) return undefined;
  return answers.edgeMoveRefused(
    movesSource ? "source_id" : "target_id",
    `Edge "${edgeType}" is ${cardinality}, so the end that stays can hold more than this edge and there is none to replace; create the edge wanted and delete this one`,
  );
}

/** What the folder sent to the items door, parsed. */
export function sentCreates(
  harness: FolderHarness,
): Array<Record<string, unknown>> {
  return harness.server.requests
    .filter(
      (request) => request.method === "POST" && request.pathname === "/items",
    )
    .map((request) => JSON.parse(request.body) as Record<string, unknown>);
}

/** The titles the folder's creates carried, in the order sent. */
export function sentTitles(harness: FolderHarness): string[] {
  return sentCreates(harness).map((sent) =>
    String((sent.properties as Record<string, unknown>).title),
  );
}

/** The item updates the folder sent, each with the id it went to. */
export function sentUpdates(
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
 *  writes a file makes (`folders/placement-create`). */
export function withoutPlacements(
  harness: FolderHarness,
  rows: QueuedWrite[],
): QueuedWrite[] {
  return rows.filter(
    (row) =>
      !(row.kind.endsWith("_edge") && row.target_id === harness.settings.id),
  );
}

/** The verdicts on writes of items, without the placements a push also
 *  sends (`folders/push-send-placement`). */
export function itemVerdicts(verdicts: DrainVerdict[]): DrainVerdict[] {
  return verdicts.filter((entry) => !entry.kind.endsWith("_edge"));
}

/** The frontmatter a file opens with, fences and all. */
export function frontOf(harness: FolderHarness, name: string): string {
  return /^---\n[\s\S]*?\n---\n/.exec(read(harness, name))?.[0] ?? "";
}

/** What follows a file's frontmatter. */
export function bodyOf(harness: FolderHarness, name: string): string {
  return read(harness, name).slice(frontOf(harness, name).length);
}

/** The edges the door holds, placements aside, as `source type target`. */
export function heldEdges(door: EdgeDoor): string[] {
  return [...door.edges.values()]
    .filter((edge) => edge.edge_type !== "in-folder")
    .map(
      (edge) =>
        `${edge.source_id} ${edge.edge_type ?? "references"} ${edge.target_id}`,
    )
    .sort();
}

/** The edge writes the folder sent, placements aside, in order. */
export function sentEdgeWrites(harness: FolderHarness): string[] {
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
    if (request.method === "PATCH" && request.pathname.startsWith("/edges/")) {
      const id = request.pathname.split("/").at(-1) ?? "";
      const body = JSON.parse(request.body) as {
        source_id?: string;
        target_id?: string;
      };
      if (body.source_id !== undefined) {
        return [`move ${id} source ${body.source_id}`];
      }
      if (body.target_id !== undefined) {
        return [`move ${id} target ${body.target_id}`];
      }
    }
    return [];
  });
}

/** Replaces a line of a file's text, failing where it is not there. */
export function edit(
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
