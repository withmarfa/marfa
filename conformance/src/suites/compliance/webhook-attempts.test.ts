import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { TestContext, WebhookDelivery } from "../../client/types.js";
import {
  cleanup,
  createTestContext,
  trackItem,
  trackWebhook,
} from "../../utils/setup.js";
import { createNote } from "../../generators/items.js";
import { waitFor } from "../../utils/wait.js";

/**
 * What a receiver can rely on about the attempts it is sent: the order they
 * come in, how many of one subscription are in flight and how long the
 * server waits for an answer.
 */
let client: MarfaClient;
let ctx: TestContext;

beforeAll(async () => {
  ({ ctx, client } = await createTestContext("compliance", "webhook-attempts"));
});

afterAll(async () => {
  await cleanup(ctx);
});

async function makeNote(label: string): Promise<string> {
  const note = await client.createItem(
    createNote({
      source: ctx.source,
      properties: { body: `attempt-${label}` },
    }),
  );
  expect(note.ok, JSON.stringify(note.error)).toBe(true);
  trackItem(ctx, note.data.item.id);
  return note.data.item.id;
}

interface Arrival {
  path: string;
  at: number;
  body: string;
}

interface Hook {
  port: number;
  arrivals: Arrival[];
  /** The most requests the receiver held open at once on one path. */
  mostOpenOn: (path: string) => number;
  /** The most requests it held open at once on all paths. */
  mostOpen: () => number;
  /** When each connection reached the receiver, by path. */
  connectedAt: (path: string) => number[];
  close: () => Promise<void>;
}

/**
 * A receiver that answers each request as `answer` says: a status after a
 * delay, or `undefined` to hold the request open without ever answering.
 */
