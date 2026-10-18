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
  verdict?: string;
  /** Held behind a write that has no answer yet. */
  waiting: boolean;
  body: Record<string, unknown>;
  answer?: string;
  refusals: number;
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
  url?: string;
  key?: string;
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
export class Subscription {
  readonly changes: BindingChange[] = [];
  /** How it ended: null where it was stopped, else the error. */
  readonly ended: Promise<BindingError | null>;
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
  told(change: BindingChange): void {
    this.changes.push(change);
  }

  /** @internal */
  end(error: BindingError | null): void {
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
  | { event: "end"; name: string; error: BindingError | null };

const CLOSE_WAIT_MS = 5_000;

export class BindingDevice {
  private readonly pending = new Map<
    number,
    { resolve: (reply: Reply) => void; reject: (error: Error) => void }
  >();
  private readonly subscriptions = new Map<string, Subscription>();
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
        for (const subscription of this.subscriptions.values()) {
          subscription.end({ message: this.gone.message, code: "host_ended" });
        }
        this.subscriptions.clear();
        resolve();
      });
    });
  }

  /** Starts the binding's process and opens the working copy in it. */
  static async start(options: BindingDeviceOptions): Promise<BindingDevice> {
    const child = fork(HOST, [], {
      env: { ...process.env, MARFA_DEVICE_MODULE: options.module },
      execArgv: [],
      stdio: ["ignore", "inherit", "pipe", "ipc"],
    });
    const device = new BindingDevice(child, options.store);
    const opened = await device.request({
      op: "open",
      handle: MAIN,
      path: options.store,
      url: options.url,
      key: options.key,
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
      const subscription = this.subscriptions.get(message.name);
      if (message.event === "change") subscription?.told(message.change);
      else {
        this.subscriptions.delete(message.name);
        subscription?.end(message.error);
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

  /** A stop that calls taking one can be given, and that is raised later. */
  async newStop(): Promise<StopHandle> {
    const name = `stop-${String(this.numbered++)}`;
    await this.request({ op: "stop", name, action: "new" });
    return new StopHandle(this, name);
  }

  private async subscribe(
    kind: "follow" | "watch",
    options: { toldUnreachable?: boolean },
  ): Promise<Subscription> {
    const name = `${kind}-${String(this.numbered++)}`;
    const subscription = new Subscription(this, name);
    this.subscriptions.set(name, subscription);
    const started = await this.request({
      op: "subscribe",
      handle: MAIN,
      name,
      kind,
      toldUnreachable: options.toldUnreachable,
    });
    if (!started.ok) {
      this.subscriptions.delete(name);
      throw new Error(
        `${kind} did not start: ${JSON.stringify(started.error)}`,
      );
    }
    return subscription;
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
  watch(options: { toldUnreachable?: boolean } = {}): Promise<Subscription> {
    return this.subscribe("watch", options);
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

  pin(id: string): Call<{ pinned: boolean; wasPinned: boolean }> {
    return this.call("pin", id);
  }

  createItem(draft: BindingDraft): Call<BindingQueuedWrite> {
    return this.call("createItem", draft);
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

  /**
   * What a debug build lets a fixture hold. An armed point makes the engine
   * wait the next time it reaches it, until it is released.
   */
  readonly hooks = {
    /** Makes the engine wait at `point` when it reaches it. */
    hold: async (point: string): Promise<void> => {
      await this.control("hook", "hold", point);
    },
    /** Lets go of what waits at `point`, and stops holding it. */
    release: async (point: string): Promise<void> => {
      await this.control("hook", "release", point);
    },
    /** How many times the engine has reached `point`, held or not. */
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
  ): Promise<unknown> {
    const reply = await this.request(
      op === "hook"
        ? { op, name, point: argument }
        : { op, name, arg: argument },
    );
    if (!reply.ok) {
      throw new Error(`${op} ${name} failed: ${JSON.stringify(reply.error)}`);
    }
    return reply.value;
  }

  /** Ends every subscription, then the host. Safe to call twice. */
  async close(): Promise<void> {
    if (this.gone === undefined) {
      const subscriptions = [...this.subscriptions.values()];
      await Promise.all(
        subscriptions.map(async (subscription) => {
          await subscription.stop().catch(() => null);
        }),
      );
      this.child.send({ op: "exit", id: -1 }, () => {});
      const killed = setTimeout(() => {
        this.child.kill("SIGKILL");
      }, CLOSE_WAIT_MS);
      await this.exited;
      clearTimeout(killed);
    }
  }
}

function refusalOf(error: BindingError): Refusal {
  return {
    code: typeof error.code === "string" ? error.code : "unclassified",
    raw: JSON.stringify(error),
  };
}
