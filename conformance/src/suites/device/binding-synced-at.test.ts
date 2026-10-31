import { describe, it, expect, afterEach, vi } from "vitest";
import { BindingDevice } from "../../device/binding-adapter.js";
import { copyStreamLive } from "../../device/marfa-answers.js";
import { StreamFeed } from "../../device/scripted-server.js";
import { KEY, requireModule, type BindingHarness } from "./harness.js";
import {
  bindingHarness,
  heldBy,
  noteMade,
  untilOpen,
} from "./binding.shared.js";

/**
 * `synced_at` as an app reads it through the Node module, as `syncedAt`. The
 * follow's bound is read from the engine's manual clock, which moves its
 * wall time too, so no fixture waits thirty seconds.
 */

let harness: BindingHarness | undefined;
const reopened: BindingDevice[] = [];

afterEach(async () => {
  for (const device of reopened.splice(0)) await device.close();
  await harness?.stop();
  harness = undefined;
});

const RFC3339_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

async function syncedAt(device: BindingDevice): Promise<string | undefined> {
  const status = await device.status();
  expect(status.ok, JSON.stringify(status)).toBe(true);
  // Absent and null are the same to an app: no time to show.
  return status.ok ? (status.value.syncedAt ?? undefined) : undefined;
}

describe("synced_at through the Node module", () => {
  it("tells no syncedAt before a hydration, an RFC 3339 UTC time once one completes, and the same time after the store is opened again", async () => {
    const own = await bindingHarness("binding-synced-at", { hydrate: false });
    harness = own;
    const { server, device } = own;

    expect(
      await syncedAt(device),
      "a store that never pulled from the server told a time it synced",
    ).toBeUndefined();

    const before = Date.now();
    const hydrated = await device.hydrate(["core.note"], "library");
    expect(hydrated.ok, JSON.stringify(hydrated)).toBe(true);
    const after = Date.now();
    const stamp = await syncedAt(device);
    expect(stamp, "the hydration told no time").toMatch(RFC3339_UTC);
    const at = Date.parse(stamp ?? "");
    expect(
      at >= before - 1 && at <= after + 1,
      `the module told ${stamp}, not a time while the hydration ran`,
    ).toBe(true);

    await device.close();
    const again = await BindingDevice.start({
      module: requireModule(),
      store: device.store,
      url: server.url,
      key: KEY,
    });
    reopened.push(again);
    expect(
      await syncedAt(again),
      "the time was lost when the store was opened again",
    ).toBe(stamp);
  });

  it("tells a time its clock gave within the last thirty seconds each time a follow at the head reads a frame", async () => {
    const feed = new StreamFeed();
    const own = await bindingHarness("binding-synced-at-follow", {
      streams: [heldBy(feed, copyStreamLive("10"))],
    });
    harness = own;
    const { device } = own;
    const hydrated = await syncedAt(device);
    // The manual clock starts at the system time, so it starts after this.
    await new Promise((resolve) => setTimeout(resolve, 20));
    await device.clock.manual();

    const follow = await device.follow();
    await untilOpen(feed);
    let first = "";
    await vi.waitFor(
      async () => {
        const stamp = await syncedAt(device);
        expect(
          stamp,
          "the follow reached the head and told no new time",
        ).not.toBe(hydrated);
        first = stamp ?? "";
      },
      { timeout: 10_000, interval: 20 },
    );
    // Told at the clock's start, so the clock reads `start + advanced`.
    const start = Date.parse(first);
    let advanced = 0;

    const withinBound = async (why: string): Promise<void> => {
      await vi.waitFor(
        async () => {
          const at = Date.parse((await syncedAt(device)) ?? "");
          const now = start + advanced;
          expect(at, why).toBeLessThanOrEqual(now);
          expect(now - at, why).toBeLessThanOrEqual(30_000);
        },
        { timeout: 10_000, interval: 20 },
      );
    };

    for (const [by, frame, what] of [
      [10_000, { comment: "keepalive" }, "a heartbeat ten seconds on"],
      [21_000, { comment: "keepalive" }, "a heartbeat thirty-one seconds on"],
      [31_000, noteMade("arrived", "11"), "an event thirty-one seconds later"],
    ] as const) {
      await device.clock.advance(by);
      advanced += by;
      feed.push(frame);
      await withinBound(
        `after ${what}, the follow at the head told a time older than thirty seconds`,
      );
    }
    expect(await follow.stop()).toBeNull();
  });
});
