/**
 * The seeded platform vocabulary lives in `types`, and must stay invisible
 * to every surface that means "what this instance was given".
 *
 * This is the sharp edge of the shipped set being data rather than code: it
 * shares one table with the registrations, and only the `origin` column
 * tells them apart. A reader that forgets the column puts the platform set
 * into an archive as though somebody had registered it, and the restore
 * replaying that archive is then refused for registering a locked type.
 * Nothing about the mistake is local to the reader that makes it, which is
 * why the invariant is asserted here rather than left to each one.
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createTestContext, type TestContext } from "../test-utils.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("the seeded platform set", () => {
  it("fills the registry, so a shipped type resolves", async () => {
    const note = await ctx.storage.types.get("core.note");
    expect(note?.id).toBe("core.note");
  });

  it("is stored as rows carrying platform provenance", async () => {
    const loaded = await ctx.storage.types.loadAll();
    const note = loaded.find((row) => row.schema.id === "core.note");
    expect(note?.origin).toBe("platform");
    expect(note?.family).toBe("core");

    const webhook = loaded.find((row) => row.schema.id === "system.webhook");
    expect(webhook?.family).toBe("system");
  });

  it("never appears in the runtime registrations", async () => {
    // What an archive carries, and what a restore replays.
    const own = await ctx.storage.types.listRegistered();
    expect(own.map((t) => t.id)).not.toContain("core.note");
  });

  it("is not counted as a registration", async () => {
    // The operator metric answers "how many types has this instance been
    // given", not "how many does the platform ship".
    expect(await ctx.storage.types.countRegistered()).toBe(0);
  });

  it("stays locked against modification and deletion", async () => {
    const { request } = await import("../test-utils.js");
    const res = await request(ctx.app, "DELETE", "/types/core.note", {
      key: ctx.workingKey,
    });
    expect(res.status).toBe(403);
  });
});
