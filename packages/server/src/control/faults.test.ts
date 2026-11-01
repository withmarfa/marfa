import { afterEach, describe, expect, it } from "vitest";
import {
  activeFaults,
  atPoint,
  clearFaults,
  deadlineFault,
  failAt,
  forgetReach,
  recordFired,
  faultProblem,
  faultsArmed,
  freeFault,
  healthAdmitted,
  holdArmed,
  holdAt,
  POINTS,
  setFault,
  storeCheckDeadlineFault,
} from "./faults.js";

const JOBS = ["trash-purge", "inbound-delivery-cleanup"];

afterEach(() => {
  clearFaults();
});

/** Arms a fault the way the route does: a refused name never reaches the table. */
function arm(name: string, arg: string | null = null): string | undefined {
  const problem = faultProblem(name, arg, JOBS);
  if (problem === undefined) setFault(name, arg);
  return problem;
}

describe("the declared points", () => {
  it("arm every point the table declares, with a job where a point names one", () => {
    for (const kind of ["hold", "fail"] as const) {
      for (const point of POINTS[kind]) {
        const name = `${kind}:${point.name.replace("<job>", JOBS[0]!)}`;
        expect(arm(name), name).toBeUndefined();
      }
    }
    expect(activeFaults().length).toBe(POINTS.hold.length + POINTS.fail.length);
  });

  it("refuse a name no point answers to, in every kind", () => {
    for (const name of [
      "hold:nothing",
      "hold:housekeeping:",
      "hold:housekeeping:Bad_Name",
      "fail:nothing",
      "fail:housekeeping:",
      "fail:commit:extra",
      "freeze:lock",
      "lock",
      "",
      "deadline:",
      "deadline:Not A Job",
    ]) {
      expect(
        arm(name, name.startsWith("deadline") ? "10" : null),
        name,
      ).not.toBeUndefined();
    }
    expect(activeFaults()).toEqual([]);
  });

  it("refuse a job the scheduler has not registered, for a hold, a failure and a deadline", () => {
    expect(arm("hold:housekeeping:unregistered")).toMatch(
      /no housekeeping job/,
    );
    expect(arm("fail:housekeeping:unregistered")).toMatch(
      /no housekeeping job/,
    );
    expect(arm("deadline:unregistered", "10")).toMatch(/no housekeeping job/);
    expect(arm("fail:housekeeping:trash-purge")).toBeUndefined();
  });

  it("refuse the placeholder itself and a failure on a job that runs no statement", () => {
    for (const name of ["hold:housekeeping:<job>", "fail:housekeeping:<job>"]) {
      expect(arm(name), name).toMatch(/no (hold|fail) point/);
    }
    const withHeartbeat = [...JOBS, "heartbeat"];
    expect(
      faultProblem("fail:housekeeping:heartbeat", null, withHeartbeat),
    ).toMatch(/runs no database statement/);
    // The witness: a hold on the same job is a real point, and the same
    // failure on a job that runs statements is armed.
    expect(
      faultProblem("hold:housekeeping:heartbeat", null, withHeartbeat),
    ).toBeUndefined();
    expect(
      faultProblem("fail:housekeeping:trash-purge", null, JOBS),
    ).toBeUndefined();
    expect(activeFaults()).toEqual([]);
  });

  it("refuse an argument the point does not take", () => {
    expect(arm("hold:version-thinning:item", "1")).toMatch(/no argument/);
    expect(arm("fail:lock", "0")).toMatch(/from 1/);
    expect(arm("fail:lock", "-1")).toMatch(/from 1/);
    expect(arm("fail:lock", "1.5")).toMatch(/from 1/);
    expect(arm("fail:lock", "items.bulk@2")).toMatch(/from 1/);
    expect(arm("fail:lock", "1000001")).toMatch(/from 1/);
    expect(arm("fail:commit", "items.bulk@0")).toMatch(/<action>@<n>/);
    expect(arm("fail:commit", "Items Bulk")).toMatch(/<action>@<n>/);
    expect(arm("fail:commit", "@2")).toMatch(/<action>@<n>/);
    expect(arm("deadline:trash-purge", "0")).toMatch(/milliseconds/);
    expect(arm("deadline:trash-purge")).toMatch(/milliseconds/);
    expect(activeFaults()).toEqual([]);
  });

  it("take a count, an action or an action and a count on a write point", () => {
    for (const arg of [
      "3",
      "items.bulk",
      "items.bulk@2",
      "items.bulk_action.chunk@10",
    ]) {
      expect(arm("fail:audit", arg), arg).toBeUndefined();
    }
  });
});

