import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { v7 as uuidv7 } from "uuid";
import {
  CliDevice,
  CliFolder,
  newStore,
  type AddedFolder,
  type FolderSettings,
} from "../../device/cli-adapter.js";
import type { Answer, Responder } from "../../device/scripted-server.js";
import { ScriptedServer } from "../../device/scripted-server.js";
import {
  answers,
  edgeTypeCatalog,
  refusal,
  edgesPage,
  copyHeadRead,
  copyReplay,
  SCRIPTED_READ_VIEW,
  itemsPage,
  typeCatalog,
  wireEdge,
  wireItem,
  writeAnswers,
  type WireEdgeOptions,
  type WireItemOptions,
} from "../../device/marfa-answers.js";

/**
 * A device and the server it talks to, both under the fixture's control.
 *
 * The device is the `marfa` binary. There is no second implementation here
 * and there is not meant to be: a fixture that agreed with a reference device
 * would be two of this suite's own opinions agreeing with each other.
 */

export const KEY = "device-fixture-key";

export function requireBinary(): string {
  const binary = process.env.MARFA_DEVICE_BIN;
  if (binary === undefined || binary === "") {
    throw new Error(
      "MARFA_DEVICE_BIN is unset. Build the binary (`cargo build -p marfa-cli` under core/) and point this at it; the conformance job does both.",
    );
  }
  refuseIfStale(binary);
  return binary;
}

/**
 * Refuses a binary older than the source it was built from.
 *
 * **This suite tests an artifact, not a checkout.** Nothing in the local
 * chain rebuilds it, so a run after an edit exercises the previous build.
 * The false alarm that costs an hour is the mild direction; the dangerous
 * one is the false pass, where a change that breaks the device is measured
 * against a binary that predates it and reads as green.
 */
function refuseIfStale(binary: string): void {
  let built: number;
  try {
    built = statSync(binary).mtimeMs;
  } catch {
    throw new Error(
      `MARFA_DEVICE_BIN points at ${binary}, which does not exist. Build it with \`cargo build -p marfa-cli\` under core/.`,
    );
  }
  const core = resolve(
    fileURLToPath(new URL(".", import.meta.url)),
    "../../../../core",
  );
  // The sources the binary is compiled from, and no others. A binding beside
  // these crates, or a test under a crate's `tests/`, is not in the binary,
  // so counting it would refuse a binary that `cargo build -p marfa-cli` has
  // no reason to relink.
  const sources = ["marfa-core", "marfa-cli"]
    .map((crate) => join(core, crate, "src"))
    .filter((source) => existsSync(source));
  let newest = 0;
  let newestPath = "";
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "target" || entry.name === "node_modules") continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (
        entry.name.endsWith(".rs") ||
        entry.name === "schema.sql" ||
        entry.name === "builtin_catalog.json"
      ) {
        const at = statSync(full).mtimeMs;
        if (at > newest) {
          newest = at;
          newestPath = full;
        }
      }
    }
  };
  // With no source tree beside the suite there is nothing to be stale
  // against, and nothing is walked.
  for (const source of sources) walk(source);
  if (newest > built) {
    throw new Error(
      `the device binary is older than the source it is built from — ${newestPath} changed after ` +
        `${binary} was built, so this run would measure the previous build and report it as this one. ` +
        "Run `cargo build -p marfa-cli` under core/ and try again.",
    );
  }
}

export interface Harness {
  server: ScriptedServer;
  device: CliDevice;
  stop: () => Promise<void>;
}

export async function startHarness(label: string): Promise<Harness> {
  const server = await ScriptedServer.start();
  const device = new CliDevice({
    binary: requireBinary(),
    store: newStore(label),
    url: server.url,
    key: KEY,
  });
  return {
    server,
    device,
    /**
     * Stopping is also where a door nobody scripted is reported. An unscripted
     * door answers 501, a device reads that as one more refusal, and a fixture
     * then reads it as the refusal it was testing for; this is the one place
     * that difference is visible.
     */
    stop: async () => {
      const unscripted = [...server.unmatchedRequests];
      await server.stop();
      if (unscripted.length > 0) {
        throw new Error(
          `the device went to a door no answer was scripted for, and read the 501 as a refusal: ${unscripted.join(", ")}`,
        );
      }
    },
  };
}

