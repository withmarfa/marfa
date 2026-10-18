import { DatabaseSync } from "node:sqlite";
import { describe, it, expect, afterEach, vi } from "vitest";
import type { BindingHarness } from "./harness.js";
import {
  BUSY,
  HELD,
  bindingHarness,
  createsSent,
  nextWait,
  queueNotes,
  streamsAsked,
  takeCreates,
  untilHeld,
  untilReached,
  untilTold,
} from "./binding.shared.js";
import {
  catchupTooOld,
  connected,
  copyHeadRead,
  copyHeldLog,
  copyItemEvent,
  copyStreamCursor,
  typeCatalog,
  wireItem,
  wireType,
} from "../../device/marfa-answers.js";
import { BUILT_FOR, type Answer } from "../../device/scripted-server.js";

/**
 * A held stream followed through the binding: the rules a caller can reach
 * only by what a binding takes and tells. The command takes no word about
 * what its caller was last told, tells its changes as lines of JSON rather
 * than typed values, and cannot run a second call on the working copy it
 * follows. The wait before a stream is asked for again is read from the
 * engine's manual clock, so no fixture waits for it.
 */

let harness: BindingHarness | undefined;

afterEach(async () => {
  await harness?.stop();
  harness = undefined;
});

describe("a follow through a binding, told what its caller was last told", () => {
  it("tells its caller the server is reachable when its first stream is had at once, where the caller was last told it was not", async () => {
    harness = await bindingHarness("binding-told-reachable");
    const { server, device } = harness;

    const before = streamsAsked(server).length;
    const told = await device.follow({ toldUnreachable: true });
    await untilTold(told, ["serverReachable"], "the follow said nothing");
    expect(
      streamsAsked(server).length - before,
      "the follow told its caller the server was reachable before it had a stream",
    ).toBe(1);
    expect(
      told.changes[0],
      "a change about the server named a row, or not the cursor held",
    ).toEqual({ kind: "serverReachable", cursor: "10" });
    expect(await told.stop()).toBeNull();

    // The witness: the same stream, for a caller that said nothing, is had in
    // silence.
    const quiet = await device.follow();
    await vi.waitFor(
      () => {
        expect(streamsAsked(server).length - before).toBe(2);
      },
      { timeout: 10_000, interval: 20 },
    );
    expect(await quiet.stop()).toBeNull();
    expect(
      quiet.changes,
      "a caller that was not last told the server was lost was told it was back",
    ).toEqual([]);
  });

  it("does not tell its caller the server is unreachable again where it was last told so, and tells it the server is reachable when a stream is had", async () => {
    const followed = await bindingHarness("binding-told-not-again");
    harness = followed;
    const { server, device, events } = followed;
    events.set(BUSY, BUSY, HELD);
    await device.clock.manual();

    const before = streamsAsked(server).length;
    const told = await device.follow({ toldUnreachable: true });
    expect(await nextWait(device)).toBe(1_000);
    expect(streamsAsked(server).length - before).toBe(1);
    await device.clock.advance(1_000);
    expect(await nextWait(device)).toBe(2_000);
    expect(streamsAsked(server).length - before).toBe(2);
    expect(
      told.kinds,
      "a caller last told the server was lost was told so again by a follow that could not reach it",
    ).toEqual([]);
    await device.clock.advance(2_000);
    await untilTold(
      told,
      ["serverReachable"],
      "the follow did not tell its caller the server was back",
    );
    expect(await told.stop()).toBeNull();

    // The witness: a caller that was not told is told once, on the first
    // refusal, for the same streams.
    events.set(BUSY, HELD);
    const fresh = await device.follow();
    await untilTold(
      fresh,
      ["serverUnreachable"],
      "a follow that could not reach the server did not tell a caller that had not been told so",
    );
    expect(await fresh.stop()).toBeNull();
  });
});

