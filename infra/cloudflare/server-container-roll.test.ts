import { describe, expect, it } from "vitest";

import {
  rollIfStale,
  type ImageTagStore,
  type RollableContainer,
} from "./server-container/src/roll.js";

/**
 * A deploy replaces the running container.
 *
 * It did not. The Worker rolls atomically on `wrangler deploy`; the container
 * is replaced only when it goes idle for the whole `sleepAfter` window, and
 * any request renews that window. So a build that 500s every request stays
 * resident precisely because the failing clients keep retrying — an outage
 * that sustains itself, unbounded under traffic rather than the fifteen to
 * thirty seconds the runbook described.
 *
 * Tested here rather than against the Worker entry for the same reason the
 * cold-start tests are: the entry reaches for `cloudflare:workers` and the
 * containers library at import time, and this package carries its own
 * `node_modules`, so a specifier mock resolves to a different physical copy
 * and misses.
 */

function recordingContainer(
  opts: { failDestroy?: boolean } = {},
): RollableContainer & {
  destroyed: number;
} {
  let destroyed = 0;
  return {
    get destroyed() {
      return destroyed;
    },
    destroy: () => {
      if (opts.failDestroy) return Promise.reject(new Error("destroy refused"));
      destroyed += 1;
      return Promise.resolve();
    },
  };
}

function memoryStore(
  initial?: string,
): ImageTagStore & { value: () => string | undefined } {
  let value = initial;
  return {
    value: () => value,
    get: () => Promise.resolve(value),
    set: (tag) => {
      value = tag;
      return Promise.resolve();
    },
  };
}

describe("rollIfStale", () => {
  it("replaces an instance running a different image", async () => {
    const container = recordingContainer();
    const store = memoryStore("registry/marfa:old");

    const outcome = await rollIfStale(container, store, "registry/marfa:new");

    expect(outcome).toBe("rolled");
    expect(container.destroyed).toBe(1);
    expect(store.value()).toBe("registry/marfa:new");
  });

  it("leaves a current instance alone", async () => {
    // The sharpest risk in this mechanism: a comparison that is wrong in this
    // direction destroys the container on every request, which is a
    // self-inflicted outage dressed as a fix.
    const container = recordingContainer();
    const store = memoryStore("registry/marfa:same");

    const outcome = await rollIfStale(container, store, "registry/marfa:same");

    expect(outcome).toBe("current");
    expect(container.destroyed).toBe(0);
  });

  it("rolls once when no image has been recorded, then stays put", async () => {
    // "Unrecorded" cannot be told from "stale", and the safe reading of an
    // unknown build is that it is the wrong one. That costs one cold start per
    // instance, once.
    const container = recordingContainer();
    const store = memoryStore(undefined);

    expect(await rollIfStale(container, store, "registry/marfa:new")).toBe(
      "rolled",
    );
    expect(await rollIfStale(container, store, "registry/marfa:new")).toBe(
      "current",
    );
    expect(container.destroyed).toBe(1);
  });

  it("never rolls when no expected image is declared", async () => {
    // Fails closed. The deploy script guards against an unresolved token, but
    // a var that went missing must not turn every request into a cold start.
    const container = recordingContainer();
    const store = memoryStore("registry/marfa:old");

    for (const missing of [undefined, "", "   "]) {
      expect(await rollIfStale(container, store, missing)).toBe("unknown");
    }
    expect(container.destroyed).toBe(0);
    expect(store.value()).toBe("registry/marfa:old");
  });

  it("leaves the recorded image alone when the destroy does not take", async () => {
    // So the next request tries again rather than recording a roll that never
    // happened, which would strand the old build silently.
    const container = recordingContainer({ failDestroy: true });
    const store = memoryStore("registry/marfa:old");

    const outcome = await rollIfStale(container, store, "registry/marfa:new");

    expect(outcome).toBe("failed");
    expect(store.value()).toBe("registry/marfa:old");
  });

  it("does not fail the request when the destroy does not take", async () => {
    const container = recordingContainer({ failDestroy: true });
    await expect(
      rollIfStale(container, memoryStore("old"), "new"),
    ).resolves.toBe("failed");
  });
});