describe("a fail fault", () => {
  it("acts on the first reach by default, once, and keeps its count", () => {
    arm("fail:lock");
    expect([failAt("lock"), failAt("lock"), failAt("lock")]).toEqual([
      true,
      false,
      false,
    ]);
    expect(activeFaults()).toEqual([
      { name: "fail:lock", arg: null, waiting: 0, fired: 1 },
    ]);
  });

  it("acts on the nth reach and on no other, with reaches before and after it", () => {
    arm("fail:lock", "3");
    expect(Array.from({ length: 5 }, () => failAt("lock"))).toEqual([
      false,
      false,
      true,
      false,
      false,
    ]);
  });

  it("counts only the reaches made with the audit action it is aimed at", () => {
    arm("fail:audit", "items.bulk@2");
    expect(failAt("audit", "keys.create")).toBe(false);
    expect(failAt("audit", "items.bulk")).toBe(false);
    expect(failAt("audit", "keys.create")).toBe(false);
    expect(failAt("audit", "items.bulk")).toBe(true);
    expect(failAt("audit", "items.bulk")).toBe(false);
  });

  it("counts every reach when it is aimed at no action, and takes a bare action as the first", () => {
    arm("fail:commit", "2");
    expect([failAt("commit", "a"), failAt("commit", "b")]).toEqual([
      false,
      true,
    ]);
    arm("fail:commit-ack", "items.bulk");
    expect([
      failAt("commit-ack", "x"),
      failAt("commit-ack", "items.bulk"),
    ]).toEqual([false, true]);
  });

  it("does not act on a point no fault was set on, and leaves another fault's count alone", () => {
    arm("fail:commit");
    expect(failAt("commit-full")).toBe(false);
    expect(failAt("audit")).toBe(false);
    expect(failAt("commit")).toBe(true);
  });

  it("starts again when it is set again, and when it is cleared acts no more", () => {
    arm("fail:lock");
    expect(failAt("lock")).toBe(true);
    arm("fail:lock", "2");
    expect(activeFaults()[0]).toMatchObject({ arg: "2", fired: 0 });
    expect([failAt("lock"), failAt("lock")]).toEqual([false, true]);
    clearFaults("fail:lock");
    expect(failAt("lock")).toBe(false);
    expect(activeFaults()).toEqual([]);
  });

  it("is gone when every fault is cleared, which a restart does by starting empty", () => {
    arm("fail:audit");
    arm("hold:version-thinning:item");
    arm("deadline:trash-purge", "50");
    expect(faultsArmed()).toBe(true);
    clearFaults();
    expect(faultsArmed()).toBe(false);
    expect(failAt("audit")).toBe(false);
    expect(deadlineFault("trash-purge")).toBeUndefined();
  });

  it("counts a statement fault only when a statement failed, and waits for a reach that can", () => {
    arm("fail:export-read");
    // A scope that ran no statement: reached, not counted, taken back.
    expect(failAt("export-read", undefined, false)).toBe(true);
    forgetReach("export-read");
    expect(activeFaults()[0]).toMatchObject({ fired: 0 });
    // The next reach is the first again, and counts when a statement fails.
    expect(failAt("export-read", undefined, false)).toBe(true);
    recordFired("export-read");
    expect(activeFaults()[0]).toMatchObject({ fired: 1 });
    expect(failAt("export-read", undefined, false)).toBe(false);
  });

  it("costs one read of the table when nothing is set", () => {
    expect(faultsArmed()).toBe(false);
    expect(failAt("lock")).toBe(false);
    expect(failAt("audit", "items.bulk")).toBe(false);
  });
});

describe("a hold fault and a deadline fault", () => {
  it("keep their behavior: a hold waits until cleared, and a deadline reads its milliseconds", async () => {
    arm("hold:version-thinning:item");
    const order: string[] = [];
    const held = atPoint("version-thinning:item", (wasHeld) => {
      order.push(`ran held=${String(wasHeld)}`);
      return Promise.resolve();
    });
    await Promise.resolve();
    expect(activeFaults()[0]).toMatchObject({ waiting: 1, fired: 0 });
    expect(order).toEqual([]);
    clearFaults();
    await held;
    expect(order).toEqual(["ran held=true"]);

    arm("deadline:trash-purge", "250");
    expect(deadlineFault("trash-purge")).toBe(250);
    expect(deadlineFault("inbound-delivery-cleanup")).toBeUndefined();
  });
});

