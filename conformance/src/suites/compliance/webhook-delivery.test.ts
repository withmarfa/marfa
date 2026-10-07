import { createServer, type Server } from "node:http";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { TestContext, WebhookDelivery } from "../../client/types.js";
import {
  createTestContext,
  getOperatorClient,
  trackEdge,
  trackEdgeType,
  trackItem,
  trackKey,
  trackWebhook,
  cleanup,
} from "../../utils/setup.js";
import { createNote, createTask } from "../../generators/items.js";
import { waitFor } from "../../utils/wait.js";
import {
  expectSignedBy,
  startReceiver,
  type Receiver,
} from "../../utils/webhook-receiver.js";

let client: MarfaClient;
let ctx: TestContext;
let apiUrl: string;
let receiver: Receiver;

beforeAll(async () => {
  ({ ctx, client, apiUrl } = await createTestContext(
    "compliance",
    "webhook-delivery",
  ));
  receiver = await startReceiver();
});

afterAll(async () => {
  await receiver.close();
  await cleanup(ctx);
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
  expect(minted.ok, JSON.stringify(minted.error)).toBe(true);
  trackKey(ctx, minted.data.id);
  return {
    id: minted.data.id,
    client: new MarfaClient({ baseUrl: apiUrl, apiKey: minted.data.key }),
  };
}

async function registerEdgeType(label: string): Promise<string> {
  const id = `mock.webhook.${label}.${ctx.runId}`;
  const registered = await client.registerEdgeType({
    id,
    cardinality: "many-to-many",
  });
  expect(registered.ok, JSON.stringify(registered.error)).toBe(true);
  trackEdgeType(ctx, id);
  return id;
}

async function makeNote(label: string): Promise<string> {
  const note = await client.createItem(
    createNote({ source: ctx.source, properties: { body: `hook-${label}` } }),
  );
  expect(note.ok, JSON.stringify(note.error)).toBe(true);
  trackItem(ctx, note.data.item.id);
  return note.data.item.id;
}

async function makeTask(label: string): Promise<string> {
  const task = await client.createItem(
    createTask({ source: ctx.source, properties: { title: `hook-${label}` } }),
  );
  expect(task.ok, JSON.stringify(task.error)).toBe(true);
  trackItem(ctx, task.data.item.id);
  return task.data.item.id;
}

async function link(
  source: string,
  target: string,
  edgeType: string,
): Promise<string> {
  const edge = await client.createEdge({
    source_id: source,
    target_id: target,
    edge_type: edgeType,
  });
  expect(edge.ok, JSON.stringify(edge.error)).toBe(true);
  trackEdge(ctx, edge.data.edge.id);
  return edge.data.edge.id;
}

interface Attempt {
  at: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

interface Answer {
  status: number;
  headers?: Record<string, string>;
}

/**
 * A receiver whose answer depends on the path and on how many attempts that
 * path has had, which the fixed-status receiver cannot do.
 */
interface ScriptedReceiver {
  url: string;
  hookUrl: (label: string) => string;
  attempts: (label: string) => Attempt[];
  close: () => Promise<void>;
}

async function startScriptedReceiver(
  answer: (label: string, attempt: number) => Answer,
): Promise<ScriptedReceiver> {
  const byLabel = new Map<string, Attempt[]>();
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
    });
    req.on("end", () => {
      const label = (req.url ?? "").replace(/^\/hook\//, "");
      const seen = byLabel.get(label) ?? [];
      seen.push({ at: Date.now(), headers: req.headers, body });
      byLabel.set(label, seen);
      const { status, headers } = answer(label, seen.length);
      res.writeHead(status, headers);
      res.end("ok");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (typeof address !== "object" || address === null) {
    throw new Error("the receiver did not bind to a port");
  }
  const url = `http://127.0.0.1:${String(address.port)}/hook`;
  return {
    url,
    hookUrl: (label) => `${url}/${label}`,
    attempts: (label) => byLabel.get(label) ?? [],
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** A subscription to `item.created` on a hook of the receiver's. */
async function subscribe(
  hook: ScriptedReceiver,
  label: string,
  owner: MarfaClient = client,
): Promise<{ id: string; secret: string }> {
  const created = await owner.createWebhook({
    url: hook.hookUrl(label),
    events: ["item.created"],
  });
  expect(created.status, JSON.stringify(created.error)).toBe(201);
  trackWebhook(ctx, created.data.id, owner);
  return { id: created.data.id, secret: created.data.secret };
}

/** The newest delivery row of a subscription, once `settled` says it is. */
async function deliveryOf(
  webhookId: string,
  settled: (row: WebhookDelivery) => boolean,
  owner: MarfaClient = client,
): Promise<WebhookDelivery> {
  return waitFor(`the delivery of ${webhookId} to settle`, async () => {
    const rows = await owner.listWebhookDeliveries(webhookId);
    expect(rows.ok).toBe(true);
    const row = rows.data.data[0];
    return row !== undefined && settled(row) ? row : undefined;
  });
}

/**
 * Run the attempt job until `done`, so a retry whose wait has passed is
 * attempted now rather than at the job's own 30 second cadence. A run
 * before the wait ends attempts nothing; a run while the job's own cadence
 * holds it answers 409 and is run again.
 */
async function runRetriesUntil(done: () => boolean, what: string) {
  const operator = getOperatorClient();
  await waitFor(
    what,
    async () => {
      if (done()) return true;
      await operator.runHousekeeping("webhook-poll");
      await new Promise((r) => setTimeout(r, 200));
      return done() ? true : undefined;
    },
    60_000,
  );
}

const signedAt = (attempt: Attempt): number =>
  Number(/^t=(\d+),/.exec(String(attempt.headers["x-marfa-signature"]))?.[1]);

async function purge(itemId: string): Promise<void> {
  expect((await client.deleteItem(itemId)).ok).toBe(true);
  const purged = await client.purgeItem(itemId);
  expect(purged.ok, JSON.stringify(purged.error)).toBe(true);
}

describe("outbound webhook delivery", () => {
  it("sends no edge.deleted for an edge a purge took to an owner who may not read the purged item's type, and sends it for a type the owner reads", async () => {
    const edgeType = await registerEdgeType("purged-source");
    const owner = await keyWith("purged-source-owner", {
      type_permissions: { "core.note": "read" },
      edge_permissions: { "*": "read" },
    });
    const narrow = await owner.client.createWebhook({
      url: receiver.hookUrl("purged-narrow"),
      events: ["edge.deleted"],
    });
    expect(narrow.status).toBe(201);
    trackWebhook(ctx, narrow.data.id, owner.client);
    // The witness that the purge announced the edge and it could be sent:
    // a subscription of the run's own key, which reads every type.
    const wide = await client.createWebhook({
      url: receiver.hookUrl("purged-wide"),
      events: ["edge.deleted"],
    });
    expect(wide.status).toBe(201);
    trackWebhook(ctx, wide.data.id, client);

    const target = await makeNote("purged-target");
    const task = await makeTask("purged-source");
    const taskEdge = await link(task, target, edgeType);
    await purge(task);

    // The sentinel: the same purge of a source the owner reads, written
    // after the first so its delivery says the first was already decided.
    const note = await makeNote("purged-readable-source");
    const noteEdge = await link(note, target, edgeType);
    await purge(note);

    const delivered = await receiver.waitFor(
      (r) => r.path === "/hook/purged-narrow" && r.body.includes(noteEdge),
    );
    expect(delivered.headers["x-marfa-event-type"]).toBe("edge.deleted");
    expect(JSON.parse(delivered.body)).toMatchObject({
      event_type: "edge.deleted",
      source_type: "core.note",
      purged_with: note,
    });
    await receiver.waitFor(
      (r) => r.path === "/hook/purged-wide" && r.body.includes(taskEdge),
    );
    await receiver.waitFor(
      (r) => r.path === "/hook/purged-wide" && r.body.includes(noteEdge),
    );

    expect(
      receiver.received.filter(
        (r) => r.path === "/hook/purged-narrow" && r.body.includes(taskEdge),
      ),
      "an owner that may not read tasks was sent the edge of a purged task",
    ).toHaveLength(0);
    const rows = await owner.client.listWebhookDeliveries(narrow.data.id);
    expect(rows.ok).toBe(true);
    expect(rows.data.data).toHaveLength(1);
  });
  it("leaves a delivery pending after a 500 and retries it with the same ids", async () => {
    const hook = await startScriptedReceiver((_, n) => ({
      status: n === 1 ? 500 : 200,
    }));
    try {
      const sub = await subscribe(hook, "retried");
      const note = await makeNote("retried");
      await waitFor("the first attempt", async () =>
        hook.attempts("retried").length >= 1 ? true : undefined,
      );

      const failed = await deliveryOf(sub.id, (r) => r.attempt === 1);
      expect(failed).toMatchObject({
        status: "pending",
        succeeded: false,
        status_code: 500,
        error: "HTTP 500",
        attempt: 1,
      });

      await runRetriesUntil(
        () => hook.attempts("retried").length >= 2,
        "the retry",
      );
      const [first, second] = hook.attempts("retried");
      for (const attempt of [first, second]) {
        expectSignedBy({ ...attempt, path: "" }, sub.secret);
        expect(attempt.body).toContain(note);
      }
      const a = JSON.parse(first!.body) as {
        event_id: string;
        delivery_id: string;
        delivered_at: string;
      };
      const b = JSON.parse(second!.body) as typeof a;
      expect(b.delivery_id).toBe(a.delivery_id);
      expect(b.delivery_id).toBe(failed.id);
      expect(b.event_id).toBe(a.event_id);
      expect(Number.isNaN(Date.parse(b.delivered_at))).toBe(false);
      expect(b.delivered_at).not.toBe(a.delivered_at);
      expect(signedAt(second!)).toBeGreaterThan(signedAt(first!));

      const settled = await deliveryOf(sub.id, (r) => r.status === "success");
      expect(settled).toMatchObject({
        id: failed.id,
        succeeded: true,
        status_code: 200,
        attempt: 2,
      });
    } finally {
      await hook.close();
    }
  });

  it("waits for the Retry-After a receiver names, and never less than the ordinary wait", async () => {
    const hook = await startScriptedReceiver((_, n) => {
      if (n === 1) return { status: 503, headers: { "Retry-After": "4" } };
      if (n === 2) return { status: 503, headers: { "Retry-After": "1" } };
      return { status: 200 };
    });
    try {
      const sub = await subscribe(hook, "retry-after");
      await makeNote("retry-after");
      await runRetriesUntil(
        () => hook.attempts("retry-after").length >= 3,
        "the third attempt",
      );
      const [first, second, third] = hook.attempts("retry-after") as [
        Attempt,
        Attempt,
        Attempt,
      ];
      // The receiver stamps an arrival after the server chose the wait, so a
      // wait honored in full shows as at least its length between arrivals.
      expect(
        second.at - first.at,
        "a hint above the ordinary wait",
      ).toBeGreaterThanOrEqual(4000);
      expect(
        third.at - second.at,
        "a hint below the ordinary wait",
      ).toBeGreaterThanOrEqual(5000);
      const settled = await deliveryOf(sub.id, (r) => r.status === "success");
      expect(settled.attempt).toBe(3);
    } finally {
      await hook.close();
    }
  });

  it("retries a 408 and a 429, and gives up at once on any other 4xx answer", async () => {
    const permanent = [400, 404, 410, 422];
    const hook = await startScriptedReceiver((label, n) => {
      if (label === "408" || label === "429") {
        return { status: n === 1 ? Number(label) : 200 };
      }
      return { status: Number(label) };
    });
    try {
      const subs = new Map<string, { id: string }>();
      for (const label of ["408", "429", ...permanent.map(String)]) {
        subs.set(label, await subscribe(hook, label));
      }
      await makeNote("statuses");

      for (const [label, sub] of subs) {
        const row = await deliveryOf(sub.id, (r) => r.attempt === 1);
        const retried = label === "408" || label === "429";
        expect(row, label).toMatchObject({
          status: retried ? "pending" : "dead_letter",
          status_code: Number(label),
          error: `HTTP ${label}`,
          attempt: 1,
        });
      }

      // The retried two are attempted again, and the run that does so would
      // have picked up any other row still pending.
      await runRetriesUntil(
        () =>
          hook.attempts("408").length >= 2 && hook.attempts("429").length >= 2,
        "the retries of the 408 and the 429",
      );
      for (const label of ["408", "429"]) {
        const row = await deliveryOf(
          subs.get(label)!.id,
          (r) => r.status === "success",
        );
        expect(row, label).toMatchObject({ status_code: 200, attempt: 2 });
      }
      for (const label of permanent.map(String)) {
        expect(hook.attempts(label), label).toHaveLength(1);
      }
    } finally {
      await hook.close();
    }
  });

  it("gives up on a redirect without following it", async () => {
    const statuses = [301, 302, 303, 307, 308];
    const target = "redirect-target";
    const hook = await startScriptedReceiver((label) => {
      const status = Number(/^redirect-(\d+)$/.exec(label)?.[1]);
      return statuses.includes(status)
        ? { status, headers: { Location: `${hook.hookUrl(target)}` } }
        : { status: 200 };
    });
    try {
      const subs = new Map<number, { id: string }>();
      for (const status of statuses) {
        subs.set(status, await subscribe(hook, `redirect-${String(status)}`));
      }
      await makeNote("redirects");

      for (const [status, sub] of subs) {
        const row = await deliveryOf(sub.id, (r) => r.attempt === 1);
        expect(row, String(status)).toMatchObject({
          status: "dead_letter",
          status_code: status,
          error:
            "The receiver answered with a redirect, which is not followed.",
          attempt: 1,
        });
        expect(hook.attempts(`redirect-${String(status)}`)).toHaveLength(1);
      }
      expect(hook.attempts(target), "a redirect was followed").toHaveLength(0);

      // The witness: the target is a place the receiver records a visit to.
      expect(
        (await fetch(hook.hookUrl(target), { method: "POST" })).status,
      ).toBe(200);
      expect(hook.attempts(target)).toHaveLength(1);
    } finally {
      await hook.close();
    }
  });
});
