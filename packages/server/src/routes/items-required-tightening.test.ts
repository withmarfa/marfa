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
import {
  createTestContext,
  request,
  TEST_API_KEY_SALT,
} from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { hashApiKey } from "../middleware/auth.js";

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
    // `marfa.*` is a reserved namespace: the only credential that reaches it
    // is a runtime credential whose manifest declared that exact type, which
    // is what the capture handler holds. Both writes go through it — the row
    // carries the credential's integration provenance, so its own re-sync is
    // the only thing allowed to edit it afterwards.
    const suffix = Math.random().toString(36).slice(2, 10);
    const captureKey = `marfa_k1_capture_${suffix}`;
    await ctx.storage.keys.createRuntimeCredential(
      {
        label: `capture-${suffix}`,
        source: `capture-${suffix}`,
        type_permissions: { "marfa.captured_email": "write" },
        connection_id: `conn_capture_${suffix}`,
        expires_at: new Date(Date.now() + 600_000).toISOString(),
        item_source: `integration:acme.capture.${suffix}`,
      },
      hashApiKey(captureKey, TEST_API_KEY_SALT),
      ctx.spaceId,
    );

    // The type is shaped for `core.note` and mirrors `text_body` into `body`,
    // but does not require `body` and does not claim the compatibility, both
    // of which would strand captures written before the handler populated it
    // unconditionally.
    const created = await request(ctx.app, "POST", "/items", {
      key: captureKey,
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
      key: captureKey,
      body: { properties: { subject: "Retitled" } },
    });
    expect(patched.status).toBe(200);
  });
});
