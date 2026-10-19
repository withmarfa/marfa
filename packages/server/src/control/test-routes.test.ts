import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createApp } from "../app.js";
import {
  clockOffsetMs,
  installDateShim,
  resetClockForTests,
  withRealTime,
} from "../clock.js";
import { ensureInstanceId } from "../storage/instance-id.js";
import { createTestContext, type TestContext } from "../test-utils.js";
import {
  activeFaults,
  clearFaults,
  holdAt,
  scriptedAnswer,
  scriptedConnectionAddress,
} from "./faults.js";

let ctx: TestContext;
let instanceId: string;

beforeAll(async () => {
  ctx = await createTestContext();
  instanceId = await ensureInstanceId(ctx.storage.settings);
  ctx.housekeeping.register({
    name: "trash-purge",
    intervalMs: 3_600_000,
    firstRunDelayMs: 3_600_000,
    run: () => Promise.resolve(null),
  });
});

afterAll(async () => {
  await ctx.cleanup();
});

afterEach(() => {
  resetClockForTests();
  clearFaults();
});

function appFor(testHooks: boolean, localAuthority: boolean) {
  return createApp(
    ctx.storage,
    ctx.blobs,
    ctx.housekeeping,
    { ...ctx.config, testHooks },
    instanceId,
    { localAuthority },
  );
}

const TEST_ROUTES = [
  ["GET", "/_control/test/clock"],
  ["POST", "/_control/test/clock"],
  ["GET", "/_control/test/faults"],
  ["PUT", "/_control/test/faults"],
  ["DELETE", "/_control/test/faults"],
] as const;

async function status(
  app: {
    request: (path: string, init?: RequestInit) => Response | Promise<Response>;
  },
  method: string,
  path: string,
): Promise<number> {
  return (
    await app.request(path, {
      method,
      headers: { "content-type": "application/json" },
      body: method === "GET" || method === "DELETE" ? undefined : "{}",
    })
  ).status;
}

describe("the test hook routes", () => {
  it("answer on the private socket when the hooks are on", async () => {
    // The witness for the two absences below: the same routes are served
    // once both conditions hold.
    const app = appFor(true, true);
    expect(await status(app, "GET", "/_control/test/clock")).toBe(200);
    expect(await status(app, "GET", "/_control/test/faults")).toBe(200);
  });

  it("are absent without MARFA_TEST_HOOKS, even on the private socket", async () => {
    const app = appFor(false, true);
    for (const [method, path] of TEST_ROUTES) {
      expect(await status(app, method, path), `${method} ${path}`).toBe(404);
    }
  });

  it("are absent on the public listener, even with MARFA_TEST_HOOKS", async () => {
    const app = appFor(true, false);
    for (const [method, path] of TEST_ROUTES) {
      expect(await status(app, method, path), `${method} ${path}`).toBe(404);
    }
  });
});