async function startHook(
  answer: (
    path: string,
    arrival: number,
  ) => { status: number; afterMs: number } | undefined,
): Promise<Hook> {
  const arrivals: Arrival[] = [];
  const connected = new Map<string, number[]>();
  const open = new Map<string, number>();
  const most = new Map<string, number>();
  let openAll = 0;
  let mostAll = 0;
  const sockets = new Set<import("node:net").Socket>();
  const server: Server = createServer((req, res) => {
    const path = req.url ?? "";
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
    });
    req.on("end", () => {
      const seen = arrivals.filter((a) => a.path === path).length + 1;
      arrivals.push({ path, at: Date.now(), body });
      const now = (open.get(path) ?? 0) + 1;
      open.set(path, now);
      most.set(path, Math.max(most.get(path) ?? 0, now));
      openAll += 1;
      mostAll = Math.max(mostAll, openAll);
      const plan = answer(path, seen);
      const finish = () => {
        open.set(path, (open.get(path) ?? 1) - 1);
        openAll -= 1;
      };
      if (plan === undefined) {
        res.on("close", finish);
        return;
      }
      setTimeout(() => {
        res.writeHead(plan.status);
        res.end("ok");
        finish();
      }, plan.afterMs);
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  server.on("request", (req) => {
    const path = req.url ?? "";
    connected.set(path, [...(connected.get(path) ?? []), Date.now()]);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (typeof address !== "object" || address === null) {
    throw new Error("the receiver did not bind to a port");
  }
  return {
    port: address.port,
    arrivals,
    mostOpenOn: (path) => most.get(path) ?? 0,
    mostOpen: () => mostAll,
    connectedAt: (path) => connected.get(path) ?? [],
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function subscribe(hook: Hook, path: string): Promise<string> {
  const created = await client.createWebhook({
    url: `http://127.0.0.1:${String(hook.port)}${path}`,
    events: ["item.created"],
  });
  expect(created.status, JSON.stringify(created.error)).toBe(201);
  trackWebhook(ctx, created.data.id, client);
  return created.data.id;
}

const eventIdOf = (arrival: Arrival): bigint =>
  BigInt((JSON.parse(arrival.body) as { event_id: string }).event_id);

describe("the attempts a webhook receiver is sent", () => {
  it("sends a later event before the retry of an earlier one, whose event_id gives the order", async () => {
    const hook = await startHook((_, arrival) => ({
      status: arrival === 1 ? 500 : 200,
      afterMs: 0,
    }));
    const id = await subscribe(hook, "/order");
    try {
      const first = await makeNote("order-first");
      await waitFor("the first attempt", async () =>
        hook.arrivals.length >= 1 ? true : undefined,
      );
      // The retry of the first event waits a second; the second event is
      // due at once.
      const second = await makeNote("order-second");
      await waitFor(
        "the second event and the first event's retry",
        async () => (hook.arrivals.length >= 3 ? true : undefined),
        15_000,
      );
      const bodies = hook.arrivals.map((a) => JSON.parse(a.body) as unknown);
      const carries = (n: number, note: string) =>
        JSON.stringify(bodies[n]).includes(note);
      expect(carries(0, first)).toBe(true);
      expect(carries(1, second)).toBe(true);
      expect(carries(2, first)).toBe(true);
      const [a, b, c] = hook.arrivals.map(eventIdOf);
      expect(c).toBe(a);
      expect(b! > a!).toBe(true);
    } finally {
      await client.deleteWebhook(id);
      await hook.close();
    }
  });

  it("holds at most one attempt in flight for a subscription, and one for each of two", async () => {
    const hook = await startHook(() => ({ status: 200, afterMs: 600 }));
    const ids = [await subscribe(hook, "/one"), await subscribe(hook, "/two")];
    try {
      for (let n = 1; n <= 4; n += 1) await makeNote(`inflight-${String(n)}`);
      const noteCount = (path: string) =>
        hook.arrivals.filter((a) => a.path === path).length;
      await waitFor(
        "four deliveries to each subscription",
        async () =>
          noteCount("/one") >= 4 && noteCount("/two") >= 4 ? true : undefined,
        30_000,
      );
      // The two subscriptions overlap, which shows the receiver would have
      // counted two attempts of one subscription.
      expect(hook.mostOpen()).toBe(2);
      expect(hook.mostOpenOn("/one")).toBe(1);
      expect(hook.mostOpenOn("/two")).toBe(1);
    } finally {
      for (const id of ids) await client.deleteWebhook(id);
      await hook.close();
    }
  });

  // The claim is an elapsed time, so a second run is not the same test.
  it(
    "ends an attempt the receiver has not answered 10 seconds after it started, and takes one answered within it",
    { retry: 0 },
    async () => {
      const hook = await startHook((path) =>
        path === "/slow" ? { status: 200, afterMs: 6_000 } : undefined,
      );
      const silent = await subscribe(hook, "/silent");
      const slow = await subscribe(hook, "/slow");
      try {
        await makeNote("answer-bound");
        const record = async (
          id: string,
          done: (r: WebhookDelivery) => boolean,
        ) =>
          waitFor(
            `the delivery of ${id} to record an attempt`,
            async () => {
              const rows = await client.listWebhookDeliveries(id);
              expect(rows.ok).toBe(true);
              const row = rows.data.data[0];
              return row !== undefined && done(row) ? row : undefined;
            },
            30_000,
          );
        let silentEnded = 0;
        const ended = await record(silent, (r) => {
          if (r.attempt === 1) silentEnded = Date.now();
          return r.attempt === 1;
        });
        expect(ended).toMatchObject({
          status: "pending",
          status_code: null,
          error: "The receiver did not answer in time.",
        });
        const started = hook.connectedAt("/silent")[0]!;
        const waited = silentEnded - started;
        // The bound counts from the start of the attempt, and the poll above
        // sees the record within a second of it.
        expect(waited).toBeGreaterThanOrEqual(9_500);
        expect(waited).toBeLessThan(12_000);

        // An answer after 6 seconds is inside the bound.
        const answered = await record(slow, (r) => r.status === "success");
        expect(answered).toMatchObject({ status_code: 200, attempt: 1 });
      } finally {
        for (const id of [silent, slow]) await client.deleteWebhook(id);
        await hook.close();
      }
    },
  );
});
