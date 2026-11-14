import { afterEach, describe, expect, it } from "vitest";
import {
  SCRIPTED_INSTANCE,
  answers,
  refusal,
  wireItem,
} from "../../device/marfa-answers.js";
import type { DeviceUnderTest } from "../../device/protocol.js";
import { BUILT_FOR, type Answer } from "../../device/scripted-server.js";
import { scriptHydration, startHarness } from "./harness.js";
import type { Harness } from "./harness.js";

/**
 * A purge through a working copy against a scripted server (the device
 * chapter's section "Purging"): the refusals the copy makes before sending
 * anything, the instance it confirms first, and a purge whose answer never
 * comes.
 */

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.stop();
  harness = undefined;
});

const TRASHED = "01900000-0000-7000-8000-0000000000a1";
const ACTIVE = "01900000-0000-7000-8000-0000000000a2";

/** A copy holding one item in the bin, at version 3, and one outside it. */
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
    items: {
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

describe("a device sends a purge only for an item it holds in the bin", () => {
  it("refuses an item the copy does not hold, sending nothing", async () => {
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
      "a purge of an item the copy never held was sent",
    ).toEqual([]);

    // The witness: an item the copy holds in the bin is sent at once, at the
    // version the copy holds, and leaves the copy.
    harness.server.answer("POST", `/items/${TRASHED}/purge`, accepted);
    const purged = await harness.device.purgeItem(TRASHED);
    expect(purged.ok, JSON.stringify(purged)).toBe(true);
    expect(purges(harness)).toEqual([`/items/${TRASHED}/purge?version=3`]);
    expect(await trashed(harness.device)).not.toContain(TRASHED);
    expect(await queued(harness.device)).toEqual([]);
  });

  it("refuses an item the copy shows restored, sending nothing and keeping the restore", async () => {
    harness = await holding("purge-restored");
    expect(await trashed(harness.device)).toContain(TRASHED);
    const restore = await harness.device.restoreItem(TRASHED);
    expect(restore.ok, JSON.stringify(restore)).toBe(true);
    if (!restore.ok) return;

    const refused = await harness.device.purgeItem(TRASHED);
    expect(
      refused.ok,
      "a purge destroyed an item this device had restored, before the restore was sent",
    ).toBe(false);
    if (!refused.ok) {
      expect(refused.refusal.code).toBe("validation");
      expect(refused.refusal.raw).toContain("invalid_transition");
    }
    expect(purges(harness)).toEqual([]);
    expect(await queued(harness.device)).toEqual([restore.value.id]);
  });

  it("refuses an item a write to which still waits, sending nothing", async () => {
    harness = await holding("purge-waiting");
    const deleted = await harness.device.deleteItem(ACTIVE);
    expect(deleted.ok, JSON.stringify(deleted)).toBe(true);
    if (!deleted.ok) return;
    // The witness: the copy shows the item in the bin, as a purge needs.
    expect(await trashed(harness.device)).toContain(ACTIVE);

    const refused = await harness.device.purgeItem(ACTIVE);
    expect(
      refused.ok,
      "a purge went out ahead of a write to the same item",
    ).toBe(false);
    if (!refused.ok) {
      expect(refused.refusal.code).toBe("invalid");
      expect(refused.refusal.raw).toContain("waiting");
      expect(
        refused.refusal.raw,
        "the refusal names a command that does not take a write with no answer out of its wait",
      ).not.toMatch(/withdraw|discard|release/);
      expect(refused.refusal.raw).toContain("drain");
    }
    expect(purges(harness)).toEqual([]);
    expect(await queued(harness.device)).toEqual([deleted.value.id]);
  });
});

