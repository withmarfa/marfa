/**
 * The root route, which is the one door a caller holding nothing can ask
 * what it is talking to.
 *
 * It had no test in this package at all. `compliance/instance.test.ts`
 * asserts what it serves, but that suite needs a booted server and runs in
 * a separate job, so a regression in the boot wiring — `index.ts` resolving
 * the identity and handing it to `createApp` — reached the conformance run
 * or nothing. Mutating the served id to a literal passed 2,559 tests here.
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createTestContext } from "./test-utils.js";
import type { TestContext } from "./test-utils.js";
import { ensureInstanceId } from "./storage/instance-id.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("GET /", () => {
  it("names the instance its own storage holds", async () => {
    const res = await ctx.app.request("/");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      name: string;
      version: string;
      instance_id: string;
      features: string[];
    };
    expect(body.name).toBe("marfa");
    // Against the store, not against a shape. A hardcoded or invented id
    // satisfies every assertion about format, and the wiring this covers is
    // exactly the step that could hand the app somebody else's name.
    expect(body.instance_id).toBe(await ensureInstanceId(ctx.storage.settings));
    expect(body.features.length).toBeGreaterThan(0);
  });

  it("answers without a credential", async () => {
    // The whole point of the door. It is mounted ahead of the auth
    // middleware, and a caller that has to present something to learn the
    // instance's name cannot use it to decide what to present.
    const res = await ctx.app.request("/");
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Error-Code")).toBeNull();
  });

  it("serves the same identity as GET /config", async () => {
    // Three doors, one name, and all three are in this package: the root,
    // `/config` and the export manifest. The conformance suite asserts them
    // together against a booted server; this holds the root against
    // `/config`, and `export.test.ts` holds the manifest against
    // `ensureInstanceId`, so neither pair can drift between conformance
    // runs.
    const root = (await (await ctx.app.request("/")).json()) as {
      instance_id: string;
    };
    const res = await ctx.app.request("/config", {
      headers: { Authorization: `Bearer ${ctx.workingKey}` },
    });
    expect(res.status).toBe(200);
    const config = (await res.json()) as { instance_id: string };
    expect(config.instance_id).toBe(root.instance_id);
  });
});