describe("a hold on a blob store's read or question", () => {
  it("lets a caller whose signal aborts go without running its step, and stops counting it", async () => {
    arm("hold:blob-has");
    const controller = new AbortController();
    let ran = false;
    const held = atPoint(
      "blob-has",
      () => {
        ran = true;
        return Promise.resolve();
      },
      undefined,
      controller.signal,
    );
    const staying = holdAt("blob-has");
    await Promise.resolve();
    expect(activeFaults()[0]).toMatchObject({ waiting: 2 });
    const reason = new Error("given up");
    controller.abort(reason);
    await expect(held).rejects.toBe(reason);
    expect(ran).toBe(false);
    expect(activeFaults()[0]).toMatchObject({ waiting: 1 });
    clearFaults();
    await staying;
  });

  it("refuses a caller whose signal has already aborted, without waiting", async () => {
    arm("hold:blob-read");
    const reason = new Error("already given up");
    await expect(
      holdAt("blob-read", undefined, AbortSignal.abort(reason)),
    ).rejects.toBe(reason);
    expect(activeFaults()[0]).toMatchObject({ waiting: 0 });
  });
});

describe("a store-check-deadline fault", () => {
  it("reads its milliseconds until cleared, and refuses anything but a whole number from 1", () => {
    expect(storeCheckDeadlineFault()).toBeUndefined();
    for (const arg of [null, "0", "soon", "1.5"]) {
      expect(arm("store-check-deadline", arg), String(arg)).toMatch(
        /whole number of milliseconds/,
      );
    }
    expect(arm("store-check-deadline", "40")).toBeUndefined();
    expect(storeCheckDeadlineFault()).toBe(40);
    clearFaults();
    expect(storeCheckDeadlineFault()).toBeUndefined();
  });
});

describe("a free fault", () => {
  it("reads the bytes it was set to for its volume alone, until it is set again or cleared", () => {
    expect(freeFault("blobs")).toBeUndefined();
    expect(arm("free:blobs", "2048")).toBeUndefined();
    expect(freeFault("blobs")).toBe(2048);
    expect(freeFault("database")).toBeUndefined();
    expect(arm("free:blobs", "0")).toBeUndefined();
    expect(freeFault("blobs")).toBe(0);
    clearFaults();
    expect(freeFault("blobs")).toBeUndefined();
  });

  it("refuses a volume nothing reads, and an argument that is not a whole number of bytes", () => {
    expect(arm("free:elsewhere", "1")).toMatch(/not a volume/);
    expect(arm("free:blobs")).toMatch(/whole number/);
    for (const arg of ["-1", "1.5", "1e3", "", "ten", "9007199254740993"]) {
      expect(arm("free:blobs", arg), arg).toMatch(/whole number/);
    }
    expect(activeFaults()).toEqual([]);
  });
});

describe("a hold on a stream point", () => {
  it("is armed for its own point and for no other, and is not armed by another kind of fault", () => {
    expect(holdArmed("stream-drain")).toBe(false);
    arm("fail:stream-credential");
    expect(holdArmed("stream-drain")).toBe(false);
    arm("hold:stream-drain");
    expect(holdArmed("stream-drain")).toBe(true);
    expect(holdArmed("stream-replay")).toBe(false);
    clearFaults("hold:stream-drain");
    expect(holdArmed("stream-drain")).toBe(false);
  });

  it("holds every caller that reaches it until it is cleared, and counts them", async () => {
    arm("hold:stream-head");
    const released: string[] = [];
    const callers = ["one", "two"].map(async (name) => {
      await holdAt("stream-head");
      released.push(name);
    });
    await Promise.resolve();
    expect(activeFaults()).toEqual([
      { name: "hold:stream-head", arg: null, waiting: 2, fired: 0 },
    ]);
    expect(released).toEqual([]);
    clearFaults("hold:stream-head");
    await Promise.all(callers);
    expect(released.sort()).toEqual(["one", "two"]);
  });

  it("takes no argument", () => {
    for (const point of [
      "stream-open",
      "stream-head",
      "stream-replay",
      "stream-drain",
      "announce",
      "read-snapshot",
    ]) {
      expect(arm(`hold:${point}`, "1"), point).toMatch(/no argument/);
    }
  });
});

describe("a fail fault on an event point", () => {
  it("acts on the nth reach and takes only a count", () => {
    for (const point of [
      "stream-head",
      "stream-replay",
      "stream-credential",
      "stream-replay-row",
      "edge-source-type",
    ]) {
      expect(arm(`fail:${point}`, "2"), point).toBeUndefined();
      expect([failAt(point), failAt(point), failAt(point)]).toEqual([
        false,
        true,
        false,
      ]);
      expect(arm(`fail:${point}`, "items.bulk"), point).toMatch(/from 1/);
      clearFaults();
    }
  });
});

