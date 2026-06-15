/**
 * Worker-thread pool for the local runtime executor.
 *
 * The supervisor hands each queue message to `Executor.dispatch`, which
 * routes to the appropriate per-integration pool. The pool keeps a small
 * number of `Worker` threads pre-warmed (default 2 per integration) and
 * round-robins dispatches across them; each worker is single-threaded
 * within itself and handles one message at a time.
 *
 * Trust model is fault isolation, not adversarial isolation. A handler
 * crash tears down the worker; the pool replaces it. Other integrations'
 * pools are untouched. `resourceLimits` cap memory and stack size per
 * thread so a runaway handler can't OOM the server process.
 *
 * Test mode: when an integration is registered with `directDispatch`,
 * the executor skips the worker pool entirely and calls the callback
 * synchronously. Used by `runtime-test`-shaped integration tests to
 * exercise the supervisor's lock + cursor plumbing without paying the
 * worker_thread startup cost.
 */
import { fileURLToPath } from "node:url";
import { Worker, type ResourceLimits } from "node:worker_threads";
import type {
  LocalIntegrationRegistration,
  WorkerDispatchRequest,
  WorkerDispatchResponse,
} from "./types.js";

/**
 * Default resource caps per worker thread. Tuned for the in-tree
 * integrations (RSS poller, Calendar diff, GitHub webhook handler) —
 * none of which need more than a few hundred kilobytes of working set.
 * Operators can raise these per-deployment if a heavier handler lands.
 */
const DEFAULT_RESOURCE_LIMITS: ResourceLimits = {
  maxOldGenerationSizeMb: 64,
  maxYoungGenerationSizeMb: 16,
  stackSizeMb: 4,
};

const DEFAULT_POOL_SIZE = 2;

/** Path to the compiled worker entry script. */
function workerEntryPath(): string {
  return fileURLToPath(new URL("./worker-entry.js", import.meta.url));
}

interface PendingDispatch {
  resolve: (response: WorkerDispatchResponse) => void;
  reject: (err: Error) => void;
}

/**
 * Wraps a single Worker with the bookkeeping the pool needs:
 *   - `ready` resolves when the worker has imported the handler module
 *   - one in-flight dispatch at a time (the pool serializes across
 *     dispatches landing on the same worker; per-Connection serialization
 *     happens upstream in the supervisor via the advisory lock)
 */
class WorkerSlot {
  readonly worker: Worker;
  ready: Promise<void>;
  inFlight: PendingDispatch | null = null;
  isDead = false;
  /** Resolved when the worker exits. */
  exited: Promise<void>;

  constructor(handlerModulePath: string, resourceLimits: ResourceLimits) {
    this.worker = new Worker(workerEntryPath(), {
      workerData: { handlerModulePath },
      resourceLimits,
    });
    let resolveReady!: () => void;
    let rejectReady!: (err: Error) => void;
    this.ready = new Promise<void>((res, rej) => {
      resolveReady = res;
      rejectReady = rej;
    });
    // Eager-spawn can produce an unhandled rejection if a worker dies before
    // the first dispatch awaits `ready` (e.g. bad module path). A no-op catch
    // here prevents process termination; the real consumer in dispatch() still
    // observes the rejection independently.
    this.ready.catch(() => undefined);
    let resolveExited!: () => void;
    this.exited = new Promise<void>((res) => {
      resolveExited = res;
    });
    this.worker.on("message", (msg: unknown) => {
      if (
        typeof msg === "object" &&
        msg !== null &&
        (msg as { kind?: unknown }).kind === "ready"
      ) {
        resolveReady();
        return;
      }
      const pending = this.inFlight;
      this.inFlight = null;
      pending?.resolve(msg as WorkerDispatchResponse);
    });
    this.worker.on("error", (err: Error) => {
      this.isDead = true;
      rejectReady(err);
      const pending = this.inFlight;
      this.inFlight = null;
      pending?.reject(err);
    });
    this.worker.on("exit", () => {
      this.isDead = true;
      resolveExited();
      if (this.inFlight) {
        const pending = this.inFlight;
        this.inFlight = null;
        pending.reject(new Error("worker exited mid-dispatch"));
      }
    });
  }

