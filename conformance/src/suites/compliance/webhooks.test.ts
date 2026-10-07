import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { BulkActionJob, TestContext } from "../../client/types.js";
import {
  createTestContext,
  getOperatorClient,
  trackEdge,
  trackItem,
  trackKey,
  trackWebhook,
  cleanup,
} from "../../utils/setup.js";
import { v7 as uuidv7 } from "uuid";
import { itemsArchive } from "../../utils/archive.js";
import { createNote, createTask } from "../../generators/items.js";
import { withStream, collectUntil } from "../../utils/stream.js";
import { expectMatchesSchema } from "../../utils/openapi.js";
import {
  expectSignedBy,
  startReceiver,
  type Receiver,
} from "../../utils/webhook-receiver.js";

let client: MarfaClient;
let ctx: TestContext;
let apiUrl: string;
let apiKey: string;
let receiver: Receiver;
let receiverUrl: string;

beforeAll(async () => {
  ({ ctx, client, apiUrl, apiKey } = await createTestContext(
    "compliance",
    "webhooks",
  ));
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
    const mine = listed.data.data.find((w) => w.id === created.data.id);
    expect(mine).toBeDefined();
    expect(mine?.secret).not.toBe(created.data.secret);
  });

  it("redelivers a retained failed row to the current address with stable identity", async () => {
    const refusal = await startReceiver({ status: 400 });
    try {
      const created = await client.createWebhook({
        url: refusal.hookUrl("refused"),
        events: ["item.created"],
      });
      expect(created.status).toBe(201);
      trackWebhook(ctx, created.data.id, client);
      const item = await client.createItem(
        createNote({
          source: ctx.source,
          properties: { body: "redelivery witness" },
        }),
      );
      expect(item.ok).toBe(true);
      trackItem(ctx, item.data.item.id);
      const first = await refusal.waitFor((r) =>
        r.body.includes(item.data.item.id),
      );
      expectSignedBy(first, created.data.secret);
      let failed = (
        await client.listWebhookDeliveries(created.data.id)
      ).data.data.find(
        (d) =>
          d.id ===
          (JSON.parse(first.body) as { delivery_id: string }).delivery_id,
      );
      const deadline = Date.now() + 10000;
      while (failed?.status !== "dead_letter" && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25));
        failed = (
          await client.listWebhookDeliveries(created.data.id)
        ).data.data.find(
          (d) =>
            d.id ===
            (JSON.parse(first.body) as { delivery_id: string }).delivery_id,
        );
      }
      expect(failed).toMatchObject({
        status: "dead_letter",
        status_code: 400,
        attempt: 1,
      });
      const path = `/webhooks/${created.data.id}/deliveries/${failed!.id}/redeliver`;
      const missing = await client.rawRequest(
        `/webhooks/${created.data.id}/deliveries/missing-delivery/redeliver`,
        { method: "POST" },
      );
      expect(missing.status).toBe(404);
      expect(missing.error?.error.code).toBe("webhook_not_found");
      expect(
        (await client.updateWebhook(created.data.id, { active: false })).ok,
      ).toBe(true);
      const inactive = await client.rawRequest(path, { method: "POST" });
      expect(inactive.status).toBe(409);
      expect(inactive.error?.error.code).toBe("conflict");
      const retained = await client.listWebhookDeliveries(created.data.id);
      expect(retained.data.data.find((d) => d.id === failed!.id)).toMatchObject(
        {
          status: "dead_letter",
          attempt: 1,
          status_code: 400,
        },
      );
      const updated = await client.updateWebhook(created.data.id, {
        active: true,
        url: receiver.hookUrl("redelivered"),
      });
      expect(updated.ok).toBe(true);
      const response = await fetch(
        `${apiUrl}/webhooks/${created.data.id}/deliveries/${failed!.id}/redeliver`,
        { method: "POST", headers: { Authorization: `Bearer ${apiKey}` } },
      );
      expect(response.status).toBe(202);
      const audit = await client.listAudit({
        action: "webhook.delivery.redeliver",
        resource_id: failed!.id,
      });
      expect(audit.status).toBe(200);
      expect(audit.data.data).toHaveLength(1);
      expect(audit.data.data[0]).toMatchObject({
        resource_type: "webhook_delivery",
        resource_id: failed!.id,
        details: { webhook_id: created.data.id },
      });
      const queued = (await response.json()) as {
        id: string;
        status: string;
        attempt: number;
        status_code: number;
      };
      expect(queued).toMatchObject({
        id: failed!.id,
        status: "pending",
        attempt: 1,
        status_code: 400,
      });
      await expectMatchesSchema(
        "POST",
        "/webhooks/{id}/deliveries/{delivery_id}/redeliver",
        202,
        queued,
      );
      const received = await receiver.waitFor(
        (r) =>
          r.path === "/hook/redelivered" && r.body.includes(item.data.item.id),
      );
      expectSignedBy(received, created.data.secret);
      const a = JSON.parse(first.body) as {
        event_id: string;
        delivery_id: string;
        delivered_at: string;
      };
      const b = JSON.parse(received.body) as typeof a;
      expect(b.event_id).toBe(a.event_id);
      expect(b.delivery_id).toBe(a.delivery_id);
      expect(b.delivered_at).not.toBe(a.delivered_at);
    } finally {
      await refusal.close();
    }
  });

  it("delivers a matching event to the URL with a verifiable signature", async ({
    signal,
  }) => {
    const created = await client.createWebhook({
      url: receiver.hookUrl("signed"),
      events: ["item.created"],
    });
    expect(created.status).toBe(201);
    trackWebhook(ctx, created.data.id, client);
    const secret = created.data.secret;

    await withStream(apiUrl, apiKey, {}, async (stream) => {
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
        event_id: string;
        delivery_id: string;
        delivered_at: string;
        item: { id: string; type: string };
      };
      const { events } = await collectUntil(
        stream,
        (frames) =>
          frames.some(
            (frame) =>
              frame.event === "item.created" &&
              (frame.data as { item?: { id?: string } }).item?.id ===
                item.data.item.id,
          ),
        "the delivered item event and its exact cursor",
        signal,
      );
      const event = events.find(
        (frame) =>
          frame.event === "item.created" &&
          (frame.data as { item?: { id?: string } }).item?.id ===
            item.data.item.id,
      );
      expect(payload.event_id).toBe(event?.id);
      expect(payload.event_id).toMatch(/^(0|[1-9][0-9]*)$/);
      expect(Number.isNaN(Date.parse(payload.delivered_at))).toBe(false);
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
      const row = deliveries.data.data.find(
        (d) => d.event_type === "item.created",
      );
      expect(row).toBeDefined();
      expect(row?.id).toBe(payload.delivery_id);
      expect(row?.status).toBe("success");
      expect(row?.error).toBeNull();
      expect(row?.succeeded).toBe(true);
      expect(row?.status_code).toBe(200);
      expect(row?.attempt).toBe(1);
    });
  });

  it("normalizes one item filter and preserves it after refused updates", async () => {
    const created = await client.createWebhook({
      url: receiver.hookUrl("filter-validation"),
      events: ["edge.created"],
      type_filter: " core.note ",
    });
    expect(created.status).toBe(201);
    trackWebhook(ctx, created.data.id, client);
    expect(created.data.type_filter).toBe("core.note");
    for (const type_filter of ["*", "bad filter", "core.note,core.task"]) {
      expect(
        (
          await client.createWebhook({
            url: receiver.hookUrl("invalid-filter"),
            events: ["item.created"],
            type_filter,
          })
        ).status,
      ).toBe(400);
      const changed = await client.updateWebhook(created.data.id, {
        type_filter,
      });
      expect(changed.status).toBe(400);
      expect((await client.getWebhook(created.data.id)).data.type_filter).toBe(
        "core.note",
      );
    }
    for (const type_filter of ["core.*", "demo.unregistered"]) {
      expect(
        (await client.updateWebhook(created.data.id, { type_filter })).status,
      ).toBe(200);
    }
    for (const type_filter of [" ", "", null]) {
      expect(
        (await client.updateWebhook(created.data.id, { type_filter })).status,
      ).toBe(200);
      expect(
        (await client.getWebhook(created.data.id)).data.type_filter ?? null,
      ).toBeNull();
    }
  });

  it("pages its delivery log by cursor, every delivery once", async () => {
    const created = await client.createWebhook({
      url: receiver.hookUrl("paged"),
      events: ["item.created"],
    });
    expect(created.status).toBe(201);
    trackWebhook(ctx, created.data.id, client);
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const item = await client.createItem(
        createNote({
          source: ctx.source,
          properties: { body: `paged ${String(i)}` },
        }),
      );
      expect(item.ok).toBe(true);
      trackItem(ctx, item.data.item.id);
      ids.push(item.data.item.id);
    }
    for (const id of ids) {
      await receiver.waitFor(
        (r) => r.path === "/hook/paged" && r.body.includes(id),
      );
    }
    // The delivery is logged after the receiver answers, so the log is
    // read until it holds all three.
    let seen = 0;
    for (let attempt = 0; attempt < 40 && seen < 3; attempt++) {
      seen = (await client.listWebhookDeliveries(created.data.id)).data.data
        .length;
      if (seen < 3) await new Promise((r) => setTimeout(r, 250));
    }
    expect(seen).toBe(3);

    const first = await client.listWebhookDeliveries(created.data.id, {
      limit: 2,
    });
    expect(first.data.data).toHaveLength(2);
    expect(first.data.next_cursor).not.toBeNull();
    const rest = await client.listWebhookDeliveries(created.data.id, {
      limit: 2,
      cursor: first.data.next_cursor!,
    });
    expect(rest.data.data).toHaveLength(1);
    expect(rest.data.next_cursor).toBeNull();
    expect(
      new Set([...first.data.data, ...rest.data.data].map((d) => d.id)).size,
    ).toBe(3);
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
    expect(rows.data.data.map((d) => d.event_type)).toEqual(["item.created"]);
    expect(rows.data.data.every((d) => d.succeeded)).toBe(true);
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

  it("calls out for a bulk write only when the call asks for fan-out", async () => {
    // What `enable_fanout` governs is the outbound call and nothing else. It is
    // off unless the caller says otherwise, because one bulk call writes
    // thousands of rows and a delivery per row per subscriber is not what the
    // caller asked for. The event log is not conditional on it —
    // `items/bulk-event-log` cites `sync/replay.test.ts` for that half, which
    // is the half a client rebuilding its state depends on.
    const created = await client.createWebhook({
      url: receiver.hookUrl("fanout"),
      events: ["item.created"],
    });
    expect(created.status).toBe(201);
    trackWebhook(ctx, created.data.id, client);

    // Silent, because the call named no flag.
    const quiet = await client.bulkItems({
      items: [
        createNote({ source: ctx.source, properties: { body: "quiet" } }),
      ],
    });
    expect(quiet.ok).toBe(true);
    const quietId = String(quiet.data.results[0]?.id);
    expect(quietId).not.toBe("undefined");
    trackItem(ctx, quietId);

    // Delivered, because this one asked. Sent second on purpose: its
    // arrival is what bounds the wait for the other, which by then has had
    // every moment this one took to produce a delivery of its own.
    const loud = await client.bulkItems({
      items: [createNote({ source: ctx.source, properties: { body: "loud" } })],
      enable_fanout: true,
    });
    expect(loud.ok).toBe(true);
    const loudId = String(loud.data.results[0]?.id);
    expect(loudId).not.toBe("undefined");
    trackItem(ctx, loudId);

    const delivery = await receiver.waitFor(
      (r) => r.path === "/hook/fanout" && r.body.includes(loudId),
    );
    expect(delivery.headers["x-marfa-event-type"]).toBe("item.created");

    // The absence, and the arrival above is its witness: one subscription,
    // one door, one run, and one of the two writes called out. The silence
    // is the flag's doing rather than a subscription that was never going
    // to fire.
    expect(
      receiver.received.filter(
        (r) => r.path === "/hook/fanout" && r.body.includes(quietId),
      ),
    ).toEqual([]);

    // One attempt recorded, not two, so nothing was delivered out of sight
    // of the receiver either.
    const deliveries = await client.listWebhookDeliveries(created.data.id);
    expect(deliveries.ok).toBe(true);
    expect(
      deliveries.data.data.filter((d) => d.event_type === "item.created")
        .length,
    ).toBe(1);

    // And the silent write is a write: the row is there to be read.
    const read = await client.getItem(quietId);
    expect(read.ok).toBe(true);
  });

  it("calls out for a bulk edge write only when the call asks for fan-out", async () => {
    const created = await client.createWebhook({
      url: receiver.hookUrl("edge-fanout"),
      events: ["edge.created"],
    });
    expect(created.status).toBe(201);
    trackWebhook(ctx, created.data.id, client);

    const pair = async () => {
      const ids: string[] = [];
      for (let i = 0; i < 2; i++) {
        const item = await client.createItem(
          createNote({ source: ctx.source }),
        );
        expect(item.ok).toBe(true);
        trackItem(ctx, item.data.item.id);
        ids.push(item.data.item.id);
      }
      return { source_id: ids[0]!, target_id: ids[1]!, edge_type: "about" };
    };
    const write = async (enableFanout?: boolean) => {
      const res = await client.bulkEdges({
        edges: [await pair()],
        ...(enableFanout === undefined ? {} : { enable_fanout: enableFanout }),
      });
      expect(res.ok, JSON.stringify(res.error)).toBe(true);
      expect(res.data.counts.created).toBe(1);
      const id = String(res.data.results[0]?.id);
      trackEdge(ctx, id);
      return id;
    };

    const quietId = await write();
    const loudId = await write(true);

    const delivery = await receiver.waitFor(
      (r) => r.path === "/hook/edge-fanout" && r.body.includes(loudId),
    );
    expect(delivery.headers["x-marfa-event-type"]).toBe("edge.created");
    expect(
      receiver.received.filter(
        (r) => r.path === "/hook/edge-fanout" && r.body.includes(quietId),
      ),
    ).toEqual([]);
    const deliveries = await client.listWebhookDeliveries(created.data.id);
    expect(
      deliveries.data.data.filter((d) => d.event_type === "edge.created")
        .length,
    ).toBe(1);
    expect((await client.getEdge(quietId)).ok).toBe(true);
  });

  it("calls out for a bulk action only when the call asks for fan-out", async () => {
    const created = await client.createWebhook({
      url: receiver.hookUrl("action-fanout"),
      events: ["item.state_changed"],
    });
    expect(created.status).toBe(201);
    trackWebhook(ctx, created.data.id, client);

    const archive = async (enableFanout?: boolean) => {
      const tag = `fanout-action-${ctx.runId}-${String(enableFanout)}`;
      const item = await client.createItem(
        createNote({ source: ctx.source, tags: [tag] }),
      );
      expect(item.ok).toBe(true);
      trackItem(ctx, item.data.item.id);
      const queued = await client.bulkAction({
        action: "transition",
        state: "archived",
        filter: { tags: [tag] },
        ...(enableFanout === undefined ? {} : { enable_fanout: enableFanout }),
      });
      expect(queued.status).toBe(202);
      const job = await client.pollBulkActionToTerminal(
        (queued.data as BulkActionJob).id,
      );
      expect(job.status).toBe("completed");
      expect(job.succeeded).toBe(1);
      expect((await client.getItem(item.data.item.id)).data.item.state).toBe(
        "archived",
      );
      return item.data.item.id;
    };

    const quietId = await archive();
    const loudId = await archive(true);

    const delivery = await receiver.waitFor(
      (r) => r.path === "/hook/action-fanout" && r.body.includes(loudId),
    );
    expect(delivery.headers["x-marfa-event-type"]).toBe("item.state_changed");
    expect(
      receiver.received.filter(
        (r) => r.path === "/hook/action-fanout" && r.body.includes(quietId),
      ),
    ).toEqual([]);
    const deliveries = await client.listWebhookDeliveries(created.data.id);
    expect(
      deliveries.data.data.filter((d) => d.event_type === "item.state_changed")
        .length,
    ).toBe(1);
  });

  it("never calls out for an archive restore", async () => {
    const created = await client.createWebhook({
      url: receiver.hookUrl("restore-fanout"),
      events: ["item.created"],
    });
    expect(created.status).toBe(201);
    trackWebhook(ctx, created.data.id, client);

    const restoredId = uuidv7();
    const restored = await getOperatorClient().restoreArchive(
      itemsArchive([
        {
          id: restoredId,
          type: "core.note",
          source: ctx.source,
          properties: { body: "restored without a call out" },
        },
      ]),
    );
    expect(restored.ok, JSON.stringify(restored.error)).toBe(true);
    expect(restored.data.imported).toBe(1);
    trackItem(ctx, restoredId);

    // The witness: a write after the restore on the same subscription is
    // delivered, so the silence above it is the restore's.
    const sentinel = await client.createItem(
      createNote({ source: ctx.source, properties: { body: "sentinel" } }),
    );
    expect(sentinel.ok).toBe(true);
    trackItem(ctx, sentinel.data.item.id);
    await receiver.waitFor(
      (r) =>
        r.path === "/hook/restore-fanout" &&
        r.body.includes(sentinel.data.item.id),
    );
    expect(
      receiver.received.filter(
        (r) => r.path === "/hook/restore-fanout" && r.body.includes(restoredId),
      ),
    ).toEqual([]);
    expect((await client.getItem(restoredId)).ok).toBe(true);
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
    expect(rows.data.data.map((d) => d.event_type)).toEqual(["item.deleted"]);
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
      await narrowed.rawRequest(
        `/webhooks/${mine.data.id}/deliveries/missing-delivery/redeliver`,
        { method: "POST" },
      ),
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

  /** A key the run's key mints with `webhooks.manage` and the reach given. */
  async function keyWith(
    label: string,
    reach: Record<string, unknown>,
  ): Promise<{ id: string; client: MarfaClient }> {
    const minted = await client.createKey({
      label,
      source: `${ctx.source}-${label}`,
      permissions: ["webhooks.manage"],
      ...reach,
    });
    expect(minted.ok).toBe(true);
    trackKey(ctx, minted.data.id);
    return {
      id: minted.data.id,
      client: new MarfaClient({ baseUrl: apiUrl, apiKey: minted.data.key }),
    };
  }

  it("delivers to a credential that reads part of what is stored only that part", async () => {
    const narrow = await keyWith("partial-reader", {
      type_permissions: { "core.note": "read" },
    });
    const created = await narrow.client.createWebhook({
      url: receiver.hookUrl("partial-reader"),
      events: ["item.created"],
    });
    expect(created.status).toBe(201);
    trackWebhook(ctx, created.data.id, narrow.client);

    // The unreadable event first, so the readable one after it is the
    // sentinel that says the first was not merely late.
    const task = await client.createItem(
      createTask({ source: ctx.source, properties: { title: "unreadable" } }),
    );
    expect(task.ok).toBe(true);
    trackItem(ctx, task.data.item.id);
    const note = await client.createItem(
      createNote({ source: ctx.source, properties: { body: "readable" } }),
    );
    expect(note.ok).toBe(true);
    trackItem(ctx, note.data.item.id);

    await receiver.waitFor(
      (r) =>
        r.path === "/hook/partial-reader" && r.body.includes(note.data.item.id),
    );
    const toThisHook = receiver.received.filter(
      (r) => r.path === "/hook/partial-reader",
    );
    expect(toThisHook.some((r) => r.body.includes(task.data.item.id))).toBe(
      false,
    );
    const rows = await narrow.client.listWebhookDeliveries(created.data.id);
    expect(rows.ok).toBe(true);
    expect(rows.data.data).toHaveLength(1);
  });

  it("delivers only the extension namespaces the credential may read", async () => {
    const reader = await keyWith("alpha-reader", {
      type_permissions: { "*": "read" },
      extension_permissions: { "webhook.alpha": "read" },
    });
    const created = await reader.client.createWebhook({
      url: receiver.hookUrl("alpha-reader"),
      events: ["metadata.changed"],
    });
    expect(created.status).toBe(201);
    trackWebhook(ctx, created.data.id, reader.client);

    const note = await client.createItem(
      createNote({ source: ctx.source, properties: { body: "namespaced" } }),
    );
    expect(note.ok).toBe(true);
    trackItem(ctx, note.data.item.id);
    const id = note.data.item.id;
    expect(
      (await client.setItemExtension(id, "webhook.alpha", { a: 1 })).ok,
    ).toBe(true);
    expect(
      (await client.setItemExtension(id, "webhook.beta", { b: 2 })).ok,
    ).toBe(true);

    // The second write's event is the one whose item holds both namespaces.
    const delivery = await receiver.waitFor(
      (r) =>
        r.path === "/hook/alpha-reader" &&
        r.body.includes(id) &&
        receiver.received.filter(
          (x) => x.path === "/hook/alpha-reader" && x.body.includes(id),
        ).length === 2,
    );
    const last = receiver.received
      .filter((r) => r.path === "/hook/alpha-reader" && r.body.includes(id))
      .map((r) => JSON.parse(r.body) as { metadata: { extensions: object } });
    expect(delivery).toBeDefined();
    for (const body of last) {
      expect(Object.keys(body.metadata.extensions)).toEqual(["webhook.alpha"]);
    }
    // The witness: the item holds the namespace the delivery left out.
    const beta = await client.getItemExtension(id, "webhook.beta");
    expect(beta.ok).toBe(true);
  });

  it("answers a subscription another credential registered as an unknown id on every door", async () => {
    const mine = await client.createWebhook({
      url: receiver.hookUrl("owned"),
      events: ["item.created"],
    });
    expect(mine.status).toBe(201);
    trackWebhook(ctx, mine.data.id, client);
    const other = await keyWith("other-owner", {});

    for (const refused of [
      await other.client.getWebhook(mine.data.id),
      await other.client.updateWebhook(mine.data.id, {
        url: receiver.hookUrl("taken-over"),
      }),
      await other.client.listWebhookDeliveries(mine.data.id),
      await other.client.deleteWebhook(mine.data.id),
    ]) {
      expect(refused.status).toBe(404);
      expect(refused.error?.error.code).toBe("webhook_not_found");
    }
    const listed = await other.client.listWebhooks();
    expect(listed.ok).toBe(true);
    expect(listed.data.data.map((w) => w.id)).not.toContain(mine.data.id);

    // The witness: the owner still reaches it, unchanged.
    const owned = await client.getWebhook(mine.data.id);
    expect(owned.ok).toBe(true);
    expect(owned.data.url).toBe(receiver.hookUrl("owned"));
  });

  it("stops delivering once the credential that registered it is revoked", async () => {
    const owner = await keyWith("revoked-owner", {
      type_permissions: { "*": "read" },
    });
    const created = await owner.client.createWebhook({
      url: receiver.hookUrl("revoked-owner"),
      events: ["item.created"],
    });
    expect(created.status).toBe(201);

    const before = await client.createItem(
      createNote({ source: ctx.source, properties: { body: "before" } }),
    );
    expect(before.ok).toBe(true);
    trackItem(ctx, before.data.item.id);
    // The witness: the subscription delivers while its credential stands.
    await receiver.waitFor(
      (r) =>
        r.path === "/hook/revoked-owner" &&
        r.body.includes(before.data.item.id),
    );

    expect((await client.revokeKey(owner.id)).ok).toBe(true);
    const after = await client.createItem(
      createNote({ source: ctx.source, properties: { body: "after" } }),
    );
    expect(after.ok).toBe(true);
    trackItem(ctx, after.data.item.id);

    // A sentinel on a subscription of the run's own key, registered after
    // the revoke, says the event was dispatched.
    const sentinel = await client.createWebhook({
      url: receiver.hookUrl("revoke-sentinel"),
      events: ["item.created"],
    });
    expect(sentinel.status).toBe(201);
    trackWebhook(ctx, sentinel.data.id, client);
    const last = await client.createItem(
      createNote({ source: ctx.source, properties: { body: "sentinel" } }),
    );
    expect(last.ok).toBe(true);
    trackItem(ctx, last.data.item.id);
    await receiver.waitFor(
      (r) =>
        r.path === "/hook/revoke-sentinel" &&
        r.body.includes(last.data.item.id),
    );
    expect(
      receiver.received.some(
        (r) =>
          r.path === "/hook/revoked-owner" &&
          (r.body.includes(after.data.item.id) ||
            r.body.includes(last.data.item.id)),
      ),
    ).toBe(false);
  });

  it("refuses a secret shorter than 32 characters, the empty one included", async () => {
    for (const secret of ["", "x".repeat(31)]) {
      const refused = await client.createWebhook({
        url: receiverUrl,
        events: ["item.created"],
        secret,
      });
      expect(refused.status).toBe(400);
      expect(refused.error?.error.code).toBe("validation_error");
    }
    const taken = await client.createWebhook({
      url: receiverUrl,
      events: ["item.created"],
      secret: "x".repeat(32),
    });
    expect(taken.status).toBe(201);
    trackWebhook(ctx, taken.data.id, client);
  });

  it("refuses a URL that is not http or https, or carries credentials", async () => {
    for (const url of [
      "ftp://receiver.example/hook",
      "file:///etc/passwd",
      "https://user:pass@receiver.example/hook",
    ]) {
      const refused = await client.createWebhook({
        url,
        events: ["item.created"],
      });
      expect(refused.status, url).toBe(400);
      expect(refused.error?.error.code).toBe("validation_error");
    }
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
