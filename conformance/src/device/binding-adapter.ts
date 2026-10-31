import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { Outcome, Refusal, SliceTier, Tier } from "./protocol.js";

/**
 * The device's binding, driven as the device under test.
 *
 * `CliDevice` runs one command at a time on a store it holds for that
 * command alone, so it cannot run two calls on one working copy, hold one of
 * them part way, or start a follow as one whose caller was told the server
 * was lost. A binding can, and this is the adapter for it. The binding runs
 * in a process of its own (`binding-host.mjs`): a call that blocks its
 * thread, as the engine's synchronous ones do while they read from the
 * server, would otherwise stop the scripted server in this process
 * answering it.
 *
 * What a call answers is what the binding returns, in the binding's own
 * shape (`itemId`, a change told apart by `kind`), not the command's JSON.
 * The shapes below are the parts of the module's declarations that fixtures
 * read, written out by hand: nothing under `suites/` imports the module.
 */

export interface BindingItem {
  id: string;
  type: string;
  properties: Record<string, unknown>;
  state: string;
  version: number;
  tags: string[];
}

export interface BindingHydrateReport {
  types: string[];
  tier: SliceTier;
  edgeTypes: string[];
  items: number;
  edges: number;
  pages: number;
  cursor: string;
}

export interface BindingCatchUpReport {
  applied: number;
  skipped: number;
  cursor: string;
  catalogChanged: boolean;
}

export interface BindingDrainVerdict {
  id: string;
  kind: string;
  itemId?: string;
  edgeId?: string;
  verdict?: string;
  refusals: number;
  replayed: boolean;
}

export interface BindingDrainReport {
  answered: number;
  held: number;
  undelivered: number;
  unsent: number;
  unmade: number;
  unavailable?: string;
  verdicts: BindingDrainVerdict[];
  stopped?: string;
  unclaimedSources: string[];
  retryAfterSeconds?: number;
}

export interface BindingQueuedWrite {
  id: string;
  kind: string;
  itemId?: string;
  targetId?: string;
  edgeId?: string;
  idempotencyKey: string;
  dependsOn: string[];
  follows?: string;
  /** Absent while the server has not answered it. */
  verdict?: { verdict: string; reason?: string; [field: string]: unknown };
  /** Held behind a write that has no answer yet. */
  waiting: boolean;
  body: Record<string, unknown>;
  answer?: string;
  refusals: number;
}

export interface BindingItemType {
  id: string;
  label?: string;
  parent?: string;
  version: number;
  fields: Array<{ name: string; type: string; declaredBy: string }>;
}

/** Absent where the item has none. */
export interface BindingItemDisplay {
  name?: string;
  preview?: string;
}

export interface BindingEdgeType {
  id: string;
  label: string;
  reverseLabel: string;
  cardinality: string;
}

export interface BindingStatus {
  serverOrigin?: string;
  instanceId?: string;
  sliceTypes: string[];
  sliceTier?: SliceTier;
  pinned: string[];
  eventCursor?: string;
  hydration: "never" | "in_progress" | "complete" | "expired";
  items: number;
  edges: number;
  catalogVersion?: number;
  syncedAt?: string;
}

/** What a held stream or a watch tells, told apart by `kind`. */
export type BindingChange =
  | {
      kind: "applied";
      event: string;
      itemId?: string;
      edgeId?: string;
      cursor: string;
    }
  | { kind: "catalogChanged"; cursor: string }
  | { kind: "serverUnreachable"; reason: string; cursor: string }
  | { kind: "serverReachable"; cursor: string }
  | { kind: "queueDrained"; report: BindingDrainReport; cursor: string }
  | { kind: "queueNotDrained"; code: string; reason: string; cursor: string }
  | { kind: "saved"; dataVersion: number; cursor: string }
  | { kind: "watchFailed"; code: string; reason: string; cursor: string };

/** An error the binding threw: its `code` and message, and what rode on it. */
export interface BindingError {
  code?: string;
  message: string;
  [field: string]: unknown;
}