describe("the wait before a held stream is asked for again", () => {
  it("doubles the wait before it asks for a held stream again up to thirty seconds, and waits no longer unless the server names a longer wait", async () => {
    const followed = await bindingHarness("binding-backoff-cap");
    harness = followed;
    const { server, device, events } = followed;
    // Every stream is refused, until the fixture lets one through.
    let named: Answer | undefined;
    events.set(() => named ?? BUSY);
    await device.clock.manual();

    const before = streamsAsked(server).length;
    const told = await device.follow();
    const waited: number[] = [];
    for (let round = 0; round < 7; round += 1) {
      const asked = await nextWait(device);
      waited.push(asked);
      expect(
        streamsAsked(server).length - before,
        "the follow asked again before the wait it had was spent",
      ).toBe(round + 1);
      // The last is left unspent, so the answer to the stream after it is
      // set before it is asked for.
      if (round < 6) await device.clock.advance(asked);
    }
    expect(
      waited,
      "the wait did not double from a second, or went past thirty seconds",
    ).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]);

    // A server that names a longer wait is waited for as long as it names.
    named = {
      kind: "json",
      status: 429,
      headers: { "retry-after": "45" },
      body: { error: { code: "rate_limited", message: "Too many requests" } },
    };
    await device.clock.advance(30_000);
    expect(
      await nextWait(device),
      "a wait the server named was cut to the cap",
    ).toBe(45_000);
    named = HELD;
    await device.clock.advance(45_000);
    await untilTold(
      told,
      ["serverUnreachable", "serverReachable"],
      "the follow did not have its stream after the wait the server named",
    );
    expect(await told.stop()).toBeNull();
  });
});

describe("what a follow through a binding tells", () => {
  it("tells that the catalog changed, that the server was lost and is back, and what a drain did or failed to do, each as a change of its own kind apart from the events the stream applied", async () => {
    let registered = false;
    const followed = await bindingHarness("binding-change-kinds", {
      setup: ({ server }) => {
        // The hydration reads it once; every read after reads what the
        // fixture has registered by then.
        server.copyAnswer("GET", "/types", () =>
          typeCatalog(
            registered
              ? [wireType("acme.late-note", { parent: "core.note" })]
              : [],
          ),
        );
      },
    });
    harness = followed;
    const { server, device, events } = followed;
    // The first stream is refused, and the second carries one event.
    events.set(BUSY, {
      kind: "sse",
      hold: true,
      frames: [
        connected,
        copyStreamCursor("11"),
        copyItemEvent(
          "11",
          "item.created",
          wireItem({
            id: "arrived",
            properties: { title: "arrived", body: "live" },
          }),
        ),
      ],
    });
    await device.clock.manual();
    // The first create is taken; the second is answered as another contract
    // would answer it, which a drain cannot read.
    takeCreates(server, (take) => [
      take,
      {
        kind: "json",
        status: 201,
        body: {},
        contract: String(Number(BUILT_FOR) + 1),
      },
    ]);
    await queueNotes(device, "first");

    const lost = await device.follow();
    expect(await nextWait(device)).toBe(1_000);
    registered = true;
    await device.clock.advance(1_000);
    await vi.waitFor(
      () => {
        expect(lost.kinds).toContain("queueDrained");
        expect(lost.kinds).toContain("applied");
      },
      { timeout: 10_000, interval: 20 },
    );
    expect(await lost.stop()).toBeNull();

    // A caller last told the server was lost, with a write the server will
    // not take from it.
    await queueNotes(device, "second");
    events.set(HELD);
    const back = await device.follow({ toldUnreachable: true });
    await untilTold(
      back,
      ["serverReachable", "queueNotDrained"],
      "a drain that ended with an error was not told, or was told as drained",
    );
    expect(await back.stop()).toBeNull();

    const told = [...lost.changes, ...back.changes];
    const kinds = told.map((change) => change.kind);
    expect(
      [...new Set(kinds)].sort(),
      "a change was told as the kind of another",
    ).toEqual(
      [
        "applied",
        "catalogChanged",
        "queueDrained",
        "queueNotDrained",
        "serverReachable",
        "serverUnreachable",
      ].sort(),
    );
    const at = (kind: (typeof kinds)[number]) => kinds.indexOf(kind);
    expect(at("serverUnreachable")).toBe(0);
    expect(at("serverReachable")).toBe(1);
    expect(
      at("queueDrained"),
      "the drain was told before the server was back",
    ).toBeGreaterThan(at("serverReachable"));
    expect(kinds.filter((kind) => kind === "applied")).toHaveLength(1);

    // An event the stream applied is the only change that names an event, a
    // row or an edge.
    for (const change of told) {
      if (change.kind === "applied") {
        expect(change).toEqual({
          kind: "applied",
          event: "item.created",
          itemId: "arrived",
          cursor: "11",
        });
      } else {
        expect(
          Object.keys(change).filter((name) =>
            ["event", "itemId", "edgeId"].includes(name),
          ),
          `a change of kind ${change.kind} named an event or a row`,
        ).toEqual([]);
      }
    }
    const drained = told.find((change) => change.kind === "queueDrained");
    expect(drained?.kind === "queueDrained" && drained.report.answered).toBe(1);
    const notDrained = told.find((change) => change.kind === "queueNotDrained");
    expect(
      notDrained?.kind === "queueNotDrained" && notDrained.reason,
      "the caller was not told why",
    ).toContain("contract");
    const unreachable = told[0];
    expect(
      unreachable?.kind === "serverUnreachable" && unreachable.reason,
      "the caller was not told why",
    ).toContain("503");
  });
});

