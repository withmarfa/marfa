import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { clockOffsetMs, resetClockForTests } from "../clock.js";
import { ensureInstanceId } from "../storage/instance-id.js";
import { createTestContext, type TestContext } from "../test-utils.js";
import { activeFaults, clearFaults, holdAt } from "./faults.js";

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
      { name: "fail:disk" },
      { name: "fail:lock", arg: "0" },
      { name: "fail:lock", arg: "items.bulk@2" },
      { name: "fail:commit", arg: "items.bulk@0" },
      { name: "fail:housekeeping:no-such-job" },
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
