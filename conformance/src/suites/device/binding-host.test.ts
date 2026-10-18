import { afterEach, describe, expect, it } from "vitest";
import type { BindingHarness } from "./harness.js";
import { bindingHarness, untilHeld } from "./binding.shared.js";

/** The binding harness's own controls, not the device's behavior. */

let harness: BindingHarness | undefined;

afterEach(async () => {
  await harness?.stop();
  harness = undefined;
});

describe("closing a binding", () => {
  it("ends the host, though a follow is held at a point and a call is unanswered", async () => {
    const followed = await bindingHarness("binding-close-held", {
      hydrate: false,
    });
    harness = followed;
    const { device } = followed;
    await device.hooks.hold("follow-waiting");
    const follow = await device.follow();
    await untilHeld(device, "follow-waiting");
    const started = Date.now();
    await followed.stop();
    harness = undefined;
    expect(
      Date.now() - started,
      "closing waited on a follow held at a point",
    ).toBeLessThan(4_000);
    expect(follow.isOver).toBe(true);
  });
});