/** A wait the engine asked the manual clock for. */
export interface ClockWait {
  askedMs: number;
  /** Null for a wait too long to add to the clock. */
  leftMs: number | null;
}

export interface BindingDraft {
  type: string;
  id?: string;
  properties?: Record<string, unknown>;
  tags?: string[];
  tier?: Tier;
}

export interface BindingDeviceOptions {
  /** The built Node module; a debug build where a fixture holds or moves the clock. */
  module: string;
  store: string;
  /** Without a server, only local reads and writes work. */
  url?: string;
  key?: string;
  /** Opens the store another process writes, to read it only. */
  reader?: boolean;
  /** An isolated folder registry for this host. */
  registry?: string;
}

/** What a listener a fixture adds does besides record what it is told. */
export interface ListenerOptions {
  /** Says the listener was last told `serverUnreachable`. */
  toldUnreachable?: boolean;
  /** Takes this many milliseconds to return from each change. */
  slowMs?: number;
  /** Throws from the change it is told with this number, counting from 0. */
  throwAt?: number;
  /** Opens this store as a writer would the moment it is told it ended. */
  openOnEnd?: { path: string; url?: string; key?: string };
}

/**
 * The result of opening a store. If another handle holds the writer's role,
 * the new handle opens as a reader.
 */
export interface OpenAttempt {
  opened: boolean;
  handle?: "writer" | "reader";
  error?: BindingError;
}

/** The handle the host opens the fixture's working copy as. */
const MAIN = "main";

const HOST = fileURLToPath(new URL("./binding-host.mjs", import.meta.url));

/** A call that has been started and may not have ended. */
export class Call<T> implements PromiseLike<Outcome<T>> {
  private ended = false;
  private readonly outcome: Promise<Outcome<T>>;

  constructor(
    readonly method: string,
    started: Promise<Outcome<T>>,
  ) {
    this.outcome = started.then((outcome) => {
      this.ended = true;
      return outcome;
    });
    // A call a fixture started and never awaited, because it failed first,
    // is not a second failure when the host ends under it.
    this.outcome.catch(() => {});
  }

  /** Whether the call has answered, which a fixture reads without waiting. */
  get settled(): boolean {
    return this.ended;
  }

  then<R1 = Outcome<T>, R2 = never>(
    onfulfilled?: ((value: Outcome<T>) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ): PromiseLike<R1 | R2> {
    return this.outcome.then(onfulfilled, onrejected);
  }
}

/** A stop a call can be given and a fixture can raise. */
export class StopHandle {
  constructor(
    private readonly device: BindingDevice,
    readonly name: string,
  ) {}

  async raise(): Promise<void> {
    await this.device.request({
      op: "stop",
      name: this.name,
      action: "raise",
    });
  }
}

/**
 * A follow or a watch the binding holds, told as it goes: every change it
 * told so far is in `changes`, and `ended` settles once with how it ended.
 */
export class Subscription<T extends { kind: string } = BindingChange> {
  readonly changes: T[] = [];
  /** What it was told after it had been told it ended. */
  readonly afterEnd: T[] = [];
  /** How it ended: null where it was stopped, else the error. */
  readonly ended: Promise<BindingError | null>;
  /** How many times it was told it ended. */
  endings = 0;
  /** What came of opening the store as it was told it ended, where asked. */
  openedOnEnd: OpenAttempt | undefined;
  private resolveEnded: (error: BindingError | null) => void = () => {};
  private over = false;

  constructor(
    private readonly device: BindingDevice,
    readonly name: string,
  ) {
    this.ended = new Promise((resolve) => {
      this.resolveEnded = (error) => {
        this.over = true;
        resolve(error);
      };
    });
  }

  /** The kinds told so far, in order. */
  get kinds(): string[] {
    return this.changes.map((change) => change.kind);
  }

  get isOver(): boolean {
    return this.over;
  }

  /** @internal */
  told(change: T): void {
    (this.over ? this.afterEnd : this.changes).push(change);
  }

