import { describe, it, expect, afterEach } from "vitest";
import {
  startHarness,
  scriptHydration,
  scriptWrites,
  type Harness,
} from "./harness.js";
import {
  answers,
  catchupTooOld,
  connected,
  copyIncompleteReplay,
  copyItemEvent,
  copyLiveReplay,
  copyReplay,
  copyStreamCursor,
  refusal,
  wireItem,
} from "../../device/marfa-answers.js";
import type { Answer } from "../../device/scripted-server.js";
import type { DeviceUnderTest } from "../../device/protocol.js";

/**
 * `synced_at` is what an app shows as "updated 5 minutes ago" or "offline
 * since 10:42". A stamp moved by a pull that failed tells a person their
 * rows are current when they are not, and one lost on reopen tells them the
 * copy never synced.
 */

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.stop();
  harness = undefined;
});

const RFC3339_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

async function syncedAt(device: DeviceUnderTest): Promise<string | null> {
  const status = await device.status();
  expect(
    status.ok,
    `the device would not report its state: ${JSON.stringify(status)}`,
  ).toBe(true);
  if (!status.ok) throw new Error("unreachable: the assertion above threw");
  expect(
    status.value,
    "the state report has no synced_at at all, so an app cannot tell a copy that never synced from one that did",
  ).toHaveProperty("synced_at");
  return status.value.synced_at ?? null;
}

/** The time a stamp names, checked to be one an app can read. */
function readTime(stamp: string | null): number {
  expect(stamp, "no time was recorded").not.toBeNull();
  expect(stamp).toMatch(RFC3339_UTC);
  return Date.parse(stamp ?? "");
}

/** Lets the clock pass a millisecond, so a stamp moved is a stamp told apart. */
async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

/**
 * A hydration of one note, then each replay after the hydration's own
 * answering the next of `replays`, the last repeating.
 */
function scriptPulls(server: Harness["server"], ...replays: Answer[]): void {
  let asked = 0;
  scriptHydration(server, {
    head: "10",
    rows: { "core.note": [{ item: { id: "n1" } }] },
    replay: () => {
      asked++;
      // The hydration's own replay comes first.
      if (asked === 1) return copyReplay("10", []);
      return replays[Math.min(asked - 2, replays.length - 1)]!;
    },
  });
}

