import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { withInstanceDatabase } from "../../utils/instance-database.js";
import { idOf, send } from "../../utils/inbound-sender.js";

/**
 * How long a delivery is kept: a handled one for seven days after it was
 * handled and a pending one for thirty after it arrived, unless the instance
 * says otherwise, and the pass that removes what is past them. The age of a
 * delivery is a clock a fixture cannot wait out, so a server of its own is
 * stopped, its stored times are set back, and it is started again; the pass
 * is then run through the operator rather than waited for.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

let server: FreshServer;
let serial = 0;

beforeAll(async () => {
  server = await bootFreshServer("inbound-retention", {
    // Far enough off that no pass but the ones this file asks for runs.
    MARFA_INBOUND_CLEANUP_INTERVAL_MS: "3153600000000",
  });
  // The first run puts the job's next one at the end of that interval, where
  // its first run would otherwise be thirty seconds after the boot.
  const first = await operator().runHousekeeping("inbound-delivery-cleanup");
  expect(first.status).toBe(200);
  expect(first.data.result).toEqual({ deleted: 0, remaining: false });
}, 2 * FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  await server.stop();
}, 2 * FRESH_SERVER_TIMEOUT_MS);

function operator(): MarfaClient {
  return new MarfaClient({
    baseUrl: server.apiUrl,
    apiKey: server.operatorKey,
  });
}

function minter(): MarfaClient {
  return new MarfaClient({ baseUrl: server.apiUrl, apiKey: server.workingKey });
}

interface World {
  /** On the server's address as it is now, which a restart changes. */
  readonly client: MarfaClient;
  id: string;
  path: string;
  /** Sends one body and answers the delivery it made. */
  deliver(body: string): Promise<string>;
  /** Marks a delivery handled. */
  handle(delivery: string): Promise<void>;
  /** The deliveries kept, by body. */
  kept(): Promise<string[]>;
}

/** A registration and an address of its own, removed with its deliveries
 *  when the test is done, so no test's rows reach the next one's pass. */
async function world(): Promise<World> {
  serial += 1;
  const label = `retention-${String(serial)}`;
  const minted = await minter().createKey({
    label,
    source: label,
    default_tier: "library",
  });
  expect(minted.status).toBe(201);
  const current = () =>
    new MarfaClient({ baseUrl: server.apiUrl, apiKey: minted.data.key });
  const registered = await current().registerConnector({ name: label });
  expect(registered.status).toBe(201);
  const made = await current().createInboundEndpoint(registered.data.id);
  expect(made.status).toBe(201);
  const id = registered.data.id;
  const bodies = new Map<string, string>();
  return {
    get client() {
      return current();
    },
    id,
    path: made.data.path,
    async deliver(body) {
      const delivered = idOf(await send(server.apiUrl, made.data.path, body));
      bodies.set(delivered, body);
      return delivered;
    },
    async handle(delivery) {
      const marked = await current().markInboundDeliveriesHandled(id, {
        ids: [delivery],
        outcome: "processed",
      });
      expect(marked.status).toBe(200);
    },
    async kept() {
      const found: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await current().listInboundDeliveries(id, {
          state: "any",
          limit: 200,
          cursor,
        });
        expect(page.status).toBe(200);
        found.push(
          ...page.data.data.map((row) => bodies.get(row.id) ?? row.id),
        );
        cursor = page.data.next_cursor ?? undefined;
      } while (cursor !== undefined);
      return found.sort();
    },
  };
}

/** Sets stored times back while the server is stopped, and starts it again. */
async function setBack(
  rows: { id: string; received?: number; handled?: number }[],
): Promise<void> {
  await server.restart({
    whileStopped: () => {
      const now = Date.now();
      withInstanceDatabase(server.sqlitePath, (db) => {
        const stamp = (ageMs: number) => new Date(now - ageMs).toISOString();
        const received = db.prepare(
          "UPDATE inbound_deliveries SET received_at = ? WHERE id = ?",
        );
        const handled = db.prepare(
          "UPDATE inbound_deliveries SET handled_at = ? WHERE id = ? AND handled_at IS NOT NULL",
        );
        db.exec("BEGIN");
        for (const row of rows) {
          if (row.received !== undefined) {
            received.run(stamp(row.received), row.id);
          }
          if (row.handled !== undefined) {
            handled.run(stamp(row.handled), row.id);
          }
        }
        db.exec("COMMIT");
      });
    },
  });
}

async function sweep() {
  const run = await operator().runHousekeeping("inbound-delivery-cleanup");
  expect(run.status).toBe(200);
  expect(run.data.outcome, String(run.data.error)).toBe("ok");
  return run.data.result;
}

async function configured(
  overrides: Record<string, number>,
): Promise<() => Promise<void>> {
  const before = await minter().getConfig();
  expect(before.status).toBe(200);
  const changed = await minter().updateConfig({
    ...(before.data as Record<string, unknown>),
    ...overrides,
  });
  expect(changed.status, JSON.stringify(changed.error)).toBe(200);
  return async () => {
    expect((await minter().updateConfig({})).status).toBe(200);
  };
}