  send(request: WorkerDispatchRequest): Promise<WorkerDispatchResponse> {
    if (this.isDead) {
      return Promise.reject(new Error("worker is dead"));
    }
    if (this.inFlight) {
      return Promise.reject(
        new Error("worker already has an in-flight dispatch"),
      );
    }
    return new Promise<WorkerDispatchResponse>((resolve, reject) => {
      this.inFlight = { resolve, reject };
      this.worker.postMessage(request);
    });
  }

  async terminate(): Promise<void> {
    await this.worker.terminate();
  }
}

class WorkerPool {
  private slots: WorkerSlot[] = [];
  private cursor = 0;
  private terminated = false;

  constructor(
    private readonly handlerModulePath: string,
    poolSize: number,
    private readonly resourceLimits: ResourceLimits,
  ) {
    for (let i = 0; i < poolSize; i++) this.slots.push(this.spawn());
  }

  private spawn(): WorkerSlot {
    return new WorkerSlot(this.handlerModulePath, this.resourceLimits);
  }

  async dispatch(
    request: WorkerDispatchRequest,
  ): Promise<WorkerDispatchResponse> {
    if (this.terminated) {
      throw new Error("worker pool already terminated");
    }
    // Round-robin: two different Connections can be in flight at once despite
    // the per-Connection advisory lock, so we may need to skip busy slots.
    for (let attempt = 0; attempt < this.slots.length * 2; attempt++) {
      const idx = this.cursor % this.slots.length;
      this.cursor++;
      const slot = this.slots[idx];
      if (!slot) continue;
      if (slot.isDead) {
        this.slots[idx] = this.spawn();
        continue;
      }
      if (slot.inFlight) continue;
      await slot.ready;
      try {
        const response = await slot.send(request);
        // Worker may have transitioned to dead during slot.send() via the async
        // "exit" listener; replace it for the next caller.
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        if (slot.isDead) this.slots[idx] = this.spawn();
        return response;
      } catch (err) {
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        if (slot.isDead) this.slots[idx] = this.spawn();
        throw err;
      }
    }
    // All slots were busy — queue behind the first slot's in-flight dispatch.
    const slot = this.slots[0];
    if (!slot) throw new Error("worker pool is empty");
    await slot.ready;
    return slot.send(request);
  }

  async terminate(): Promise<void> {
    this.terminated = true;
    await Promise.all(this.slots.map((s) => s.terminate()));
    await Promise.all(this.slots.map((s) => s.exited));
    this.slots = [];
  }
}

/**
 * Executor public surface. Dispatches a `WorkerDispatchRequest` against
 * the right per-integration pool (or directDispatch test seam) and
 * returns the worker's response.
 */
export interface Executor {
  dispatch(
    registration: LocalIntegrationRegistration,
    request: WorkerDispatchRequest,
  ): Promise<WorkerDispatchResponse>;
  terminate(): Promise<void>;
}

export interface ExecutorConfig {
  /** Workers per integration. Defaults to 2. */
  poolSize?: number;
  /** Per-thread resource limits. Defaults to a 64MB old-gen / 16MB
   *  young-gen / 4MB stack budget. */
  resourceLimits?: ResourceLimits;
}

export function createExecutor(config: ExecutorConfig = {}): Executor {
  const poolSize = config.poolSize ?? DEFAULT_POOL_SIZE;
  const resourceLimits = {
    ...DEFAULT_RESOURCE_LIMITS,
    ...config.resourceLimits,
  };
  const pools = new Map<string, WorkerPool>();

  function getPool(name: string, handlerModulePath: string): WorkerPool {
    let pool = pools.get(name);
    if (!pool) {
      pool = new WorkerPool(handlerModulePath, poolSize, resourceLimits);
      pools.set(name, pool);
    }
    return pool;
  }

  return {
    async dispatch(registration, request) {
      if (registration.directDispatch) {
        return registration.directDispatch(request);
      }
      if (!registration.handlerModulePath) {
        throw new Error(
          `Integration ${registration.name} has no handlerModulePath and no directDispatch`,
        );
      }
      const pool = getPool(registration.name, registration.handlerModulePath);
      return pool.dispatch(request);
    },
    async terminate() {
      await Promise.all([...pools.values()].map((p) => p.terminate()));
      pools.clear();
    },
  };
}
