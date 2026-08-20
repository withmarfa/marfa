/**
 * The local bridge's stop() must settle on a quiescent process.
 *
 * `iterator.return()` alone cannot unwind a generator suspended on an
 * event that never comes, so without the wake sentinel a parked drainer
 * held stop() open forever — every shutdown then burned its bridge-stop
 * budget and the drainer's coordination reservation was severed only by
 * the forced pool end at storage close. This pins the sentinel: stop()
 * settles promptly with no events flowing at all.
 *
 * Storage is a stub that throws on any access — the bridge's initial
 * subscription load catches and logs, which is exactly the quiescent
 * shape under test: nothing to drain, iterators parked.
 */
import { describe, it, expect } from "vitest";
import { createLocalReactiveBridge } from "./reactive-bridge.js";
import type { LocalRuntime } from "./types.js";
import type { Storage } from "../../storage/interface.js";

const throwingStorage = new Proxy(
  {},
  {
    get() {
      throw new Error("quiescent-bridge test: storage must not be reached");
    },
  },
) as Storage;

const unusedRuntime = {
  enqueue: () => Promise.resolve(),
  getRegistration: () => undefined,
} as unknown as LocalRuntime;

describe("local reactive bridge stop()", () => {
  it("settles promptly on a quiescent process", async () => {
    const bridge = createLocalReactiveBridge(throwingStorage, unusedRuntime, {
      disableCoordinationLock: true,
    });
    await bridge.start();
    // Let the drainer reach its parked await on the event iterator.
    await new Promise((r) => setTimeout(r, 100));

    const started = Date.now();
    await Promise.race([
      bridge.stop(),
      new Promise((_, reject) =>
        setTimeout(() => {
          reject(
            new Error(
              "stop() did not settle — the wake sentinel is not reaching the parked iterators",
            ),
          );
        }, 5_000),
      ),
    ]);
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});
