import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type {
  BulkEdgeResponse,
  BulkResponse,
  MarfaItem,
} from "../../client/types.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { collectUntil, withStream } from "../../utils/stream.js";
import { waitFor } from "../../utils/wait.js";
import { startReceiver } from "../../utils/webhook-receiver.js";

/**
 * What the server does when one store write, or the answer to its commit,
 * fails: the write fails before it commits, its commit is refused or turned
 * away by the volume, or its commit lands and the database reports an error.
 * The fixtures set the failure through the target interface's `fail` faults
 * (`conformance/README.md`, "Faults"), on a server of their own that nothing
 * else writes to, so the count a fault is aimed at is the fixture's own.
 *
 * **What a lost answer proves.** A commit the database refuses leaves the
 * server unable to say whether it landed, and a commit that landed and was
 * answered with an error is the same to it. The server settles the second by
 * reading back the audit entry its write recorded, and reports the first as
 * unknown. A fixture that holds the server to one of them sets the fault that
 * produces it and then reads the stored state to say which it was.
 */
let server: FreshServer;
let working: MarfaClient;

beforeAll(async () => {
  server = await bootFreshServer("write-faults");
  working = new MarfaClient({
    baseUrl: server.apiUrl,
    apiKey: server.workingKey,
  });
}, 2 * FRESH_SERVER_TIMEOUT_MS);

afterEach(async () => {
  await server.clearFault();
});

afterAll(async () => {
  await server.stop();
}, 2 * FRESH_SERVER_TIMEOUT_MS);

let serial = 0;
/** A tag no other write of the file carries, so a case reads back only its own rows. */
function tagged(label: string): string {
  serial += 1;
  return `${label}-${String(serial)}`;
}

function notes(count: number, tag: string) {
  return Array.from({ length: count }, (_, index) => ({
    type: "core.note",
    properties: { body: `${tag}-${String(index)}` },
    tags: [tag],
  }));
}

async function stored(tag: string): Promise<MarfaItem[]> {
  const listed = await working.listItems({ tags: [tag], limit: 100 });
  expect(listed.status).toBe(200);
  return listed.data.data;
}

async function fired(name: string): Promise<number | undefined> {
  return (await server.faults()).find((fault) => fault.name === name)?.fired;
}

async function auditCount(action: string): Promise<number> {
  const listed = await working.listAudit({ action, limit: 200 });
  expect(listed.status).toBe(200);
  return listed.data.data.length;
}

/** A fixture's edges: a source item and three targets. */
async function edgeEnds(tag: string): Promise<[string, string[]]> {
  const made = await working.bulkItems({
    atomic: true,
    items: notes(4, tag),
  });
  expect(made.status).toBe(200);
  const ids = made.data.results.map((entry) => entry.id!);
  return [ids[0]!, ids.slice(1)];
}

const COMMIT_UNKNOWN_MESSAGE = /may have been written/;

