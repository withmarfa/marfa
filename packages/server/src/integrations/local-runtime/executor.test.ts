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
 * prevent that termination; this test pins the behaviour so a future
 * refactor that removes the no-op can't silently regress the
 * resilience.
 */
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createExecutor } from "./executor.js";
import type {
  LocalIntegrationRegistration,
  WorkerDispatchRequest,
} from "./types.js";

const tempRoot = mkdtempSync(join(tmpdir(), "myme-executor-test-"));

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

describe("executor resilience", () => {
  it("worker that throws at module-load does not crash the process", async () => {
    // Capture any unhandled rejections that fire during this test —
    // the §6 regression manifests as a `triggerUncaughtException`
    // from Node's internal/process/promises:332, which would normally
    // terminate the test runner.
    const rejections: unknown[] = [];
    const captureRejection = (reason: unknown): void => {
      rejections.push(reason);
    };
    process.on("unhandledRejection", captureRejection);

    const executor = createExecutor({ poolSize: 2 });
    const poisonPath = writePoisonHandler("poison: module-load failure");
    const registration: LocalIntegrationRegistration = {
      name: "poison",
      handlerModulePath: poisonPath,
      echo: { echo_ttl_seconds: 0 },
      triggerKinds: new Set(["schedule"]),
    };
    const request: WorkerDispatchRequest = {
      apiUrl: "http://test.local",
      credential: {
        api_key: "myme_k1_test",
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

    // The dispatch is expected to reject — the worker thread dies
    // (either from the handler module throwing on load, or because
    // under vitest the executor resolves `./worker-entry.js`
    // against the source tree where only `.ts` exists). Either way
    // slot.ready rejects and dispatch surfaces the error to the
    // caller. The load-bearing assertion below is that the OTHER
    // pool slot's `ready` — which the dispatch loop never reaches —
    // doesn't escalate to an unhandled rejection.
    await expect(executor.dispatch(registration, request)).rejects.toThrow();

    // Give any further rejections (e.g. the second pool slot whose
    // `ready` was never awaited) a chance to surface as unhandled.
    await new Promise<void>((resolve) => setTimeout(resolve, 200));

    process.off("unhandledRejection", captureRejection);
    await executor.terminate();

    expect(rejections).toEqual([]);
  });
});
