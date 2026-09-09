/**
 * What happens to items that predate a newly-required field.
 *
 * `PATCH /items/:id` re-validates the *merged* property set, not the patch, so
 * adding a field to a type's `required` list does not only constrain future
 * writes — it makes every stored item that lacks the field un-editable, in
 * perpetuity, including by a patch that has nothing to do with that field.
 *
 * That is the correct reading of "required" and these tests do not argue with
 * it. They exist so the cost is a visible, asserted fact rather than something
 * a type author discovers from a support ticket: tightening `required` on a
 * type that already has items needs a backfill first, and the backfill has to
 * land in an earlier deploy than the tightening.
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createTestContext, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.cleanup();
});

/** Register `demo.tightened` with `body` optional, then create one item without it. */
async function seedLooseItem(id: string): Promise<string> {
  const registered = await request(ctx.app, "POST", "/types", {
    key: ctx.spaceKey,
    body: {
      id,
      version: 1,
      fields: {
        title: { type: "string", required: true },
        body: { type: "string" },
      },
    },
  });
  expect(registered.status).toBe(201);

  const created = await request(ctx.app, "POST", "/items", {
    key: ctx.spaceKey,
    body: { type: id, properties: { title: "no body here" } },
  });
  expect(created.status).toBe(201);
  const { item } = (await created.json()) as { item: { id: string } };
  return item.id;
}

async function tightenBodyToRequired(id: string): Promise<void> {
  const updated = await request(ctx.app, "PUT", `/types/${id}`, {
    key: ctx.spaceKey,
    body: {
      id,
      version: 2,
      fields: {
        title: { type: "string", required: true },
        body: { type: "string", required: true },
      },
    },
  });
  expect(updated.status).toBe(200);
}

describe("tightening required on a type with existing items", () => {
  it("locks an unrelated patch out of every row that predates the change", async () => {
    const typeId = "demo.tightened_locked";
    const itemId = await seedLooseItem(typeId);

    // Editable before the tightening.
    const before = await request(ctx.app, "PATCH", `/items/${itemId}`, {
      key: ctx.spaceKey,
      body: { properties: { title: "still fine" } },
    });
    expect(before.status).toBe(200);

    await tightenBodyToRequired(typeId);

    // The same patch, touching only `title`, is now rejected — the merged set
    // is what gets validated, and it has no `body`.
    const after = await request(ctx.app, "PATCH", `/items/${itemId}`, {
      key: ctx.spaceKey,
      body: { properties: { title: "no longer allowed" } },
    });
    expect(after.status).toBe(400);
    const body = (await after.json()) as {
      error: { code: string; details?: { errors?: { field: string }[] } };
    };
    expect(body.error.code).toBe("invalid_properties");
    expect(body.error.details?.errors?.some((e) => e.field === "body")).toBe(
      true,
    );
  });

  it("is undone by supplying the missing field, which is what a backfill does", async () => {
    const typeId = "demo.tightened_recovered";
    const itemId = await seedLooseItem(typeId);
    await tightenBodyToRequired(typeId);

    const repaired = await request(ctx.app, "PATCH", `/items/${itemId}`, {
      key: ctx.spaceKey,
      body: { properties: { body: "" } },
    });
    expect(repaired.status).toBe(200);

    const afterwards = await request(ctx.app, "PATCH", `/items/${itemId}`, {
      key: ctx.spaceKey,
      body: { properties: { title: "editable again" } },
    });
    expect(afterwards.status).toBe(200);
  });
});

describe("marfa.captured_email keeps bodyless captures editable", () => {
  it("accepts a capture with no body and lets it be patched afterwards", async () => {
    // The type is shaped for `core.note` and mirrors `text_body` into `body`,
    // but does not require `body` and does not claim the compatibility, both
    // of which would strand captures written before the handler populated it
    // unconditionally.
    const created = await request(ctx.app, "POST", "/items", {
      key: ctx.spaceKey,
      body: {
        type: "marfa.captured_email",
        properties: {
          from_address: "sender@example.com",
          to_address: "capture@example.com",
          subject: "No text part",
        },
      },
    });
    expect(created.status).toBe(201);
    const { item } = (await created.json()) as { item: { id: string } };

    const patched = await request(ctx.app, "PATCH", `/items/${item.id}`, {
      key: ctx.spaceKey,
      body: { properties: { subject: "Retitled" } },
    });
    expect(patched.status).toBe(200);
  });
});
