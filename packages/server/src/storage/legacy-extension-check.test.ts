import { describe, it, expect, afterEach } from "vitest";
import { createTestContext } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { checkLegacySyncAgentExtensions } from "./legacy-extension-check.js";

let ctx: TestContext | undefined;

afterEach(async () => {
  await ctx?.cleanup();
  ctx = undefined;
});

describe("T-140 — legacy sync-agent extension boot probe", () => {
  it("returns 0 on a fresh database", async () => {
    ctx = await createTestContext();
    const count = await checkLegacySyncAgentExtensions(ctx.storage);
    expect(count).toBe(0);
  });

  it("returns 0 when items only carry the new `sync` namespace", async () => {
    ctx = await createTestContext();
    const item = await ctx.storage.items.create({
      type: "core.note",
      properties: { body: "hello" },
    });
    await ctx.storage.metadata.setExtension(item.id, "sync", {
      file_path: "x.md",
      modified_at: new Date().toISOString(),
    });
    const count = await checkLegacySyncAgentExtensions(ctx.storage);
    expect(count).toBe(0);
  });

  it("counts every metadata row carrying the legacy `sync-agent` namespace", async () => {
    ctx = await createTestContext();
    const a = await ctx.storage.items.create({
      type: "core.note",
      properties: { body: "a" },
    });
    const b = await ctx.storage.items.create({
      type: "core.note",
      properties: { body: "b" },
    });
    const c = await ctx.storage.items.create({
      type: "core.note",
      properties: { body: "c" },
    });
    // Two items carry the legacy namespace; one carries only the new
    // namespace and must NOT be counted.
    await ctx.storage.metadata.setExtension(a.id, "sync-agent", {
      legacy: true,
    });
    await ctx.storage.metadata.setExtension(b.id, "sync-agent", {
      legacy: true,
    });
    await ctx.storage.metadata.setExtension(c.id, "sync", { migrated: true });

    const count = await checkLegacySyncAgentExtensions(ctx.storage);
    expect(count).toBe(2);
  });

  it("counts a row that carries BOTH legacy and new namespaces (collision case)", async () => {
    ctx = await createTestContext();
    const item = await ctx.storage.items.create({
      type: "core.note",
      properties: { body: "x" },
    });
    await ctx.storage.metadata.setExtension(item.id, "sync-agent", {
      legacy: true,
    });
    await ctx.storage.metadata.setExtension(item.id, "sync", {
      migrated: true,
    });
    const count = await checkLegacySyncAgentExtensions(ctx.storage);
    expect(count).toBe(1);
  });

  it("returns 0 (best-effort) when the storage escape-hatch is missing", async () => {
    // Stub storage that resembles the real shape but omits the
    // dialect-specific raw-query escape hatch the probe relies on.
    // Probe must NOT throw — boot-time it would crash the server.
    const stubStorage = {
      betterAuthDialect: "pg" as const,
      // No __pgClient property.
    } as unknown as Parameters<typeof checkLegacySyncAgentExtensions>[0];
    const count = await checkLegacySyncAgentExtensions(stubStorage);
    expect(count).toBe(0);
  });

  it("returns 0 (best-effort) when the underlying query throws", async () => {
    const stubStorage = {
      betterAuthDialect: "sqlite" as const,
      __sqliteAll: () => {
        throw new Error("simulated db failure");
      },
    } as unknown as Parameters<typeof checkLegacySyncAgentExtensions>[0];
    const count = await checkLegacySyncAgentExtensions(stubStorage);
    expect(count).toBe(0);
  });
});