describe("an entry of a page under atomic: false whose commit cannot be confirmed", () => {
  it("is reported errored with write_outcome unknown and the code internal_error, counted under errored alone, while the entries around it land", async () => {
    const tag = tagged("items-unknown");
    await server.setFault("fail:commit=items.bulk@2");
    const page = await working.bulkItems({
      atomic: false,
      items: notes(3, tag),
    });
    // The witness that the fault acted, on the second entry and no other.
    expect(await fired("fail:commit")).toBe(1);

    expect(page.status).toBe(200);
    const body: BulkResponse = page.data;
    expect(body.counts).toEqual({
      created: 2,
      updated: 0,
      skipped: 0,
      errored: 1,
    });
    expect(body.results.map((entry) => entry.outcome)).toEqual([
      "created",
      "errored",
      "created",
    ]);
    const unknown = body.results[1]!;
    expect(unknown.id).toBeUndefined();
    expect(unknown.error?.code).toBe("internal_error");
    expect(unknown.error?.details).toEqual({ write_outcome: "unknown" });
    expect(unknown.error?.message).toMatch(COMMIT_UNKNOWN_MESSAGE);

    // The server went on to the next entry (items/bulk-outcome-unknown-continues),
    // and the refused commit left nothing of the second behind.
    expect((await stored(tag)).map((item) => item.properties.body)).toEqual(
      expect.arrayContaining([`${tag}-0`, `${tag}-2`]),
    );
    expect(await stored(tag)).toHaveLength(2);
  });

  it("is reported the same way on an entry of an edge page, with the entries around it kept", async () => {
    const [source, targets] = await edgeEnds(tagged("edges-unknown"));
    await server.setFault("fail:commit=edges.bulk@2");
    const page = await working.bulkEdges({
      atomic: false,
      edges: targets.map((target_id) => ({
        source_id: source,
        target_id,
        edge_type: "references",
      })),
    });
    expect(await fired("fail:commit")).toBe(1);

    expect(page.status).toBe(200);
    const body: BulkEdgeResponse = page.data;
    expect(body.counts).toEqual({
      created: 2,
      updated: 0,
      skipped: 0,
      errored: 1,
    });
    expect(body.results.map((entry) => entry.outcome)).toEqual([
      "created",
      "errored",
      "created",
    ]);
    expect(body.results[1]!.error?.code).toBe("internal_error");
    expect(body.results[1]!.error?.details).toEqual({
      write_outcome: "unknown",
    });

    const held = await working.listItemEdges(source);
    expect(held.status).toBe(200);
    expect(held.data.data.map((edge) => edge.target_id).sort()).toEqual(
      [targets[0]!, targets[2]!].sort(),
    );
  });

  it("is the first entry of the page as well as a later one, and the page still answers 200", async () => {
    const tag = tagged("items-unknown-first");
    await server.setFault("fail:commit=items.bulk");
    const page = await working.bulkItems({
      atomic: false,
      items: notes(2, tag),
    });
    expect(page.status).toBe(200);
    expect(page.data.results.map((entry) => entry.outcome)).toEqual([
      "errored",
      "created",
    ]);
    expect(page.data.results[0]!.error?.details).toEqual({
      write_outcome: "unknown",
    });
    expect(await stored(tag)).toHaveLength(1);
  });

  it("on a single write answers 500 and stores nothing", async () => {
    const tag = tagged("single-unknown");
    await server.setFault("fail:commit=item.create");
    const refused = await working.createItem({
      type: "core.note",
      properties: { body: tag },
      tags: [tag],
    });
    expect(await fired("fail:commit")).toBe(1);
    expect(refused.status).toBe(500);
    expect(refused.error?.error.code).toBe("internal_error");
    expect(await stored(tag)).toHaveLength(0);
  });
});

describe("a write whose volume turns away its commit", () => {
  it("answers 507 insufficient_storage with write_outcome unknown, and the write that follows lands", async () => {
    const tag = tagged("full");
    await server.setFault("fail:commit-full=item.create");
    const refused = await working.createItem({
      type: "core.note",
      properties: { body: tag },
      tags: [tag],
    });
    expect(await fired("fail:commit-full")).toBe(1);
    expect(refused.status).toBe(507);
    expect(refused.error?.error.code).toBe("insufficient_storage");
    expect(refused.error?.error.details).toEqual({ write_outcome: "unknown" });
    expect(await stored(tag)).toHaveLength(0);

    // The witness: the fault acted once, and the same write lands after it.
    const again = await working.createItem({
      type: "core.note",
      properties: { body: tag },
      tags: [tag],
    });
    expect(again.status).toBe(201);
  });
});

describe("a change that has committed", () => {
  it("is never answered with a 5xx: a single write whose commit answer is lost answers 201 and is stored once", async () => {
    const tag = tagged("single-lost");
    const before = await auditCount("item.create");
    await server.setFault("fail:commit-ack=item.create");
    const created = await working.createItem({
      type: "core.note",
      properties: { body: tag },
      tags: [tag],
    });
    expect(await fired("fail:commit-ack")).toBe(1);
    expect(created.status).toBe(201);
    expect(await stored(tag)).toHaveLength(1);
    expect(await auditCount("item.create")).toBe(before + 1);
  });

  it("is never answered with a 5xx: a page entry whose commit answer is lost is reported created, and the page answers 200", async () => {
    const tag = tagged("entry-lost");
    await server.setFault("fail:commit-ack=items.bulk@2");
    const page = await working.bulkItems({
      atomic: false,
      items: notes(3, tag),
    });
    expect(await fired("fail:commit-ack")).toBe(1);
    expect(page.status).toBe(200);
    expect(page.data.counts).toEqual({
      created: 3,
      updated: 0,
      skipped: 0,
      errored: 0,
    });
    // Each entry once: replaying the page would have written the second twice.
    expect(await stored(tag)).toHaveLength(3);
  });

  it("is never answered with a 5xx: an edge entry whose commit answer is lost is reported created", async () => {
    const [source, targets] = await edgeEnds(tagged("edges-lost"));
    await server.setFault("fail:commit-ack=edges.bulk@2");
    const page = await working.bulkEdges({
      atomic: false,
      edges: targets.map((target_id) => ({
        source_id: source,
        target_id,
        edge_type: "references",
      })),
    });
    expect(await fired("fail:commit-ack")).toBe(1);
    expect(page.status).toBe(200);
    expect(page.data.counts.created).toBe(3);
  });

  it("is never answered with a 5xx: an atomic page whose commit answer is lost answers 200 and is stored once", async () => {
    const tag = tagged("atomic-lost");
    await server.setFault("fail:commit-ack=items.bulk");
    const page = await working.bulkItems({
      atomic: true,
      items: notes(2, tag),
    });
    expect(await fired("fail:commit-ack")).toBe(1);
    expect(page.status).toBe(200);
    expect(page.data.counts.created).toBe(2);
    expect(await stored(tag)).toHaveLength(2);
  });
});

