import { readFileSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  BindingDevice,
  BindingFolderEvent,
  Call,
  Subscription,
} from "../../device/binding-adapter.js";
import { copyLiveReplay } from "../../device/marfa-answers.js";
import {
  bindingFolderHarness,
  folderTold,
  type BindingFolderHarness,
} from "./binding-folders.shared.js";
import { untilHeld, untilReached } from "./binding.shared.js";
import { put, scriptFolderWrites } from "./folders.shared.js";

const made: BindingFolderHarness[] = [];
afterEach(async () => {
  for (const harness of made.splice(0).reverse()) await harness.stop();
});

async function waitingFor(
  device: BindingDevice,
  askedMs: number,
): Promise<void> {
  await vi.waitFor(async () => {
    expect(
      (await device.clock.waits()).some((wait) => wait.askedMs === askedMs),
    ).toBe(true);
  });
}

async function watched(label: string): Promise<
  BindingFolderHarness & {
    watch: Subscription<BindingFolderEvent>;
    served: ReturnType<typeof scriptFolderWrites>;
  }
> {
  const harness = await bindingFolderHarness(label, {
    events: [copyLiveReplay("1", [])],
  });
  made.push(harness);
  const served = scriptFolderWrites(harness);
  const watch = await harness.bound.watch();
  await folderTold(watch, "watching");
  return { ...harness, watch, served };
}

type Asked =
  | "add"
  | "sync"
  | "confirm"
  | "restore"
  | "remove"
  | "removeUnmatched"
  | "discardKept";

/** Starts the binding call `method` names on the harness's folder. */
function asked(harness: BindingFolderHarness, method: Asked): Call<unknown> {
  const { bound } = harness;
  switch (method) {
    case "add":
      return bound.add(harness.settings.id);
    case "removeUnmatched":
      return bound.removeUnmatched(["none.md"]);
    default:
      return bound[method]();
  }
}

/**
 * Moves the engine's clock until `done`, one step for each step of real time.
 * A command asking for a folder gives up after ten seconds of that clock, and
 * the watch it asks lets go only when its pass reaches the end of a step,
 * which takes real time. A step every few milliseconds ran the clock far
 * ahead of the watch on a busy machine, so the command was refused before the
 * watch had answered. Never faster than real time, the clock cannot pass the
 * refusal before the watch could have let go.
 */
async function advanceUntil(
  harness: BindingFolderHarness,
  done: () => boolean | Promise<boolean>,
): Promise<void> {
  await vi.waitFor(
    async () => {
      if (await done()) return;
      await harness.device.clock.advance(200);
      expect(await done()).toBe(true);
    },
    { timeout: 30_000, interval: 200 },
  );
}