/**
 * The script a plain hydration needs: a head cursor, the catalog, and one page
 * per declared type.
 *
 * Answers for a door are consumed in order and the last one repeats, so a
 * fixture writes the whole sequence before the device runs. Appending an
 * answer after the device has already been through a door queues it behind
 * the one that is still answering, which reads as the new answer being
 * ignored.
 * `rows` is keyed by type, and a type with no entry
 * answers an empty page rather than going unscripted, because an unscripted
 * door answers 501 and the device would report that instead of the thing
 * under test.
 */
export function scriptHydration(
  server: ScriptedServer,
  options: {
    head: string;
    instance?: () => string;
    rows?: Record<string, Array<{ item: WireItemOptions; tags?: string[] }>>;
    /** What `GET /edges` lists, by edge type; scripted only where named. */
    edges?: Record<string, WireEdgeOptions[]>;
    /** The catalog every read of `/types` answers, the scripted one unless named. */
    catalog?: Answer;
    /** What `GET /edge-types` answers, the shipped types unless named. */
    edgeTypes?: Responder;
    /** A folder's name lookup answered otherwise, where this answers. */
    lookup?: (text: string) => Answer | undefined;
    /** What `GET /keys/current` answers, a key reading and writing every
     *  type unless named. */
    key?: Responder[];
  },
): void {
  const copyInstance = (answer: Answer): Answer => {
    if (options.instance === undefined || answer.kind !== "sse") return answer;
    return {
      ...answer,
      frames: answer.frames.map((frame) =>
        frame.event === "stream_cursor" || frame.event === "stream_live"
          ? {
              ...frame,
              data: {
                ...(frame.data as Record<string, unknown>),
                instance_id: options.instance!(),
              },
            }
          : frame,
      ),
    };
  };
  const rows = options.rows ?? {};
  const edges = options.edges;
  if (edges !== undefined) {
    server.copyAnswer("GET", "/edges", (request) => {
      const type = request.query.get("edge_type") ?? "";
      return edgesPage(
        (edges[type] ?? []).map((edge) =>
          wireEdge({ ...edge, edge_type: type }),
        ),
      );
    });
  }
  server.copyAnswer(
    "GET",
    "/edge-types",
    options.edgeTypes ?? edgeTypeCatalog(),
  );
  scriptKey(server, ...(options.key ?? []));
  server.copyAnswer(
    "GET",
    "/events",
    (request) => {
      if (
        request.query.toString() !== "edges=all&copy=1" ||
        request.headers["last-event-id"] !== undefined ||
        request.headers["x-marfa-read-view"] !== undefined
      )
        return refusal(
          400,
          "validation_error",
          "invalid copy bootstrap request",
        );
      return copyInstance(copyHeadRead(options.head));
    },
    (request) => {
      const cursor = request.headers["last-event-id"];
      const fence = request.headers["x-marfa-read-view"];
      if (request.query.toString() !== "edges=all&copy=1")
        return refusal(400, "validation_error", "invalid copy stream query");
      if (cursor === undefined && fence === undefined)
        return copyInstance(copyHeadRead(options.head));
      if (
        cursor === undefined ||
        !/^(0|[1-9][0-9]*)$/.test(cursor) ||
        BigInt(cursor) > 9223372036854775807n ||
        fence !== SCRIPTED_READ_VIEW
      )
        return refusal(400, "validation_error", "invalid copy replay request");
      return copyInstance(copyReplay(options.head, []));
    },
  );
  server.copyAnswer("GET", "/types", options.catalog ?? typeCatalog());
  server.copyAnswer("GET", "/items", (request) => {
    const type = request.query.get("type");
    // No type is every type the key reads, which leaves `system.*` out.
    const forType =
      type === null
        ? Object.values(rows)
            .flat()
            .filter((row) => !(row.item.type ?? "").startsWith("system."))
        : (rows[type] ?? []);
    // The state parameter is honored rather than ignored, because a
    // scripted server more generous than the real one lets a device that
    // stopped asking for every state stay green while a real copy silently
    // holds only active rows (`device.md` 31). `any` is the only value
    // hydration sends, so anything else narrows the same way the server's
    // listing does.
    const asked = request.query.get("state") ?? "active";
    const inState =
      asked === "any"
        ? forType
        : forType.filter((row) => (row.item.state ?? "active") === asked);
    const filter = request.query.get("filter");
    if (filter === null) {
      return itemsPage(
        inState.map((row) => ({ item: wireItem(row.item), tags: row.tags })),
      );
    }
    // A pin that a read by id answers 404 asks the bin for the row this way.
    const byId = /^id eq "([^"]*)"$/.exec(filter);
    if (byId !== null) {
      return itemsPage(
        inState
          .filter((row) => row.item.id === byId[1])
          .map((row) => ({ item: wireItem(row.item), tags: row.tags })),
      );
    }
    const contains = containsFilter(filter);
    if ("kind" in contains) return contains;
    const standIn = options.lookup?.(contains.text);
    if (standIn !== undefined) return standIn;
    const visible = inState.filter((row) => {
      const value = wireItem(row.item).properties as Record<string, unknown>;
      const held = value[contains.field];
      return (
        typeof held === "string" &&
        asciiLower(held).includes(asciiLower(contains.text))
      );
    });
    return itemsPage(
      visible.map((row) => ({ item: wireItem(row.item), tags: row.tags })),
    );
  });
}

