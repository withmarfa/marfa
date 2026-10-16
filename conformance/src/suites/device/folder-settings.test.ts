import { afterEach, describe, expect, it } from "vitest";
import { SCRIPTED_INSTANCE, refusal } from "../../device/marfa-answers.js";
import { hydratedHarness, type Harness } from "./harness.js";

/**
 * A folder's settings change through a working copy against a scripted
 * server, for what the real server cannot be made to answer: another
 * instance at the copy's address.
 */

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.stop();
  harness = undefined;
});

describe("a device names the copy's instance on a folder's settings", () => {
  it("names it, and expires the copy where another instance refuses the change", async () => {
    harness = await hydratedHarness("folder-settings-instance-changed");
    const { server, device } = harness;
    server.answer(
      "POST",
      "/folders",
      refusal(409, "instance_changed", "another instance at this address"),
    );

    const refused = await device.createFolder({ title: "Elsewhere" });
    expect(refused.ok, "another instance's refusal was taken as done").toBe(
      false,
    );
    if (!refused.ok) {
      expect(refused.refusal.code).toBe("copy_expired");
      expect(refused.refusal.raw).toContain("instance_changed");
    }
    const sent = server.requests.filter(
      (request) => request.method === "POST" && request.pathname === "/folders",
    );
    expect(
      sent.map((request) => request.headers["x-marfa-instance-id"]),
      "the change did not name the copy's instance",
    ).toEqual([SCRIPTED_INSTANCE]);
    const status = await device.status();
    expect(status.ok ? status.value.hydration : status).toBe("expired");
  });
});
