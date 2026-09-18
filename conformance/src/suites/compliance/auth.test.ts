import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import { createTestContext, cleanup } from "../../utils/setup.js";

let client: MarfaClient;
let ctx: TestContext;
let apiUrl: string;

beforeAll(async () => {
  ({ ctx, client, apiUrl } = await createTestContext("compliance", "auth"));
});

afterAll(async () => {
  await cleanup(ctx);
});

describe("authentication", () => {
  it("returns 401 when no auth header is provided", async () => {
    const noAuthClient = new MarfaClient({
      baseUrl: apiUrl,
      apiKey: "",
    });
    const response = await noAuthClient.listItems();
    expect(response.status).toBe(401);
    expect(response.error?.error.code).toBe("unauthorized");
  });

  it("returns 401 for an invalid API key", async () => {
    const badClient = new MarfaClient({
      baseUrl: apiUrl,
      apiKey: "completely-invalid-key-value",
    });
    const response = await badClient.listItems();
    expect(response.status).toBe(401);
    expect(response.error?.error.code).toBe("unauthorized");
  });

  it("accepts a valid API key", async () => {
    const response = await client.listItems({ limit: 1 });
    expect(response.ok).toBe(true);
  });
});
