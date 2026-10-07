import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import { createTestContext, cleanup } from "../../utils/setup.js";

let client: MarfaClient;
let ctx: TestContext;

beforeAll(async () => {
  ({ ctx, client } = await createTestContext("compliance", "type-label"));
});

afterAll(async () => {
  await cleanup(ctx);
});

describe("type label compliance", () => {
  it("built-in types have labels", async () => {
    const list = await client.listTypes();
    expect(list.ok).toBe(true);

    const coreNote = list.data.data.find((t) => t.id === "core.note");
    expect(coreNote).toBeDefined();
    expect(coreNote!.label).toBe("Note");
  });

  it("get single type includes label", async () => {
    const r = await client.getType("core.note");
    expect(r.ok).toBe(true);
    expect(r.data.label).toBe("Note");
  });

  it("register custom type with label", async () => {
    // **`user.*`, not a publisher root.** The publisher tier's first segment
    // is a claimable handle, and registering there requires the caller to hold
    // it; the suite's credentials hold none, so every publisher registration
    // is refused. Labels are a property of any custom type, so the tier is
    // incidental to what this file is about.
    const typeId = `user.label-test-${ctx.runId}`;
    const r = await client.registerType({
      id: typeId,
      label: "Test Widget",
      fields: { title: { type: "string", required: true } },
    });
    expect(r.ok).toBe(true);

    const fetched = await client.getType(typeId);
    expect(fetched.ok).toBe(true);
    expect(fetched.data.label).toBe("Test Widget");
  });

  it("register custom type without label", async () => {
    const typeId = `user.no-label-${ctx.runId}`;
    const r = await client.registerType({
      id: typeId,
      fields: { value: { type: "number" } },
    });
    expect(r.ok).toBe(true);

    const fetched = await client.getType(typeId);
    expect(fetched.ok).toBe(true);
    // Derived from the identifier's last segment: hyphen-separated words,
    // each capitalized.
    const derived = typeId
      .split(".")
      .pop()!
      .split("-")
      .map((word) => word[0].toUpperCase() + word.slice(1))
      .join(" ");
    expect(fetched.data.label).toBe(derived);
  });

  it("makes a label from the identifier when a replacement names none", async () => {
    const typeId = `user.relabel-${ctx.runId}`;
    expect(
      (
        await client.registerType({
          id: typeId,
          label: "Given",
          fields: { value: { type: "number" } },
        })
      ).ok,
    ).toBe(true);
    // The witness: the label the registration named is the one read back.
    expect((await client.getType(typeId)).data.label).toBe("Given");

    const replaced = await client.replaceType(typeId, {
      id: typeId,
      fields: { value: { type: "number" } },
    });
    expect(replaced.status, JSON.stringify(replaced.error)).toBe(200);
    const derived = typeId
      .split(".")
      .pop()!
      .replace(/[_-]/g, " ")
      .replace(/\b\w/g, (ch) => ch.toUpperCase());
    expect((await client.getType(typeId)).data.label).toBe(derived);
  });

  it("label appears in type list", async () => {
    const typeId = `user.label-list-${ctx.runId}`;
    const r = await client.registerType({
      id: typeId,
      label: "Listed Widget",
      fields: { name: { type: "string" } },
    });
    expect(r.ok).toBe(true);

    const list = await client.listTypes();
    expect(list.ok).toBe(true);

    const found = list.data.data.find((t) => t.id === typeId);
    expect(found).toBeDefined();
    expect(found!.label).toBe("Listed Widget");
  });
});
