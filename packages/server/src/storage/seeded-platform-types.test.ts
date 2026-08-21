/**
 * The seeded platform vocabulary lives in `custom_types`, and must stay
 * invisible to every surface that means "what this space registered".
 *
 * This is the sharp edge of making the shipped set data. Three surfaces read
 * that table and all three meant "custom" as "not shipped", which was true
 * for free while the shipped set was compiled in. Seeding broke that
 * assumption silently: an archive began carrying the platform set as though
 * the space had registered it, and the restore replaying it was refused for
 * registering a locked type.
 *
 * The failures were caught by unrelated suites. This one names the invariant
 * so the next change to the table meets it directly.
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
    const loaded = await ctx.storage.types.loadCustomTypes();
    const note = loaded.find((row) => row.schema.id === "core.note");
    expect(note?.origin).toBe("platform");
    expect(note?.family).toBe("core");

    const activity = loaded.find((row) => row.schema.id === "system.activity");
    expect(activity?.family).toBe("system");
  });

  it("never appears in a space's own registrations", async () => {
    // What an archive carries, and what a restore replays.
    const own = await ctx.storage.types.listCustom();
    expect(own.map((t) => t.id)).not.toContain("core.note");
  });

  it("is not counted as a custom type", async () => {
    // The operator metric answers "how many types has this instance been
    // given", not "how many does the platform ship".
    expect(await ctx.storage.types.countCustom()).toBe(0);
  });

  it("stays locked against modification and deletion", async () => {
    const { request } = await import("../test-utils.js");
    const res = await request(ctx.app, "DELETE", "/types/core.note", {
      key: ctx.adminKey,
    });
    expect(res.status).toBe(403);
  });
});