describe("the clock route", () => {
  it("pauses real-time drift while explicit advances still work", async () => {
    const app = appFor(true, true);
    const post = (body: unknown) =>
      app.request("/_control/test/clock", {
        method: "POST",
        body: JSON.stringify(body),
      });
    const paused = await post({ paused: true });
    expect(paused.status).toBe(200);
    const start = (await paused.json()) as { now: string };
    const real = Date.now();
    const wall = vi.spyOn(Date, "now").mockReturnValue(real + 60_000);
    try {
      const moved = await post({ advance_ms: 999 });
      expect(Date.parse(((await moved.json()) as { now: string }).now)).toBe(
        Date.parse(start.now) + 999,
      );
      const due = await post({ advance_ms: 1 });
      expect(Date.parse(((await due.json()) as { now: string }).now)).toBe(
        Date.parse(start.now) + 1000,
      );
      const resumed = await post({ paused: false });
      expect(
        Date.parse(((await resumed.json()) as { now: string }).now),
      ).toBeGreaterThanOrEqual(real + 61_000);
    } finally {
      wall.mockRestore();
    }
  });

  it("pauses the Date shim with the stated clock while external time keeps running", async () => {
    const systemDate = Date;
    installDateShim();
    const app = appFor(true, true);
    const post = (body: unknown) =>
      app.request("/_control/test/clock", {
        method: "POST",
        body: JSON.stringify(body),
      });
    await post({ advance_ms: 86_400_000 });
    const paused = await post({ paused: true });
    const instant = Date.parse(((await paused.json()) as { now: string }).now);
    expect(Date.now()).toBe(instant);
    const wall = vi.spyOn(systemDate, "now").mockReturnValue(instant + 60_000);
    try {
      expect(Date.now()).toBe(instant);
      expect(new Date().getTime()).toBe(instant);
      expect(
        await withRealTime(async () => {
          await Promise.resolve();
          return Date.now();
        }),
      ).toBe(instant + 60_000);
      await post({ advance_ms: 1000 });
      expect(Date.now()).toBe(instant + 1000);
      await post({ paused: true });
      expect(Date.now()).toBe(instant + 1000);
      await post({ paused: false });
      expect(Date.now()).toBe(instant + 60_000 + 86_401_000);
    } finally {
      wall.mockRestore();
    }
  });

  it("moves the clock forward and reports the offset", async () => {
    const app = appFor(true, true);
    const moved = await app.request("/_control/test/clock", {
      method: "POST",
      body: JSON.stringify({ advance_ms: 90_000 }),
    });
    expect(moved.status).toBe(200);
    expect(((await moved.json()) as { offset_ms: number }).offset_ms).toBe(
      90_000,
    );
    expect(clockOffsetMs()).toBe(90_000);
  });

  it("refuses a step back, a fraction and a missing step, and stays where it was", async () => {
    const app = appFor(true, true);
    await app.request("/_control/test/clock", {
      method: "POST",
      body: JSON.stringify({ advance_ms: 1_000 }),
    });
    for (const body of [
      { advance_ms: -1 },
      { advance_ms: 1.5 },
      { advance_ms: "5" },
      { paused: "true" },
      { paused: true, advance_ms: 1 },
      {},
    ]) {
      const refused = await app.request("/_control/test/clock", {
        method: "POST",
        body: JSON.stringify(body),
      });
      expect(refused.status, JSON.stringify(body)).toBe(400);
    }
    expect(clockOffsetMs()).toBe(1_000);
  });
});