describe("the pass that removes deliveries past their retention", () => {
  it("removes handled deliveries seven days after they were handled and pending ones thirty days after they arrived, and keeps the rest", async () => {
    const w = await world();
    const handledIn = await w.deliver("handled inside");
    const handledAt = await w.deliver("handled at");
    const handledOut = await w.deliver("handled past");
    const handledNow = await w.deliver("handled now, arrived long ago");
    const pendingIn = await w.deliver("pending inside");
    const pendingAt = await w.deliver("pending at");
    const pendingOut = await w.deliver("pending past");
    const pendingEight = await w.deliver("pending eight days");
    for (const id of [handledIn, handledAt, handledOut, handledNow]) {
      await w.handle(id);
    }
    expect(await w.kept()).toHaveLength(8);

    // Stamped at the retention itself, a delivery is past it by the time the
    // pass runs, and an hour inside it is not.
    await setBack([
      { id: handledIn, received: 100 * DAY_MS, handled: 7 * DAY_MS - HOUR_MS },
      { id: handledAt, received: 100 * DAY_MS, handled: 7 * DAY_MS },
      { id: handledOut, received: 100 * DAY_MS, handled: 7 * DAY_MS + HOUR_MS },
      { id: handledNow, received: 100 * DAY_MS, handled: 60_000 },
      { id: pendingIn, received: 30 * DAY_MS - HOUR_MS },
      { id: pendingAt, received: 30 * DAY_MS },
      { id: pendingOut, received: 30 * DAY_MS + HOUR_MS },
      // Past what a handled delivery is kept, inside what a pending one is.
      { id: pendingEight, received: 8 * DAY_MS },
    ]);
    expect(await w.kept()).toHaveLength(8);

    expect(await sweep()).toEqual({ deleted: 4, remaining: false });
    expect(await w.kept()).toEqual([
      "handled inside",
      "handled now, arrived long ago",
      "pending eight days",
      "pending inside",
    ]);
    // What is deleted goes with its body, and what is kept keeps it.
    const body = (id: string) => w.client.getInboundDeliveryBody(w.id, id);
    expect((await body(handledAt)).status).toBe(404);
    expect((await body(pendingOut)).status).toBe(404);
    expect((await body(handledIn)).status).toBe(200);
    expect((await body(pendingEight)).status).toBe(200);

    // Nothing is left past its retention, so a second pass finds nothing.
    expect(await sweep()).toEqual({ deleted: 0, remaining: false });
    expect((await w.client.deleteConnector(w.id)).status).toBe(200);
  });

  it("keeps a class whose retention is zero, whatever its age", async () => {
    const w = await world();
    const reset = await configured({
      inbound_handled_retention_days: 0,
      inbound_pending_retention_days: 2,
    });
    try {
      const handled = await w.deliver("handled long ago");
      const young = await w.deliver("pending a day");
      const old = await w.deliver("pending three days");
      await w.handle(handled);
      await setBack([
        { id: handled, received: 400 * DAY_MS, handled: 400 * DAY_MS },
        { id: young, received: DAY_MS },
        { id: old, received: 3 * DAY_MS },
      ]);

      expect(await sweep()).toEqual({ deleted: 1, remaining: false });
      expect(await w.kept()).toEqual(["handled long ago", "pending a day"]);

      // Both zero keeps everything, a delivery of four hundred days among it.
      await setBack([{ id: young, received: 400 * DAY_MS }]);
      expect(
        (
          await minter().updateConfig({
            inbound_handled_retention_days: 0,
            inbound_pending_retention_days: 0,
          })
        ).status,
      ).toBe(200);
      expect(await sweep()).toEqual({ deleted: 0, remaining: false });
      expect(await w.kept()).toEqual(["handled long ago", "pending a day"]);
    } finally {
      await reset();
      await w.client.deleteConnector(w.id);
    }
  });

  it("ages each class by the retention the instance names for it, and by the default for one it does not", async () => {
    const w = await world();
    const reset = await configured({ inbound_handled_retention_days: 1 });
    try {
      const handledOld = await w.deliver("handled two days");
      const handledYoung = await w.deliver("handled twelve hours");
      const pendingYoung = await w.deliver("pending twenty days");
      const pendingOld = await w.deliver("pending thirty-one days");
      await w.handle(handledOld);
      await w.handle(handledYoung);
      await setBack([
        { id: handledOld, handled: 2 * DAY_MS },
        { id: handledYoung, handled: 12 * HOUR_MS },
        { id: pendingYoung, received: 20 * DAY_MS },
        { id: pendingOld, received: 31 * DAY_MS },
      ]);

      expect(await sweep()).toEqual({ deleted: 2, remaining: false });
      expect(await w.kept()).toEqual([
        "handled twelve hours",
        "pending twenty days",
      ]);
    } finally {
      await reset();
      await w.client.deleteConnector(w.id);
    }
  });

  it("removes at most 500 deliveries in a pass, the oldest first, and says that work remains", async () => {
    const w = await world();
    const ids: string[] = [];
    for (let i = 0; i < 501; i++)
      ids.push(await w.deliver(`past ${String(i)}`));
    // The first is the oldest, a second apart from the next.
    await setBack(
      ids.map((id, i) => ({
        id,
        received: 40 * DAY_MS + (ids.length - i) * 1000,
      })),
    );
    expect(await w.kept()).toHaveLength(501);

    expect(await sweep()).toEqual({ deleted: 500, remaining: true });
    expect(await w.kept()).toEqual(["past 500"]);
    expect(await sweep()).toEqual({ deleted: 1, remaining: false });
    expect(await w.kept()).toEqual([]);
    expect((await w.client.deleteConnector(w.id)).status).toBe(200);
  }, 120_000);
});
