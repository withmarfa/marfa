import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CliDevice,
  CliFolder,
  newStore,
  type FolderSlice,
} from "../../device/cli-adapter.js";
import type { Responder } from "../../device/scripted-server.js";
import { ScriptedServer } from "../../device/scripted-server.js";
import {
  headRead,
  itemsPage,
  typeCatalog,
  wireItem,
  writeAnswers,
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
  const root = resolve(
    fileURLToPath(new URL(".", import.meta.url)),
    "../../../../core",
  );
  let newest = 0;
  let newestPath = "";
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "target" || entry.name === "node_modules") continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith(".rs") || entry.name === "schema.sql") {
        const at = statSync(full).mtimeMs;
        if (at > newest) {
          newest = at;
          newestPath = full;
        }
      }
    }
  };
  try {
    walk(root);
  } catch {
    return; // No source tree beside the suite: nothing to be stale against.
  }
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
    rows?: Record<string, Array<{ item: WireItemOptions; tags?: string[] }>>;
  },
): void {
  const rows = options.rows ?? {};
  server.answer("GET", "/events", headRead(options.head));
  server.answer("GET", "/types", typeCatalog());
  server.answer("GET", "/items", (request) => {
    const type = request.query.get("type") ?? "";
    const forType = rows[type] ?? [];
    // The state parameter is honored rather than ignored, because a
    // scripted server more generous than the real one lets a device that
    // stopped asking for every state stay green while a real copy silently
    // holds only active rows (`device.md` 31). `any` is the only value
    // hydration sends, so anything else narrows the same way the server's
    // listing does.
    const asked = request.query.get("state") ?? "active";
    const visible =
      asked === "any"
        ? forType
        : forType.filter((row) => (row.item.state ?? "active") === asked);
    return itemsPage(
      visible.map((row) => ({ item: wireItem(row.item), tags: row.tags })),
    );
  });
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
  /** The single-item read a refused write is reconciled against. */
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
  // A refused write is read back from the server
  // (`queue-and-verdicts.md` 12), so a fixture that scripts a refusal
  // scripts the read too or the device meets an unscripted door on its way
  // to reconciling.
  if (options.read !== undefined)
    server.answer("GET", /^\/items\/[^/]+$/, ...options.read);
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
  stop: () => Promise<void>;
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
    slice?: FolderSlice;
    head?: string;
    rows?: Record<string, Array<{ item: WireItemOptions; tags?: string[] }>>;
    /** Skip the hydration, for the cases that are about a folder before one. */
    hydrate?: boolean;
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
  const server = await ScriptedServer.start();
  const dir = join(
    mkdtempSync(join(tmpdir(), `marfa-folder-${label}-`)),
    "notes",
  );
  const folder = new CliFolder(dir, {
    binary: requireBinary(),
    url: server.url,
    key: KEY,
  });
  const slice = options.slice ?? {
    types: ["core.note"],
    defaultType: "core.note",
  };
  const stop = async (): Promise<void> => {
    const unscripted = [...server.unmatchedRequests];
    await server.stop();
    if (unscripted.length > 0) {
      throw new Error(
        `the folder went to a door no answer was scripted for, and read the 501 as a refusal: ${unscripted.join(", ")}`,
      );
    }
  };
  const added = await folder.add(slice);
  if (!added.ok) {
    await stop();
    throw new Error(
      `the fixture could not make a folder: ${JSON.stringify(added.refusal)}`,
    );
  }
  scriptHydration(server, { head: options.head ?? "1", rows: options.rows });
  if (options.events !== undefined) {
    server.answer("GET", "/events", ...options.events);
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
  return { server, folder, dir, stop };
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
  server.answer(
    "GET",
    `/blobs/${hash}/url`,
    writeAnswers.link(`${server.url}/links/${hex}`),
  );
  server.answer("GET", `/links/${hex}`, {
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