describe("a drain a held stream starts when its server is back", () => {
  it("starts the held stream's drain only after the drain its caller started has ended, and drains nothing where that drain left no work", async () => {
    const followed = await bindingHarness("binding-drain-one-nothing");
    harness = followed;
    const { server, device } = followed;
    const [queued] = await queueNotes(device, "the caller's");
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    takeCreates(server, (take) => [
      (request) => ({ kind: "gated", until: gate, then: take(request) }),
    ]);

    // The caller's drain is under way, its write sent and not answered.
    const callers = device.drain();
    await vi.waitFor(() => {
      expect(createsSent(server)).toEqual([queued]);
    });
    const follow = await device.follow({ toldUnreachable: true });
    await untilTold(follow, ["serverReachable"], "the follow said nothing");
    await untilReached(device, "recovery-drain-asked");
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(
      createsSent(server),
      "the held stream's drain sent the write the caller's drain had in flight",
    ).toEqual([queued]);
    expect(callers.settled).toBe(false);

    release();
    const drained = await callers;
    expect(drained.ok && drained.value.answered, JSON.stringify(drained)).toBe(
      1,
    );
    await untilReached(device, "recovery-drain-found-none");
    expect(await follow.stop()).toBeNull();
    expect(
      follow.kinds,
      "the held stream told a drain of a queue the caller's drain had emptied",
    ).toEqual(["serverReachable"]);
    expect(createsSent(server), "a write was sent more than once").toEqual([
      queued,
    ]);
  });

  it("drains what the caller's drain left once it has ended, each write sent once", async () => {
    const followed = await bindingHarness("binding-drain-one-remaining");
    harness = followed;
    const { server, device } = followed;
    const [first] = await queueNotes(device, "the caller's");
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    takeCreates(server, (take) => [
      (request) => ({ kind: "gated", until: gate, then: take(request) }),
    ]);

    const callers = device.drain();
    await vi.waitFor(() => {
      expect(createsSent(server)).toEqual([first]);
    });
    const follow = await device.follow({ toldUnreachable: true });
    await untilTold(follow, ["serverReachable"], "the follow said nothing");
    await untilReached(device, "recovery-drain-asked");
    // Queued while the caller's drain is under way.
    const [second] = await queueNotes(device, "queued meanwhile");
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(createsSent(server)).toEqual([first]);

    release();
    expect((await callers).ok).toBe(true);
    await untilTold(
      follow,
      ["serverReachable", "queueDrained"],
      "the held stream did not drain what the caller's drain left",
    );
    expect(await follow.stop()).toBeNull();
    expect(
      createsSent(server),
      "a write was sent more than once, or not in the order it was made",
    ).toEqual([first, second]);
    const drained = follow.changes[1];
    expect(
      drained?.kind === "queueDrained" &&
        drained.report.verdicts.map((verdict) => verdict.itemId),
      "the held stream's drain sent a write other than the one left",
    ).toEqual([second]);
  });
});

