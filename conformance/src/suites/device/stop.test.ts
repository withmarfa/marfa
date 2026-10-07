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
  edgeTypeCatalog,
  refusal,
  wireItem,
} from "../../device/marfa-answers.js";
import type { Answer, Responder } from "../../device/scripted-server.js";
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
  it("reports canceled after a stopped head read ends or is refused, without retrying or changing the queue", async () => {
    for (const failure of [
      { kind: "sse", frames: [connected] },
      refusal(503, "unavailable", "try again"),
    ] satisfies Answer[]) {
      harness = await startHarness(`stop-head-${failure.kind}`);
      const { server, device } = harness;
      expect((await device.status()).ok).toBe(true);
      expect(
        (
          await device.create({
            type: "core.note",
            properties: { title: "saved before stop", body: "kept" },
          })
        ).ok,
      ).toBe(true);
      const queued = await device.queue();
      let release = (): void => {};
      const until = new Promise<void>((resolve) => (release = resolve));
      let gated = false;
      server.copyAnswer("GET", "/events", () =>
        gated ? { kind: "gated", until, then: failure } : failure,
      );
      const heads = () =>
        server.requests.filter((request) => request.pathname === "/events")
          .length;

      // The unstopped read meets the same failure; EOF retries three times.
      const failed = await device.hydrate(["core.note"], "library");
      expect(failed.ok ? "answered" : failed.refusal.code).toBe(
        failure.kind === "sse" ? "stream_incomplete" : "server",
      );
      expect(heads()).toBe(failure.kind === "sse" ? 3 : 1);
      const before = heads();
      gated = true;
      const hydrating = device.hold([
        "hydrate",
        "--types",
        "core.note",
        "--tier",
        "library",
      ]);
      try {
        await vi.waitFor(() => expect(heads()).toBe(before + 1), {
          timeout: 5_000,
          interval: 25,
        });
        hydrating.interrupt();
        // Give the signal waiter its delivery window before releasing the failure.
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(hydrating.exitCode(), hydrating.stderr).toBeNull();
        release();
        await vi.waitFor(() => expect(hydrating.exitCode()).not.toBeNull(), {
          timeout: 5_000,
          interval: 25,
        });
        await hydrating.exited();
        expect(hydrating.exitCode(), hydrating.stderr).toBe(UNFINISHED);
        expect(JSON.parse(hydrating.stderr).error.code).toBe("canceled");
      } finally {
        release();
        await hydrating.stop();
      }
      expect(heads(), "a stopped head read retried its failure").toBe(
        before + 1,
      );
      expect(await device.queue()).toEqual(queued);
      const status = await device.status();
      expect(status.ok && status.value.event_cursor).toBeNull();
      await harness.stop();
      harness = undefined;
    }
  });

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
        "canceled",
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
  it("reports canceled after a stopped stream opening is refused, keeping its cursor and queue", async () => {
    harness = await hydratedHarness("stop-refused-catch-up", { head: "10" });
    const { server, device } = harness;
    expect(
      (
        await device.create({
          type: "core.note",
          properties: { title: "kept through stop", body: "kept" },
        })
      ).ok,
    ).toBe(true);
    const queued = await device.queue();
    let release = (): void => {};
    const until = new Promise<void>((resolve) => (release = resolve));
    const failure = refusal(503, "unavailable", "try again");
    let gated = false;
    server.copyAnswer("GET", "/events", () =>
      gated ? { kind: "gated", until, then: failure } : failure,
    );
    // Spend the hydration's remaining replay answer before the failed read.
    expect((await device.catchUp()).ok).toBe(true);
    const failed = await device.catchUp();
    expect(failed.ok ? "answered" : failed.refusal.code).toBe("server");
    const events = () =>
      server.requests.filter((request) => request.pathname === "/events")
        .length;
    const before = events();
    gated = true;
    const catching = device.hold(["catch-up"]);
    try {
      await vi.waitFor(() => expect(events()).toBe(before + 1), {
        timeout: 5_000,
        interval: 25,
      });
      catching.interrupt();
      // Give the signal waiter its delivery window before releasing the 503.
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(catching.exitCode(), catching.stderr).toBeNull();
      release();
      await vi.waitFor(() => expect(catching.exitCode()).not.toBeNull(), {
        timeout: 5_000,
        interval: 25,
      });
      await catching.exited();
      expect(catching.exitCode(), catching.stderr).toBe(UNFINISHED);
      expect(JSON.parse(catching.stderr).error.code).toBe("canceled");
    } finally {
      release();
      await catching.stop();
    }
    expect(events()).toBe(before + 1);
    const status = await device.status();
    expect(
      status.ok && [status.value.hydration, status.value.event_cursor],
    ).toEqual(["complete", "10"]);
    expect(await device.queue()).toEqual(queued);
  });

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
      expect(JSON.parse(catching.stderr).error.code).toBe("canceled");
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
      expect(JSON.parse(draining.stderr).error.code).toBe("canceled");
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