describe("an entry of a page under atomic: false that meets the write lock", () => {
  it("after an earlier entry has committed is reported errored with write_contention in a 200 answer, and the entries around it land", async () => {
    const tag = tagged("lock-entry");
    await server.setFault("fail:lock=2");
    const page = await working.bulkItems({
      atomic: false,
      items: notes(3, tag),
    });
    expect(await fired("fail:lock")).toBe(1);
    expect(page.status).toBe(200);
    expect(page.data.counts).toEqual({
      created: 2,
      updated: 0,
      skipped: 0,
      errored: 1,
    });
    expect(page.data.results.map((entry) => entry.outcome)).toEqual([
      "created",
      "errored",
      "created",
    ]);
    expect(page.data.results[1]!.error?.code).toBe("write_contention");
    // The lock was refused before the entry did any work: nothing of it is
    // stored, so a retry of that entry alone writes it once.
    expect(await stored(tag)).toHaveLength(2);
    const retried = await working.bulkItems({
      atomic: false,
      items: [notes(3, tag)[1]!],
    });
    expect(retried.data.counts.created).toBe(1);
  });

  it("is reported the same way on an entry of an edge page", async () => {
    const [source, targets] = await edgeEnds(tagged("edges-lock"));
    await server.setFault("fail:lock=2");
    const page = await working.bulkEdges({
      atomic: false,
      edges: targets.map((target_id) => ({
        source_id: source,
        target_id,
        edge_type: "references",
      })),
    });
    expect(await fired("fail:lock")).toBe(1);
    expect(page.status).toBe(200);
    expect(page.data.results.map((entry) => entry.outcome)).toEqual([
      "created",
      "errored",
      "created",
    ]);
    expect(page.data.results[1]!.error?.code).toBe("write_contention");
  });

  it("before any entry has committed answers the page 503 write_contention, where the first entry meets it", async () => {
    const tag = tagged("lock-page");
    await server.setFault("fail:lock=1");
    const refused = await working.bulkItems({
      atomic: false,
      items: notes(2, tag),
    });
    expect(refused.status).toBe(503);
    expect(refused.error?.error.code).toBe("write_contention");
    expect(await stored(tag)).toHaveLength(0);
  });
});

