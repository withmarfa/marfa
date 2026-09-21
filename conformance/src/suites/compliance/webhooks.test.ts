import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import {
  createTestContext,
  trackItem,
  trackKey,
  trackWebhook,
  cleanup,
} from "../../utils/setup.js";
import { createNote } from "../../generators/items.js";
import { expectMatchesSchema } from "../../utils/openapi.js";
import {
  expectSignedBy,
  startReceiver,
  type Receiver,
} from "../../utils/webhook-receiver.js";

let client: MarfaClient;
let ctx: TestContext;
let apiUrl: string;
let receiver: Receiver;
let receiverUrl: string;

beforeAll(async () => {
  ({ ctx, client, apiUrl } = await createTestContext("compliance", "webhooks"));
  receiver = await startReceiver();
  receiverUrl = receiver.url;
});

afterAll(async () => {
  await receiver.close();
  await cleanup(ctx);
});

describe("outbound webhooks", () => {
  it("registers a subscription and returns the secret once", async () => {
    const created = await client.createWebhook({
      url: receiverUrl,
      events: ["item.created"],
    });
    expect(created.status).toBe(201);
    trackWebhook(ctx, created.data.id, client);
    await expectMatchesSchema("POST", "/webhooks", 201, created.data);
    expect(created.data.url).toBe(receiverUrl);
    expect(created.data.events).toEqual(["item.created"]);
    expect(created.data.active).toBe(true);
    expect(created.data.secret).toMatch(/^[0-9a-f]{64}$/);

    const fetched = await client.getWebhook(created.data.id);
    expect(fetched.ok).toBe(true);
    await expectMatchesSchema("GET", "/webhooks/{id}", 200, fetched.data);
    expect(fetched.data.id).toBe(created.data.id);
    expect(fetched.data.secret).not.toBe(created.data.secret);
    expect(fetched.data.secret).toMatch(/^\*+[0-9a-f]{4}$/);

    const listed = await client.listWebhooks();
    expect(listed.ok).toBe(true);
    await expectMatchesSchema("GET", "/webhooks", 200, listed.data);
    const mine = listed.data.webhooks.find((w) => w.id === created.data.id);
    expect(mine).toBeDefined();
    expect(mine?.secret).not.toBe(created.data.secret);
  });

  it("delivers a matching event to the URL with a verifiable signature", async () => {
    const created = await client.createWebhook({
      url: receiver.hookUrl("signed"),
      events: ["item.created"],
    });
    expect(created.status).toBe(201);
    trackWebhook(ctx, created.data.id, client);
    const secret = created.data.secret;

    const item = await client.createItem(
      createNote({ source: ctx.source, properties: { body: "delivered" } }),
    );
    expect(item.ok).toBe(true);
    trackItem(ctx, item.data.item.id);

    const delivery = await receiver.waitFor(
      (r) => r.path === "/hook/signed" && r.body.includes(item.data.item.id),
    );
    expect(delivery.headers["x-marfa-event-type"]).toBe("item.created");
    expect(delivery.headers["content-type"]).toContain("application/json");
    const payload = JSON.parse(delivery.body) as {
      event_type: string;
      item: { id: string; type: string };
    };
    expect(payload.event_type).toBe("item.created");
    expect(payload.item.id).toBe(item.data.item.id);
    expect(payload.item.type).toBe("core.note");

    expectSignedBy(delivery, secret);

    const deliveries = await client.listWebhookDeliveries(created.data.id);
    expect(deliveries.ok).toBe(true);
    await expectMatchesSchema(
      "GET",
      "/webhooks/{id}/deliveries",
      200,
      deliveries.data,
    );
    const row = deliveries.data.deliveries.find(
      (d) => d.event_type === "item.created",
    );
    expect(row).toBeDefined();
    expect(row?.succeeded).toBe(true);
    expect(row?.status_code).toBe(200);
    expect(row?.attempt).toBe(1);
  });

  it("refuses a wildcard subscription while a named one on the same event is delivered", async () => {
    // Asserting the refusal alone would pass on a server that had stopped
    // delivering altogether, so the named subscription on the same event is
    // here as the proof that dispatch still works with `*` gone.
    const wildcard = await client.createWebhook({
      url: receiver.hookUrl("wildcard"),
      events: ["*"],
    });
    expect(wildcard.status).toBe(400);
    expect(wildcard.error?.error.code).toBe("validation_error");
    // The entry's position rather than the body, because a caller editing a
    // list of ten has to be told which one went.
    const errors = wildcard.error?.error.details?.errors as
      { path: string; message: string }[] | undefined;
    expect(errors?.[0]?.path).toBe("events.0");

    const named = await client.createWebhook({
      url: receiver.hookUrl("wildcard-control"),
      events: ["item.created"],
    });
    expect(named.status).toBe(201);
    trackWebhook(ctx, named.data.id, client);

    const item = await client.createItem(
      createNote({ source: ctx.source, properties: { body: "wildcard" } }),
    );
    expect(item.ok).toBe(true);
    trackItem(ctx, item.data.item.id);

    const delivered = await receiver.waitFor(
      (r) =>
        r.path === "/hook/wildcard-control" &&
        r.body.includes(item.data.item.id),
    );
    expect(delivered.headers["x-marfa-event-type"]).toBe("item.created");
    expectSignedBy(delivered, named.data.secret);

    // Nothing reached the URL the refused request named, which is what makes
    // the refusal a refusal rather than a row written somewhere else.
    expect(
      receiver.received.filter((r) => r.path === "/hook/wildcard"),
    ).toEqual([]);

    const rows = await client.listWebhookDeliveries(named.data.id);
    expect(rows.ok).toBe(true);
    expect(rows.data.deliveries.map((d) => d.event_type)).toEqual([
      "item.created",
    ]);
    expect(rows.data.deliveries.every((d) => d.succeeded)).toBe(true);
  });

  it("refuses a wildcard on the update door, leaving the stored events alone", async () => {
    // One vocabulary, two doors. `PATCH` rewrites the whole event list, so a
    // door that still took `*` here would put back exactly the row the create
    // door now refuses to write, and the refusal would be a property of one
    // door rather than of the vocabulary.
    const created = await client.createWebhook({
      url: receiver.hookUrl("patch-wildcard"),
      events: ["item.created"],
    });
    expect(created.status).toBe(201);
    trackWebhook(ctx, created.data.id, client);

    const refused = await client.updateWebhook(created.data.id, {
      events: ["*"],
    });
    expect(refused.status).toBe(400);
    expect(refused.error?.error.code).toBe("validation_error");

    // Read back, because a door that answered 400 after writing would satisfy
    // the status assertion alone.
    const untouched = await client.getWebhook(created.data.id);
    expect(untouched.ok).toBe(true);
    expect(untouched.data.events).toEqual(["item.created"]);

    // The control: the same door takes a named event in the same field, so
    // the refusal above is the vocabulary rather than a door that had stopped
    // accepting `events` at all.
    const accepted = await client.updateWebhook(created.data.id, {
      events: ["item.updated"],
    });
    expect(accepted.ok).toBe(true);
    expect(accepted.data.events).toEqual(["item.updated"]);
  });

  it("does not deliver an event outside the subscription", async () => {
    const created = await client.createWebhook({
      url: receiver.hookUrl("deleted-only"),
      events: ["item.deleted"],
    });
    expect(created.status).toBe(201);
    trackWebhook(ctx, created.data.id, client);

    // A sentinel of the subscribed kind proves the earlier, unsubscribed
    // event was not merely late.
    const item = await client.createItem(
      createNote({ source: ctx.source, properties: { body: "not delivered" } }),
    );
    expect(item.ok).toBe(true);
    trackItem(ctx, item.data.item.id);
    const deleted = await client.deleteItem(item.data.item.id);
    expect(deleted.ok).toBe(true);

    const sentinel = await receiver.waitFor(
      (r) =>
        r.path === "/hook/deleted-only" &&
        r.headers["x-marfa-event-type"] === "item.deleted" &&
        r.body.includes(item.data.item.id),
    );
    expect(sentinel).toBeDefined();
    const toThisHook = receiver.received.filter(
      (r) => r.path === "/hook/deleted-only",
    );
    expect(toThisHook.map((r) => r.headers["x-marfa-event-type"])).toEqual([
      "item.deleted",
    ]);
    const rows = await client.listWebhookDeliveries(created.data.id);
    expect(rows.ok).toBe(true);
    expect(rows.data.deliveries.map((d) => d.event_type)).toEqual([
      "item.deleted",
    ]);
  });

  it("updates the url, events, type filter and active flag in place", async () => {
    const created = await client.createWebhook({
      url: receiver.hookUrl("before-patch"),
      events: ["item.created"],
    });
    expect(created.status).toBe(201);
    trackWebhook(ctx, created.data.id, client);

    const patchedUrl = receiver.hookUrl("after-patch");
    const updated = await client.updateWebhook(created.data.id, {
      url: patchedUrl,
      events: ["item.updated"],
      type_filter: "core.note",
      active: false,
    });
    expect(updated.ok).toBe(true);
    await expectMatchesSchema("PATCH", "/webhooks/{id}", 200, updated.data);
    expect(updated.data.url).toBe(patchedUrl);
    expect(updated.data.events).toEqual(["item.updated"]);
    expect(updated.data.type_filter).toBe("core.note");
    expect(updated.data.active).toBe(false);
    expect(Date.parse(updated.data.updated_at)).toBeGreaterThanOrEqual(
      Date.parse(created.data.updated_at),
    );

    // Read back rather than trusting the write's own answer: a server that
    // echoed the patch while storing the old row satisfies every assertion
    // above.
    const read = await client.getWebhook(created.data.id);
    expect(read.ok).toBe(true);
    expect(read.data.url).toBe(patchedUrl);
    expect(read.data.events).toEqual(["item.updated"]);
    expect(read.data.type_filter).toBe("core.note");
    expect(read.data.active).toBe(false);
  });

  it("deletes a subscription and answers 404 for it afterwards", async () => {
    const created = await client.createWebhook({
      url: receiverUrl,
      events: ["item.created"],
    });
    expect(created.status).toBe(201);
    trackWebhook(ctx, created.data.id, client);

    const removed = await client.deleteWebhook(created.data.id);
    expect(removed.status).toBe(200);
    await expectMatchesSchema("DELETE", "/webhooks/{id}", 200, removed.data);
    const gone = await client.getWebhook(created.data.id);
    expect(gone.status).toBe(404);
    expect(gone.error?.error.code).toBe("webhook_not_found");
    const removedAgain = await client.deleteWebhook(created.data.id);
    expect(removedAgain.status).toBe(404);
  });

  it("refuses an event name outside the vocabulary", async () => {
    const r = await client.createWebhook({
      url: receiverUrl,
      events: ["item.exploded"],
    });
    expect(r.status).toBe(400);
    expect(r.error?.error.code).toBe("validation_error");
  });

  it("refuses a body with no url or no events", async () => {
    const noUrl = await client.rawRequest("/webhooks", {
      method: "POST",
      body: { events: ["item.created"] },
    });
    expect(noUrl.status).toBe(400);
    const noEvents = await client.rawRequest("/webhooks", {
      method: "POST",
      body: { url: receiverUrl },
    });
    expect(noEvents.status).toBe(400);
  });

  it("refuses a key without webhooks.manage", async () => {
    const mine = await client.createWebhook({
      url: receiver.hookUrl("permission"),
      events: ["item.created"],
    });
    expect(mine.status).toBe(201);
    trackWebhook(ctx, mine.data.id, client);

    const keyResp = await client.createKey({
      label: "no-webhooks",
      source: `${ctx.source}-no-webhooks`,
      permissions: [],
      type_permissions: { "*": "write" },
    });
    expect(keyResp.ok).toBe(true);
    trackKey(ctx, keyResp.data.id);
    const narrowed = new MarfaClient({
      baseUrl: apiUrl,
      apiKey: keyResp.data.key,
    });

    const create = await narrowed.createWebhook({
      url: receiverUrl,
      events: ["item.created"],
    });
    expect(create.status).toBe(403);
    expect(create.error?.error.code).toBe("forbidden");
    expect(create.error?.error.details?.required_scope).toBe("webhooks.manage");
    const list = await narrowed.listWebhooks();
    expect(list.status).toBe(403);
    expect(list.error?.error.details?.required_scope).toBe("webhooks.manage");

    // Against a subscription that exists and belongs to another credential,
    // so a 403 here is the permission gate rather than a miss the row-scoped
    // doors would answer 404 for.
    for (const refused of [
      await narrowed.getWebhook(mine.data.id),
      await narrowed.updateWebhook(mine.data.id, { active: false }),
      await narrowed.listWebhookDeliveries(mine.data.id),
      await narrowed.deleteWebhook(mine.data.id),
    ]) {
      expect(refused.status).toBe(403);
      expect(refused.error?.error.code).toBe("forbidden");
      expect(refused.error?.error.details?.required_scope).toBe(
        "webhooks.manage",
      );
    }

    // The refusals left the row where it was.
    const survived = await client.getWebhook(mine.data.id);
    expect(survived.ok).toBe(true);
    expect(survived.data.active).toBe(true);
  });

  it("refuses a subscription from a credential that cannot read everything", async () => {
    // A second gate, past `webhooks.manage`, and a different refusal. A
    // subscription sends whatever matches to an endpoint the server does
    // not control, so a credential that can read only some types would be
    // exporting the rest through a door it cannot read them through.
    const keyResp = await client.createKey({
      label: "scoped-reader",
      source: `${ctx.source}-scoped-reader`,
      permissions: ["webhooks.manage"],
      type_permissions: { "core.note": "write" },
    });
    expect(keyResp.ok).toBe(true);
    trackKey(ctx, keyResp.data.id);
    const scoped = new MarfaClient({
      baseUrl: apiUrl,
      apiKey: keyResp.data.key,
    });

    const create = await scoped.createWebhook({
      url: receiverUrl,
      events: ["item.created"],
    });
    expect(create.status).toBe(403);
    expect(create.error?.error.code).toBe("scoped_credential_not_permitted");

    // The control: the same credential holds `webhooks.manage`, so the
    // refusal is the reach and not the permission — a key missing the
    // permission answers `forbidden` in the case above.
    const list = await scoped.listWebhooks();
    expect(list.ok).toBe(true);
  });

  it("answers 404 for an unknown subscription on every door", async () => {
    const unknown = "00000000-0000-7000-8000-000000000000";
    expect((await client.getWebhook(unknown)).status).toBe(404);
    expect((await client.updateWebhook(unknown, { active: true })).status).toBe(
      404,
    );
    expect((await client.listWebhookDeliveries(unknown)).status).toBe(404);
    expect((await client.deleteWebhook(unknown)).status).toBe(404);
  });

  it("refuses every door without a credential", async () => {
    const anonymous = new MarfaClient({ baseUrl: apiUrl, apiKey: "" });
    expect((await anonymous.listWebhooks()).status).toBe(401);
    expect(
      (
        await anonymous.createWebhook({
          url: receiverUrl,
          events: ["item.created"],
        })
      ).status,
    ).toBe(401);
  });
});
