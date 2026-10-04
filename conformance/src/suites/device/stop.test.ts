import { describe, it, expect, afterEach, vi } from "vitest";
import {
  hydratedHarness,
  scriptHydration,
  scriptWrites,
  startHarness,
  type Harness,
} from "./harness.js";
import {
  answers,
  connected,
  copyHeadRead,
  itemsPage,
  copyStreamCursor,
  refusal,
  wireItem,
} from "../../device/marfa-answers.js";
import type { Responder } from "../../device/scripted-server.js";
import type { ScriptedServer } from "../../device/scripted-server.js";

/**
 * "A long call can be stopped."
 *
 * An app that starts a hydration, a catch-up or a drain from a view that then
 * goes away has to be able to end it: left to run, a hydration of a large copy
 * goes on for as long as the copy is large, on a thread nobody is waiting on.
 * The binary's own stop is Ctrl-C, which these fixtures send to the command
 * while it is waiting on the server.
 */

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.stop();
  harness = undefined;
});

/** Exit 3 is the code a call that did not finish leaves by. */
const UNFINISHED = 3;

function creates(server: ScriptedServer): number {
  return server.requests.filter(
    (request) => request.method === "POST" && request.pathname === "/items",
  ).length;
}

/** A create door that takes every write it is sent, and reads each back. */
function accepting(
  server: ScriptedServer,
): Extract<Responder, (...args: never[]) => unknown> {
  const rows = new Map<string, ReturnType<typeof wireItem>>();
  server.copyAnswer("GET", /^\/items\/[^/]+$/, (request) => {
    const row = rows.get(request.pathname.split("/").at(-1) ?? "");
    return row === undefined
      ? refusal(404, "item_not_found", "No such item")
      : answers.updated(row);
  });
  return (request) => {
    const sent = JSON.parse(request.body);
    const row = wireItem({
      id: sent.id,
      type: sent.type,
      tier: sent.tier,
      properties: sent.properties,
    });
    rows.set(String(row.id), row);
    return answers.created(row);
  };
}

describe("stopping a hydration", () => {
  it("ends it between pages, leaving a copy that refuses reads and a queue that is as it was", async () => {
    harness = await startHarness("stop-hydrate");
    const { server, device } = harness;
    // The listing's first page is held back until the fixture lets it go, and
    // is scripted first because a door answers its scripts in order.
    let release = (): void => {};
    const until = new Promise<void>((resolve) => (release = resolve));
    server.copyAnswer(
      "GET",
      "/items",
      {
        kind: "gated",
        until,
        then: itemsPage([], { nextCursor: "page-2" }),
      },
      itemsPage([]),
    );
    scriptHydration(server, { head: "10" });
    // A hydration reads again the row a queued create made, which the server
    // does not hold yet.
    server.copyAnswer(
      "GET",
      /^\/items\/[^/]+$/,
      refusal(404, "item_not_found", "none"),
    );
    // The store is made by its state report (45).
    expect((await device.status()).ok).toBe(true);
    expect(
      (
        await device.create({
          type: "core.note",
          properties: { title: "saved first", body: "saved first" },
        })
      ).ok,
    ).toBe(true);
    const queued = await device.queue();

    const itemReads = () =>
      server.requests.filter((request) => request.pathname === "/items").length;

    const hydrating = device.hold([
      "hydrate",
      "--types",
      "core.note",
      "--tier",
      "library",
    ]);
    try {
      await vi.waitFor(
        () => {
          expect(itemReads(), hydrating.stderr).toBe(1);
        },
        { timeout: 10_000, interval: 25 },
      );
      hydrating.interrupt();
      release();
      await hydrating.exited();
      expect(hydrating.exitCode(), hydrating.stderr).toBe(UNFINISHED);
      expect(JSON.parse(hydrating.stderr).error.code, hydrating.stderr).toBe(
        "cancelled",
      );
    } finally {
      release();
      await hydrating.stop();
    }
    expect(
      itemReads(),
      "a page was asked for after the stop, so it ended no sooner than a call nobody stopped",
    ).toBe(1);

    const status = await device.status();
    expect(status.ok && status.value.hydration).not.toBe("complete");
    const read = await device.list();
    expect(
      read.ok ? "answered" : read.refusal.code,
      "a copy whose hydration was stopped answered a read from the rows it had taken",
    ).toBe("hydration_incomplete");
    expect(await device.queue(), "the stop touched the queue").toEqual(queued);

    // The witness: the same copy hydrates whole when it is not stopped.
    const finished = await device.hydrate(["core.note"], "library");
    expect(finished.ok, JSON.stringify(finished)).toBe(true);
    expect((await device.list()).ok).toBe(true);
  });
});