  /** @internal */
  end(error: BindingError | null, opened?: OpenAttempt): void {
    this.endings += 1;
    this.openedOnEnd ??= opened;
    this.resolveEnded(error);
  }

  /** Stops it, and answers once it has ended. */
  async stop(): Promise<BindingError | null> {
    if (!this.over) {
      await this.device.request({ op: "unsubscribe", name: this.name });
    }
    return this.ended;
  }
}

type Reply =
  | { id: number; ok: true; value: unknown }
  | { id: number; ok: false; error: BindingError };

type FromHost =
  | Reply
  | { event: "change"; name: string; change: BindingChange }
  | { event: "folder-change"; name: string; change: BindingFolderEvent }
  | {
      event: "end";
      name: string;
      error: BindingError | null;
      opened?: OpenAttempt;
    };

const CLOSE_WAIT_MS = 5_000;

export class BindingDevice {
  private readonly pending = new Map<
    number,
    { resolve: (reply: Reply) => void; reject: (error: Error) => void }
  >();
  private readonly subscriptions = new Map<string, Subscription>();
  private readonly folderSubscriptions = new Map<
    string,
    Subscription<BindingFolderEvent>
  >();
  private next = 0;
  private numbered = 0;
  private errors = "";
  private gone: Error | undefined;
  private readonly exited: Promise<void>;

  private constructor(
    private readonly child: ChildProcess,
    readonly store: string,
  ) {
    child.on("message", (message: FromHost) => {
      this.received(message);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      this.errors += chunk.toString("utf8");
    });
    this.exited = new Promise((resolve) => {
      child.once("exit", (code, signal) => {
        this.gone = new Error(
          `the binding host ended (${signal ?? String(code)}) with calls unanswered. What it printed to stderr: ${this.errors}`,
        );
        for (const waiting of this.pending.values()) {
          waiting.reject(this.gone);
        }
        this.pending.clear();
        for (const subscription of [
          ...this.subscriptions.values(),
          ...this.folderSubscriptions.values(),
        ]) {
          if (!subscription.isOver) {
            subscription.end({
              message: this.gone.message,
              code: "host_ended",
            });
          }
        }
        this.subscriptions.clear();
        resolve();
      });
    });
  }

  /** Starts the binding's process and opens the working copy in it. */
  static async start(options: BindingDeviceOptions): Promise<BindingDevice> {
    const child = fork(HOST, [], {
      env: {
        ...process.env,
        MARFA_DEVICE_MODULE: options.module,
        ...(options.registry === undefined
          ? {}
          : { MARFA_FOLDER_REGISTRY: options.registry }),
      },
      // Collection is how a fixture lets go of a core the binding holds.
      execArgv: ["--expose-gc"],
      stdio: ["ignore", "inherit", "pipe", "ipc"],
    });
    const device = new BindingDevice(child, options.store);
    const opened = await device.request({
      op: "open",
      handle: MAIN,
      path: options.store,
      url: options.url,
      key: options.key,
      reader: options.reader,
    });
    if (!opened.ok) {
      await device.close();
      throw new Error(
        `the binding could not open ${options.store}: ${JSON.stringify(opened.error)}`,
      );
    }
    return device;
  }

  /** What the host has printed to stderr, a Rust panic among it. */
  get stderr(): string {
    return this.errors;
  }

  private received(message: FromHost): void {
    if ("event" in message) {
      if (message.event === "folder-change") {
        this.folderSubscriptions.get(message.name)?.told(message.change);
      } else if (message.event === "change") {
        this.subscriptions.get(message.name)?.told(message.change);
      } else {
        (
          this.subscriptions.get(message.name) ??
          this.folderSubscriptions.get(message.name)
        )?.end(message.error, message.opened);
      }
      return;
    }
    const waiting = this.pending.get(message.id);
    this.pending.delete(message.id);
    waiting?.resolve(message);
  }