/**
 * What `GET /keys/current` answers, which a hydration reads to refuse a type
 * the key cannot read (`device.md` 6): a key reading and writing every type
 * unless answers are named. For a fixture that scripts a hydration's doors
 * itself.
 */
export function scriptKey(server: ScriptedServer, ...key: Responder[]): void {
  server.copyAnswer(
    "GET",
    "/keys/current",
    ...(key.length > 0
      ? key
      : [answers.currentKey("fixture-key", { "*": "write" })]),
  );
}

/** ASCII letters lowercased and nothing else, as the server's `contains`. */
function asciiLower(text: string): string {
  return text.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
}

/** A name lookup's filter read as the server's grammar reads it, where only
 *  `\"` escapes, so a string ending in a backslash never closes. */
function containsFilter(
  filter: string,
): { field: string; text: string } | Answer {
  const head = /^properties\.([A-Za-z0-9_]+) contains "/.exec(filter);
  if (head === null) {
    return refusal(400, "validation_error", `no scripted filter: ${filter}`);
  }
  let text = "";
  let at = head[0].length;
  while (at < filter.length && filter[at] !== '"') {
    if (filter[at] === "\\" && filter[at + 1] === '"') {
      text += '"';
      at += 2;
    } else {
      text += filter[at];
      at += 1;
    }
  }
  if (at >= filter.length) {
    return refusal(
      400,
      "validation_error",
      `Unterminated string starting at position ${String(head[0].length - 1)}`,
    );
  }
  return { field: head[1] ?? "", text };
}

/**
 * A harness whose device has hydrated, which every write fixture needs.
 *
 * A write refuses on a store that has never pulled a slice, so a fixture
 * asserting something about a write would otherwise be asserting the
 * hydration refusal. `rows` seeds the copy so an update has something to be
 * based on.
 */
export async function hydratedHarness(
  label: string,
  options: {
    head?: string;
    rows?: Record<string, Array<{ item: WireItemOptions; tags?: string[] }>>;
    types?: string[];
  } = {},
): Promise<Harness> {
  const harness = await startHarness(label);
  scriptHydration(harness.server, {
    head: options.head ?? "1",
    rows: options.rows,
  });
  const hydrated = await harness.device.hydrate(
    options.types ?? ["core.note"],
    "library",
  );
  if (!hydrated.ok) {
    await harness.stop();
    throw new Error(
      `the fixture could not hydrate the device it is about to write to: ${JSON.stringify(hydrated.refusal)}`,
    );
  }
  return harness;
}

/**
 * The door a write goes to, and the answers it gets, in order.
 *
 * A door is scripted only where the fixture names one. An unscripted door
 * answers 501, and a device reads that as one more refusal — which a fixture
 * asserting a refusal would then read as the refusal it was testing for, so
 * the harness collects the unmatched requests and throws them at `stop`.
 */
export interface ScriptedWrites {
  create?: Responder[];
  update?: Responder[];
  /** The certified single-item read used to reconcile a settled write. */
  read?: Responder[];
  /** The tag and metadata doors, which answer the same sidecar. */
  tags?: Responder[];
  extensions?: Responder[];
  edges?: Responder[];
}

