import { describe, it, expect, afterEach, vi } from "vitest";
import type { Subscription } from "../../device/binding-adapter.js";
import { StreamFeed, BUILT_FOR } from "../../device/scripted-server.js";
import type { BindingHarness } from "./harness.js";
import { KEY, startBindingHarness } from "./harness.js";
import {
  BUSY,
  bindingHarness,
  heldBy,
  nextWait,
  noteMade,
  quietly,
  streamsAsked,
  untilOpen,
  untilTold,
  type Followed,
} from "./binding.shared.js";

/**
 * The watch an app's listeners share, driven through the binding: the rules
 * that need two listeners on one working copy, a listener that is slow or
 * faults, or a store opened to read. The command runs one listener, so none
 * of them can be reached through it (`watch.test.ts` holds those that can).
 *
 * The stream a watch holds is one the fixture speaks on as it goes
 * (`StreamFeed`), so a change is told after a listener has joined, not at a
 * time the fixture guesses. The wait before a stream is asked for again is
 * read from the engine's manual clock.
 */

let harness: BindingHarness | undefined;

afterEach(async () => {
  await harness?.stop();
  harness = undefined;
});

/** The ids an `applied` change named, in the order told. */
function ids(listener: Subscription): string[] {
  return listener.changes.flatMap((change) =>
    change.kind === "applied" ? [change.itemId ?? ""] : [],
  );
}

/** Waits until `listener` has been told `count` events the stream applied. */
async function untilApplied(
  listener: Subscription,
  count: number,
  why: string,
): Promise<void> {
  await vi.waitFor(
    () => {
      expect(ids(listener).length, why).toBeGreaterThanOrEqual(count);
    },
    { timeout: 10_000, interval: 20 },
  );
}

/** A copy whose first stream is held and spoken on through `feed`. */
async function watched(
  label: string,
): Promise<Followed & { feed: StreamFeed }> {
  const feed = new StreamFeed();
  const started = await bindingHarness(label, { streams: [heldBy(feed)] });
  harness = started;
  return { ...started, feed };
}

describe("listeners that share one watch", () => {
  it("holds one stream for every listener, and tells each of them each change in the order the stream carried it", async () => {
    const { server, device, feed } = await watched("binding-watch-one-stream");
    const before = streamsAsked(server).length;

    const first = await device.watch();
    const second = await device.watch();
    await untilOpen(feed);
    feed.push(noteMade("n1", "11"), noteMade("n2", "12"), noteMade("n3", "13"));
    for (const listener of [first, second]) {
      await untilApplied(listener, 3, "a listener was not told each change");
      expect(ids(listener)).toEqual(["n1", "n2", "n3"]);
    }
    await quietly();
    expect(
      streamsAsked(server).length - before,
      "a second listener opened a second stream",
    ).toBe(1);
    expect(feed.opened).toBe(1);

    // The witness: the stream is asked for when a watch needs one, so the
    // one above was counted.
    expect(await first.stop()).toBeNull();
    expect(await second.stop()).toBeNull();
  });

  it("tells a listener each change made after it joined and none made before", async () => {
    const { device, feed } = await watched("binding-watch-from-join");
    const early = await device.watch();
    await untilOpen(feed);
    feed.push(noteMade("before", "11"));
    await untilApplied(early, 1, "the early listener was not told");

    const late = await device.watch();
    expect(late.changes).toEqual([]);
    feed.push(noteMade("after", "12"));
    await untilApplied(late, 1, "the late listener was told nothing");
    await untilApplied(early, 2, "the early listener missed a change");
    await quietly();
    expect(
      ids(late),
      "a listener was told a change made before it joined",
    ).toEqual(["after"]);
    expect(ids(early)).toEqual(["before", "after"]);
  });

  it("tells a listener that joins while the server is unreachable so, with why, before any later change", async () => {
    const feed = new StreamFeed();
    const started = await bindingHarness("binding-watch-join-outage", {
      streams: [BUSY, heldBy(feed)],
    });
    harness = started;
    const { device } = started;
    await device.clock.manual();

    const early = await device.watch();
    await untilTold(early, ["serverUnreachable"], "the outage was not told");
    expect(await nextWait(device)).toBe(1_000);

    const late = await device.watch();
    await untilTold(
      late,
      ["serverUnreachable"],
      "a listener that joined during the outage was not told of it",
    );
    const [first] = early.changes;
    const [joined] = late.changes;
    expect(
      joined?.kind === "serverUnreachable" && joined.reason,
      "the listener was not told why",
    ).toContain("503");
    expect(joined).toEqual(first);

    await device.clock.advance(1_000);
    await untilOpen(feed);
    feed.push(noteMade("n1", "11"));
    for (const listener of [early, late]) {
      await untilTold(
        listener,
        ["serverUnreachable", "serverReachable", "applied"],
        "a change was told before the outage, or the outage was not ended first",
      );
    }
  });

  it("tells a listener that joins a held stream, and says it was last told the server was unreachable, that the server is reachable", async () => {
    const { device, feed } = await watched("binding-watch-join-reachable");
    const early = await device.watch();
    await untilOpen(feed);
    feed.push(noteMade("n1", "11"));
    await untilApplied(early, 1, "the stream was not had");

    const restarted = await device.watch({ toldUnreachable: true });
    await untilTold(
      restarted,
      ["serverReachable"],
      "a caller that restarted its watch was left showing an outage that is over",
    );
    // The witness: a listener that was not told it was lost is told nothing.
    const quiet = await device.watch();
    await quietly();
    expect(quiet.changes).toEqual([]);
    expect(early.kinds).toEqual(["applied"]);
  });

  it("tells a listener that joins a watch that failed so, with the error, before any later change", async () => {
    const started = await bindingHarness("binding-watch-join-failed");
    harness = started;
    const { device, server } = started;
    // The stream is asked for on a contract this device cannot read.
    server.contract = String(Number(BUILT_FOR) + 1);

    const early = await device.watch();
    await untilTold(early, ["watchFailed"], "the failure was not told");
    const late = await device.watch();
    await untilTold(
      late,
      ["watchFailed"],
      "a listener that joined a failed watch was not told it had failed",
    );
    const [failed] = late.changes;
    expect(
      failed?.kind === "watchFailed" && [failed.code, failed.reason],
      "the failure carried no error",
    ).toEqual([
      "contract_mismatch",
      expect.stringContaining("contract") as unknown,
    ]);
    expect(late.isOver, "a failure ended a listener").toBe(false);
    expect(early.isOver).toBe(false);
  });
});