  /** @internal Sends one message and answers with the host's reply. */
  request(message: Record<string, unknown>): Promise<Reply> {
    if (this.gone !== undefined) return Promise.reject(this.gone);
    const id = this.next++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.send({ ...message, id }, (error) => {
        if (error !== null) {
          this.pending.delete(id);
          reject(error);
        }
      });
    });
  }

  /**
   * Starts a call of the binding's and answers at once, without waiting for
   * it, so a fixture can start a second before the first has ended. Await
   * the `Call` for its outcome. A refusal arrives as data, as every adapter
   * here reports one.
   */
  call<T>(method: string, ...args: unknown[]): Call<T> {
    return new Call(
      method,
      this.request({ op: "call", handle: MAIN, method, args }).then(
        (reply): Outcome<T> =>
          reply.ok
            ? { ok: true, value: reply.value as T }
            : { ok: false, refusal: refusalOf(reply.error) },
      ),
    );
  }

  async probeReentry(action: "start" | "answers" | "stop"): Promise<{
    hydrationError?: string;
    catchUpError?: string;
  } | null> {
    const reply = await this.request({ op: "reentry", action, handle: MAIN });
    if (!reply.ok) throw new Error(JSON.stringify(reply.error));
    return reply.value as {
      hydrationError?: string;
      catchUpError?: string;
    } | null;
  }

  listFolders(): Call<Array<{ dir: string; folder: string }>> {
    return this.folderCall("list");
  }

  folder(dir: string): BindingFolder {
    return new BindingFolder(this, dir);
  }

  folderCall<T>(method: string, ...args: unknown[]): Call<T> {
    return new Call(
      method,
      this.request({ op: "folder-call", method, args }).then(
        (reply): Outcome<T> =>
          reply.ok
            ? { ok: true, value: reply.value as T }
            : { ok: false, refusal: refusalOf(reply.error) },
      ),
    );
  }

  async folderWatch(
    dir: string,
  ): Promise<Outcome<Subscription<BindingFolderEvent>>> {
    const name = `folder-${String(this.numbered++)}`;
    const subscription = new Subscription<BindingFolderEvent>(this, name);
    this.folderSubscriptions.set(name, subscription);
    const started = await this.request({ op: "folder-watch", name, dir });
    if (!started.ok) {
      this.folderSubscriptions.delete(name);
      return { ok: false, refusal: refusalOf(started.error) };
    }
    return { ok: true, value: subscription };
  }

  /** A stop that calls taking one can be given, and that is raised later. */
  async newStop(): Promise<StopHandle> {
    const name = `stop-${String(this.numbered++)}`;
    await this.request({ op: "stop", name, action: "new" });
    return new StopHandle(this, name);
  }

  private async start(
    kind: "follow" | "watch",
    options: ListenerOptions,
  ): Promise<Outcome<Subscription>> {
    const name = `${kind}-${String(this.numbered++)}`;
    const subscription = new Subscription(this, name);
    this.subscriptions.set(name, subscription);
    const started = await this.request({
      op: "subscribe",
      handle: MAIN,
      name,
      kind,
      ...options,
    });
    if (!started.ok) {
      this.subscriptions.delete(name);
      return { ok: false, refusal: refusalOf(started.error) };
    }
    return { ok: true, value: subscription };
  }

  private async subscribe(
    kind: "follow" | "watch",
    options: ListenerOptions,
  ): Promise<Subscription> {
    const started = await this.start(kind, options);
    if (!started.ok) {
      throw new Error(
        `${kind} did not start: ${JSON.stringify(started.refusal)}`,
      );
    }
    return started.value;
  }

  /**
   * Holds the event stream open (`follow`), telling each change as it
   * happens. `toldUnreachable` says the caller was last told
   * `serverUnreachable`.
   */
  follow(options: { toldUnreachable?: boolean } = {}): Promise<Subscription> {
    return this.subscribe("follow", options);
  }

  /** Adds a listener to the store's watch. */
  watch(options: ListenerOptions = {}): Promise<Subscription> {
    return this.subscribe("watch", options);
  }

  /** Adds a listener to the store's watch, or answers why it could not. */
  tryWatch(options: ListenerOptions = {}): Promise<Outcome<Subscription>> {
    return this.start("watch", options);
  }

  /**
   * Lets go of the core the binding opened, so that the only hold on the
   * store left is what the engine itself keeps: a watch with listeners.
   */
  async forget(): Promise<void> {
    await this.request({ op: "forget", handle: MAIN });
  }

  /**
   * Replaces the store the writer refuses with an empty one, and holds it in
   * place of the core `forget` let go of.
   */
  async replaceRefused(url?: string, key?: string): Promise<Outcome<null>> {
    const reply = await this.request({
      op: "replace-refused",
      handle: MAIN,
      path: this.store,
      url,
      key,
    });
    return reply.ok
      ? { ok: true, value: null }
      : { ok: false, refusal: refusalOf(reply.error) };
  }

  /**
   * Removes the store, agreeing to lose `unsent` writes the server has not
   * taken. Call `forget` first, or the binding's own core holds the store.
   */
  async removeStore(unsent: number): Promise<Outcome<null>> {
    const reply = await this.request({
      op: "remove-store",
      path: this.store,
      unsent,
    });
    return reply.ok
      ? { ok: true, value: null }
      : { ok: false, refusal: refusalOf(reply.error) };
  }

  /** Opens the store as a writer would, and says the role it was given. */
  async tryOpen(url?: string, key?: string): Promise<OpenAttempt> {
    const reply = await this.request({
      op: "try-open",
      path: this.store,
      url,
      key,
    });
    if (!reply.ok) throw new Error(JSON.stringify(reply.error));
    return reply.value as OpenAttempt;
  }

  hydrate(
    types: string[],
    tier: SliceTier = "library",
    stop?: StopHandle,
  ): Call<BindingHydrateReport> {
    return this.call(
      "hydrate",
      types,
      tier,
      ...(stop === undefined ? [] : [{ $stop: stop.name }]),
    );
  }

  catchUp(stop?: StopHandle): Call<BindingCatchUpReport> {
    return this.call(
      "catchUp",
      ...(stop === undefined ? [] : [{ $stop: stop.name }]),
    );
  }

  drain(stop?: StopHandle): Call<BindingDrainReport> {
    return this.call(
      "drain",
      ...(stop === undefined ? [] : [{ $stop: stop.name }]),
    );
  }

  queue(): Call<BindingQueuedWrite[]> {
    return this.call("queue");
  }

  status(): Call<BindingStatus> {
    return this.call("status");
  }

  get(id: string): Call<BindingItem | null> {
    return this.call("get", id);
  }

  /** A number that moves each time another process saves to the store. */
  dataVersion(): Call<number> {
    return this.call("dataVersion");
  }

  itemTypes(): Call<BindingItemType[]> {
    return this.call("itemTypes");
  }

  /** Each item's name and preview text, in order, by the copy's catalog alone. */
  itemDisplays(
    items: { type: string; properties: Record<string, unknown> }[],
  ): Call<BindingItemDisplay[]> {
    return this.call("itemDisplays", items);
  }

  edgeTypes(): Call<BindingEdgeType[]> {
    return this.call("edgeTypes");
  }

  updateItem(
    id: string,
    edit: { properties: Record<string, unknown>; baseVersion?: number },
  ): Call<BindingQueuedWrite> {
    return this.call("updateItem", id, edit);
  }

  pin(id: string): Call<{ pinned: boolean; wasPinned: boolean }> {
    return this.call("pin", id);
  }

  createItem(draft: BindingDraft): Call<BindingQueuedWrite> {
    return this.call("createItem", draft);
  }

  deleteItem(id: string): Call<BindingQueuedWrite> {
    return this.call("deleteItem", id);
  }

  release(id: string): Call<boolean> {
    return this.call("release", id);
  }

  withdraw(id: string): Call<boolean> {
    return this.call("withdraw", id);
  }

  discard(id: string): Call<boolean> {
    return this.call("discard", id);
  }

  takeAnswered(): Call<BindingQueuedWrite[]> {
    return this.call("takeAnswered");
  }

  /**
   * What a debug build lets a fixture hold. An armed point makes the engine
   * wait the next time it reaches it, until it is released.
   */
  readonly hooks = {
    /** Makes the engine wait at `point` when it reaches it. */
    hold: async (point: string): Promise<void> => {
      this.armed.add(point);
      await this.control("hook", "hold", point);
    },
    /**
     * Makes the engine fail where it reaches `point`, until `fail(point,
     * false)`. Only the points the engine names can fail.
     */
    fail: async (point: string, on = true): Promise<void> => {
      await this.control("hook", "fail", point, on);
    },
    /** Lets go of what waits at `point`, and stops holding it. */
    release: async (point: string): Promise<void> => {
      await this.control("hook", "release", point);
    },
    /** How many times the engine has reached `point` since the host armed observation. */
    reached: async (point: string): Promise<number> =>
      (await this.control("hook", "reached", point)) as number,
    /** How many calls wait at `point` now. */
    waiting: async (point: string): Promise<number> =>
      (await this.control("hook", "waiting", point)) as number,
  };

  /**
   * The clock the engine waits by. Set it manual before the calls whose
   * waits a fixture reads; it then moves only where `advance` moves it.
   */
  readonly clock = {
    manual: async (on = true): Promise<void> => {
      await this.control("clock", "manual", on);
    },
    advance: async (ms: number): Promise<void> => {
      await this.control("clock", "advance", ms);
    },
    waits: async (): Promise<ClockWait[]> =>
      (await this.control("clock", "waits")) as ClockWait[],
  };

  private async control(
    op: "hook" | "clock",
    name: string,
    argument?: unknown,
    second?: unknown,
  ): Promise<unknown> {
    const reply = await this.request(
      op === "hook"
        ? { op, name, point: argument, arg: second }
        : { op, name, arg: argument },
    );
    if (!reply.ok) {
      throw new Error(`${op} ${name} failed: ${JSON.stringify(reply.error)}`);
    }
    return reply.value;
  }

  /** Ends every subscription, then the host. Safe to call twice. */
  async close(): Promise<void> {
    if (this.gone !== undefined) return;
    // The deadline starts first: a subscription held at a point, or a call
    // that never answers, must not keep the host alive.
    const killed = setTimeout(() => {
      this.child.kill("SIGKILL");
    }, CLOSE_WAIT_MS);
    try {
      await this.releaseHolds();
      const subscriptions = [
        ...this.subscriptions.values(),
        ...this.folderSubscriptions.values(),
      ];
      await Promise.all(
        subscriptions.map(async (subscription) => {
          await subscription.stop().catch(() => null);
        }),
      );
      this.child.send({ op: "exit", id: -1 }, () => {});
      await this.exited;
    } finally {
      clearTimeout(killed);
    }
  }

  /** The points a fixture armed, let go of at close. */
  private readonly armed = new Set<string>();

  private async releaseHolds(): Promise<void> {
    await Promise.all(
      [...this.armed].map((point) => this.hooks.release(point).catch(() => {})),
    );
  }
}

