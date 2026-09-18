import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import { createTestContext, cleanup, trackItem } from "../../utils/setup.js";
import { createMessage } from "../../generators/items.js";

/**
 * `core.message` is the light, cross-platform message type: a body, a sender,
 * and an optional recipient list, with threading expressed as edges rather
 * than as properties. Anything richer — attachments, reactions, read state —
 * belongs to an app namespace, so the coverage here is deliberately narrow.
 *
 * Both `body` and `from` are required. `from` is easy to overlook because a
 * message reads like a note with an author attached, so the required-field
 * assertions cover each field independently.
 */

let client: MarfaClient;
let ctx: TestContext;

beforeAll(async () => {
  ({ ctx, client } = await createTestContext("compliance", "core-message"));
});

afterAll(async () => {
  await cleanup(ctx);
});

describe("core.message", () => {
  it("creates a message with body, from, and to", async () => {
    const r = await client.createItem(createMessage({ source: ctx.source }));
    expect(r.ok).toBe(true);
    trackItem(ctx, r.data.item.id);

    const props = r.data.item.properties;
    expect(props.body).toBe("Hey, the new conformance suite is looking great!");
    expect(props.from).toBe("alice@example.com");
    expect(props.to).toEqual(["bob@example.com"]);
  });

  it("creates with only the required body and from", async () => {
    const r = await client.createItem({
      type: "core.message",
      source: ctx.source,
      properties: { body: "No recipients on this one.", from: "+15550100" },
    });
    expect(r.ok).toBe(true);
    trackItem(ctx, r.data.item.id);
    expect(r.data.item.properties.from).toBe("+15550100");
  });

  it("accepts participant identifiers in any format", async () => {
    // The type documents `from` and `to` as format-agnostic. A phone number, a
    // handle, and an email must all be accepted verbatim — the server does not
    // normalize them, so a client that round-trips one gets back what it sent.
    const r = await client.createItem({
      type: "core.message",
      source: ctx.source,
      properties: {
        body: "Mixed identifier formats.",
        from: "@alice",
        to: ["+15550101", "bob@example.com", "@carol"],
      },
    });
    expect(r.ok).toBe(true);
    trackItem(ctx, r.data.item.id);
    expect(r.data.item.properties.to).toEqual([
      "+15550101",
      "bob@example.com",
      "@carol",
    ]);
  });

  it("rejects a message missing body with invalid_properties naming it", async () => {
    const r = await client.createItem({
      type: "core.message",
      source: ctx.source,
      properties: { from: "alice@example.com" },
    });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(400);
    expect(r.error?.error.code).toBe("invalid_properties");
    const errors = r.error?.error.details?.errors as
      Array<{ field: string }> | undefined;
    expect(errors?.map((e) => e.field)).toContain("body");
  });

  it("rejects a message missing from with invalid_properties naming it", async () => {
    const r = await client.createItem({
      type: "core.message",
      source: ctx.source,
      properties: { body: "Who sent this?" },
    });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(400);
    expect(r.error?.error.code).toBe("invalid_properties");
    const errors = r.error?.error.details?.errors as
      Array<{ field: string }> | undefined;
    expect(errors?.map((e) => e.field)).toContain("from");
  });

  it("starts in active state (universal lifecycle)", async () => {
    const r = await client.createItem(createMessage({ source: ctx.source }));
    expect(r.ok).toBe(true);
    trackItem(ctx, r.data.item.id);
    expect(r.data.item.state).toBe("active");
  });

  it("transitions active -> archived", async () => {
    const r = await client.createItem(createMessage({ source: ctx.source }));
    expect(r.ok).toBe(true);
    trackItem(ctx, r.data.item.id);

    const archived = await client.transitionItem(r.data.item.id, "archived");
    expect(archived.ok).toBe(true);
    expect(archived.data.item.state).toBe("archived");

    const fetched = await client.getItem(r.data.item.id);
    expect(fetched.ok).toBe(true);
    expect(fetched.data.item.state).toBe("archived");
  });

  it("declares body as its display body field", async () => {
    // `display_hints` is what lets a generic client render an unfamiliar type
    // without special-casing it, so the hint is part of the contract rather
    // than documentation.
    const t = await client.getType("core.message");
    expect(t.ok).toBe(true);
    expect(t.data.display_hints?.body_field).toBe("body");
  });

  it("declares body and from as required in the registry", async () => {
    // The registry is the authority the create-time validation above is
    // checked against; asserting both sides catches a schema that drifts from
    // the behavior without either alone failing.
    const t = await client.getType("core.message");
    expect(t.ok).toBe(true);
    expect(t.data.fields.body.required).toBe(true);
    expect(t.data.fields.from.required).toBe(true);
    expect(t.data.fields.to.required).toBeUndefined();
  });
});