describe("the time a copy last synced", () => {
  it("reports no synced_at on a new store, and the time a hydration completed once one has, across a reopen", async () => {
    harness = await startHarness("synced-at-hydration");
    const { server, device } = harness;
    scriptPulls(server, copyReplay("10", []));

    expect(
      await syncedAt(device),
      "a store that has never pulled from the server says it synced",
    ).toBeNull();

    const before = Date.now();
    expect((await device.hydrate(["core.note"], "library")).ok).toBe(true);
    const after = Date.now();
    const stamp = await syncedAt(device);
    const at = readTime(stamp);
    expect(
      at >= before - 1 && at <= after + 1,
      `the hydration recorded ${stamp}, not a time while it ran (${new Date(before).toISOString()} to ${new Date(after).toISOString()})`,
    ).toBe(true);

    expect(
      await syncedAt(device.reopen()),
      "the time was lost when the store was opened again",
    ).toBe(stamp);
  });

  it("moves synced_at when a catch-up completes", async () => {
    harness = await startHarness("synced-at-catch-up");
    const { server, device } = harness;
    scriptPulls(
      server,
      copyReplay("11", [
        copyItemEvent("11", "item.created", wireItem({ id: "n2" })),
      ]),
    );
    expect((await device.hydrate(["core.note"], "library")).ok).toBe(true);
    const hydrated = readTime(await syncedAt(device));
    await tick();

    const caught = await device.catchUp();
    expect(caught.ok, JSON.stringify(caught)).toBe(true);
    expect(
      readTime(await syncedAt(device)),
      "a catch-up that completed left the time of the hydration before it",
    ).toBeGreaterThan(hydrated);
  });

  it("keeps synced_at when a catch-up fails, and moves it on the next that completes", async () => {
    harness = await startHarness("synced-at-catch-up-fails");
    const { server, device } = harness;
    scriptPulls(
      server,
      refusal(503, "service_unavailable", "the server is busy"),
      copyReplay("10", []),
    );
    expect((await device.hydrate(["core.note"], "library")).ok).toBe(true);
    const stamp = await syncedAt(device);
    readTime(stamp);
    await tick();

    expect(
      (await device.catchUp()).ok,
      "the catch-up the server refused succeeded, so nothing below is about a failed one",
    ).toBe(false);
    expect(
      await syncedAt(device),
      "a catch-up the server refused moved the time the copy last synced",
    ).toBe(stamp);

    // The witness: the same catch-up, answered, moves it.
    expect((await device.catchUp()).ok).toBe(true);
    expect(readTime(await syncedAt(device))).toBeGreaterThan(readTime(stamp));
  });

  it("keeps synced_at when the server refuses the credential a catch-up sends", async () => {
    harness = await startHarness("synced-at-credential-refused");
    const { server, device } = harness;
    scriptPulls(
      server,
      copyReplay("10", []),
      refusal(401, "unauthorized", "the key was revoked"),
    );
    expect((await device.hydrate(["core.note"], "library")).ok).toBe(true);
    const hydrated = readTime(await syncedAt(device));
    await tick();

    // The witness: the same catch-up, answered, moves it.
    const caught = await device.catchUp();
    expect(caught.ok, JSON.stringify(caught)).toBe(true);
    const stamp = await syncedAt(device);
    expect(readTime(stamp)).toBeGreaterThan(hydrated);
    await tick();

    expect((await device.catchUp()).ok).toBe(false);
    expect(
      await syncedAt(device),
      "a catch-up whose credential was refused moved the time the copy last synced",
    ).toBe(stamp);
  });

  it("keeps synced_at when a catch-up ends part way, though it applied what came before", async () => {
    harness = await startHarness("synced-at-catch-up-part-way");
    const { server, device } = harness;
    scriptPulls(
      server,
      copyIncompleteReplay("12", [
        copyItemEvent("11", "item.created", wireItem({ id: "n2" })),
      ]),
    );
    expect((await device.hydrate(["core.note"], "library")).ok).toBe(true);
    const stamp = await syncedAt(device);
    readTime(stamp);
    await tick();

    expect((await device.catchUp()).ok).toBe(false);
    expect(
      (await device.get("n2")).ok,
      "the event before the end was not applied, so nothing below is about a catch-up that ended part way",
    ).toBe(true);
    expect(
      await syncedAt(device),
      "a catch-up that never reached the head of the log moved the time the copy last synced",
    ).toBe(stamp);
  });

  it("keeps synced_at when the copy goes stale", async () => {
    harness = await startHarness("synced-at-stale");
    const { server, device } = harness;
    scriptPulls(server, {
      kind: "sse",
      frames: [connected, copyStreamCursor("900"), catchupTooOld("500", "10")],
    });
    expect((await device.hydrate(["core.note"], "library")).ok).toBe(true);
    const stamp = await syncedAt(device);
    readTime(stamp);

    expect((await device.catchUp()).ok).toBe(false);
    const status = await device.status();
    expect(
      status.ok && status.value.hydration,
      "the copy did not go stale, so nothing below is about a stale one",
    ).toBe("stale");
    expect(
      await syncedAt(device),
      "a copy that went stale lost the time it last synced",
    ).toBe(stamp);
  });

  it("moves synced_at when a follow reaches the head of the log", async () => {
    harness = await startHarness("synced-at-follow");
    const { server, device } = harness;
    scriptPulls(
      server,
      copyLiveReplay("11", [
        copyItemEvent("11", "item.created", wireItem({ id: "n2" })),
      ]),
    );
    expect((await device.hydrate(["core.note"], "library")).ok).toBe(true);
    const hydrated = readTime(await syncedAt(device));
    await tick();

    const followed = await device.follow(2);
    expect(followed.ok, JSON.stringify(followed)).toBe(true);
    expect((await device.get("n2")).ok).toBe(true);
    expect(
      readTime(await syncedAt(device)),
      "a follow that applied the server's events and reached the head left the time of the hydration",
    ).toBeGreaterThan(hydrated);
  });

  it("keeps synced_at through a follow that applies events but never reaches the head", async () => {
    harness = await startHarness("synced-at-follow-short");
    const { server, device } = harness;
    scriptPulls(
      server,
      copyIncompleteReplay("12", [
        copyItemEvent("11", "item.created", wireItem({ id: "n2" })),
      ]),
      { kind: "drop" },
    );
    expect((await device.hydrate(["core.note"], "library")).ok).toBe(true);
    const stamp = await syncedAt(device);
    readTime(stamp);
    await tick();

    await device.follow(2);
    expect(
      (await device.get("n2")).ok,
      "the follow applied nothing, so nothing below is about one that applied events",
    ).toBe(true);
    expect(
      await syncedAt(device),
      "a follow that never reached the head of the log moved the time the copy last synced",
    ).toBe(stamp);
  });

  it("keeps synced_at through a drain", async () => {
    harness = await startHarness("synced-at-drain");
    const { server, device } = harness;
    scriptPulls(server, copyReplay("10", []));
    expect((await device.hydrate(["core.note"], "library")).ok).toBe(true);
    const stamp = await syncedAt(device);
    readTime(stamp);
    await tick();

    const queued = await device.create({
      type: "core.note",
      properties: { title: "sent", body: "sent" },
    });
    expect(queued.ok, JSON.stringify(queued)).toBe(true);
    const sent = wireItem({
      id: queued.ok ? (queued.value.item_id ?? "") : "",
      properties: { title: "sent", body: "sent" },
    });
    scriptWrites(server, {
      create: [answers.created(sent)],
      read: [answers.updated(sent)],
    });
    const drained = await device.drain();
    expect(drained.ok, JSON.stringify(drained)).toBe(true);
    expect(
      drained.ok && drained.value.answered,
      "the drain sent nothing, so nothing below is about a drain that reached the server",
    ).toBe(1);
    expect(
      await syncedAt(device),
      "a drain, which pulls nothing, moved the time the copy last synced",
    ).toBe(stamp);
  });

  it("removes synced_at when a hydration clears the copy", async () => {
    harness = await startHarness("synced-at-cleared");
    const { server, device } = harness;
    let cut = false;
    scriptHydration(server, {
      head: "10",
      pageSize: 1,
      drop: () => cut,
      rows: {
        "core.note": [{ item: { id: "n1" } }],
        "core.bookmark": [
          { item: { id: "b1", type: "core.bookmark" } },
          { item: { id: "b2", type: "core.bookmark" } },
        ],
      },
    });
    expect((await device.hydrate(["core.note"], "library")).ok).toBe(true);
    readTime(await syncedAt(device));

    cut = true;
    expect(
      (await device.hydrate(["core.note", "core.bookmark"], "library")).ok,
      "the interrupted hydration succeeded, so nothing below is about a copy it cleared",
    ).toBe(false);
    const status = await device.status();
    expect(status.ok && status.value.hydration).toBe("in_progress");
    expect(
      await syncedAt(device),
      "a copy a hydration cleared and has not filled still says when it last synced",
    ).toBeNull();
  });
});