function refusalOf(error: BindingError): Refusal {
  return {
    code: typeof error.code === "string" ? error.code : "unclassified",
    raw: JSON.stringify(error),
  };
}

export interface BindingFolderScan {
  created: number;
  updated: number;
  renamed: number;
  unchanged: number;
  waiting: number;
  missing: number;
  deleted: number;
  skipped: number;
  movedAway: number;
  paused: number;
  trashed: string[];
  rootGone?: string;
}

export interface BindingFolderPull {
  written: number;
  rewritten: number;
  moved: number;
  unchanged: number;
  skipped: number;
  removed: number;
  purged: number;
  kept: number;
  unwritten: number;
  absent: number;
  unplaced: number;
  unmatched: number;
  paused: number;
  rootGone?: string;
}

export interface BindingFolderPass {
  settings: {
    sent: boolean;
    written: boolean;
    flagged?: string;
    unwritten?: string;
  };
  scan: BindingFolderScan;
  drain: BindingDrainReport;
  rebased: number;
  gaveWay: number;
  pull?: BindingFolderPull;
  flagged: Array<{ path: string; flag: string; reason: string; item?: string }>;
}

export interface BindingFolderStatus {
  files: Array<{
    path: string;
    itemId?: string;
    state: string;
    waits: string[];
    flag?: string;
    reason?: string;
  }>;
  directories: Array<{ path: string; flag: string; reason: string }>;
  paused: { disk: number; pull: number };
  firstSync?: {
    plan?: { write: number; send: number; beside: number; left: number };
  };
}