describe("stopping a catch-up", () => {
  it("ends it while it waits on a stream, keeping the cursor it had", async () => {
    harness = await hydratedHarness("stop-catch-up", { head: "10" });
    const { server, device } = harness;
    let holding = true;
    server.copyAnswer("GET", "/events", () =>
      holding
        ? {
            kind: "sse",
            frames: [connected, copyStreamCursor("10")],
            hold: true,
          }
        : copyHeadRead("10"),
    );
    // A door answers its scripts in order, so the answer the hydration left
    // is spent by a catch-up that reaches the head, and the held stream is
    // the one the command below meets.
    expect((await device.catchUp()).ok).toBe(true);
    const events = () =>
      server.requests.filter((request) => request.pathname === "/events")
        .length;
    const before = events();
    const catching = device.hold(["catch-up"]);
    try {
      await vi.waitFor(
        () => {
          expect(events(), catching.stderr).toBe(before + 1);
        },
        { timeout: 10_000, interval: 25 },
      );
      const raised = Date.now();
      catching.interrupt();
      await catching.exited();
      expect(catching.exitCode(), `${catching.stdout} ${catching.stderr}`).toBe(
        UNFINISHED,
      );
      expect(JSON.parse(catching.stderr).error.code).toBe("cancelled");
      expect(
        Date.now() - raised,
        "the catch-up went on waiting on its stream after the stop",
      ).toBeLessThan(5_000);
    } finally {
      await catching.stop();
    }
    const status = await device.status();
    expect(
      status.ok && [status.value.hydration, status.value.event_cursor],
    ).toEqual(["complete", "10"]);

    // The witness: given a stream that reaches its head, the same command ends
    // by itself.
    holding = false;
    expect((await device.catchUp()).ok).toBe(true);
  });
});

describe("stopping a drain", () => {
  it("ends it before the next write is sent, leaving that write queued and unsent", async () => {
    harness = await hydratedHarness("stop-drain", { head: "10" });
    const { server, device } = harness;
    for (const title of ["first", "second"]) {
      expect(
        (
          await device.create({
            type: "core.note",
            properties: { title, body: title },
          })
        ).ok,
      ).toBe(true);
    }
    let release = (): void => {};
    const until = new Promise<void>((resolve) => (release = resolve));
    const taking = accepting(server);
    scriptWrites(server, {
      create: [
        (request) => ({ kind: "gated", until, then: taking(request) }),
        taking,
      ],
    });
    const draining = device.hold(["drain"]);
    try {
      await vi.waitFor(
        () => {
          expect(creates(server), draining.stderr).toBe(1);
        },
        { timeout: 10_000, interval: 25 },
      );
      draining.interrupt();
      release();
      await draining.exited();
      expect(draining.exitCode(), draining.stderr).toBe(UNFINISHED);
      expect(JSON.parse(draining.stderr).error.code).toBe("cancelled");
    } finally {
      release();
      await draining.stop();
    }
    expect(
      creates(server),
      "a write was sent after the stop, so it ended no sooner than a drain nobody stopped",
    ).toBe(1);
    const queue = await device.queue();
    expect(queue.ok && queue.value.map((row) => row.verdict)).toEqual([
      "accepted",
      null,
    ]);

    // The witness: the next drain sends the write the stopped one left.
    expect((await device.drain()).ok).toBe(true);
    expect(creates(server)).toBe(2);
    const settled = await device.queue();
    expect(settled.ok && settled.value.map((row) => row.verdict)).toEqual([
      "accepted",
      "accepted",
    ]);
  });
});
