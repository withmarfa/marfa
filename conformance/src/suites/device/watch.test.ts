import { describe, it, expect, afterEach, vi } from "vitest";
import {
  startHarness,
  scriptHydration,
  scriptWrites,
  type Harness,
} from "./harness.js";
import {
  answers,
  connected,
  copyItemEvent,
  copyStreamCursor,
  refusal,
  wireItem,
} from "../../device/marfa-answers.js";
import {
  BUILT_FOR,
  type Answer,
  type Responder,
} from "../../device/scripted-server.js";
import type { Change } from "../../device/protocol.js";

/**
 * The watch an app's listeners share: one source for a store, told to however
 * many listeners. The command line runs one listener, so the rules that need
 * two, or a hydration or catch-up called on a running watch, cannot be driven
 * through it (see the contract).
 */

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.stop();
  harness = undefined;
});

interface Watched {
  changes: Change[];
  code: number | null;
  stderr: string;
}

/** Runs `watch` for `seconds` and reads the line it printed for each change. */
async function watched(
  device: Harness["device"],
  seconds: number,
): Promise<Watched> {
  const run = device.hold(["watch", "--for", String(seconds)]);
  try {
    await run.exited();
  } finally {
    await run.stop();
  }
  return {
    changes: run.stdout
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as Change),
    code: run.exitCode(),
    stderr: run.stderr,
  };
}

async function queueNotes(
  device: Harness["device"],
  ...titles: string[]
): Promise<string[]> {
  const ids: string[] = [];
  for (const title of titles) {
    const queued = await device.create({
      type: "core.note",
      properties: { title, body: title },
    });
    expect(queued.ok, JSON.stringify(queued)).toBe(true);
    if (queued.ok) ids.push(queued.value.item_id ?? "");
  }
  return ids;
}

function takeCreates(
  server: Harness["server"],
  ahead: (
    take: (request: { body: string }) => Answer,
  ) => Responder[] = () => [],
) {
  const rows = new Map<string, Record<string, unknown>>();
  const take = (request: { body: string }): Answer => {
    const sent = JSON.parse(request.body) as {
      id: string;
      properties: Record<string, unknown>;
    };
    const row = wireItem({ id: sent.id, properties: sent.properties });
    rows.set(sent.id, row);
    return answers.created(row);
  };
  scriptWrites(server, {
    create: [...ahead(take), take],
    read: [
      (request) => {
        const row = rows.get(request.pathname.split("/").at(-1) ?? "");
        return row
          ? answers.updated(row)
          : refusal(404, "item_not_found", "no such item");
      },
    ],
  });
}

function createsSent(server: Harness["server"]): string[] {
  return server.requests
    .filter(
      (request) => request.method === "POST" && request.pathname === "/items",
    )
    .map((request) => (JSON.parse(request.body) as { id: string }).id);
}

