import { execFile, spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  type CatchUpReport,
  type DeviceUnderTest,
  type Draft,
  type DrainReport,
  type EdgeDraft,
  type Edit,
  type HydrateReport,
  type Item,
  type ListFilters,
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
 * The one refusal that is not an envelope is clap's own, for a command line
 * the binary does not offer: it exits 2 with its usage text, which is the
 * device refusing an operation rather than the core refusing one it does.
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
  running: () => boolean;
  stop: () => Promise<void>;
}

export interface CliDeviceOptions {
  /** The built binary. The conformance job exports it; a local run may point at a debug build. */
  binary: string;
  store: string;
  url?: string;
  key?: string;
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

  reopen(overrides: { url?: string; key?: string } = {}): DeviceUnderTest {
    return new CliDevice({ ...this.options, ...overrides });
  }

  async hydrate(types: string[], tier: Tier): Promise<Outcome<HydrateReport>> {
    return this.json<HydrateReport>([
      "hydrate",
      ...this.server(),
      "--types",
      types.join(","),
      "--tier",
      tier,
    ]);
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
    if (filters.unsupported !== undefined)
      args.push(filters.unsupported[0], filters.unsupported[1]);
    return this.json<Item[]>(args);
  }

  async get(id: string): Promise<Outcome<Item>> {
    return this.json<Item>(["items", "get", id]);
  }

  async search(
    query: string,
    filters: SearchFilters = {},
    limit?: number,
  ): Promise<Outcome<SearchHit[]>> {
    const args = ["search", query];
    if (filters.state !== undefined) args.push("--state", filters.state);
    if (filters.allStates === true) args.push("--all-states");
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

  async status(): Promise<Outcome<Status>> {
    return this.json<Status>(["status"]);
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
  hold(args: string[], at: "device" | "root" = "device"): HeldCommand {
    const child = spawn(
      this.options.binary,
      [
        ...(at === "device" ? this.prefix() : ["--json"]),
        ...args,
        ...this.server(),
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    return {
      get stderr() {
        return stderr;
      },
      running: () => child.exitCode === null && !child.killed,
      stop: async () => {
        if (child.exitCode === null) child.kill("SIGKILL");
        await new Promise<void>((resolve) => {
          if (child.exitCode !== null) {
            resolve();
            return;
          }
          child.once("close", () => {
            resolve();
          });
        });
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
    edit: { properties: Record<string, unknown>; version?: number },
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
    return this.json<QueuedWrite>(args);
  }

  async deleteEdge(id: string): Promise<Outcome<QueuedWrite>> {
    return this.json<QueuedWrite>(["edges", "delete", id]);
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

  private server(): string[] {
    const args: string[] = [];
    if (this.options.url !== undefined) args.push("--url", this.options.url);
    if (this.options.key !== undefined) args.push("--key", this.options.key);
    return args;
  }

  /** Every device operation is a `device` command on one store, answered as JSON. */
  private prefix(): string[] {
    return ["--json", "device", "--db", this.options.store];
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
    let stdout: string;
    try {
      // A device that hangs is a failing device, and the runner owns the
      // deadline for everything else; this bound stops one hung spawn from
      // taking the file's whole budget with nothing naming it.
      ({ stdout } = await run(this.options.binary, full, {
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
    const text = stdout.trim();
    if (text === "") return { ok: true, value: null as T };
    try {
      return { ok: true, value: JSON.parse(text) as T };
    } catch {
      throw new Error(
        `the device exited cleanly and printed something that is not JSON: ${text.slice(0, 200)}`,
      );
    }
  }
}

/** What `folders add` is given. */
export interface FolderSlice {
  types: string[];
  tier?: Tier;
  defaultType?: string;
  defaults?: Record<string, unknown>;
  tags?: string[];
}

export interface ScanReport {
  created: number;
  updated: number;
  renamed: number;
  unchanged: number;
  missing: number;
  deleted: number;
  skipped: number;
  /** Items moved off a contested name and back (`folders.md` 24). */
  parked: number;
}

export interface PullReport {
  written: number;
  rewritten: number;
  moved: number;
  unchanged: number;
  skipped: number;
  unwritten: number;
  collided: number;
  outside: number;
  /** Files of items that left the slice, taken away (`folders.md` 26). */
  removed: number;
  /** The same, left where they are because the person changed them. */
  kept: number;
}

export interface PushReport {
  scan: ScanReport;
  drain: DrainReport;
  pull: PullReport;
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
    private readonly options: { binary: string; url: string; key: string },
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
    });
  }

  async add(slice: FolderSlice): Promise<Outcome<unknown>> {
    const args = ["folders", "add", this.dir, "--types", slice.types.join(",")];
    if (slice.tier !== undefined) args.push("--tier", slice.tier);
    if (slice.defaultType !== undefined)
      args.push("--default-type", slice.defaultType);
    if (slice.defaults !== undefined)
      args.push("--defaults", JSON.stringify(slice.defaults));
    for (const tag of slice.tags ?? []) args.push("--tag", tag);
    return this.run(args);
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
    return this.run<PullReport>(["folders", "pull", this.dir]);
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
    return new CliDevice({
      binary: this.options.binary,
      store: this.store,
      url: this.options.url,
      key: this.options.key,
    }).hold(["folders", "watch", this.dir], "root");
  }

  private server(): string[] {
    return ["--url", this.options.url, "--key", this.options.key];
  }

  private async run<T>(args: string[]): Promise<Outcome<T>> {
    // A folder command names its directory and finds its own store under
    // `.marfa`, so it runs at the root, with no `--db` at all.
    return new CliDevice({
      binary: this.options.binary,
      store: this.store,
      url: this.options.url,
      key: this.options.key,
    }).root<T>(args);
  }
}
