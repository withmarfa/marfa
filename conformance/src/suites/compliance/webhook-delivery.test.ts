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

/** A subscription on a hook of the receiver's, to `item.created` unless told. */
async function subscribe(
  hook: ScriptedReceiver,
  label: string,
  owner: MarfaClient = client,
  events: string[] = ["item.created"],
): Promise<{ id: string; secret: string }> {
  const created = await owner.createWebhook({
    url: hook.hookUrl(label),
    events,
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
          succeeded: false,
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

  it("settles a pending delivery unsent when its subscription is repointed, turned off or deleted, and keeps its last answer", async () => {
    const hook = await startScriptedReceiver((label, n) => ({
      status:
        label === "replacement" || (label === "control" && n > 1) ? 200 : 500,
    }));
    try {
      const subs = new Map<string, { id: string }>();
      for (const label of ["repointed", "off", "deleted", "control"]) {
        subs.set(label, await subscribe(hook, label));
      }
      await makeNote("settled-unsent");
      for (const [label, sub] of subs) {
        const row = await deliveryOf(sub.id, (r) => r.attempt === 1);
        expect(row, label).toMatchObject({
          status: "pending",
          status_code: 500,
        });
      }

      const repoint = await client.updateWebhook(subs.get("repointed")!.id, {
        url: hook.hookUrl("replacement"),
      });
      expect(repoint.ok).toBe(true);
      const off = await client.updateWebhook(subs.get("off")!.id, {
        active: false,
      });
      expect(off.ok).toBe(true);
      expect((await client.deleteWebhook(subs.get("deleted")!.id)).ok).toBe(
        true,
      );

      // Past the wait that made each of them due, with the run that retries
      // the untouched subscription a witness that a due row is attempted.
      const lastFirst = Math.max(
        ...["repointed", "off", "deleted", "control"].map(
          (label) => hook.attempts(label)[0]!.at,
        ),
      );
      await runRetriesUntil(
        () =>
          hook.attempts("control").length >= 2 &&
          Date.now() >= lastFirst + 1500,
        "the retry of the untouched subscription",
      );

      for (const [label, reason] of [
        ["repointed", "The subscription was pointed at another URL."],
        ["off", "The subscription was turned off."],
      ] as const) {
        const row = await deliveryOf(subs.get(label)!.id, () => true);
        expect(row, label).toMatchObject({
          status: "canceled",
          succeeded: false,
          error: reason,
          status_code: 500,
          attempt: 1,
        });
      }
      const gone = await client.listWebhookDeliveries(subs.get("deleted")!.id);
      expect(gone.status).toBe(404);
      expect(gone.error?.error.code).toBe("webhook_not_found");
      for (const label of ["repointed", "off", "deleted"]) {
        expect(hook.attempts(label), `${label} was sent to again`).toHaveLength(
          1,
        );
      }
      expect(hook.attempts("replacement")).toHaveLength(0);
    } finally {
      await hook.close();
    }
  });

  it("refuses to redeliver a delivery that is pending, delivered or canceled with 409 conflict, where a failed one is accepted", async () => {
    const hook = await startScriptedReceiver((label) => ({
      status: label === "delivered" ? 200 : label === "failed" ? 400 : 500,
    }));
    try {
      const subs = new Map<string, { id: string }>();
      for (const label of ["pending", "delivered", "canceled", "failed"]) {
        subs.set(label, await subscribe(hook, label));
      }
      await makeNote("redeliver-states");
      const rows = new Map<string, WebhookDelivery>();
      for (const [label, sub] of subs) {
        rows.set(label, await deliveryOf(sub.id, (r) => r.attempt === 1));
      }
      expect(rows.get("pending")?.status).toBe("pending");
      expect(rows.get("delivered")?.status).toBe("success");
      expect(rows.get("failed")?.status).toBe("dead_letter");
      const repoint = await client.updateWebhook(subs.get("canceled")!.id, {
        url: hook.hookUrl("canceled-elsewhere"),
      });
      expect(repoint.ok).toBe(true);
      rows.set(
        "canceled",
        await deliveryOf(
          subs.get("canceled")!.id,
          (r) => r.status === "canceled",
        ),
      );

      const redeliver = (label: string) =>
        client.rawRequest<WebhookDelivery>(
          `/webhooks/${subs.get(label)!.id}/deliveries/${rows.get(label)!.id}/redeliver`,
          { method: "POST" },
        );
      for (const label of ["pending", "delivered", "canceled"]) {
        const refused = await redeliver(label);
        expect(refused.status, label).toBe(409);
        expect(refused.error?.error.code, label).toBe("conflict");
        const audit = await client.listAudit({
          action: "webhook.delivery.redeliver",
          resource_id: rows.get(label)!.id,
        });
        expect(audit.data.data, label).toHaveLength(0);
        expect(
          (await client.listWebhookDeliveries(subs.get(label)!.id)).data
            .data[0],
          label,
        ).toMatchObject({
          status: rows.get(label)!.status,
          attempt: rows.get(label)!.attempt,
        });
      }

      // The witness: the same door accepts a delivery that failed for good.
      const accepted = await redeliver("failed");
      expect(accepted.status).toBe(202);
      expect(accepted.data.status).toBe("pending");
    } finally {
      await hook.close();
    }
  });

  it("clears the error a failed attempt recorded when a later attempt succeeds", async () => {
    const hook = await startScriptedReceiver((_, n) => ({
      status: n === 1 ? 503 : 200,
    }));
    try {
      const sub = await subscribe(hook, "cleared");
      await makeNote("cleared");
      const failed = await deliveryOf(sub.id, (r) => r.attempt === 1);
      expect(failed).toMatchObject({
        status: "pending",
        status_code: 503,
        error: "HTTP 503",
      });

      await runRetriesUntil(
        () => hook.attempts("cleared").length >= 2,
        "the retry",
      );
      const settled = await deliveryOf(sub.id, (r) => r.status === "success");
      expect(settled).toMatchObject({
        id: failed.id,
        status_code: 200,
        attempt: 2,
        error: null,
      });
    } finally {
      await hook.close();
    }
  });

  it("narrows what a retry carries to the credential as it stands after the event", async () => {
    const owner = await keyWith("narrowed-extensions", {
      type_permissions: { "*": "read" },
      extension_permissions: { "webhook.keep": "read", "webhook.drop": "read" },
    });
    let refuse = true;
    const hook = await startScriptedReceiver(() => ({
      status: refuse ? 500 : 200,
    }));
    try {
      // The first namespace is written before the subscription, so the one
      // event it is sent holds both namespaces.
      const note = await makeNote("narrowed-extensions");
      expect(
        (await client.setItemExtension(note, "webhook.keep", { a: 1 })).ok,
      ).toBe(true);
      const sub = await subscribe(hook, "narrowed", owner.client, [
        "metadata.changed",
      ]);
      expect(
        (await client.setItemExtension(note, "webhook.drop", { b: 2 })).ok,
      ).toBe(true);
      await waitFor("the first attempt", async () =>
        hook.attempts("narrowed").length >= 1 ? true : undefined,
      );
      const namespacesOf = (attempt: Attempt): string[] =>
        Object.keys(
          (JSON.parse(attempt.body) as { metadata: { extensions: object } })
            .metadata.extensions,
        ).sort();
      const [first] = hook.attempts("narrowed") as [Attempt];
      // The witness: before the narrowing the event carried both.
      expect(namespacesOf(first)).toEqual(["webhook.drop", "webhook.keep"]);
      await deliveryOf(sub.id, (r) => r.attempt === 1, owner.client);

      const narrowed = await client.updateKey(owner.id, {
        extension_permissions: { "webhook.keep": "read" },
      });
      expect(narrowed.ok, JSON.stringify(narrowed.error)).toBe(true);
      refuse = false;
      await runRetriesUntil(
        () => hook.attempts("narrowed").length >= 2,
        "the retry",
      );
      const [, retry] = hook.attempts("narrowed") as [Attempt, Attempt];
      expect(namespacesOf(retry)).toEqual(["webhook.keep"]);
      const ids = [first, retry].map(
        (a) => (JSON.parse(a.body) as { delivery_id: string }).delivery_id,
      );
      expect(ids[1]).toBe(ids[0]);
      const settled = await deliveryOf(
        sub.id,
        (r) => r.status === "success",
        owner.client,
      );
      expect(settled.id).toBe(ids[0]);
    } finally {
      await hook.close();
    }
  });

  it("settles a pending delivery unsent when the credential is narrowed away from its type", async () => {
    const owner = await keyWith("narrowed-types", {
      type_permissions: { "core.note": "read", "core.task": "read" },
    });
    const hook = await startScriptedReceiver((label, n) => ({
      status: label === "control" && n > 1 ? 200 : 500,
    }));
    try {
      const narrowed = await subscribe(hook, "narrowed-away", owner.client);
      const control = await subscribe(hook, "control");
      await makeTask("narrowed-away");
      const pending = await deliveryOf(
        narrowed.id,
        (r) => r.attempt === 1,
        owner.client,
      );
      await deliveryOf(control.id, (r) => r.attempt === 1);
      expect(pending).toMatchObject({ status: "pending", status_code: 500 });

      const update = await client.updateKey(owner.id, {
        type_permissions: { "core.note": "read" },
      });
      expect(update.ok, JSON.stringify(update.error)).toBe(true);
      const lastFirst = Math.max(
        hook.attempts("narrowed-away")[0]!.at,
        hook.attempts("control")[0]!.at,
      );
      await runRetriesUntil(
        () =>
          hook.attempts("control").length >= 2 &&
          Date.now() >= lastFirst + 1500,
        "the retry of the control subscription",
      );

      const row = await deliveryOf(narrowed.id, () => true, owner.client);
      expect(row).toMatchObject({
        id: pending.id,
        status: "canceled",
        succeeded: false,
        error:
          "The credential the subscription belongs to may not read this event.",
        status_code: 500,
        attempt: 1,
      });
      expect(hook.attempts("narrowed-away")).toHaveLength(1);
    } finally {
      await hook.close();
    }
  });

  it("delivers the marks of a stream frame, naming another row only to an owner who may read its type", async () => {
    const owner = await keyWith("marks-notes-owner", {
      type_permissions: { "core.note": "read" },
    });
    const events = ["item.deleted", "item.restored", "item.purged"];
    const full = await client.createWebhook({
      url: receiver.hookUrl("marks-full"),
      events,
    });
    const notes = await owner.client.createWebhook({
      url: receiver.hookUrl("marks-notes"),
      events,
    });
    expect(full.status).toBe(201);
    expect(notes.status).toBe(201);
    trackWebhook(ctx, full.data.id, client);
    trackWebhook(ctx, notes.data.id, owner.client);

    const root = await makeTask("marks-root");
    const child = await makeNote("marks-child");
    const alone = await makeNote("marks-alone");
    const edgeType = "parent-of";
    await link(root, child, edgeType);
    expect((await client.deleteItem(root)).ok).toBe(true);
    expect((await client.restoreItem(root)).ok).toBe(true);
    expect((await client.deleteItem(root)).ok).toBe(true);
    expect((await client.purgeItem(child)).ok).toBe(true);
    // The sentinel for the notes owner: written after everything above.
    expect((await client.deleteItem(alone)).ok).toBe(true);

    type Marked = { id: string } & Record<string, unknown>;
    const framesAt = (label: string, eventType: string, id: string): Marked[] =>
      receiver.received
        .filter(
          (r) =>
            r.path === `/hook/${label}` &&
            r.headers["x-marfa-event-type"] === eventType &&
            (JSON.parse(r.body) as { item: Marked }).item.id === id,
        )
        .map((r) => (JSON.parse(r.body) as { item: Marked }).item);
    const restoredWith = (label: string, id: string): unknown[] =>
      receiver.received
        .filter(
          (r) =>
            r.path === `/hook/${label}` &&
            r.headers["x-marfa-event-type"] === "item.restored" &&
            (JSON.parse(r.body) as { item: Marked }).item.id === id,
        )
        .map(
          (r) =>
            (JSON.parse(r.body) as { restored_with?: string }).restored_with,
        );

    // Each delivery is its own request, so the sentinel arriving does not say
    // the earlier ones have; each is waited for by what it must carry.
    for (const label of ["marks-full", "marks-notes"]) {
      await waitFor(`the deliveries to ${label}`, async () =>
        framesAt(label, "item.deleted", child).length >= 2 &&
        framesAt(label, "item.deleted", alone).length >= 1 &&
        framesAt(label, "item.purged", child).length >= 1 &&
        restoredWith(label, child).length >= 1
          ? true
          : undefined,
      );
    }

    // An owner that reads every type is told which row each mark names.
    for (const eventType of ["item.deleted", "item.purged"]) {
      const frames = framesAt("marks-full", eventType, child);
      expect(frames.length, eventType).toBeGreaterThan(0);
      for (const item of frames) {
        expect(item.trashed_by_cascade, eventType).toBe(true);
        expect(item.trashed_with, eventType).toBe(root);
      }
    }
    expect(restoredWith("marks-full", child)).toEqual([root]);
    expect(restoredWith("marks-full", root)).toEqual([undefined]);

    // An owner that may not read tasks is told a cascade took the row, and
    // not which row.
    for (const eventType of ["item.deleted", "item.purged"]) {
      const frames = framesAt("marks-notes", eventType, child);
      expect(frames.length, eventType).toBeGreaterThan(0);
      for (const item of frames) {
        expect(item.trashed_by_cascade, eventType).toBe(true);
        expect(item, eventType).not.toHaveProperty("trashed_with");
      }
    }
    expect(restoredWith("marks-notes", child)).toEqual([undefined]);
    for (const eventType of events) {
      expect(framesAt("marks-notes", eventType, root), eventType).toHaveLength(
        0,
      );
    }
  });

  it("answers a redelivery on a subscription another credential registered 404 webhook_not_found, and accepts the owner's", async () => {
    const hook = await startScriptedReceiver(() => ({ status: 400 }));
    try {
      const sub = await subscribe(hook, "foreign-redeliver");
      await makeNote("foreign-redeliver");
      const failed = await deliveryOf(
        sub.id,
        (r) => r.status === "dead_letter",
      );
      const other = await keyWith("foreign-redeliverer", {});
      const path = `/webhooks/${sub.id}/deliveries/${failed.id}/redeliver`;

      for (const refused of [
        await other.client.rawRequest(path, { method: "POST" }),
        await other.client.rawRequest(
          `/webhooks/${sub.id}-unknown/deliveries/${failed.id}/redeliver`,
          { method: "POST" },
        ),
      ]) {
        expect(refused.status).toBe(404);
        expect(refused.error?.error.code).toBe("webhook_not_found");
      }
      const audit = await client.listAudit({
        action: "webhook.delivery.redeliver",
        resource_id: failed.id,
      });
      expect(audit.data.data).toHaveLength(0);
      expect((await deliveryOf(sub.id, () => true)).status).toBe("dead_letter");

      const accepted = await client.rawRequest<WebhookDelivery>(path, {
        method: "POST",
      });
      expect(accepted.status).toBe(202);
    } finally {
      await hook.close();
    }
  });

  it("queues one transition when a redelivery is requested twice at once, and records one audit entry", async () => {
    const hook = await startScriptedReceiver(() => ({ status: 400 }));
    try {
      const sub = await subscribe(hook, "twice");
      await makeNote("twice");
      const failed = await deliveryOf(
        sub.id,
        (r) => r.status === "dead_letter",
      );
      const path = `/webhooks/${sub.id}/deliveries/${failed.id}/redeliver`;

      const answers = await Promise.all([
        client.rawRequest<WebhookDelivery>(path, { method: "POST" }),
        client.rawRequest<WebhookDelivery>(path, { method: "POST" }),
      ]);
      expect(answers.map((a) => a.status).sort()).toEqual([202, 409]);
      const refused = answers.find((a) => a.status === 409);
      expect(refused?.error?.error.code).toBe("conflict");
      const audit = await client.listAudit({
        action: "webhook.delivery.redeliver",
        resource_id: failed.id,
      });
      expect(audit.data.data).toHaveLength(1);
    } finally {
      await hook.close();
    }
  });

  it("sends a subscription no event written before it was registered", async () => {
    const hook = await startScriptedReceiver(() => ({ status: 200 }));
    try {
      const before: string[] = [];
      for (let i = 0; i < 10; i++)
        before.push(await makeNote(`before-${String(i)}`));
      const sub = await subscribe(hook, "after-registration");
      const after = await makeNote("after-registration");
      await waitFor("the delivery of the later item", async () =>
        hook.attempts("after-registration").some((a) => a.body.includes(after))
          ? true
          : undefined,
      );
      const bodies = hook.attempts("after-registration").map((a) => a.body);
      for (const id of before) {
        expect(
          bodies.some((b) => b.includes(id)),
          id,
        ).toBe(false);
      }
      expect(
        (await client.listWebhookDeliveries(sub.id)).data.data,
      ).toHaveLength(1);
    } finally {
      await hook.close();
    }
  });

  it("lists a subscription's deliveries newest first", async () => {
    const hook = await startScriptedReceiver(() => ({ status: 200 }));
    try {
      const sub = await subscribe(hook, "newest-first");
      const written: string[] = [];
      for (let i = 0; i < 3; i++)
        written.push(await makeNote(`newest-${String(i)}`));
      await waitFor("all three deliveries", async () =>
        hook.attempts("newest-first").length >= 3 ? true : undefined,
      );
      const eventIds = new Map(
        hook.attempts("newest-first").map((a) => {
          const body = JSON.parse(a.body) as {
            delivery_id: string;
            event_id: string;
          };
          return [body.delivery_id, BigInt(body.event_id)] as const;
        }),
      );
      const rows = await waitFor("three delivery rows", async () => {
        const listed = (await client.listWebhookDeliveries(sub.id)).data.data;
        return listed.length === 3 ? listed : undefined;
      });
      const order = rows.map((r) => eventIds.get(r.id)!);
      expect(order).toEqual([...order].sort((a, b) => (a > b ? -1 : 1)));
      expect(rows.map((r) => r.created_at)).toEqual(
        [...rows.map((r) => r.created_at)].sort().reverse(),
      );
    } finally {
      await hook.close();
    }
  });

  it("shows a subscription as its id, url, events, type_filter, secret, active flag and two timestamps, and no more", async () => {
    const keys = [
      "active",
      "created_at",
      "events",
      "id",
      "secret",
      "type_filter",
      "updated_at",
      "url",
    ];
    const created = await client.createWebhook({
      url: receiver.hookUrl("shape"),
      events: ["item.created"],
      type_filter: "core.note",
    });
    expect(created.status).toBe(201);
    trackWebhook(ctx, created.data.id, client);
    expect(Object.keys(created.data).sort()).toEqual(keys);

    const fetched = await client.getWebhook(created.data.id);
    expect(Object.keys(fetched.data).sort()).toEqual(keys);
    const updated = await client.updateWebhook(created.data.id, {
      active: false,
    });
    expect(Object.keys(updated.data).sort()).toEqual(keys);
    expect(updated.data.secret).toMatch(/^\*+[0-9a-f]{4}$/);
    const listed = await client.listWebhooks();
    const mine = listed.data.data.find((w) => w.id === created.data.id);
    expect(Object.keys(mine ?? {}).sort()).toEqual(keys);
    expect(listed.data.next_cursor).toBeNull();
  });

  it("signs deliveries under a secret the caller supplied, returned whole on creation, at the time of the attempt", async () => {
    const secret = "supplied-secret-".padEnd(40, "s");
    const hook = await startScriptedReceiver(() => ({ status: 200 }));
    try {
      const created = await client.createWebhook({
        url: hook.hookUrl("supplied"),
        events: ["item.created"],
        secret,
      });
      expect(created.status).toBe(201);
      trackWebhook(ctx, created.data.id, client);
      expect(created.data.secret).toBe(secret);
      await makeNote("supplied");
      await waitFor("the delivery", async () =>
        hook.attempts("supplied").length >= 1 ? true : undefined,
      );
      const [attempt] = hook.attempts("supplied") as [Attempt];
      expectSignedBy({ ...attempt, path: "" }, secret);
      expect(
        Math.abs(signedAt(attempt) - Date.now() / 1000),
      ).toBeLessThanOrEqual(60);
    } finally {
      await hook.close();
    }
  });

  it("records an unreachable receiver and one that does not answer as pending, naming no address", async () => {
    const closed = await startScriptedReceiver(() => ({ status: 200 }));
    const closedUrl = closed.hookUrl("unreachable");
    await closed.close();
    const sockets = new Set<import("node:net").Socket>();
    const silent = createServer(() => undefined);
    silent.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    await new Promise<void>((resolve) =>
      silent.listen(0, "127.0.0.1", resolve),
    );
    const silentPort = (silent.address() as { port: number }).port;
    try {
      const unreachable = await client.createWebhook({
        url: closedUrl,
        events: ["item.created"],
      });
      const timedOut = await client.createWebhook({
        url: `http://127.0.0.1:${String(silentPort)}/hook/silent`,
        events: ["item.created"],
      });
      expect(unreachable.status).toBe(201);
      expect(timedOut.status).toBe(201);
      trackWebhook(ctx, unreachable.data.id, client);
      trackWebhook(ctx, timedOut.data.id, client);
      await makeNote("no-answer");

      const first = await deliveryOf(
        unreachable.data.id,
        (r) => r.attempt === 1,
      );
      expect(first).toMatchObject({
        status: "pending",
        status_code: null,
        error: "The receiver could not be reached.",
      });
      const second = await deliveryOf(timedOut.data.id, (r) => r.attempt === 1);
      expect(second).toMatchObject({
        status: "pending",
        status_code: null,
        error: "The receiver did not answer in time.",
      });
      for (const row of [first, second]) {
        expect(row.error).not.toMatch(/127\.0\.0\.1|:\d{4,5}/);
      }
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => silent.close(() => resolve()));
    }
  });

  it("settles a pending delivery unsent when its key no longer holds webhooks.manage", async () => {
    const owner = await keyWith("manage-removed", {
      type_permissions: { "*": "read" },
    });
    const hook = await startScriptedReceiver((label, n) => ({
      status: label === "control" && n > 1 ? 200 : 500,
    }));
    try {
      const sub = await subscribe(hook, "manage-removed", owner.client);
      const control = await subscribe(hook, "control");
      await makeNote("manage-removed");
      await deliveryOf(sub.id, (r) => r.attempt === 1, owner.client);
      await deliveryOf(control.id, (r) => r.attempt === 1);

      const removed = await client.updateKey(owner.id, { permissions: [] });
      expect(removed.ok, JSON.stringify(removed.error)).toBe(true);
      const lastFirst = Math.max(
        hook.attempts("manage-removed")[0]!.at,
        hook.attempts("control")[0]!.at,
      );
      await runRetriesUntil(
        () =>
          hook.attempts("control").length >= 2 &&
          Date.now() >= lastFirst + 1500,
        "the retry of the control subscription",
      );
      expect(hook.attempts("manage-removed")).toHaveLength(1);

      // The owner can read its log again only with the permission back.
      const restored = await client.updateKey(owner.id, {
        permissions: ["webhooks.manage"],
      });
      expect(restored.ok, JSON.stringify(restored.error)).toBe(true);
      expect(await deliveryOf(sub.id, () => true, owner.client)).toMatchObject({
        status: "canceled",
        succeeded: false,
        error:
          "The credential the subscription belongs to no longer stands or no longer holds webhooks.manage.",
        status_code: 500,
        attempt: 1,
      });
    } finally {
      await hook.close();
    }
  });

  it("delivers an edge event under a type_filter that selects neither of its items", async () => {
    const edgeType = await registerEdgeType("filtered-edge");
    const created = await client.createWebhook({
      url: receiver.hookUrl("filtered-edge"),
      events: ["edge.created"],
      type_filter: "core.task",
    });
    expect(created.status).toBe(201);
    trackWebhook(ctx, created.data.id, client);

    const source = await makeNote("filtered-edge-source");
    const target = await makeNote("filtered-edge-target");
    const edgeId = await link(source, target, edgeType);
    const delivered = await receiver.waitFor(
      (r) => r.path === "/hook/filtered-edge" && r.body.includes(edgeId),
    );
    expect(delivered.headers["x-marfa-event-type"]).toBe("edge.created");
  });
});