describe("a listener that stops, or faults", () => {
  it("tells a listener it ended once when it stops, and nothing after, while the others go on", async () => {
    const { device, feed } = await watched("binding-watch-listener-ends");
    const leaving = await device.watch();
    const staying = await device.watch();
    await untilOpen(feed);
    feed.push(noteMade("n1", "11"));
    await untilApplied(leaving, 1, "the stream was not had");

    expect(await leaving.stop()).toBeNull();
    // Stopped again: it is told once.
    expect(await leaving.stop()).toBeNull();
    feed.push(noteMade("n2", "12"));
    await untilApplied(staying, 2, "the watch stopped for the others");
    await quietly();
    expect(leaving.endings, "a listener was told it ended more than once").toBe(
      1,
    );
    expect(
      leaving.afterEnd,
      "a listener was told a change after it was told it ended",
    ).toEqual([]);
    expect(ids(leaving)).toEqual(["n1"]);
    // The witness: a listener still watching is told the change.
    expect(ids(staying)).toEqual(["n1", "n2"]);
    expect(staying.endings).toBe(0);
  });

  it("lets go of the working copy's store before it tells the last listener of a watch that it ended", async () => {
    const { device, server, feed } = await watched("binding-watch-released");
    const only = await device.watch({
      openOnEnd: {
        path: device.store,
        url: server.url,
        key: KEY,
      },
    });
    await untilOpen(feed);
    // The binding lets go of its own hold, so the watch's is the one left.
    await device.forget();
    const held = await device.tryOpen(server.url, KEY);
    expect(
      held,
      "the store could be taken as a writer while a watch held it, so the opening below proves nothing",
    ).toEqual({ opened: true, handle: "reader" });

    expect(await only.stop()).toBeNull();
    expect(
      only.openedOnEnd,
      "the listener was not told it ended",
    ).toBeDefined();
    expect(
      only.openedOnEnd,
      "the watch still held the store when its last listener was told it ended",
    ).toEqual({ opened: true, handle: "writer" });
  });

  it("tells every listener every change in order, losing none, while one of them takes long to return from each", async () => {
    const { device, feed } = await watched("binding-watch-slow");
    const slow = await device.watch({ slowMs: 40 });
    const quick = await device.watch();
    await untilOpen(feed);
    const wanted = Array.from(
      { length: 60 },
      (_, index) => `n${String(index)}`,
    );
    feed.push(...wanted.map((id, index) => noteMade(id, String(11 + index))));
    for (const listener of [slow, quick]) {
      await vi.waitFor(
        () => {
          expect(ids(listener).length).toBeGreaterThanOrEqual(wanted.length);
        },
        { timeout: 20_000, interval: 50 },
      );
      expect(
        ids(listener),
        "a change was lost, or told out of order, while a listener was slow",
      ).toEqual(wanted);
    }
  });

  it("ends a listener that faults with the fault, and tells every other listener the change it faulted on", async () => {
    const { device, feed } = await watched("binding-watch-faults");
    const faulting = await device.watch({ throwAt: 1 });
    const steady = await device.watch();
    await untilOpen(feed);
    feed.push(
      noteMade("n1", "11"),
      noteMade("n2", "12"),
      noteMade("n3", "13"),
      noteMade("n4", "14"),
    );
    await untilApplied(steady, 4, "a listener's fault stopped the others");
    await vi.waitFor(
      () => {
        expect(faulting.endings, "a listener that faulted was not ended").toBe(
          1,
        );
      },
      { timeout: 5_000, interval: 20 },
    );
    const ended = await faulting.ended;
    expect(
      ended,
      "a listener that faulted was ended with no error",
    ).toMatchObject({ code: "listener_threw" });
    expect(ended?.message).toContain("faulted");
    expect(faulting.endings).toBe(1);
    await quietly();
    expect(
      ids(faulting),
      "a listener was told on after the change it faulted on",
    ).toEqual(["n1", "n2"]);
    expect(
      ids(steady),
      "another listener missed a change, or was told them out of order",
    ).toEqual(["n1", "n2", "n3", "n4"]);
    expect(steady.endings).toBe(0);
  });
});