describe("counted holds", () => {
  it("holds only the nth matching write and lets later writes pass", async () => {
    expect(arm("hold:write", "item.update@2")).toBeUndefined();
    await holdAt("write", "edge.create");
    await holdAt("write", "item.update");
    const held = holdAt("write", "item.update");
    expect(activeFaults()[0]?.waiting).toBe(1);
    await holdAt("write", "item.update");
    expect(activeFaults()[0]?.waiting).toBe(1);
    clearFaults();
    await held;
  });

  it("resets the page count when rearmed and releases every waiter on clear", async () => {
    arm("hold:export-page", "2");
    await holdAt("export-page");
    const first = holdAt("export-page");
    expect(activeFaults()[0]?.waiting).toBe(1);
    arm("hold:export-page", "1");
    const second = holdAt("export-page");
    expect(activeFaults()[0]?.waiting).toBe(2);
    clearFaults();
    await Promise.all([first, second]);
  });

  it("refuses literal templates and invalid counts with valid names as witnesses", () => {
    for (const [name, arg] of [
      ["hold:write", "<action>@<n>"],
      ["hold:export-page", "<n>"],
      ["hold:write", "item.update@0"],
      ["hold:export-page", "1000001"],
    ])
      expect(arm(name!, arg)).toBeDefined();
    expect(activeFaults()).toEqual([]);
    expect(arm("hold:write", "item.update@2")).toBeUndefined();
    expect(arm("hold:export-page", "2")).toBeUndefined();
  });
});

describe("a release fault", () => {
  it("clears its hold as /health is admitted, once, and records the holds waiting when it answers", async () => {
    expect(arm("release:housekeeping:trash-purge")).toBeUndefined();
    expect(arm("hold:housekeeping:trash-purge")).toBeUndefined();
    expect(arm("hold:version-thinning:item")).toBeUndefined();
    let resumed = false;
    const job = holdAt("housekeeping:trash-purge").then(async () => {
      resumed = true;
      await holdAt("version-thinning:item");
    });
    const answered = healthAdmitted();
    expect(answered).toBeDefined();
    expect(holdArmed("housekeeping:trash-purge")).toBe(false);
    expect(resumed).toBe(false);
    await new Promise((resolve) => setImmediate(resolve));
    answered?.();
    const release = activeFaults().find(
      (fault) => fault.name === "release:housekeeping:trash-purge",
    );
    expect(release).toMatchObject({
      fired: 1,
      held_when_answered: ["hold:version-thinning:item"],
    });
    expect(healthAdmitted()).toBeUndefined();
    clearFaults();
    await job;
  });

  it("records no hold when /health answers before the work reaches one", () => {
    arm("release:read-hydration");
    arm("hold:read-hydration");
    arm("hold:export-page", "5");
    const answered = healthAdmitted();
    answered?.();
    expect(activeFaults()).toEqual([
      {
        name: "release:read-hydration",
        arg: null,
        waiting: 0,
        fired: 1,
        held_when_answered: [],
      },
      { name: "hold:export-page", arg: "5", waiting: 0, fired: 0 },
    ]);
  });

  it("costs one read of the table when nothing is set, and acts on no hold without a release", () => {
    expect(healthAdmitted()).toBeUndefined();
    arm("hold:read-hydration");
    expect(healthAdmitted()).toBeUndefined();
    expect(holdArmed("read-hydration")).toBe(true);
  });

  it("names a hold point and takes no argument", () => {
    for (const [name, arg] of [
      ["release:nothing", null],
      ["release:housekeeping:no-such-job", null],
      ["release:read-hydration", "1"],
      ["release:", null],
    ] as const)
      expect(arm(name, arg), name).toBeDefined();
    expect(activeFaults()).toEqual([]);
    expect(arm("release:read-hydration")).toBeUndefined();
  });
});

describe("a counted hold between bulk chunks", () => {
  it("holds every reach without an argument, and only the nth with one", async () => {
    arm("hold:bulk-job:between-chunks", "3");
    await holdAt("bulk-job:between-chunks");
    await holdAt("bulk-job:between-chunks");
    const third = holdAt("bulk-job:between-chunks");
    expect(activeFaults()[0]?.waiting).toBe(1);
    await holdAt("bulk-job:between-chunks");
    clearFaults();
    await third;
    arm("hold:bulk-job:between-chunks");
    const first = holdAt("bulk-job:between-chunks");
    const second = holdAt("bulk-job:between-chunks");
    expect(activeFaults()[0]?.waiting).toBe(2);
    clearFaults();
    await Promise.all([first, second]);
  });
});