describe("a device purges no item a blocked write still names", () => {
  it("refuses an item a blocked write names, sending nothing", async () => {
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
    // copy still shows the item in the bin.
    expect(queue.ok && queue.value.map((row) => [row.id, row.verdict])).toEqual(
      [[deleted.value.id, "blocked"]],
    );
    expect(await trashed(harness.device)).toContain(ACTIVE);

    const refused = await harness.device.purgeItem(ACTIVE);
    expect(refused.ok, "a purge went out over a blocked write").toBe(false);
    if (!refused.ok) {
      expect(refused.refusal.code).toBe("invalid");
      expect(refused.refusal.raw).toContain("waiting");
      expect(
        refused.refusal.raw,
        "the refusal names a command that cannot take a write blocked for a spent key",
      ).not.toMatch(/withdraw|discard/);
      expect(refused.refusal.raw).toContain("release");
    }
    expect(purges(harness)).toEqual([]);
  });
});

describe("a purge refusal names the exits a waiting write has", () => {
  it("refuses an item a dead write names with the commands that clear it, and no longer once it is withdrawn", async () => {
    harness = await holding("purge-dead");
    const deleted = await harness.device.deleteItem(ACTIVE);
    expect(deleted.ok, JSON.stringify(deleted)).toBe(true);
    if (!deleted.ok) return;
    // An answer the device cannot read counts at every drain, and the fifth
    // makes the write dead.
    harness.server.answer("DELETE", `/items/${ACTIVE}`, {
      kind: "json",
      status: 200,
      body: "not an answer",
    });
    for (let pass = 0; pass < 5; pass += 1)
      expect((await harness.device.drain()).ok).toBe(true);
    const queue = await harness.device.queue();
    expect(queue.ok && queue.value.map((row) => [row.id, row.verdict])).toEqual(
      [[deleted.value.id, "dead"]],
    );
    expect(await trashed(harness.device)).toContain(ACTIVE);

    const refused = await harness.device.purgeItem(ACTIVE);
    expect(refused.ok, "a purge went out over a dead write").toBe(false);
    if (!refused.ok) {
      expect(refused.refusal.code).toBe("invalid");
      expect(
        refused.refusal.raw,
        "the refusal does not name a command that clears a dead write",
      ).toContain("withdraw");
      expect(
        refused.refusal.raw,
        "the refusal names a command that cannot take a dead write",
      ).not.toContain("discard");
    }
    expect(purges(harness)).toEqual([]);

    // The witness: the command the refusal names takes the write out, and
    // the purge is no longer refused for it.
    harness.server.copyAnswer(
      "GET",
      /^\/items\/[^/]+$/,
      answers.updated(wireItem({ id: ACTIVE, version: 2 })),
    );
    const withdrawn = await harness.device.withdraw(deleted.value.id);
    expect(withdrawn.ok && withdrawn.value, JSON.stringify(withdrawn)).toEqual([
      deleted.value.id,
    ]);
    expect(await queued(harness.device)).toEqual([]);
    const after = await harness.device.purgeItem(ACTIVE);
    expect(after.ok).toBe(false);
    if (!after.ok) expect(after.refusal.code).toBe("invalid_transition");
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

describe("a device names the copy's instance on a purge", () => {
  it("names it, and expires the copy where another instance refuses the purge", async () => {
    harness = await holding("purge-instance-changed");
    harness.server.answer(
      "POST",
      `/items/${TRASHED}/purge`,
      refusal(409, "instance_changed", "another instance at this address"),
      accepted,
    );
    const refused = await harness.device.purgeItem(TRASHED);
    expect(refused.ok, "another instance's refusal was taken as done").toBe(
      false,
    );
    if (!refused.ok) {
      expect(refused.refusal.code).toBe("copy_expired");
      expect(refused.refusal.raw).toContain("instance_changed");
    }
    const sent = harness.server.requests.filter((request) =>
      request.pathname.endsWith("/purge"),
    );
    expect(
      sent.map((request) => request.headers["x-marfa-instance-id"]),
    ).toEqual([SCRIPTED_INSTANCE]);
    const status = await harness.device.status();
    expect(status.ok ? status.value.hydration : status).toBe("expired");
  });
});

describe("a device reads the bin from the server alone", () => {
  it("refuses to read the bin while the server cannot be reached", async () => {
    harness = await holding("bin-offline");
    // The witness: the copy holds an item in the bin it could have answered.
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

describe("a device keeps the item while a purge's outcome is unknown", () => {
  it("keeps the item when a purge that was sent is never answered", async () => {
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
