import { afterEach, describe, expect, it } from "vitest";
import {
  SCRIPTED_INSTANCE,
  answers,
  refusal,
} from "../../device/marfa-answers.js";
import type { DeviceUnderTest } from "../../device/protocol.js";
import { BUILT_FOR, type Answer } from "../../device/scripted-server.js";
import { scriptHydration, startHarness } from "./harness.js";
import type { Harness } from "./harness.js";

/**
 * A purge through a working copy against a scripted server (`device/purge-not-held` to `device/purge-unanswered`): the refusals the copy makes before sending anything, the instance
 * it confirms first, and a purge whose answer never comes.
 */

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.stop();
  harness = undefined;
});

const TRASHED = "01900000-0000-7000-8000-0000000000a1";
const ACTIVE = "01900000-0000-7000-8000-0000000000a2";

/** A copy holding one row in the bin, at version 3, and one outside it. */
async function holding(
  label: string,
  instance: () => string = () => SCRIPTED_INSTANCE,
): Promise<Harness> {
  const started = await startHarness(label);
  started.server.copyAnswer("GET", "/", () =>
    answers.root(Number(BUILT_FOR), instance()),
  );
  scriptHydration(started.server, {
    head: "10",
    instance,
    rows: {
      "core.note": [
        { item: { id: TRASHED, state: "trashed", version: 3 } },
        { item: { id: ACTIVE, version: 2 } },
      ],
    },
  });
  const hydrated = await started.device.hydrate(["core.note"], "library");
  expect(hydrated.ok, JSON.stringify(hydrated)).toBe(true);
  return started;
}

function purges(started: Harness): string[] {
  return started.server.requests
    .filter(
      (request) =>
        request.method === "POST" && request.pathname.endsWith("/purge"),
    )
    .map((request) => request.target);
}

async function trashed(device: DeviceUnderTest): Promise<string[]> {
  const listed = await device.list({ state: "trashed" });
  expect(listed.ok, JSON.stringify(listed)).toBe(true);
  return listed.ok ? listed.value.map((row) => row.id) : [];
}

async function queued(device: DeviceUnderTest): Promise<string[]> {
  const queue = await device.queue();
  expect(queue.ok, JSON.stringify(queue)).toBe(true);
  return queue.ok ? queue.value.map((row) => row.id) : [];
}

const accepted: Answer = { kind: "json", status: 200, body: { ok: true } };

describe("the version a purge names", () => {
  it("sends the version the caller names over the one the copy holds", async () => {
    harness = await holding("purge-named-version");
    harness.server.answer("POST", `/items/${TRASHED}/purge`, accepted);
    const purged = await harness.device.purgeItem(TRASHED, 9);
    expect(purged.ok, JSON.stringify(purged)).toBe(true);
    expect(purges(harness)).toEqual([`/items/${TRASHED}/purge?version=9`]);
  });
});

describe("a device sends a purge only for a row it holds in the bin", () => {
  it("refuses a row the copy does not hold, sending nothing", async () => {
    harness = await holding("purge-unheld");
    const refused = await harness.device.purgeItem(
      "01900000-0000-7000-8000-0000000000ff",
    );
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.refusal.code).toBe("not_found");
      expect(refused.refusal.raw).toContain("not_held");
    }
    expect(
      purges(harness),
      "a purge of a row the copy never held was sent",
    ).toEqual([]);

    // The witness: a row the copy holds in the bin is sent at once, at the
    // version the copy holds, and leaves the copy.
    harness.server.answer("POST", `/items/${TRASHED}/purge`, accepted);
    const purged = await harness.device.purgeItem(TRASHED);
    expect(purged.ok, JSON.stringify(purged)).toBe(true);
    expect(purges(harness)).toEqual([`/items/${TRASHED}/purge?version=3`]);
    expect(await trashed(harness.device)).not.toContain(TRASHED);
    expect(await queued(harness.device)).toEqual([]);
  });

  it("refuses a row the copy shows restored, sending nothing and keeping the restore", async () => {
    harness = await holding("purge-restored");
    expect(await trashed(harness.device)).toContain(TRASHED);
    const restore = await harness.device.restoreItem(TRASHED);
    expect(restore.ok, JSON.stringify(restore)).toBe(true);
    if (!restore.ok) return;

    const refused = await harness.device.purgeItem(TRASHED);
    expect(
      refused.ok,
      "a purge destroyed a row this device had restored, before the restore was sent",
    ).toBe(false);
    if (!refused.ok) {
      expect(refused.refusal.code).toBe("validation");
      expect(refused.refusal.raw).toContain("invalid_transition");
    }
    expect(purges(harness)).toEqual([]);
    expect(await queued(harness.device)).toEqual([restore.value.id]);
  });

  it("refuses a row a write to which still waits, sending nothing", async () => {
    harness = await holding("purge-waiting");
    const deleted = await harness.device.deleteItem(ACTIVE);
    expect(deleted.ok, JSON.stringify(deleted)).toBe(true);
    if (!deleted.ok) return;
    // The witness: the copy shows the row in the bin, as a purge needs.
    expect(await trashed(harness.device)).toContain(ACTIVE);

    const refused = await harness.device.purgeItem(ACTIVE);
    expect(
      refused.ok,
      "a purge went out ahead of a write to the same row",
    ).toBe(false);
    if (!refused.ok) {
      expect(refused.refusal.code).toBe("invalid");
      expect(refused.refusal.raw).toContain("waiting");
    }
    expect(purges(harness)).toEqual([]);
    expect(await queued(harness.device)).toEqual([deleted.value.id]);
  });
});