export function scriptWrites(
  server: ScriptedServer,
  options: ScriptedWrites = {},
): void {
  if (options.create !== undefined)
    server.answer("POST", "/items", ...options.create);
  if (options.update !== undefined)
    server.answer("PATCH", /^\/items\/[^/]+$/, ...options.update);
  // A receipt cannot establish present read access (`device.md` 54), so
  // reconciliation after an accepted or refused write needs a certified read.
  if (options.read !== undefined)
    server.copyAnswer("GET", /^\/items\/[^/]+$/, ...options.read);
  if (options.tags !== undefined) {
    server.answer("POST", /^\/items\/[^/]+\/tags$/, ...options.tags);
    server.answer("DELETE", /^\/items\/[^/]+\/tags\/[^/]+$/, ...options.tags);
    // The metadata doors answer the same sidecar, so they are scripted with
    // the tag doors rather than needing a group of their own — and leaving
    // them out is how a drain carrying a metadata write met an unscripted
    // door and read the 501 as a refusal.
    server.answer("PUT", /^\/items\/[^/]+\/metadata$/, ...options.tags);
    server.answer("PATCH", /^\/items\/[^/]+\/metadata$/, ...options.tags);
  }
  if (options.extensions !== undefined) {
    const door = /^\/items\/[^/]+\/extensions\/[^/]+$/;
    server.answer("PUT", door, ...options.extensions);
    server.answer("DELETE", door, ...options.extensions);
  }
  if (options.edges !== undefined) {
    server.answer("POST", "/edges", ...options.edges);
    server.answer("PATCH", /^\/edges\/[^/]+$/, ...options.edges);
    server.answer("DELETE", /^\/edges\/[^/]+$/, ...options.edges);
  }
}

/**
 * A folder, its directory and the server it talks to.
 *
 * The directory is real and temporary: a folder's rules are about paths,
 * inodes and birth times, and none of them can be asserted against anything
 * but a filesystem.
 */
export interface FolderHarness {
  server: ScriptedServer;
  folder: CliFolder;
  dir: string;
  /** The `system.folder` this folder follows, as the server holds it: a
   *  fixture changes it to stand for another device changing the settings. */
  settings: FolderRow;
  /** What the hydration served, so a scripted write door knows those rows. */
  rows: Record<string, Array<{ item: WireItemOptions; tags?: string[] }>>;
  /** The folder registry of the machine it is on (`folders.md` 41). */
  registry: string;
  /** What the add reported, including what the first sync will do. */
  added: AddedFolder;
  stop: () => Promise<void>;
}

/** A `system.folder` the scripted server holds. */
export interface FolderRow {
  id: string;
  version: number;
  settings: FolderSettings;
}

/** The row a `system.folder` read answers, as the server holds it. */
export function folderItem(row: FolderRow): Record<string, unknown> {
  return wireItem({
    id: row.id,
    type: "system.folder",
    version: row.version,
    properties: { title: "folder", ...row.settings },
  });
}

/**
 * Serves a `system.folder` by id, as its current settings. Scripted before
 * any fixture's own read door, so the first-matching route is this one.
 */
export function scriptFolderRow(
  server: ScriptedServer,
  settings: FolderSettings,
): FolderRow {
  const row: FolderRow = { id: uuidv7(), version: 1, settings };
  server.copyAnswer("GET", `/items/${row.id}`, () =>
    answers.updated(folderItem(row)),
  );
  return row;
}

/**
 * A folder on a scripted server, added and hydrated.
 *
 * `rows` seeds what the hydration answers, so a fixture about an item
 * becoming a file has an item to start from.
 */
