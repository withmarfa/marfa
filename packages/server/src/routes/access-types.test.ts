import { parseScope } from "@withmarfa/shared";
import { afterEach, describe, expect, it } from "vitest";
import { createTestContext, type TestContext } from "../test-utils.js";
import { asksForAllData, resolveChoosableTypes } from "./access-types.js";
import { resolveWildcardExpansions } from "./auth-consent.js";

let ctx: TestContext | undefined;
afterEach(async () => {
  await ctx?.cleanup();
  ctx = undefined;
});

describe("resolveChoosableTypes", () => {
  it("lists the core types by identifier, then the instance's own, and never a system type", async () => {
    ctx = await createTestContext({});
    await ctx.storage.types.create({
      id: "app.inkwell.draft",
      label: "Reading summary",
      version: 1,
      fields: {},
    });
    const types = await resolveChoosableTypes(ctx.storage, ["*:read"]);
    const ids = types.map((type) => type.id);
    expect(ids.some((id) => id.startsWith("system."))).toBe(false);
    // The witness that the filter removes something: the registry holds them.
    expect(
      (await ctx.storage.types.list()).some((t) => t.id.startsWith("system.")),
    ).toBe(true);
    expect(ids.at(-1)).toBe("app.inkwell.draft");
    expect(types.at(-1)?.label).toBe("Reading summary");
    const core = ids.filter((id) => id.startsWith("core."));
    expect(ids.slice(0, core.length)).toEqual([...core].sort());
    // A type sits beside its subtypes.
    expect(core.indexOf("core.entity.person")).toBe(
      core.indexOf("core.entity") + 1,
    );
  });

  it("offers a client with no registered list a type registered while the server runs", async () => {
    ctx = await createTestContext({});
    await ctx.storage.types.create({
      id: "app.inkwell.draft",
      label: "Reading summary",
      version: 1,
      fields: {},
    });
    const ids = (await resolveChoosableTypes(ctx.storage, null)).map(
      (type) => type.id,
    );
    expect(ids).toContain("core.note");
    expect(ids).toContain("app.inkwell.draft");
  });
});

describe("asksForAllData", () => {
  it("is true for the all-data scope at either level, and for nothing narrower", () => {
    expect(asksForAllData(["openid", "*:read"])).toBe(true);
    expect(asksForAllData(["*:write"])).toBe(true);
    expect(
      asksForAllData(["core.*:read", "core.note:read", "content:read"]),
    ).toBe(false);
  });
});

describe("the names a wildcard's reach line gives", () => {
  it("names a type with no label as its own row does", async () => {
    ctx = await createTestContext({});
    await ctx.storage.types.create({
      id: "user.reading_list",
      version: 1,
      fields: {},
    });
    await ctx.storage.types.create({
      id: "user.ticket",
      label: "Ticket",
      version: 1,
      fields: {},
    });
    const scope = parseScope("user.*:read");
    if (!scope) throw new Error("unparseable");
    // The witness: the registry holds the type with no label of its own.
    expect((await ctx.storage.types.get("user.reading_list"))?.label).toBe(
      undefined,
    );
    expect(
      (await resolveWildcardExpansions(ctx.storage, [scope]))["user.*"],
    ).toEqual(["Reading list", "Ticket"]);
  });
});