describe("a device purges no row a blocked write still names", () => {
  it("refuses a row a blocked write names, sending nothing", async () => {
    harness = await holding("purge-blocked");
    const deleted = await harness.device.deleteItem(ACTIVE);
    expect(deleted.ok, JSON.stringify(deleted)).toBe(true);
    if (!deleted.ok) return;
    harness.server.answer(
      "DELETE",
      `/items/${ACTIVE}`,
      refusal(422, "idempotency_key_reused", "The key was spent"),
    );
    const drained = await harness.device.drain();
    expect(drained.ok, JSON.stringify(drained)).toBe(true);
    const queue = await harness.device.queue();
    // The witness: the write is blocked, not waiting to be sent, and the
    // copy still shows the row in the bin.
    expect(queue.ok && queue.value.map((row) => [row.id, row.verdict])).toEqual(
      [[deleted.value.id, "blocked"]],
    );
    expect(await trashed(harness.device)).toContain(ACTIVE);

    const refused = await harness.device.purgeItem(ACTIVE);
    expect(refused.ok, "a purge went out over a blocked write").toBe(false);
    if (!refused.ok) {
      expect(refused.refusal.code).toBe("invalid");
      expect(refused.refusal.raw).toContain("waiting");
    }
    expect(purges(harness)).toEqual([]);
  });
});

describe("a device confirms the instance before it sends a purge", () => {
  it("sends nothing to another instance at the same address, and expires the copy", async () => {
    let instance = SCRIPTED_INSTANCE;
    harness = await holding("purge-other-instance", () => instance);
    harness.server.answer("POST", `/items/${TRASHED}/purge`, accepted);
    const replaced = "00000000-0000-7000-8000-0000000000ff";
    instance = replaced;

    const refused = await harness.device.purgeItem(TRASHED);
    expect(
      refused.ok,
      "a purge was sent to another instance at the same address",
    ).toBe(false);
    if (!refused.ok) {
      expect(refused.refusal.code).toBe("copy_expired");
      expect(refused.refusal.raw).toContain(replaced);
    }
    expect(purges(harness)).toEqual([]);
    const status = await harness.device.status();
    expect(status.ok ? status.value.hydration : status).toBe("expired");
  });
});

describe("a device reads the bin from the server alone", () => {
  it("refuses to read the bin while the server cannot be reached", async () => {
    harness = await holding("bin-offline");
    // The witness: the copy holds a row in the bin it could have answered.
    expect(await trashed(harness.device)).toContain(TRASHED);
    await harness.server.offline();
    const refused = await harness.device.bin();
    await harness.server.online();
    expect(
      refused.ok,
      "the bin was answered from the copy while the server was away",
    ).toBe(false);
    if (!refused.ok) expect(refused.refusal.code).toBe("network");
  });
});

describe("a device keeps the row while a purge's outcome is unknown", () => {
  it("keeps the row when a purge that was sent is never answered", async () => {
    harness = await holding("purge-unanswered");
    harness.server.answer("POST", `/items/${TRASHED}/purge`, { kind: "drop" });
    const refused = await harness.device.purgeItem(TRASHED);
    expect(refused.ok, "a purge nobody answered was taken as done").toBe(false);
    if (!refused.ok) expect(refused.refusal.code).toBe("network");
    expect(purges(harness), "the purge never left the device").toEqual([
      `/items/${TRASHED}/purge?version=3`,
    ]);
    expect(await trashed(harness.device)).toContain(TRASHED);
    expect(await queued(harness.device)).toEqual([]);
  });
});