describe("a write whose audit entry cannot be recorded", () => {
  it("is rolled back with its events, answers 500, and leaves the write after it to land", async () => {
    const tag = tagged("audit-fails");
    await withStream(server.apiUrl, server.workingKey, {}, async (stream) => {
      await new Promise((resolve) => setTimeout(resolve, 250));
      const audited = await auditCount("item.create");
      await server.setFault("fail:audit=item.create");
      const refused = await working.createItem({
        type: "core.note",
        properties: { body: tag },
        tags: [tag],
      });
      expect(await fired("fail:audit")).toBe(1);
      expect(refused.status).toBe(500);
      expect(await stored(tag)).toHaveLength(0);
      expect(await auditCount("item.create")).toBe(audited);

      // The witness: the same write lands once the fault has acted, with its
      // audit entry and its event.
      const landed = await working.createItem({
        type: "core.note",
        properties: { body: tag },
        tags: [tag],
      });
      expect(landed.status).toBe(201);
      expect(await auditCount("item.create")).toBe(audited + 1);
      const { events } = await collectUntil(
        stream,
        (seen) =>
          seen.some(
            (event) =>
              (event.data as { item?: { id?: string } })?.item?.id ===
              landed.data.item.id,
          ),
        "the landed write's event",
      );
      // Everything before the landed write's frame has arrived or was
      // withheld, so the refused write's event, which carries the same
      // body, is absent: one event, the landed write's, names it.
      expect(
        events.filter(
          (event) =>
            (event.data as { item?: { properties?: { body?: string } } })?.item
              ?.properties?.body === tag,
        ),
      ).toHaveLength(1);
    });
  });

  it("rolls back an entry of a page under atomic: false and reports it errored, while the entries around it land", async () => {
    const tag = tagged("audit-entry");
    await server.setFault("fail:audit=items.bulk@2");
    const page = await working.bulkItems({
      atomic: false,
      items: notes(3, tag),
    });
    expect(await fired("fail:audit")).toBe(1);
    expect(page.status).toBe(200);
    expect(page.data.results.map((entry) => entry.outcome)).toEqual([
      "created",
      "errored",
      "created",
    ]);
    expect(page.data.results[1]!.error).toEqual({
      code: "internal_error",
      message: "The entry could not be written, and nothing of it was",
    });
    expect(await stored(tag)).toHaveLength(2);
  });
});

describe("a redelivery whose audit entry cannot be recorded", () => {
  it("leaves the failed delivery unchanged, queues nothing and records nothing, and a retry is accepted", async () => {
    const refusal = await startReceiver({ status: 400 });
    try {
      const webhook = await working.createWebhook({
        url: refusal.hookUrl("redelivery-faults"),
        events: ["item.created"],
      });
      expect(webhook.status).toBe(201);
      const tag = tagged("redelivery");
      const created = await working.createItem({
        type: "core.note",
        properties: { body: tag },
        tags: [tag],
      });
      expect(created.status).toBe(201);
      const first = await refusal.waitFor((received) =>
        received.body.includes(created.data.item.id),
      );
      const deliveryId = (JSON.parse(first.body) as { delivery_id: string })
        .delivery_id;
      const delivery = () =>
        waitFor("the delivery's dead letter", async () => {
          const listed = await working.listWebhookDeliveries(webhook.data.id);
          return listed.data.data.find(
            (row) => row.id === deliveryId && row.status === "dead_letter",
          );
        });
      const failed = await delivery();
      expect(failed).toMatchObject({ status_code: 400, attempt: 1 });
      const path = `/webhooks/${webhook.data.id}/deliveries/${deliveryId}/redeliver`;
      const before = await auditCount("webhook.delivery.redeliver");
      const attempts = refusal.received.length;

      await server.setFault("fail:audit=webhook.delivery.redeliver");
      const refused = await working.rawRequest(path, { method: "POST" });
      expect(await fired("fail:audit")).toBe(1);
      expect(refused.status).toBe(500);
      expect(await delivery()).toEqual(failed);
      expect(await auditCount("webhook.delivery.redeliver")).toBe(before);
      // Nothing was queued for the receiver either.
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(refusal.received).toHaveLength(attempts);

      // The witness: with the fault gone the same redelivery is accepted,
      // recorded.
      const accepted = await working.rawRequest(path, { method: "POST" });
      expect(accepted.status).toBe(202);
      expect(await auditCount("webhook.delivery.redeliver")).toBe(before + 1);
    } finally {
      await refusal.close();
    }
  });
});

describe("a fault armed before a restart", () => {
  it("does not outlive it: the write it was aimed at lands, and the fault is not listed", async () => {
    const tag = tagged("restart");
    await server.setFault("fail:commit-full=item.create");
    // The witness: the fault is armed, and has not yet acted.
    expect(await server.faults()).toEqual([
      { name: "fail:commit-full", arg: "item.create", waiting: 0, fired: 0 },
    ]);
    await server.restart({ signal: "SIGKILL" });
    expect(await server.faults()).toEqual([]);

    const restarted = new MarfaClient({
      baseUrl: server.apiUrl,
      apiKey: server.workingKey,
    });
    const created = await restarted.createItem({
      type: "core.note",
      properties: { body: tag },
      tags: [tag],
    });
    expect(created.status).toBe(201);
    // The fault stays gone: the harness has to arm it again.
    await server.setFault("fail:commit-full=item.create");
    const refused = await restarted.createItem({
      type: "core.note",
      properties: { body: tag },
    });
    expect(refused.status).toBe(507);
    await server.clearFault();
  });
});
