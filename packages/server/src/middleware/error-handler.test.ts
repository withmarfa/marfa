import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestContext, type TestContext } from "../test-utils.js";

describe("error handler — malformed and empty bodies (T-077)", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestContext();
  });

  afterAll(() => {
    ctx.cleanup();
  });

  async function postRaw(body: string): Promise<Response> {
    return ctx.app.request("/items", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ctx.adminKey}`,
        "Content-Type": "application/json",
      },
      body,
    });
  }

  it("malformed JSON body returns 400 validation_error", async () => {
    const response = await postRaw("{not valid json");
    expect(response.status).toBe(400);
    expect(response.headers.get("X-Error-Code")).toBe("validation_error");
    const body = (await response.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("validation_error");
  });

  it("empty body on POST /items returns 400 validation_error", async () => {
    const response = await postRaw("");
    expect(response.status).toBe(400);
    expect(response.headers.get("X-Error-Code")).toBe("validation_error");
    const body = (await response.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("validation_error");
  });

  it("array instead of object on POST /items returns 400 (not 500)", async () => {
    const response = await postRaw(JSON.stringify([{ type: "core.note" }]));
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
  });
});