describe("the fault routes", () => {
  it("arm a fault, report who waits at it, and release them on clear", async () => {
    const app = appFor(true, true);
    const armed = await app.request("/_control/test/faults", {
      method: "PUT",
      body: JSON.stringify({ name: "hold:version-thinning:item" }),
    });
    expect(armed.status).toBe(200);
    let released = false;
    const waiter = holdAt("version-thinning:item").then(() => {
      released = true;
    });
    await Promise.resolve();
    expect(activeFaults()).toEqual([
      { name: "hold:version-thinning:item", arg: null, waiting: 1, fired: 0 },
    ]);
    expect(released).toBe(false);
    const cleared = await app.request("/_control/test/faults", {
      method: "DELETE",
    });
    expect(cleared.status).toBe(200);
    await waiter;
    expect(released).toBe(true);
    expect(activeFaults()).toEqual([]);
  });

  it("let a point pass at once when no fault holds it", async () => {
    await holdAt("version-thinning:item");
    await holdAt("housekeeping:trash-purge");
  });

  it("refuse a name no point answers to, so a typo cannot pass for an armed fault", async () => {
    const app = appFor(true, true);
    for (const body of [
      { name: "hold:housekeeping:Not A Job" },
      { name: "hold:somewhere-else" },
      { name: "hold:version-thinning:item", arg: "5" },
      { name: "hold:stream-drain", arg: "1" },
      { name: "hold:stream" },
      { name: "fail:stream-replay", arg: "items.bulk" },
      { name: "fail:stream-credential", arg: "0" },
      { name: "hold:housekeeping:no-such-job" },
      { name: "deadline:no-such-job", arg: "100" },
      { name: "deadline:trash-purge" },
      { name: "deadline:trash-purge", arg: "0" },
      { name: "deadline:trash-purge", arg: "soon" },
      { name: "unfold-deadline" },
      { name: "unfold-deadline", arg: "0" },
      { name: "unfold-deadline", arg: "soon" },
      { name: "fail:disk" },
      { name: "hold:write", arg: "<action>@<n>" },
      { name: "hold:export-page", arg: "<n>" },
      { name: "hold:write", arg: "item.update@0" },
      { name: "fail:lock", arg: "0" },
      { name: "fail:lock", arg: "items.bulk@2" },
      { name: "fail:commit", arg: "items.bulk@0" },
      { name: "fail:housekeeping:no-such-job" },
      { name: "hold:<job>" },
      { name: "resolve:rebind.test" },
      { name: "resolve:rebind.test", arg: "not-an-address" },
      { name: "resolve:rebind.test", arg: "1.1.1.1;" },
      { name: "resolve:rebind.test", arg: "1.1.1.1>" },
      { name: "resolve:rebind.test", arg: "1.1.1.1>2.2.2.2>3.3.3.3" },
      { name: "resolve:Not A Host", arg: "1.1.1.1" },
      {},
    ]) {
      const refused = await app.request("/_control/test/faults", {
        method: "PUT",
        body: JSON.stringify(body),
      });
      expect(refused.status, JSON.stringify(body)).toBe(400);
    }
    expect(activeFaults()).toEqual([]);
    // The witness: the same shapes name a registered job and are armed.
    for (const body of [
      { name: "hold:housekeeping:trash-purge" },
      { name: "deadline:trash-purge", arg: "100" },
      { name: "fail:lock", arg: "2" },
      { name: "fail:commit", arg: "items.bulk@2" },
      { name: "fail:housekeeping:trash-purge" },
      { name: "hold:stream-drain" },
      { name: "hold:read-snapshot" },
      { name: "fail:stream-credential", arg: "3" },
      { name: "unfold-deadline", arg: "1" },
      { name: "hold:webhook-schedule:queued" },
      { name: "resolve:rebind.test", arg: "1.1.1.1,::1;127.0.0.1" },
      { name: "hold:write", arg: "item.update@2" },
      { name: "hold:export-page", arg: "2" },
    ]) {
      const armed = await app.request("/_control/test/faults", {
        method: "PUT",
        body: JSON.stringify(body),
      });
      expect(armed.status, JSON.stringify(body)).toBe(200);
    }
  });

  it("clear one fault by name and leave the rest armed", async () => {
    const app = appFor(true, true);
    for (const name of [
      "hold:housekeeping:trash-purge",
      "hold:version-thinning:item",
    ]) {
      await app.request("/_control/test/faults", {
        method: "PUT",
        body: JSON.stringify({ name }),
      });
    }
    await app.request(
      `/_control/test/faults?name=${encodeURIComponent("hold:housekeeping:trash-purge")}`,
      { method: "DELETE" },
    );
    expect(activeFaults().map((fault) => fault.name)).toEqual([
      "hold:version-thinning:item",
    ]);
  });
});

describe("the resolve fault", () => {
  it("answers one scripted answer per lookup, repeats the last, and counts the lookups", async () => {
    const app = appFor(true, true);
    expect(scriptedAnswer("rebind.test")).toBeUndefined();
    const armed = await app.request("/_control/test/faults", {
      method: "PUT",
      body: JSON.stringify({
        name: "resolve:rebind.test",
        arg: "1.1.1.1>127.0.0.1,2606:4700:4700::1111;::1",
      }),
    });
    expect(armed.status).toBe(200);
    expect(scriptedAnswer("rebind.test")).toEqual({
      checked: ["1.1.1.1", "2606:4700:4700::1111"],
      connected: ["127.0.0.1", "2606:4700:4700::1111"],
    });
    expect(scriptedConnectionAddress("rebind.test", "1.1.1.1")).toBe(
      "127.0.0.1",
    );
    expect(scriptedAnswer("REBIND.test")?.checked).toEqual(["::1"]);
    expect(scriptedConnectionAddress("rebind.test", "::1")).toBe("::1");
    expect(scriptedAnswer("rebind.test")?.checked).toEqual(["::1"]);
    expect(scriptedAnswer("other.test")).toBeUndefined();
    expect(activeFaults()[0]).toMatchObject({
      name: "resolve:rebind.test",
      fired: 3,
    });
    clearFaults();
    expect(scriptedAnswer("rebind.test")).toBeUndefined();
  });
});