describe("a watch of a store opened to read", () => {
  /** A store a writer holds, and the reading handle that watches it. */
  async function reading(label: string) {
    const started = await startBindingHarness(label);
    harness = started;
    const reader = await started.reader();
    return { ...started, reading: reader };
  }

  it("tells every listener once that the watch failed where it cannot read the store's data version", async () => {
    const { reading: reader } = await reading("binding-watch-reads-failed");
    const first = await reader.watch();
    const second = await reader.watch();
    await quietly();
    expect(
      first.changes,
      "a listener was told something before any save",
    ).toEqual([]);

    await reader.hooks.fail("data-version");
    for (const listener of [first, second]) {
      await untilTold(listener, ["watchFailed"], "the failure was not told");
    }
    const failed = await reader.hooks.reached("data-version");
    // Reads go on failing, and the failure is not told again.
    await vi.waitFor(
      async () => {
        expect(await reader.hooks.reached("data-version")).toBeGreaterThan(
          failed + 1,
        );
      },
      { timeout: 10_000, interval: 50 },
    );
    expect(first.kinds, "a failure was told more than once").toEqual([
      "watchFailed",
    ]);
    expect(second.kinds).toEqual(["watchFailed"]);

    // The witness: once it reads again the listeners are told.
    await reader.hooks.fail("data-version", false);
    for (const listener of [first, second]) {
      await untilTold(
        listener,
        ["watchFailed", "saved"],
        "the watch did not read again",
      );
    }
  });

  it("tells every listener a save when the watch reads the data version again after a read failed, though no save was made", async () => {
    const { reading: reader } = await reading("binding-watch-reads-mended");
    const version = await reader.dataVersion();
    expect(version.ok, JSON.stringify(version)).toBe(true);
    const first = await reader.watch();
    const second = await reader.watch();
    await quietly();
    expect(first.changes).toEqual([]);

    await reader.hooks.fail("data-version");
    await untilTold(first, ["watchFailed"], "the failure was not told");
    await untilTold(second, ["watchFailed"], "the failure was not told");
    await reader.hooks.fail("data-version", false);
    for (const listener of [first, second]) {
      await untilTold(
        listener,
        ["watchFailed", "saved"],
        "a save may have gone unseen while reads failed, and no listener was told",
      );
      expect(
        listener.changes[1],
        "the save named a version other than the one the store holds",
      ).toMatchObject({
        kind: "saved",
        dataVersion: version.ok ? version.value : -1,
      });
    }
    // The witness: with the reads working, a version that has not moved is
    // told to no one.
    await quietly(800);
    expect(first.kinds).toEqual(["watchFailed", "saved"]);
  });
});

describe("a working copy with no server", () => {
  it("refuses a watch of it no_server", async () => {
    harness = await startBindingHarness("binding-watch-no-server", {
      server: false,
    });
    const { device } = harness;
    const refused = await device.tryWatch();
    expect(
      !refused.ok && refused.refusal.code,
      `a copy with no server was watched: ${JSON.stringify(refused)}`,
    ).toBe("no_server");

    // The witness: a copy with a server is watched.
    const fed = await bindingHarness("binding-watch-with-server");
    const accepted = await fed.device.tryWatch();
    expect(accepted.ok, JSON.stringify(accepted)).toBe(true);
    await fed.stop();
  });
});
