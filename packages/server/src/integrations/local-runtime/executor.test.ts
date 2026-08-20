/**
 * Executor resilience tests.
 *
 * The substrate's worker_thread pool eagerly spawns `poolSize` slots
 * on first dispatch. Each slot allocates a `ready` promise that
 * rejects on the worker's `error` event. The dispatch loop awaits
 * `slot.ready` for the slot it picks; slots it doesn't pick (e.g. on
 * a poolSize=2 pool where the first slot errors and dispatch throws
 * without rotating) have their `ready` rejected with no awaiter — an
 * unhandled promise rejection that Node 15+ terminates the process on
 * by default.
 *
 * `WorkerSlot`'s constructor attaches a no-op `.catch` to `ready` to
 * prevent that termination; this test pins the behavior so a future
 * refactor that removes the no-op can't silently regress the
 * resilience.
 */
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { createExecutor } from "./executor.js";
import type {
  LocalIntegrationRegistration,
  WorkerDispatchRequest,
} from "./types.js";

const tempRoot = mkdtempSync(join(tmpdir(), "marfa-executor-test-"));

afterAll(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

function writePoisonHandler(message: string): string {
  const path = join(
    tempRoot,
    `poison-${String(Date.now())}-${String(Math.random())}.js`,
  );
  writeFileSync(path, `throw new Error(${JSON.stringify(message)});\n`);
  return path;
}

/** Registration + request pair aimed at a fresh poison handler. The
 *  values are inert: under vitest the worker dies on module resolution
 *  before any of them are read, and the fixture exists so every case
 *  exercises the same dispatch shape. */
function buildPoisonFixture(): {
  registration: LocalIntegrationRegistration;
  request: WorkerDispatchRequest;
} {
  const registration: LocalIntegrationRegistration = {
    name: "poison",
    handlerModulePath: writePoisonHandler("poison: module-load failure"),
    echo: { echo_ttl_seconds: 0 },
    triggerKinds: new Set(["schedule"]),
  };
  const request: WorkerDispatchRequest = {
    apiUrl: "http://test.local",
    credential: {
      api_key: "marfa_k1_test",
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      connection_id: "test-connection",
    },
    message: {
      kind: "schedule",
      integration_name: "poison",
      connection_id: "test-connection",
      scheduled_for_ms: Date.now(),
    },
    integrationName: "poison",
    echo: { echo_ttl_seconds: 0 },
    hopBudget: 5,
    cursorSnapshot: {},
  };
  return { registration, request };
}

describe("executor resilience", () => {
  // Capture any unhandled rejections that fire during a test — the
  // regression this suite exists for manifests as a
  // `triggerUncaughtException` from Node's internal/process/promises,
  // which would normally terminate the test runner. Installed and
  // removed in hooks so a failing assertion cannot leak the listener,
  // which would silently swallow unhandled rejections for every later
  // test in this worker — the exact bug class the suite pins.
  let rejections: unknown[] = [];
  const captureRejection = (reason: unknown): void => {
    rejections.push(reason);
  };
  beforeEach(() => {
    rejections = [];
    process.on("unhandledRejection", captureRejection);
  });
  afterEach(() => {
    process.off("unhandledRejection", captureRejection);
  });

  it("worker that throws at module-load does not crash the process", async () => {
    const executor = createExecutor({ poolSize: 2 });
    const { registration, request } = buildPoisonFixture();

    // The dispatch is expected to reject — the worker thread dies
    // (either from the handler module throwing on load, or because
    // under vitest the executor resolves `./worker-entry.js`
    // against the source tree where only `.ts` exists). Either way
    // slot.ready rejects and dispatch surfaces the error to the
    // caller. The load-bearing assertion below is that the OTHER
    // pool slot's `ready` — which the dispatch loop never reaches —
    // doesn't escalate to an unhandled rejection.
    await expect(executor.dispatch(registration, request)).rejects.toThrow();

    // terminate() awaits every slot's `exit` event — a deterministic
    // barrier that each spawned worker finished its lifecycle, with the
    // capture listener still installed while it runs.
    await executor.terminate();
    expect(rejections).toEqual([]);
  });

  // The pool size is an operator knob, so the machinery has to hold at
  // the sizes an operator would actually set, not just the default. A
  // pool of 4 spawns more never-awaited `ready` promises than the
  // default — the surface the rejection guard exists for; a pool of 1
  // pins that dispatch still surfaces the error with no sibling slot in
  // play. Spawn runs for real at each size (and immediately fails, the
  // most the vitest environment allows); terminate drains every slot.
  for (const poolSize of [1, 4]) {
    it(`pool of ${String(poolSize)}: dispatch surfaces the error and teardown drains every slot`, async () => {
      const executor = createExecutor({ poolSize });
      const { registration, request } = buildPoisonFixture();

      await expect(executor.dispatch(registration, request)).rejects.toThrow();
      await executor.terminate();
      expect(rejections).toEqual([]);
    });
  }
});