describe("stopping a call that cannot be stopped at once", () => {
  it("ends the process on a second Ctrl-C, where a first one waits for the call to notice", async () => {
    harness = await startHarness("stop-twice");
    const { server, device } = harness;
    // A listing that is never answered, so no check is ever reached.
    server.copyAnswer("GET", "/items", { kind: "stall" });
    scriptHydration(server, { head: "10" });
    expect((await device.status()).ok).toBe(true);
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
          expect(
            server.requests.filter((request) => request.pathname === "/items")
              .length,
            hydrating.stderr,
          ).toBe(1);
        },
        { timeout: 10_000, interval: 25 },
      );
      hydrating.interrupt();
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(
        hydrating.exitCode(),
        `a first Ctrl-C ended a call that had not yet reached a place to stop: ${hydrating.stderr}`,
      ).toBeNull();
      hydrating.interrupt();
      await vi.waitFor(
        () => {
          expect(hydrating.exitCode()).not.toBeNull();
        },
        { timeout: 5_000, interval: 25 },
      );
      expect(hydrating.exitCode()).toBe(130);
    } finally {
      await hydrating.stop();
    }
  });
});

describe("stopping a call whose first request is not answered", () => {
  /** Holds `command` until `path` is asked, then sends one Ctrl-C. */
  async function stoppedWhileAsking(
    server: ScriptedServer,
    device: Harness["device"],
    command: string[],
    path: string,
  ): Promise<void> {
    // A server that takes the connection and never answers, as one still
    // being reached does.
    server.answer("GET", path, { kind: "stall" });
    const call = device.hold(command);
    try {
      await vi.waitFor(
        () => {
          expect(
            server.requests.filter((request) => request.pathname === path)
              .length,
            call.stderr,
          ).toBe(1);
        },
        { timeout: 10_000, interval: 25 },
      );
      call.interrupt();
      await vi.waitFor(
        () => {
          expect(
            call.exitCode(),
            `${command[0]} went on waiting on its request after one Ctrl-C`,
          ).not.toBeNull();
        },
        { timeout: 2_000, interval: 25 },
      );
      expect(call.exitCode(), call.stderr).toBe(UNFINISHED);
      expect(JSON.parse(call.stderr).error.code).toBe("canceled");
    } finally {
      await call.stop();
    }
  }

  it("ends a hydration at once on Ctrl-C, while its head read still waits", async () => {
    harness = await startHarness("stop-unanswered-hydration");
    const { server, device } = harness;
    expect((await device.status()).ok).toBe(true);
    await stoppedWhileAsking(
      server,
      device,
      ["hydrate", "--types", "core.note", "--tier", "library"],
      "/events",
    );
    const status = await device.status();
    expect(status.ok && status.value.hydration).toBe("never");
  });

  it("ends a catch-up at once on Ctrl-C, while its catalog read still waits", async () => {
    harness = await startHarness("stop-unanswered-catch-up");
    const { server, device } = harness;
    let stalled = false;
    scriptHydration(server, {
      head: "10",
      edgeTypes: () => (stalled ? { kind: "stall" } : edgeTypeCatalog()),
    });
    expect((await device.hydrate(["core.note"], "library")).ok).toBe(true);
    const before = await device.status();
    expect(before.ok && before.value.event_cursor).toBe("10");
    const asked = (path: string) =>
      server.requests.filter((request) => request.pathname === path).length;
    const hydrationAsked = asked("/edge-types");
    const streams = asked("/events");
    stalled = true;
    const call = device.hold(["catch-up"]);
    try {
      await vi.waitFor(
        () => {
          expect(asked("/edge-types"), call.stderr).toBe(hydrationAsked + 1);
        },
        { timeout: 10_000, interval: 25 },
      );
      call.interrupt();
      await vi.waitFor(
        () => {
          expect(
            call.exitCode(),
            "catch-up went on waiting on its catalog read after one Ctrl-C",
          ).not.toBeNull();
        },
        { timeout: 2_000, interval: 25 },
      );
      expect(call.exitCode(), call.stderr).toBe(UNFINISHED);
      expect(JSON.parse(call.stderr).error.code).toBe("canceled");
    } finally {
      await call.stop();
    }
    expect(asked("/events"), "the stopped catch-up opened its stream").toBe(
      streams,
    );
    const after = await device.status();
    expect(after.ok && after.value.event_cursor).toBe("10");
  });

  it("ends a drain at once on Ctrl-C, while it still asks which instance the server is", async () => {
    harness = await hydratedHarness("stop-unanswered-drain", { head: "10" });
    const { server, device } = harness;
    expect(
      (
        await device.create({
          type: "core.note",
          properties: { title: "kept", body: "kept" },
        })
      ).ok,
    ).toBe(true);
    await stoppedWhileAsking(server, device, ["drain"], "/");
    const queue = await device.queue();
    expect(queue.ok && queue.value.map((row) => row.verdict)).toEqual([null]);
  });
});
