import { afterEach, expect, it, vi } from "vitest";
import { answers } from "../../device/marfa-answers.js";
import type { Answer } from "../../device/scripted-server.js";
import {
  bindingFolderHarness,
  type BindingFolderHarness,
} from "./binding-folders.shared.js";
import { untilHeld } from "./binding.shared.js";

let harness: BindingFolderHarness | undefined;
afterEach(async () => {
  await harness?.stop();
  harness = undefined;
});

it.each([
  {
    name: "exponential backoff",
    retryAfter: undefined,
    delays: [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000],
  },
  {
    name: "the longer of Retry-After and backoff",
    retryAfter: "12",
    delays: [12_000, 12_000, 12_000, 12_000, 16_000, 30_000, 30_000],
  },
  {
    name: "the Retry-After ceiling",
    retryAfter: "86400",
    delays: [300_000, 300_000],
  },
])(
  "retries folder hydration at $name on the manual clock",
  async ({ retryAfter, delays }) => {
    let answer: Answer = answers.currentKey("fixture-key", { "*": "write" });
    harness = await bindingFolderHarness("binding-folder-retry", {
      hydrate: false,
      key: [() => answer],
    });
    answer =
      retryAfter === undefined
        ? answers.serverFault()
        : {
            kind: "json",
            status: 429,
            headers: { "retry-after": retryAfter },
            body: {
              error: { code: "rate_limited", message: "Too many requests" },
            },
          };
    const own = harness;
    const reads = () =>
      own.server.requests.filter(
        (request) =>
          request.method === "GET" && request.pathname === "/keys/current",
      ).length;
    const before = reads();
    // The pass loop is held so its periodic wait cannot stand in for the
    // hydration's retry. The follower still runs on its own engine thread.
    await own.device.hooks.hold("folder-watch-turn");
    const watch = await own.bound.watch();
    await untilHeld(own.device, "folder-watch-turn");
    for (const [attempt, delay] of delays.entries()) {
      await vi.waitFor(
        async () => {
          expect(reads()).toBe(before + attempt + 1);
          const retry = (await own.device.clock.waits()).filter(
            (wait) => wait.askedMs >= 1_000,
          );
          expect(retry).toEqual([{ askedMs: delay, leftMs: delay }]);
        },
        { timeout: 10_000, interval: 10 },
      );
      await own.device.clock.advance(delay - 1);
      const remaining = (await own.device.clock.waits()).filter(
        (wait) => wait.askedMs >= 1_000,
      );
      expect(remaining).toEqual([{ askedMs: delay, leftMs: 1 }]);
      expect(reads(), "the hydration retried before its delay elapsed").toBe(
        before + attempt + 1,
      );
      await own.device.clock.advance(1);
      // The next request witnesses that this same path can retry.
      await vi.waitFor(() => expect(reads()).toBe(before + attempt + 2), {
        timeout: 10_000,
        interval: 10,
      });
    }
    expect(watch.isOver).toBe(false);
  },
);
