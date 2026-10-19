import { describe, it, expect, afterEach, vi } from "vitest";
import type { Subscription } from "../../device/binding-adapter.js";
import {
  copyHeadRead,
  copyReplay,
  refusal,
} from "../../device/marfa-answers.js";
import {
  BUILT_FOR,
  StreamFeed,
  type Answer,
  type RecordedRequest,
} from "../../device/scripted-server.js";
import type { BindingHarness } from "./harness.js";
import {
  BUSY,
  bindingHarness,
  createsSent,
  heldBy,
  nextWait,
  noteMade,
  queueNotes,
  quietly,
  streamsAsked,
  takeCreates,
  untilOpen,
  untilOpened,
  untilTold,
} from "./binding.shared.js";

/**
 * What a watch does around the calls its caller makes on the same working
 * copy: a hydration or a catch-up that takes its stream and gives it back, a
 * drain the caller starts, and a watch that failed. Each needs a call on a
 * copy a watch is running on, which the command, one call at a time in a
 * process of its own, cannot make. The wait before a stream is asked for
 * again is read from the engine's manual clock.
 */

let harness: BindingHarness | undefined;

afterEach(async () => {
  await harness?.stop();
  harness = undefined;
});

function ids(listener: Subscription): string[] {
  return listener.changes.flatMap((change) =>
    change.kind === "applied" ? [change.itemId ?? ""] : [],
  );
}

/** The cursor each stream the engine asked for was opened from. */
function openedFrom(
  server: BindingHarness["server"],
): Array<string | undefined> {
  return streamsAsked(server).map(
    (request) => request.headers["last-event-id"],
  );
}

describe("a hydration or a catch-up called on a copy that is watched", () => {
  it.each(["a catch-up", "a hydration"] as const)(
    "tells a listener that was last told the server was unreachable that it is reachable when %s succeeds",
    async (call) => {
      const started = await bindingHarness("binding-watch-recovery", {
        streams: [BUSY],
      });
      harness = started;
      const { device, events } = started;
      await device.clock.manual();
      const listener = await device.watch();
      await untilTold(
        listener,
        ["serverUnreachable"],
        "the outage was not told",
      );
      expect(await nextWait(device)).toBe(1_000);
      // The watch is waiting out its retry: the clock is never moved, so only
      // the call below can end the outage.
      events.set(
        ...(call === "a catch-up"
          ? [copyReplay("10", [])]
          : [copyHeadRead("20"), copyReplay("20", [])]),
        // The stream the watch holds again is refused, so that only the call
        // itself can have told the listener the server was reachable.
        BUSY,
      );
      await quietly();
      expect(
        listener.kinds,
        "the outage ended with no call that reached the server",
      ).toEqual(["serverUnreachable"]);

      const done =
        call === "a catch-up"
          ? await device.catchUp()
          : await device.hydrate(["core.note"], "library");
      expect(done.ok, JSON.stringify(done)).toBe(true);
      await untilTold(
        listener,
        ["serverUnreachable", "serverReachable", "serverUnreachable"],
        `${call} that reached the server left a listener showing an outage that is over`,
      );
      const [, reachable] = listener.changes;
      expect(
        reachable?.cursor,
        "the listener was told the cursor from before the call",
      ).toBe(call === "a catch-up" ? "10" : "20");
    },
  );

  it.each(["a catch-up", "a hydration"] as const)(
    "takes the stream from the watch for %s without its caller stopping the watch, and holds it again from the cursor the call left",
    async (call) => {
      const feed = new StreamFeed();
      const started = await bindingHarness("binding-watch-takeover", {
        streams: [heldBy(feed)],
      });
      harness = started;
      const { device, server, events } = started;
      const listener = await device.watch();
      await untilOpen(feed);
      feed.push(noteMade("n1", "11"));
      await vi.waitFor(() => {
        expect(ids(listener)).toEqual(["n1"]);
      });

      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const asked: Array<string | undefined> = [];
      const held =
        (then: Answer) =>
        (request: RecordedRequest): Answer => {
          asked.push(request.headers["last-event-id"]);
          return { kind: "gated", until: gate, then };
        };
      if (call === "a catch-up") {
        events.set(
          held(copyReplay("12", [noteMade("n2", "12")])),
          heldBy(feed),
        );
      } else {
        events.set(
          held(copyHeadRead("12")),
          copyReplay("12", []),
          heldBy(feed),
        );
      }

      const calling =
        call === "a catch-up"
          ? device.catchUp()
          : device.hydrate(["core.note"], "library");
      await vi.waitFor(() => {
        expect(asked).toHaveLength(1);
      });
      // The call has the stream. What the watch's old connection still
      // carries is not applied, and the watch asks for no stream of its own.
      feed.push(noteMade("lingering", "99"));
      await quietly();
      expect(calling.settled).toBe(false);
      expect(
        [asked, feed.opened],
        "the watch asked for a stream while the call held it",
      ).toEqual([[call === "a catch-up" ? "11" : undefined], 1]);
      expect([listener.isOver, listener.endings]).toEqual([false, 0]);
      expect(
        listener.kinds,
        "the watch went on applying its stream while a call held it, or told its listener of the gap",
      ).toEqual(["applied"]);

      release();
      const done = await calling;
      expect(
        done.ok && done.value.cursor,
        `the call was refused or did not reach the cursor: ${JSON.stringify(done)}`,
      ).toBe("12");
      await untilOpened(feed, 2);
      expect(
        openedFrom(server).at(-1),
        "the watch did not hold its stream again from the cursor the call left",
      ).toBe("12");
      feed.push(noteMade("n3", "13"));
      await vi.waitFor(() => {
        expect(ids(listener)).toEqual(["n1", "n3"]);
      });
      expect(
        [listener.isOver, listener.endings],
        "the listener was ended by the call, or by the stream coming back",
      ).toEqual([false, 0]);
    },
  );

  it.each(["a refusal", "a stop"] as const)(
    "holds the stream of the watch again from the cursor the call left where a catch-up ends on %s",
    async (ending) => {
      const feed = new StreamFeed();
      const started = await bindingHarness("binding-watch-takeover-ends", {
        streams: [heldBy(feed)],
      });
      harness = started;
      const { device, server, events } = started;
      const listener = await device.watch();
      await untilOpen(feed);
      feed.push(noteMade("n1", "11"));
      await vi.waitFor(() => {
        expect(ids(listener)).toEqual(["n1"]);
      });

      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let asked = 0;
      events.set(() => {
        asked += 1;
        return {
          kind: "gated",
          until: gate,
          then: refusal(503, "unavailable", "busy"),
        };
      }, heldBy(feed));
      const stop = await device.newStop();
      const catchUp = device.catchUp(ending === "a stop" ? stop : undefined);
      await vi.waitFor(() => {
        expect(asked).toBe(1);
      });
      if (ending === "a stop") await stop.raise();
      release();
      const ended = await catchUp;
      expect(
        ended.ok,
        `the catch-up did not end on ${ending}: ${JSON.stringify(ended)}`,
      ).toBe(false);

      await untilOpened(feed, 2);
      expect(
        openedFrom(server).at(-1),
        "the watch did not hold its stream again from the cursor the call left",
      ).toBe("11");
      expect([listener.isOver, listener.endings]).toEqual([false, 0]);
      feed.push(noteMade("n2", "12"));
      await vi.waitFor(() => {
        expect(ids(listener)).toEqual(["n1", "n2"]);
      });
    },
  );
});

