import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import { createTestContext, cleanup } from "../../utils/setup.js";

let client: MarfaClient;
let ctx: TestContext;

beforeAll(async () => {
  ({ ctx, client } = await createTestContext("compliance", "platform-types"));
});

afterAll(async () => {
  await cleanup(ctx);
});

describe("the shipped types", () => {
  it("serves no type named by a word the glossary bans", async () => {
    const listed = await client.listTypes();
    expect(listed.ok).toBe(true);
    const ids = listed.data.data.map((t) => t.id);
    expect(ids).toContain("system.connection");
    expect(ids).not.toContain("system.integration");
    const missing = await client.getType("system.integration");
    expect(missing.status).toBe(404);
    expect(missing.error?.error.code).toBe("type_not_found");
  });
});
