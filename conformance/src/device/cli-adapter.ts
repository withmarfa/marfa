import { execFile, spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { keychainEnv } from "../utils/keychain.js";
import {
  type CatchUpReport,
  type Change,
  type DeviceUnderTest,
  type Draft,
  type DrainReport,
  type Edge,
  type EdgeDraft,
  type EdgeType,
  type Edit,
  type FollowReport,
  type HydrateReport,
  type Item,
  type ItemType,
  type ListFilters,
  type PinReport,
  type Outcome,
  type QueuedWrite,
  type Refusal,
  type SearchFilters,
  type SearchHit,
  type Status,
  type Tier,
} from "./protocol.js";

const run = promisify(execFile);

/**
 * The `marfa` binary, driven as the device under test.
 *
 * There is one device implementation and it is the binary; nothing here is a
 * second engine. The adapter's whole job is translation: an operation becomes
 * a command, stdout becomes an answer, and a non-zero exit becomes a refusal.
 */

/**
 * Under `--json` the binary reports a refusal as one JSON object on stderr,
 * `{"error":{"code":...},"exit":N}`, and the code is what the adapter reads.
 * A command line the binary does not offer is refused that way too, with the
 * code `usage`: the device refusing an operation rather than the core
 * refusing one it does. Without `--json` that refusal is the usage text and
 * exit 2, read here as the same `usage`.
 */
function classify(stderr: string, exitCode: number | null): Refusal {
  const raw = stderr.trim();
  if (exitCode === 2 && !raw.startsWith("{")) return { code: "usage", raw };
  let envelope: { error?: { code?: unknown } };
  try {
    envelope = JSON.parse(raw) as { error?: { code?: unknown } };
  } catch {
    return { code: "unclassified", raw };
  }
  const code = envelope.error?.code;
  return typeof code === "string"
    ? { code, raw }
    : { code: "unclassified", raw };
}

/** A device command left running, for the one-writer rule. */
export interface HeldCommand {
  readonly stderr: string;
  /** What it has printed so far, for a command that reports as it runs. */
  readonly stdout: string;
  running: () => boolean;
  /** Its exit code once it has exited, and null before. */
  exitCode: () => number | null;
  /** Resolves once it has exited, however it exited. */
  exited: () => Promise<void>;
  /** What Ctrl-C at a terminal sends it. */
  interrupt: () => void;
  /** Closes the pipe it prints to, as a reader that went away would. */
  closeStdout: () => void;
  stop: () => Promise<void>;
}

export interface CliDeviceOptions {
  /** The built binary. The conformance job exports it; a local run may point at a debug build. */
  binary: string;
  store: string;
  url?: string;
  key?: string;
  /** Open the store to read only (`device.md` 41). */
  reader?: boolean;
  /**
   * The folder registry the binary reads, standing in for one machine's
   * (`folders.md` 41); the run's own where unnamed.
   */
  registry?: string;
  /**
   * A home for the binary in place of the run's, with no registry named, so
   * it finds the machine's own registry under it.
   */
  home?: string;
}

export function newStore(label: string): string {
  return join(
    mkdtempSync(join(tmpdir(), `marfa-device-${label}-`)),
    "core.sqlite",
  );
}

export class CliDevice implements DeviceUnderTest {
  constructor(private readonly options: CliDeviceOptions) {}

  get store(): string {
    return this.options.store;
  }

  reopen(
    overrides: {
      url?: string;
      key?: string;
      reader?: boolean;
      store?: string;
    } = {},
  ): CliDevice {
    return new CliDevice({ ...this.options, ...overrides });
  }

  /**
   * Holds the event stream open for `seconds` (`device.md` 40): a line per
   * event that changed the copy, then the report.
   */
  async follow(
    seconds: number,
  ): Promise<Outcome<{ changes: Change[]; report: FollowReport }>> {
    const lines = await this.lines([
      "follow",
      "--for",
      String(seconds),
      ...this.server(),
    ]);
    if (!lines.ok) return lines;
    const report = lines.value.at(-1) as FollowReport | undefined;
    if (report === undefined) {
      throw new Error("the follow printed nothing, not even its report");
    }
    return {
      ok: true,
      value: { changes: lines.value.slice(0, -1) as Change[], report },
    };
  }

  /**
   * The same follow, left running, so a fixture can read what it prints
   * while the stream is still held. Without `seconds` it runs until it is
   * interrupted.
   */
  holdFollow(seconds?: number): HeldCommand {
    return this.hold(
      seconds === undefined ? ["follow"] : ["follow", "--for", String(seconds)],
    );
  }

  async hydrate(
    types: string[],
    tier: Tier,
    options: { edgeTypes?: string[] } = {},
  ): Promise<Outcome<HydrateReport>> {
    return this.json<HydrateReport>([
      "hydrate",
      ...this.server(),
      "--types",
      types.join(","),
      "--tier",
      tier,
      ...(options.edgeTypes ?? []).flatMap((type) => ["--edge-type", type]),
    ]);
  }

  async pin(id: string): Promise<Outcome<PinReport>> {
    return this.json<PinReport>(["pin", ...this.server(), id]);
  }

  async unpin(id: string): Promise<Outcome<PinReport>> {
    return this.json<PinReport>(["unpin", id]);
  }

  async catchUp(): Promise<Outcome<CatchUpReport>> {
    return this.json<CatchUpReport>(["catch-up", ...this.server()]);
  }

  async list(filters: ListFilters = {}): Promise<Outcome<Item[]>> {
    const args = ["items", "list"];
    if (filters.type !== undefined) args.push("--type", filters.type);
    if (filters.state !== undefined) args.push("--state", filters.state);
    if (filters.allStates === true) args.push("--all-states");
    if (filters.occurredAfter !== undefined)
      args.push("--occurred-after", filters.occurredAfter);
    if (filters.occurredBefore !== undefined)
      args.push("--occurred-before", filters.occurredBefore);
    if (filters.tier !== undefined) args.push("--tier", filters.tier);
    for (const tag of filters.tags ?? []) args.push("--tag", tag);
    if (filters.limit !== undefined)
      args.push("--limit", String(filters.limit));
    if (filters.filter !== undefined) args.push("--filter", filters.filter);
    if (filters.beneath !== undefined) args.push("--beneath", filters.beneath);
    return this.json<Item[]>(args);
  }

  async get(id: string): Promise<Outcome<Item>> {
    return this.json<Item>(["items", "get", id]);
  }

  /**
   * The thumbnail an item carries (`device.md` 29), its bytes written to
   * `out`; `thumbnail` is null for an item that carries none.
   */
  async thumbnail(
    id: string,
    out: string,
  ): Promise<
    Outcome<{
      id: string;
      thumbnail: {
        mime_type: string;
        size_bytes: number;
        path: string | null;
      } | null;
    }>
  > {
    return this.json(["items", "thumbnail", id, "--out", out]);
  }

  async search(
    query: string,
    filters: SearchFilters = {},
    limit?: number,
  ): Promise<Outcome<SearchHit[]>> {
    const args = ["search", query];
    if (filters.state !== undefined) args.push("--state", filters.state);
    if (filters.allStates === true) args.push("--all-states");
    if (filters.type !== undefined) args.push("--type", filters.type);
    for (const tag of filters.tags ?? []) args.push("--tag", tag);
    if (filters.filter !== undefined) args.push("--filter", filters.filter);
    if (filters.beneath !== undefined) args.push("--beneath", filters.beneath);
    if (limit !== undefined) args.push("--limit", String(limit));
    return this.json<SearchHit[]>(args);
  }

  async queue(): Promise<Outcome<QueuedWrite[]>> {
    return this.json<QueuedWrite[]>(["queue"]);
  }

  async create(draft: Draft): Promise<Outcome<QueuedWrite>> {
    const args = [
      "items",
      "create",
      "--type",
      draft.type,
      "--properties",
      JSON.stringify(draft.properties ?? {}),
    ];
    for (const tag of draft.tags ?? []) args.push("--tag", tag);
    if (draft.tier !== undefined) args.push("--tier", draft.tier);
    if (draft.source !== undefined) args.push("--source", draft.source);
    if (draft.sourceId !== undefined) args.push("--source-id", draft.sourceId);
    if (draft.occurredAt !== undefined)
      args.push("--occurred-at", draft.occurredAt);
    if (draft.id !== undefined) args.push("--id", draft.id);
    if (draft.version !== undefined)
      args.push("--version", String(draft.version));
    return this.json<QueuedWrite>(args);
  }

  async update(id: string, edit: Edit): Promise<Outcome<QueuedWrite>> {
    const args = [
      "items",
      "update",
      id,
      "--properties",
      JSON.stringify(edit.properties),
    ];
    // Absent rather than sent empty, so a fixture asserting that an update
    // with no version is refused drives the same command a caller would.
    if (edit.version !== undefined)
      args.push("--version", String(edit.version));
    if (edit.asRead === true) args.push("--as-read");
    if (edit.type !== undefined) args.push("--type", edit.type);
    if (edit.tier !== undefined) args.push("--tier", edit.tier);
    if (edit.replace === true) args.push("--replace");
    return this.json<QueuedWrite>(args);
  }

  async drain(): Promise<Outcome<DrainReport>> {
    return this.json<DrainReport>(["drain", ...this.server()]);
  }

  async release(
    target: { id: string } | { reason: string },
  ): Promise<Outcome<number>> {
    const args =
      "id" in target
        ? ["release", target.id]
        : ["release", "--reason", target.reason];
    return this.json<number>(args);
  }

  async withdraw(id: string): Promise<Outcome<boolean>> {
    return this.json<boolean>(["withdraw", id, ...this.server()]);
  }

  async forget(): Promise<Outcome<number>> {
    return this.json<number>(["forget"]);
  }

  async discard(id: string): Promise<Outcome<boolean>> {
    return this.json<boolean>(["discard", id]);
  }

  async status(): Promise<Outcome<Status>> {
    return this.json<Status>(["status"]);
  }

  async itemTypes(): Promise<Outcome<ItemType[]>> {
    return this.json<ItemType[]>(["types", "list"]);
  }

  async itemType(id: string): Promise<Outcome<ItemType>> {
    return this.json<ItemType>(["types", "get", id]);
  }

  async edgeTypes(): Promise<Outcome<EdgeType[]>> {
    return this.json<EdgeType[]>(["edge-types", "list"]);
  }

  async edgeType(id: string): Promise<Outcome<EdgeType>> {
    return this.json<EdgeType>(["edge-types", "get", id]);
  }

  /**
   * A device command as a person at a terminal runs it, without `--json`,
   * for the lines the binary prints for a person rather than the document
   * it prints for a program.
   */
  async text(args: string[]): Promise<Outcome<string>> {
    return this.invokeText([
      "device",
      "--db",
      this.options.store,
      ...args,
      ...this.server(),
    ]);
  }

  /** A command at the binary's root, without `--json`. */
  async rootText(args: string[]): Promise<Outcome<string>> {
    return this.invokeText([...args, ...this.server()]);
  }

  /** An operation the binary offers no command for at all, for the refusal statements. */
  async attempt(args: string[]): Promise<Outcome<unknown>> {
    return this.json<unknown>(args);
  }

  /**
   * A command at the binary's root rather than under `device`: a folder's,
   * which names its directory and carries its own store.
   */
  async root<T>(args: string[]): Promise<Outcome<T>> {
    return this.invoke<T>(["--json", ...args]);
  }

  /**
   * Starts a command and leaves it running, for the rules that are about two
   * processes at once.
   *
   * One store has one writer, and a writer holds its claim for as long as the
   * process lives. Every other operation here is one command that opens the
   * store, does its work and exits, so two of them never overlap and both are
   * legitimately the writer. Observing the rule needs a command still running
   * while another starts, which is what this is for.
   *
   * The caller stops it. A held process that outlived its fixture would hold
   * the store for every case after it, and they would fail as the rule rather
   * than as the leak.
   */
  hold(args: string[], at: "device" | "root" | "text" = "device"): HeldCommand {
    const child = spawn(
      this.options.binary,
      [
        ...(at === "device" ? this.prefix() : at === "root" ? ["--json"] : []),
        ...args,
        ...this.server(),
      ],
      {
        env: this.env(),
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stderr = "";
    let stdout = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    const exited = new Promise<void>((resolve) => {
      child.once("close", () => {
        resolve();
      });
    });
    return {
      get stderr() {
        return stderr;
      },
      get stdout() {
        return stdout;
      },
      running: () => child.exitCode === null && !child.killed,
      exitCode: () => child.exitCode,
      exited: () => exited,
      interrupt: () => {
        child.kill("SIGINT");
      },
      closeStdout: () => {
        child.stdout.destroy();
      },
      stop: async () => {
        if (child.exitCode === null) child.kill("SIGKILL");
        await exited;
      },
    };
  }

  async deleteItem(id: string): Promise<Outcome<QueuedWrite>> {
    return this.json<QueuedWrite>(["items", "delete", id]);
  }

  async restoreItem(id: string): Promise<Outcome<QueuedWrite>> {
    return this.json<QueuedWrite>(["items", "restore", id]);
  }

  async transitionItem(
    id: string,
    state: string,
  ): Promise<Outcome<QueuedWrite>> {
    return this.json<QueuedWrite>([
      "items",
      "transition",
      id,
      "--state",
      state,
    ]);
  }

  async createEdge(edge: EdgeDraft): Promise<Outcome<QueuedWrite>> {
    const args = [
      "edges",
      "create",
      "--source",
      edge.source,
      "--target",
      edge.target,
      "--type",
      edge.type,
      "--properties",
      JSON.stringify(edge.properties ?? {}),
    ];
    if (edge.id !== undefined) args.push("--id", edge.id);
    return this.json<QueuedWrite>(args);
  }

  async updateEdge(
    id: string,
    edit: {
      properties: Record<string, unknown>;
      version?: number;
      source_id?: string;
      target_id?: string;
    },
  ): Promise<Outcome<QueuedWrite>> {
    const args = [
      "edges",
      "update",
      id,
      "--properties",
      JSON.stringify(edit.properties),
    ];
    if (edit.version !== undefined)
      args.push("--version", String(edit.version));
    if (edit.source_id !== undefined) args.push("--source", edit.source_id);
    if (edit.target_id !== undefined) args.push("--target", edit.target_id);
    return this.json<QueuedWrite>(args);
  }

  async deleteEdge(id: string): Promise<Outcome<QueuedWrite>> {
    return this.json<QueuedWrite>(["edges", "delete", id]);
  }

  async edgesFrom(item: string): Promise<Outcome<Edge[]>> {
    return this.json<Edge[]>(["edges", "list", item]);
  }

  async edgesTo(item: string): Promise<Outcome<Edge[]>> {
    return this.json<Edge[]>(["edges", "to", item]);
  }

  async addTag(item: string, tag: string): Promise<Outcome<QueuedWrite>> {
    return this.json<QueuedWrite>(["tags", "add", item, tag]);
  }

  async removeTag(item: string, tag: string): Promise<Outcome<QueuedWrite>> {
    return this.json<QueuedWrite>(["tags", "remove", item, tag]);
  }

  async writeMetadata(
    item: string,
    tags: string[],
    mode: "replace" | "merge",
  ): Promise<Outcome<QueuedWrite>> {
    const args = ["metadata", mode, item];
    for (const tag of tags) args.push("--tag", tag);
    return this.json<QueuedWrite>(args);
  }

  async writeExtension(
    item: string,
    namespace: string,
    body: Record<string, unknown>,
  ): Promise<Outcome<QueuedWrite>> {
    return this.json<QueuedWrite>([
      "extensions",
      "write",
      item,
      namespace,
      "--body",
      JSON.stringify(body),
    ]);
  }

  async deleteExtension(
    item: string,
    namespace: string,
  ): Promise<Outcome<QueuedWrite>> {
    return this.json<QueuedWrite>(["extensions", "delete", item, namespace]);
  }

  async putBlob(
    path: string,
    mimeType?: string,
  ): Promise<Outcome<QueuedWrite>> {
    const args = ["blobs", "put", path];
    if (mimeType !== undefined) args.push("--mime-type", mimeType);
    return this.json<QueuedWrite>(args);
  }

  async blob(hash: string): Promise<Outcome<{ hash: string; path: string }>> {
    return this.json<{ hash: string; path: string }>([
      "blobs",
      "get",
      hash,
      ...this.server(),
    ]);
  }

  async attach(
    item: string,
    path: string,
    options: {
      mimeType?: string;
      title?: string;
      type?: string;
      tier?: Tier;
    } = {},
  ): Promise<Outcome<QueuedWrite[]>> {
    const args = ["items", "attach", item, path];
    if (options.tier !== undefined) args.push("--tier", options.tier);
    if (options.mimeType !== undefined)
      args.push("--mime-type", options.mimeType);
    if (options.title !== undefined) args.push("--title", options.title);
    if (options.type !== undefined) args.push("--type", options.type);
    return this.json<QueuedWrite[]>(args);
  }

  async addFile(
    path: string,
    options: {
      mimeType?: string;
      title?: string;
      type?: string;
      tier?: Tier;
      tags?: string[];
    } = {},
  ): Promise<Outcome<QueuedWrite[]>> {
    const args = ["items", "add", path];
    if (options.tier !== undefined) args.push("--tier", options.tier);
    if (options.mimeType !== undefined)
      args.push("--mime-type", options.mimeType);
    if (options.title !== undefined) args.push("--title", options.title);
    if (options.type !== undefined) args.push("--type", options.type);
    for (const tag of options.tags ?? []) args.push("--tag", tag);
    return this.json<QueuedWrite[]>(args);
  }

  private server(): string[] {
    const args: string[] = [];
    if (this.options.url !== undefined) args.push("--url", this.options.url);
    if (this.options.key !== undefined) args.push("--key", this.options.key);
    return args;
  }

  /** Every device operation is a `device` command on one store, answered as JSON. */
  private prefix(): string[] {
    return [
      "--json",
      "device",
      "--db",
      this.options.store,
      ...(this.options.reader === true ? ["--reader"] : []),
    ];
  }

  /** What the binary runs under: the run's keychain, and the registry this
   *  device names, where it names one. */
  private env(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env, ...keychainEnv() };
    if (this.options.home !== undefined) {
      env.HOME = this.options.home;
      delete env.MARFA_FOLDER_REGISTRY;
      delete env.XDG_DATA_HOME;
    } else if (this.options.registry !== undefined) {
      env.MARFA_FOLDER_REGISTRY = this.options.registry;
    }
    return env;
  }

  /** A command that prints one JSON value per line as it runs. */
  private async lines(args: string[]): Promise<Outcome<unknown[]>> {
    const outcome = await this.invokeText([...this.prefix(), ...args]);
    if (!outcome.ok) return outcome;
    try {
      return {
        ok: true,
        value: outcome.value
          .split("\n")
          .filter((line) => line.trim() !== "")
          .map((line) => JSON.parse(line) as unknown),
      };
    } catch {
      throw new Error(
        `the device printed a line that is not JSON: ${outcome.value.slice(0, 200)}`,
      );
    }
  }

  /**
   * A refusal is a non-zero exit with something on stderr, and nothing else.
   *
   * Everything else the spawn can do — a binary that is not there, a hang, a
   * clean exit printing something that is not JSON — throws. Reporting one of
   * those as a refusal would make every fixture whose whole assertion is that
   * the device refused pass against a device that is simply broken, which is
   * the one way this suite could be green about nothing.
   */
  private async json<T>(args: string[]): Promise<Outcome<T>> {
    return this.invoke<T>([...this.prefix(), ...args]);
  }

  private async invoke<T>(full: string[]): Promise<Outcome<T>> {
    const outcome = await this.invokeText(full);
    if (!outcome.ok) return outcome;
    const text = outcome.value.trim();
    if (text === "") return { ok: true, value: null as T };
    try {
      return { ok: true, value: JSON.parse(text) as T };
    } catch {
      throw new Error(
        `the device exited cleanly and printed something that is not JSON: ${text.slice(0, 200)}`,
      );
    }
  }

  private async invokeText(full: string[]): Promise<Outcome<string>> {
    let stdout: string;
    try {
      // A device that hangs is a failing device, and the runner owns the
      // deadline for everything else; this bound stops one hung spawn from
      // taking the file's whole budget with nothing naming it.
      ({ stdout } = await run(this.options.binary, full, {
        env: this.env(),
        timeout: 60_000,
        maxBuffer: 32 * 1024 * 1024,
      }));
    } catch (error) {
      const failure = error as {
        stderr?: string;
        code?: number | string;
        killed?: boolean;
        message?: string;
      };
      if (failure.killed === true) {
        throw new Error(
          `the device did not answer \`${full.join(" ")}\` within its bound`,
        );
      }
      if (typeof failure.code !== "number") {
        throw new Error(
          `the device could not be run: ${failure.message ?? String(failure.code)}`,
        );
      }
      if (failure.stderr === undefined || failure.stderr.trim() === "") {
        throw new Error(
          `the device exited ${String(failure.code)} saying nothing, so there is no refusal to read`,
        );
      }
      return { ok: false, refusal: classify(failure.stderr, failure.code) };
    }
    return { ok: true, value: stdout };
  }
}

/** A `system.folder`'s settings, as the folder door takes them. */
export interface FolderSettings {
  title?: string;
  search?: {
    types?: string[];
    tier?: Tier;
    state?: Array<"active" | "archived">;
    filter?: string;
    beneath?: string;
  };
  defaults?: {
    type?: string;
    tier?: Tier;
    properties?: Record<string, unknown>;
    tags?: string[];
    edges?: Record<string, string[]>;
  };
  include?: string[];
  ignore?: string[];
  first_placement?: Record<string, string>;
  removal_threshold?: { files?: number; fraction?: number };
}

export interface ScanReport {
  created: number;
  updated: number;
  renamed: number;
  unchanged: number;
  missing: number;
  deleted: number;
  /** The paths of those, each found in no folder on the machine
   *  (`folders.md` 43). */
  trashed: string[];
  /** Journaled files held, since the other folders could not all be read
   *  (`folders.md` 43). */
  unsure: Array<{ path: string; reason: string }>;
  /** Why the registry could not be read, where it could not. */
  registry: string | null;
  /** Journaled files found in another folder on the machine, so nothing was
   *  trashed (`folders.md` 43). */
  moved_away: number;
  skipped: number;
  /** Files bound to a row the copy lost, queued again because they changed
   *  or moved (`folders.md` 38). Counted in `created` too. */
  requeued: number;
  /** Files bound to a row the copy lost and unchanged since, so nothing was
   *  sent (`folders.md` 38). */
  lost: number;
  /** Files this scan read and holds rather than sends (`folders.md` 9, 10,
   *  11). */
  flagged: FlaggedFile[];
  /** Embeds in the files this scan read that name no file it sends
   *  (`folders.md` 12), each flagged `embed`. */
  embeds: FlaggedFile[];
  /** Bound files the walk did not reach, held rather than journaled
   *  (`folders.md` 25, 26). */
  unreached: number;
  /** Directories the walk did not enter, each flagged `package` or
   *  `unreadable` (`folders.md` 26), or `gone` where one went away while
   *  the walk read it (`folders.md` 22). */
  directories: FlaggedFile[];
  /** Files the built-in secrets list refuses (`folders.md` 25). */
  secrets: string[];
  /** Deletes of files gone from the disk that wait, a large removal
   *  (`folders.md` 46). */
  paused: number;
  /** Texts near the server's limit, each flagged `size` (`folders.md` 47). */
  warnings: FlaggedFile[];
  /** Why the scan read nothing, where the folder's directory is gone
   *  (`folders.md` 22). */
  root_gone: string | null;
}

/** Where every file stands (`folders.md` 48). */
export interface StatusReport {
  files: Array<{
    path: string;
    item_id?: string;
    status:
      "in_step" | "waiting" | "held" | "unmatched" | "unreached" | "outside";
    waits?: string[];
    flag?: string;
    reason?: string;
    warning?: string;
  }>;
  paused: { disk: number; pull: number };
}

/** A file the folder holds rather than sends, and why: `edges` for edge
 *  lines that change nothing (`folders.md` 11), `embed` for an embed read
 *  as nothing (`folders.md` 12), `encoding` for a document that is not
 *  UTF-8 (`folders.md` 10), and `name` for a name another file holds in
 *  another case or form (`folders.md` 27). A directory the walk did not
 *  enter is `package` or `unreadable` (`folders.md` 26), or `gone`
 *  (`folders.md` 22). */
export interface FlaggedFile {
  path: string;
  flag:
    | "unreadable"
    | "encoding"
    | "refused"
    | "behind"
    | "edges"
    | "embed"
    | "waiting"
    | "name"
    | "package"
    | "gone";
  reason: string;
}

export interface PullReport {
  written: number;
  rewritten: number;
  moved: number;
  unchanged: number;
  skipped: number;
  unwritten: number;
  /** Files the person deleted, written back because their item changed
   *  elsewhere inside the grace (`folders.md` 21). */
  revived: number;
  /** Items whose placement another item holds, written at a free path
   *  beside it (`folders.md` 19). */
  beside: number;
  /** Placements written: an `in-folder` edge made, or its path moved to
   *  where the file is (`folders.md` 19). */
  placed: number;
  /** Items whose placement would make them another kind of file, left
   *  unwritten (`folders.md` 19). */
  unsuited: number;
  /** Placements the server refused, not sent again until the key or the
   *  settings change, or the item's placement moves on (`folders.md` 19). */
  unplaced: number;
  outside: number;
  /** Files of items trashed or out of the search's states, taken away
   *  (`folders.md` 35). */
  removed: number;
  /** The same, left where they are because the person changed them. */
  kept: number;
  /** Files whose item the search no longer matches otherwise, left where
   *  they are (`folders.md` 35). */
  unmatched: number;
  /** Files left in place whose items left elsewhere in a large removal
   *  (`folders.md` 46). */
  paused: number;
  /** Files another folder on the machine let go of, taken in here
   *  (`folders.md` 44). */
  taken: number;
  /** Items whose file was moved to another folder on the machine that has
   *  not taken it yet, so none is written here (`folders.md` 43). */
  elsewhere: number;
  /** Files of items another folder on the machine holds with a file of its
   *  own, taken away with nothing trashed (`folders.md` 44). */
  let_go: number;
  /** File items whose bytes could not be had, so no file was written (`folders.md` 37). */
  absent: number;
  /** The settings file, rewritten where the settings moved on. */
  settings: SettingsFileReport;
  /** Files left as the person wrote them, their bytes not taken. */
  flagged: FlaggedFile[];
  /** Properties a type the folder holds declares under a name no file can
   *  carry as a property (`folders.md` 7). */
  uncarried: Array<{ type: string; property: string }>;
  /** Embeds whose file this pull did not write where they say
   *  (`folders.md` 12), each flagged `embed`. */
  embeds: FlaggedFile[];
  /** Why the pull wrote nothing, where the folder's directory is gone
   *  (`folders.md` 22). */
  root_gone: string | null;
}

/** What became of the folder's settings file (`folders.md` 1). */
export interface SettingsFileReport {
  /** An edit of the file went through the folder door and landed. */
  sent: boolean;
  /** The file was written from the settings the copy holds. */
  written: boolean;
  /** Why the file's edit is not in force, where it is not. */
  flagged: string | null;
  /** Why the file could not be written, where it could not (`folders.md` 20). */
  unwritten: string | null;
}

export interface PushReport {
  /** The hydration a copy that could not answer took first, if it needed one. */
  hydrated: HydrateReport | null;
  /** The person's edit of the settings file, sent before anything else. */
  settings: SettingsFileReport;
  scan: ScanReport;
  /** With the edits the server refused `ancestor_unavailable`, sent again on
   *  the version the copy holds (`folders.md` 23). */
  drain: DrainReport & {
    rebased: number;
    /** Placements another machine made first, withdrawn for the server's
     *  (`folders.md` 19). */
    gave_way: number;
  };
  /** A catch-up from the copy's cursor, a hydration where the log had aged
   *  past it, or the reason the server could not be reached for either. */
  catch_up: {
    caught_up?: CatchUpReport | null;
    hydrated?: HydrateReport | null;
    failed?: string;
  };
  /** `null` where a failed catch-up left no copy to pull from. */
  pull: PullReport | null;
}

/**
 * A directory driven as a folder.
 *
 * Separate from `CliDevice` because a folder is addressed by its directory
 * and carries its own store under `.marfa`: pointing one at another store
 * would be two folders sharing a mapping, and neither would be right about
 * the other's files.
 */
export class CliFolder {
  constructor(
    readonly dir: string,
    private readonly options: {
      binary: string;
      url: string;
      key: string;
      /** The registry of the machine this folder is on (`folders.md` 41). */
      registry?: string;
      /** A home whose own registry the binary finds, in place of either. */
      home?: string;
    },
  ) {}

  /** The store this folder keeps its working copy and queue in. */
  get store(): string {
    return join(this.dir, ".marfa", "core.sqlite");
  }

  /** The folder's device, for the queue and the reads. */
  device(): CliDevice {
    return new CliDevice({
      binary: this.options.binary,
      store: this.store,
      url: this.options.url,
      key: this.options.key,
      // Unnamed, the registry sits beside the directory, shared only by
      // folders with the same parent.
      registry:
        this.options.registry ?? join(dirname(this.dir), "folders.json"),
      home: this.options.home,
    });
  }

  /** The folders the registry of this folder's machine lists. */
  async list(): Promise<Outcome<RegisteredFolder[]>> {
    return this.run<RegisteredFolder[]>(["folders", "list"]);
  }

  /** Where every file stands, read from the folder's own store. */
  async status(): Promise<Outcome<StatusReport>> {
    return this.run<StatusReport>(["folders", "status", this.dir]);
  }

  /** Lets a paused large removal go. */
  async confirm(): Promise<
    Outcome<{ deleted: number; moved: number; removed: number }>
  > {
    return this.run(["folders", "confirm", this.dir]);
  }

  /** Cancels a paused large removal. */
  async restore(): Promise<
    Outcome<{ put_back: number; restored: number; pull: PullReport }>
  > {
    return this.run(["folders", "restore", this.dir, ...this.server()]);
  }

  /** Takes the folder off its machine, leaving its files. */
  async remove(): Promise<Outcome<unknown>> {
    return this.run(["folders", "remove", this.dir]);
  }

  /** Binds the directory to the `system.folder` whose settings it follows. */
  async add(folder: string): Promise<Outcome<unknown>> {
    return this.run([
      "folders",
      "add",
      this.dir,
      "--folder",
      folder,
      ...this.server(),
    ]);
  }

  async hydrate(): Promise<Outcome<HydrateReport>> {
    return this.run<HydrateReport>([
      "folders",
      "hydrate",
      this.dir,
      ...this.server(),
    ]);
  }

  async scan(): Promise<Outcome<ScanReport>> {
    return this.run<ScanReport>(["folders", "scan", this.dir]);
  }

  async pull(): Promise<Outcome<PullReport>> {
    return this.run<PullReport>([
      "folders",
      "pull",
      this.dir,
      ...this.server(),
    ]);
  }

  async push(): Promise<Outcome<PushReport>> {
    return this.run<PushReport>([
      "folders",
      "push",
      this.dir,
      ...this.server(),
    ]);
  }

  /** A watch left running, which the caller stops. */
  watch(): HeldCommand {
    return this.device().hold(["folders", "watch", this.dir], "root");
  }

  /** A watch left running that prints for a person, not a program. */
  watchText(): HeldCommand {
    return this.device().hold(["folders", "watch", this.dir], "text");
  }

  /** A pull, printed for a person. */
  async pullText(): Promise<Outcome<string>> {
    return this.device().rootText(["folders", "pull", this.dir]);
  }

  /** A push, printed for a person. */
  async pushText(): Promise<Outcome<string>> {
    return this.device().rootText(["folders", "push", this.dir]);
  }

  private server(): string[] {
    return ["--url", this.options.url, "--key", this.options.key];
  }

  private async run<T>(args: string[]): Promise<Outcome<T>> {
    // A folder command names its directory and finds its own store under
    // `.marfa`, so it runs at the root, with no `--db` at all.
    return this.device().root<T>(args);
  }
}

/** A folder a machine's registry lists (`folders.md` 41). */
export interface RegisteredFolder {
  dir: string;
  folder: string;
}