describe("a drain its caller starts, on a copy that is watched", () => {
  it("tells a listener that was last told the server was unreachable that it is reachable when a drain answers a write, and not when it answers none", async () => {
    const started = await bindingHarness("binding-watch-drain-clears", {
      streams: [BUSY],
    });
    harness = started;
    const { device, server, events } = started;
    await device.clock.manual();
    takeCreates(server);
    const listener = await device.watch();
    await untilTold(listener, ["serverUnreachable"], "the outage was not told");
    expect(await nextWait(device)).toBe(1_000);

    // A drain that answers no write reaches no one.
    const empty = await device.drain();
    expect(empty.ok && empty.value.answered, JSON.stringify(empty)).toBe(0);
    await quietly();
    expect(
      listener.kinds,
      "a drain that answered nothing ended the outage",
    ).toEqual(["serverUnreachable"]);

    const [queued] = await queueNotes(device, "waiting");
    // The stream the watch asks for again is refused, so that only the drain
    // can have told the listener the server was reachable.
    events.set(BUSY);
    const drained = await device.drain();
    expect(drained.ok && drained.value.answered, JSON.stringify(drained)).toBe(
      1,
    );
    await untilTold(
      listener,
      ["serverUnreachable", "serverReachable", "serverUnreachable"],
      "a drain that reached the server left a listener showing an outage that is over",
    );
    expect(createsSent(server)).toEqual([queued]);
  });
});

describe("a watch that failed", () => {
  it("holds no stream for a failed watch until a catch-up has ended, and holds one then", async () => {
    const feed = new StreamFeed();
    const started = await bindingHarness("binding-watch-failed-holds", {
      streams: [heldBy(feed)],
    });
    harness = started;
    const { device, server, events } = started;
    await device.clock.manual();
    // The stream is asked for on a contract this device cannot read.
    server.contract = String(Number(BUILT_FOR) + 1);
    const listener = await device.watch();
    await untilTold(listener, ["watchFailed"], "the failure was not told");

    const asked = streamsAsked(server).length;
    await device.clock.advance(120_000);
    await quietly(600);
    expect(
      streamsAsked(server).length,
      "a stream was held for a watch that had failed",
    ).toBe(asked);
    expect(listener.kinds).toEqual(["watchFailed"]);

    // The witness: once a catch-up has ended, the stream is held again.
    server.contract = BUILT_FOR;
    events.set(copyReplay("10", []), heldBy(feed));
    const caughtUp = await device.catchUp();
    expect(caughtUp.ok, JSON.stringify(caughtUp)).toBe(true);
    await untilOpen(feed);
    expect(streamsAsked(server).length).toBeGreaterThan(asked);
    expect(listener.isOver).toBe(false);
  });
});