export async function folderHarness(
  label: string,
  options: {
    /** The settings its `system.folder` holds; a folder of notes unless named. */
    settings?: FolderSettings;
    /** What `GET /edges` lists, by edge type, for a search holding one whole. */
    edges?: Record<string, WireEdgeOptions[]>;
    /**
     * Another harness's server, for two folders on one server, and the key
     * this folder's machine holds.
     */
    sharing?: { server: ScriptedServer; key: string };
    /** A `system.folder` the shared server already holds, for a second
     *  machine bound to the same folder. */
    folder?: FolderRow;
    head?: string;
    rows?: Record<string, Array<{ item: WireItemOptions; tags?: string[] }>>;
    /** What `GET /keys/current` answers, a key placing files unless named. */
    key?: Responder[];
    /** Skip the hydration, for the cases that are about a folder before one. */
    hydrate?: boolean;
    /**
     * Confirm the first sync at the add, as a script does with `--yes`. False
     * leaves it waiting, for the cases about the first sync itself.
     */
    confirm?: boolean;
    /** Files already in the directory when the folder is added, by name. */
    files?: Record<string, string>;
    /**
     * Another folder's registry, for two folders on one machine. Unnamed, a
     * folder has a registry of its own, as a machine of its own would.
     */
    registry?: string;
    /** A home whose own registry the binary finds, in place of either. */
    home?: string;
    /** The type catalog the server serves, the scripted one unless named. */
    catalog?: Answer;
    /** What `GET /edge-types` answers, the shipped types unless named. */
    edgeTypes?: Responder;
    /** A name lookup answered otherwise, where this answers. */
    lookup?: (text: string) => Answer | undefined;
    /**
     * Event-stream answers for the catch-ups after the hydration.
     *
     * Scripted here rather than by the fixture, because a door with one
     * answer left repeats it: an answer appended after the hydration has
     * been through the stream queues behind the head read that is still
     * answering, and the catch-up reads that instead — which looks exactly
     * like the device ignoring the events.
     */
    events?: Responder[];
  } = {},
): Promise<FolderHarness> {
  const server = options.sharing?.server ?? (await ScriptedServer.start());
  const root = mkdtempSync(join(tmpdir(), `marfa-folder-${label}-`));
  const dir = join(root, "notes");
  const registry = options.registry ?? join(root, "registry", "folders.json");
  const folder = new CliFolder(dir, {
    binary: requireBinary(),
    url: server.url,
    key: options.sharing?.key ?? KEY,
    registry,
    home: options.home,
  });
  const settings =
    options.folder ??
    scriptFolderRow(
      server,
      options.settings ?? { search: { types: ["core.note"] } },
    );
  const stop = async (): Promise<void> => {
    const unscripted = [...server.unmatchedRequests];
    // A shared server is its owner's to stop.
    if (options.sharing === undefined) await server.stop();
    if (unscripted.length > 0) {
      throw new Error(
        `the folder went to a door no answer was scripted for, and read the 501 as a refusal: ${unscripted.join(", ")}`,
      );
    }
  };
  // Before the add, which reads the catalog. A shared server's doors are
  // its owner's; a second folder hydrates from what the owner scripted, and
  // sees the rows the owner's fixture adds.
  if (options.sharing === undefined) {
    scriptHydration(server, {
      head: options.head ?? "1",
      rows: options.rows,
      // A folder holds whole every edge type a file may write at its target.
      edges: options.edges ?? {},
      catalog: options.catalog,
      edgeTypes: options.edgeTypes,
      lookup: options.lookup,
      key: options.key,
    });
  }
  for (const [name, text] of Object.entries(options.files ?? {})) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  const added = await folder.add(settings.id, { confirm: options.confirm });
  if (!added.ok) {
    await stop();
    throw new Error(
      `the fixture could not make a folder: ${JSON.stringify(added.refusal)}`,
    );
  }
  if (options.events !== undefined) {
    server.copyAnswer("GET", "/events", ...options.events);
  }
  if (options.hydrate !== false) {
    const hydrated = await folder.hydrate();
    if (!hydrated.ok) {
      await stop();
      throw new Error(
        `the fixture could not hydrate the folder: ${JSON.stringify(hydrated.refusal)}`,
      );
    }
  }
  return {
    server,
    folder,
    dir,
    settings,
    rows: options.rows ?? {},
    registry,
    added: added.value,
    stop,
  };
}

/** The name a blob's bytes go by: `sha256:` and the hex of their digest. */
export function hashOf(bytes: Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/**
 * A blob the server holds: its link door answers a link on this server, and
 * the link serves `served`, which is the blob's own bytes unless a fixture
 * wants the link to lie. Answers the hash.
 */
export function scriptBlob(
  server: ScriptedServer,
  bytes: Buffer,
  served: Buffer = bytes,
): string {
  const hash = hashOf(bytes);
  const hex = hash.slice("sha256:".length);
  server.copyAnswer(
    "GET",
    `/blobs/${hash}/url`,
    writeAnswers.link(`${server.url}/links/${hex}`),
  );
  server.copyAnswer("GET", `/links/${hex}`, {
    kind: "bytes",
    status: 200,
    body: served,
  });
  return hash;
}

/** A file on disk, for a fixture that uploads or attaches one. */
export function fileOf(name: string, contents: string | Buffer): string {
  const path = join(mkdtempSync(join(tmpdir(), "marfa-file-")), name);
  writeFileSync(path, contents);
  return path;
}

/** `POST /blobs` answered as the server answers it, naming what it was sent. */
export function acceptUploads(server: ScriptedServer): void {
  server.answer("POST", "/blobs", (request) =>
    writeAnswers.uploaded(
      hashOf(request.raw),
      request.headers["content-type"] ?? "",
      request.raw.length,
    ),
  );
}