export type BindingFolderSync =
  | {
      kind: "waiting";
      plan: { write: number; send: number; beside: number; left: number };
    }
  | {
      kind: "done";
      sync: {
        hydrated?: BindingHydrateReport;
        catchUpError?: BindingError;
        pass: BindingFolderPass;
      };
    };

export type BindingFolderEvent =
  | { kind: "watching"; dir: string }
  | { kind: "passed"; pass: BindingFolderPass }
  | { kind: "retrying"; error: BindingError; waitMs: number }
  | { kind: "unreachable" | "waiting"; reason: string }
  | { kind: "watcherFailed"; message: string }
  | {
      kind:
        | "reachable"
        | "handedOver"
        | "takenBack"
        | "heldElsewhere"
        | "removed"
        | "unlisted";
    };

/** One folder worked through the host's Folders binding. */
export class BindingFolder {
  constructor(
    readonly device: BindingDevice,
    readonly dir: string,
  ) {}

  add(folder: string): Call<{ dir: string; folder: string }> {
    return this.device.folderCall("add", this.dir, folder);
  }
  status(): Call<BindingFolderStatus> {
    return this.device.folderCall("status", this.dir);
  }
  sync(): Call<BindingFolderSync> {
    return this.device.folderCall("sync", this.dir);
  }
  confirmFirstSync(): Call<boolean> {
    return this.device.folderCall("confirmFirstSync", this.dir);
  }
  confirm(): Call<{
    deleted: number;
    moved: number;
    removed: number;
    unsure: Array<{ path: string; reason: string }>;
  }> {
    return this.device.folderCall("confirm", this.dir);
  }
  restore(): Call<{
    putBack: number;
    restored: number;
    pull: BindingFolderPull;
  }> {
    return this.device.folderCall("restore", this.dir);
  }
  remove(): Call<void> {
    return this.device.folderCall("remove", this.dir);
  }
  testOpen(): Call<void> {
    return this.device.folderCall("testOpen", this.dir);
  }
  testClose(): Call<void> {
    return this.device.folderCall("testClose");
  }
  testPull(): Call<BindingFolderPull> {
    return this.device.folderCall("testPull");
  }
  testHydrate(): Call<BindingHydrateReport> {
    return this.device.folderCall("testHydrate");
  }
  testScan(): Call<BindingFolderScan> {
    return this.device.folderCall("testScan");
  }
  testDrain(): Call<{
    drain: BindingDrainReport;
    rebased: number;
    gaveWay: number;
  }> {
    return this.device.folderCall("testDrain");
  }
  testCatchUp(): Call<{
    caughtUp?: BindingCatchUpReport;
    hydrated?: BindingHydrateReport;
  }> {
    return this.device.folderCall("testCatchUp");
  }
  testSubmitSettingsFile(): Call<BindingFolderPass["settings"]> {
    return this.device.folderCall("testSubmitSettingsFile");
  }
  tryWatch(): Promise<Outcome<Subscription<BindingFolderEvent>>> {
    return this.device.folderWatch(this.dir);
  }
  async watch(): Promise<Subscription<BindingFolderEvent>> {
    const started = await this.tryWatch();
    if (!started.ok) throw new Error(JSON.stringify(started.refusal));
    return started.value;
  }
}
