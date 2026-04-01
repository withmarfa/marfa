import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createTestContext, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(() => {
  ctx.cleanup();
});

describe("GET /", () => {
  it("returns capabilities", async () => {
    const res = await request(ctx.app, "GET", "/");
    expect(res.status).toBe(200);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data.name).toBe("myme");
    expect(data.version).toBe("0.0.1");
    expect(data).toHaveProperty("features");
  });
});

describe("GET /health", () => {
  it("returns ok status", async () => {
    const res = await request(ctx.app, "GET", "/health");
    expect(res.status).toBe(200);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data.status).toBe("ok");
  });
});