describe("folder binding handover", () => {
  it.each([
    "add",
    "sync",
    "confirm",
    "restore",
    "remove",
    "removeUnmatched",
    "discardKept",
  ] as const)(
    "lets a watch go to %s and tells each handover once",
    async (method) => {
      const harness = await watched(`binding-handover-${method}`);
      const { device, watch } = harness;
      await device.hooks.hold("folder-handed-over");
      const call = asked(harness, method);
      await advanceUntil(
        harness,
        async () =>
          call.settled ||
          (await device.hooks.waiting("folder-handed-over")) > 0,
      );
      await folderTold(watch, "handedOver");
      if (method !== "add" && method !== "remove")
        expect(call.settled).toBe(false);
      expect(watch.kinds.filter((kind) => kind === "watching")).toHaveLength(1);
      await device.hooks.release("folder-handed-over");
      const outcome = await call;
      expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
      await advanceUntil(harness, () =>
        watch.kinds.includes(method === "remove" ? "removed" : "takenBack"),
      );
      if (method === "remove") {
        expect(await watch.ended).toBeNull();
        expect(watch.endings).toBe(1);
      } else {
        expect(watch.kinds.filter((kind) => kind === "takenBack")).toHaveLength(
          1,
        );
        put(harness, "after.md", "after handover\n");
        await advanceUntil(harness, () =>
          [...harness.served.values()].some((row) =>
            String(row.properties.body).includes("after handover"),
          ),
        );
        expect(watch.isOver).toBe(false);
      }
      expect(watch.kinds.filter((kind) => kind === "handedOver")).toHaveLength(
        1,
      );
    },
  );

  it("keeps a running watch of the directory going while it is paused, says so, and syncs a change once it is resumed", async () => {
    const harness = await watched("binding-pause-watch-stays");
    const { bound, watch } = harness;
    const sent = (): number =>
      harness.server.requests.filter(
        (request) => request.method === "POST" && request.pathname === "/items",
      ).length;

    const pausing = bound.pause();
    await advanceUntil(harness, () => watch.kinds.includes("paused"));
    expect((await pausing).ok).toBe(true);
    put(harness, "During.md", "during pause\n");
    // Long enough for a watch that was going to send it to have done so.
    for (let step = 0; step < 15; step += 1) {
      await harness.device.clock.advance(200);
      await new Promise((settled) => setTimeout(settled, 200));
    }
    expect(watch.isOver, "the pause ended the watch").toBe(false);
    expect(sent(), "a paused watch sent a file").toBe(0);
    expect(watch.kinds.filter((kind) => kind === "paused")).toHaveLength(1);

    expect((await bound.resume()).ok).toBe(true);
    await advanceUntil(harness, () => watch.kinds.includes("takenBack"));
    await advanceUntil(harness, () =>
      [...harness.served.values()].some((row) =>
        String(row.properties.body).includes("during pause"),
      ),
    );
    expect(watch.isOver).toBe(false);
  });

  it("refuses a watch of a directory that is paused before it begins", async () => {
    const harness = await bindingFolderHarness("binding-pause-watch-refused", {
      events: [copyLiveReplay("1", [])],
    });
    made.push(harness);
    expect((await harness.bound.pause()).ok).toBe(true);
    const started = await harness.bound.tryWatch();
    if (!started.ok) {
      expect(started.refusal.code).toBe("sync_paused");
      expect(started.refusal.raw).toContain("folders resume");
      return;
    }
    const ended = await started.value.ended;
    expect(ended?.code).toBe("sync_paused");
    expect(ended?.message).toContain("folders resume");
    expect(started.value.kinds).not.toContain("watching");
  });

  it.each(["remove", "removeUnmatched", "discardKept"] as const)(
    "refuses an asking call to %s at ten seconds without changing the held folder",
    async (method) => {
      const harness = await watched(`binding-handover-deadline-${method}`);
      const { device, bound, watch } = harness;
      await device.hooks.hold("folder-pass-start");
      await advanceUntil(
        harness,
        async () => (await device.hooks.waiting("folder-pass-start")) > 0,
      );
      const before = JSON.stringify(await bound.status());
      const writes = harness.server.requests.filter(
        (request) => request.method !== "GET",
      ).length;
      const call = asked(harness, method);
      await untilReached(device, "folder-handover-wait");
      await waitingFor(device, 50);
      await device.clock.advance(9_950);
      await untilReached(device, "folder-handover-wait", 2);
      await waitingFor(device, 50);
      expect(call.settled).toBe(false);
      await device.clock.advance(50);
      const result = await call;
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.refusal.code).toBe("reading_handle");
        expect(result.refusal.raw).toContain(harness.dir);
      }
      expect(JSON.stringify(await bound.status())).toBe(before);
      expect(
        harness.server.requests.filter((request) => request.method !== "GET"),
      ).toHaveLength(writes);
      expect(watch.kinds).not.toContain("handedOver");
      await device.hooks.release("folder-pass-start");
    },
  );

  it("finishes the scan step before letting the caller work the folder", async () => {
    const harness = await watched("binding-handover-step");
    const { device, bound, watch } = harness;
    await device.hooks.hold("folder-full-scan");
    await advanceUntil(
      harness,
      async () => (await device.hooks.waiting("folder-full-scan")) > 0,
    );
    put(harness, "step.md", "whole scan step\n");
    await device.hooks.hold("folder-handed-over");
    const call = bound.confirm();
    await untilReached(device, "folder-handover-wait");
    await waitingFor(device, 50);
    await device.clock.advance(200);
    await vi.waitFor(async () => {
      expect(
        (await device.clock.waits()).some((wait) => wait.askedMs === 200),
      ).toBe(false);
    });
    expect(watch.kinds).not.toContain("handedOver");
    expect(call.settled).toBe(false);
    await device.hooks.release("folder-full-scan");
    await advanceUntil(
      harness,
      async () => (await device.hooks.waiting("folder-handed-over")) > 0,
    );
    await folderTold(watch, "handedOver");
    const queued = await harness.folder.device().queue();
    expect(queued.ok).toBe(true);
    if (queued.ok) {
      const created = queued.value.filter(
        (write) => write.kind === "create_item",
      );
      expect(created).toHaveLength(1);
      expect(created[0].verdict).toBeNull();
      expect(created[0].body).toMatchObject({
        properties: { body: "whole scan step\n" },
      });
    }
    expect(
      harness.server.requests.filter(
        (request) => request.method === "POST" && request.pathname === "/items",
      ),
    ).toHaveLength(0);
    await device.hooks.release("folder-handed-over");
    expect((await call).ok).toBe(true);
  });

  it("ends after the recipient takes the folder off the registry", async () => {
    const harness = await watched("binding-handover-unlisted");
    const { device, bound, watch } = harness;
    await device.hooks.hold("folder-take-back-wait");
    const call = bound.confirm();
    await advanceUntil(harness, () => call.settled);
    expect((await call).ok).toBe(true);
    await folderTold(watch, "handedOver");
    await untilHeld(device, "folder-take-back-wait");
    const registry = JSON.parse(readFileSync(harness.registry, "utf8")) as {
      folders: Array<{ dir: string }>;
    };
    registry.folders = registry.folders.filter(
      (folder) => folder.dir !== harness.dir,
    );
    writeFileSync(harness.registry, JSON.stringify(registry));
    await device.hooks.release("folder-take-back-wait");
    await advanceUntil(harness, () => watch.kinds.includes("unlisted"));
    expect(await watch.ended).toBeNull();
    expect(watch.endings).toBe(1);
  });

  it("refuses a second binding watch while the first holds the folder", async () => {
    const { bound, watch } = await watched("binding-watch-refused");
    const refused = await bound.tryWatch();
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.refusal.code).toBe("reading_handle");
    await watch.stop();
    const next = await bound.watch();
    await folderTold(next, "watching");
    await next.stop();
  });

  it("reports another holder once at ten seconds and takes the folder back after it leaves", async () => {
    const harness = await watched("binding-handover-elsewhere");
    const { device, bound, watch } = harness;
    await device.hooks.hold("folder-take-back-wait");
    const call = bound.confirm();
    await advanceUntil(harness, () => call.settled);
    expect((await call).ok).toBe(true);
    await untilHeld(device, "folder-take-back-wait");
    expect((await bound.testOpen()).ok).toBe(true);
    await device.hooks.release("folder-take-back-wait");
    await waitingFor(device, 1_000);
    await device.clock.advance(9_000);
    await untilReached(device, "folder-take-back-wait", 2);
    await waitingFor(device, 1_000);
    expect(watch.kinds).not.toContain("heldElsewhere");
    await device.clock.advance(1_000);
    await folderTold(watch, "heldElsewhere");
    expect(watch.kinds.filter((kind) => kind === "heldElsewhere")).toHaveLength(
      1,
    );
    expect((await bound.testClose()).ok).toBe(true);
    await advanceUntil(harness, () => watch.kinds.includes("takenBack"));
    expect(watch.kinds.filter((kind) => kind === "heldElsewhere")).toHaveLength(
      1,
    );
  });
});