describe("a follow that waits for a hydration", () => {
  /** The generation of the copy, which expiring it moves. */
  function generation(store: string): unknown {
    const db = new DatabaseSync(store, { readOnly: true });
    try {
      return (
        db
          .prepare("SELECT value FROM meta WHERE key = 'copy_generation'")
          .get() as { value?: unknown } | undefined
      )?.value;
    } finally {
      db.close();
    }
  }

  it("ends a follow copy_expired at once, sending nothing, when the hydration it waits for expires the copy", async () => {
    const followed = await bindingHarness("binding-expired-waiting", {
      hydrate: false,
      // The log has aged past the head the hydration read.
      log: [
        copyHeadRead("10"),
        {
          kind: "sse",
          frames: [
            connected,
            copyStreamCursor("900"),
            catchupTooOld("500", "10"),
          ],
        },
      ],
    });
    harness = followed;
    const { server, device } = followed;

    const follow = await device.follow();
    await untilReached(device, "follow-waiting");
    expect(
      server.requests,
      "a follow waiting for a hydration asked the server",
    ).toEqual([]);
    expect(follow.isOver).toBe(false);

    const fresh = generation(device.store);
    const hydration = await device.hydrate(["core.note"], "library");
    expect(hydration.ok ? "complete" : hydration.refusal.code).toBe(
      "copy_expired",
    );
    const expired = generation(device.store);
    // The witness: expiring the copy moves its generation.
    expect(expired).not.toBe(fresh);
    const requests = server.requests.length;

    const ended = await Promise.race([
      follow.ended,
      new Promise<"waiting">((resolve) =>
        setTimeout(() => {
          resolve("waiting");
        }, 3_000),
      ),
    ]);
    expect(
      ended,
      "the follow went on waiting for a hydration that had expired the copy",
    ).not.toBe("waiting");
    expect(ended).toMatchObject({ code: "copy_expired" });
    expect(
      server.requests.length,
      "the follow sent something once the copy had expired",
    ).toBe(requests);
    expect(
      generation(device.store),
      "the follow expired a copy that was expired already",
    ).toBe(expired);
    const status = await device.status();
    expect(status.ok && status.value.hydration).toBe("expired");
  });

  it("opens the stream of a follow that waited for a hydration from the cursor the hydration stored, sending nothing before", async () => {
    const followed = await bindingHarness("binding-after-hydration", {
      hydrate: false,
      head: "37",
      streams: [
        copyHeldLog([
          copyItemEvent(
            "38",
            "item.created",
            wireItem({
              id: "arrived",
              properties: { title: "arrived", body: "live" },
            }),
          ),
        ]),
      ],
    });
    harness = followed;
    const { server, device } = followed;

    const follow = await device.follow();
    await untilReached(device, "follow-waiting");
    expect(
      server.requests,
      "a follow waiting for a hydration asked the server",
    ).toEqual([]);

    const hydration = await device.hydrate(["core.note"], "library");
    expect(
      hydration.ok && hydration.value.cursor,
      JSON.stringify(hydration),
    ).toBe("37");
    await vi.waitFor(
      () => {
        expect(
          follow.changes,
          "the follow did not apply what its stream carried",
        ).toEqual([
          {
            kind: "applied",
            event: "item.created",
            itemId: "arrived",
            cursor: "38",
          },
        ]);
      },
      { timeout: 10_000, interval: 20 },
    );
    expect(await follow.stop()).toBeNull();
    expect(
      streamsAsked(server).map((request) => request.headers["last-event-id"]),
      "the follow opened its stream from somewhere other than the cursor the hydration stored",
    ).toEqual([undefined, "37", "37"]);
    expect(follow.isOver).toBe(true);
  });
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