describe("a watch", () => {
  /** The same stream, held open, on a store of its own. */
  async function scenario(label: string): Promise<Harness> {
    const started = await startHarness(label);
    scriptHydration(started.server, { head: "10" });
    started.server.copyAnswer("GET", "/events", {
      kind: "sse",
      hold: true,
      frames: [
        connected,
        copyStreamCursor("11"),
        copyItemEvent("11", "item.created", wireItem({ id: "n1" })),
        copyItemEvent("12", "item.created", wireItem({ id: "n2" })),
      ],
    });
    expect((await started.device.hydrate(["core.note"], "library")).ok).toBe(
      true,
    );
    return started;
  }

  it("tells each event a held stream applied, in order, as a follow does", async () => {
    const followed = await scenario("watch-follows");
    let told: Change[] = [];
    try {
      const followedChanges = await followed.device.follow(3);
      expect(followedChanges.ok, JSON.stringify(followedChanges)).toBe(true);
      told = followedChanges.ok ? followedChanges.value.changes : [];
    } finally {
      await followed.stop();
    }
    expect(
      told.map((change) => change.item_id),
      "the witness stream told nothing",
    ).toEqual(["n1", "n2"]);

    harness = await scenario("watch-tells");
    const watching = await watched(harness.device, 3);
    expect(watching.code, watching.stderr).toBe(0);
    expect(
      watching.changes,
      "the watch did not tell each event in the order the stream carried it, as a follow tells it",
    ).toEqual(told);
  });

  it("tells once that the server cannot be reached, and once that it can again", async () => {
    harness = await startHarness("watch-reach");
    const { server, device } = harness;
    scriptHydration(server, { head: "10" });
    server.copyAnswer(
      "GET",
      "/events",
      refusal(503, "unavailable", "busy"),
      { kind: "drop" },
      { kind: "sse", frames: [connected], hold: true },
    );
    expect((await device.hydrate(["core.note"], "library")).ok).toBe(true);

    const told = await watched(device, 10);
    expect(told.code, told.stderr).toBe(0);
    expect(
      told.changes.map((change) => change.event),
      "the loss and the return were not each told once",
    ).toEqual(["server.unreachable", "server.reachable"]);
    expect(told.changes[0]?.reason).toContain("503");
  });

  it("tells the server is reachable when the stream ends on the server's own answer, then that it failed", async () => {
    harness = await startHarness("watch-reached");
    const { server, device } = harness;
    scriptHydration(server, { head: "10" });
    server.copyAnswer("GET", "/events", refusal(503, "unavailable", "busy"), {
      kind: "sse",
      frames: [connected],
      hold: true,
    });
    expect((await device.hydrate(["core.note"], "library")).ok).toBe(true);

    const run = device.hold(["watch", "--for", "20"]);
    try {
      await vi.waitFor(
        () => {
          expect(run.stdout, run.stderr).toContain("server.unreachable");
        },
        { timeout: 10_000, interval: 25 },
      );
      // The next stream is asked for on another contract: the server answered,
      // and it is not one this device can read.
      server.contract = String(Number(BUILT_FOR) + 1);
      await run.exited();
    } finally {
      await run.stop();
    }
    const changes = run.stdout
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as Change);
    expect(
      changes.map((change) => change.event),
      "the app was left showing the server unreachable once it had answered",
    ).toEqual(["server.unreachable", "server.reachable", "watch.failed"]);
    expect(changes[2]?.reason).toContain("contract");
    expect(run.exitCode(), "a failed watch did not end with the error").toBe(1);
    expect(run.stderr).toContain("contract_mismatch");
  });

  it("drains once at its first stream what a drain left undelivered, though the server was never lost", async () => {
    harness = await startHarness("watch-owed");
    const { server, device } = harness;
    scriptHydration(server, { head: "10" });
    server.copyAnswer("GET", "/events", {
      kind: "sse",
      frames: [connected],
      hold: true,
    });
    expect((await device.hydrate(["core.note"], "library")).ok).toBe(true);
    const queued = await queueNotes(device, "first", "second");
    // The first write goes; the server fails on the second, and then takes it.
    takeCreates(server, (take) => [take, refusal(503, "unavailable", "busy")]);
    const partial = await device.drain();
    expect(partial.ok, JSON.stringify(partial)).toBe(true);
    if (!partial.ok) return;
    expect(
      [partial.value.answered, partial.value.undelivered],
      "the drain did not answer one write and leave one, so the watch below is about nothing",
    ).toEqual([1, 1]);

    const told = await watched(device, 4);
    expect(told.code, told.stderr).toBe(0);
    expect(
      told.changes.map((change) => change.event),
      "the watch did not finish the drain at its first stream, or told the server lost and back when it never was",
    ).toEqual(["queue.drained"]);
    expect(told.changes[0]?.drain?.answered).toBe(1);
    expect(
      createsSent(server),
      "the write the drain left was not sent once more, or a write already answered was sent again",
    ).toEqual([queued[0], queued[1], queued[1]]);

    // Done, it is owed no more: the next watch sends nothing.
    const again = await watched(device, 2);
    expect(again.changes).toEqual([]);
    expect(createsSent(server)).toHaveLength(3);
  });

  it("drains nothing for a server never lost where the app only holds writes", async () => {
    harness = await startHarness("watch-holds");
    const { server, device } = harness;
    scriptHydration(server, { head: "10" });
    server.copyAnswer("GET", "/events", {
      kind: "sse",
      frames: [connected],
      hold: true,
    });
    expect((await device.hydrate(["core.note"], "library")).ok).toBe(true);
    await queueNotes(device, "waiting");
    takeCreates(server);

    const told = await watched(device, 3);
    expect(told.code, told.stderr).toBe(0);
    // The witness that a drain sends this write is the fixture above.
    expect(createsSent(server), "a watch drained what the app held").toEqual(
      [],
    );
    expect(told.changes).toEqual([]);
  });

  it("tells a reading handle each save another process makes", async () => {
    harness = await startHarness("watch-saves");
    const { server, device } = harness;
    scriptHydration(server, { head: "10" });
    expect((await device.hydrate(["core.note"], "library")).ok).toBe(true);

    const reader = device
      .reopen({ reader: true })
      .hold(["watch", "--for", "20"]);
    try {
      // The helper starts first; the app that writes starts after it.
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      const wrote = await device.create({
        type: "core.note",
        properties: { title: "saved", body: "saved" },
      });
      expect(wrote.ok, JSON.stringify(wrote)).toBe(true);
      await vi.waitFor(
        () => {
          expect(reader.stdout, reader.stderr).toContain("store.saved");
        },
        { timeout: 10_000, interval: 25 },
      );
    } finally {
      await reader.stop();
    }
    const changes = reader.stdout
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as Change);
    expect(
      changes.map((change) => change.event),
      "the reader told something other than a save, or told it more than once",
    ).toEqual(["store.saved"]);
    expect(typeof changes[0]?.data_version).toBe("number");
  });
  it("tells a save made as soon as the reader says it is watching", async () => {
    harness = await startHarness("watch-saves-at-once");
    const { server, device } = harness;
    scriptHydration(server, { head: "10" });
    expect((await device.hydrate(["core.note"], "library")).ok).toBe(true);

    const reader = device.hold(["changes", "--for", "20"]);
    try {
      await vi.waitFor(
        () => {
          expect(reader.stdout, reader.stderr).toContain('"watching":true');
        },
        { timeout: 10_000, interval: 5 },
      );
      // Written the moment the line is read: a reader that read the store
      // before it began to watch would miss it.
      const wrote = await device.create({
        type: "core.note",
        properties: { title: "at once", body: "saved" },
      });
      expect(wrote.ok, JSON.stringify(wrote)).toBe(true);
      await vi.waitFor(
        () => {
          expect(
            reader.stdout
              .split("\n")
              .filter(
                (line) =>
                  line.includes("data_version") && !line.includes("watching"),
              ),
            "a save made as soon as the reader said it was watching was not told",
          ).not.toHaveLength(0);
        },
        { timeout: 10_000, interval: 25 },
      );
    } finally {
      await reader.stop();
    }
  });
});
