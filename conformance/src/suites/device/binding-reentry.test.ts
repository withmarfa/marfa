import { afterEach, describe, expect, it, vi } from "vitest";
import { copyHeadRead, copyReplay } from "../../device/marfa-answers.js";
import { StreamFeed } from "../../device/scripted-server.js";
import {
  bindingHarness,
  heldBy,
  noteMade,
  untilOpen,
  type Followed,
} from "./binding.shared.js";

let harness: Followed | undefined;
afterEach(async () => {
  await harness?.stop();
  harness = undefined;
});

describe("a listener on the engine dispatcher", () => {
  it("refuses hydration and catch-up from its own callback", async () => {
    const feed = new StreamFeed();
    harness = await bindingHarness("dispatcher-reentry", {
      streams: [heldBy(feed)],
    });
    const { device } = harness;
    await device.probeReentry("start");
    await untilOpen(feed);
    feed.push(noteMade("callback-note", "11"));
    await vi.waitFor(
      async () => {
        expect(await device.probeReentry("answers")).toEqual({
          hydrationError: expect.stringMatching(/^invalid:/),
          catchUpError: expect.stringMatching(/^invalid:/),
        });
      },
      { timeout: 10_000, interval: 10 },
    );
    await device.probeReentry("stop");
    // Outside the dispatcher the same operations can finish.
    harness.events.set(copyReplay("11", []));
    const caught = await device.catchUp();
    expect(caught.ok, JSON.stringify(caught)).toBe(true);
    harness.events.set(copyHeadRead("11"), copyReplay("11", []));
    const hydrated = await device.hydrate(["core.note"], "library");
    expect(hydrated.ok, JSON.stringify(hydrated)).toBe(true);
  });
});
