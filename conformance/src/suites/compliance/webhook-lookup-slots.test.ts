import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MarfaClient } from "../../client/api.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  stopFreshServers,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { waitFor } from "../../utils/wait.js";
import { startReceiver, type Receiver } from "../../utils/webhook-receiver.js";

// Unlike a scripted address, localhost exercises the lookup slots.
let server: FreshServer;
let receiver: Receiver;

beforeEach(async () => {
  server = await bootFreshServer("webhook-lookup-slots");
  receiver = await startReceiver();
}, FRESH_SERVER_TIMEOUT_MS);

afterEach(async () => {
  await receiver?.close();
  await stopFreshServers();
}, 2 * FRESH_SERVER_TIMEOUT_MS);

function owner(): MarfaClient {
  return new MarfaClient({ baseUrl: server.apiUrl, apiKey: server.workingKey });
}

async function makerKey(label: string): Promise<MarfaClient> {
  const minted = await owner().createKey({
    label,
    source: `lookup-slots-${label}`,
    permissions: ["webhooks.manage"],
    type_permissions: { "*": "read" },
  });
  expect(minted.ok, JSON.stringify(minted.error)).toBe(true);
  return new MarfaClient({
    baseUrl: server.apiUrl,
    apiKey: minted.data.key,
  });
}

async function subscribe(
  client: MarfaClient,
  host: string,
  label: string,
  event = "item.created",
): Promise<string> {
  const port = new URL(receiver.url).port;
  const created = await client.createWebhook({
    url: `http://${host}:${port}/hook/${label}`,
    events: [event],
  });
  expect(created.status, JSON.stringify(created.error)).toBe(201);
  return created.data.id;
}

async function write(body: string): Promise<{ id: string; version: number }> {
  const note = await owner().createItem({
    type: "core.note",
    properties: { body },
  });
  expect(note.ok, JSON.stringify(note.error)).toBe(true);
  return { id: note.data.item.id, version: note.data.item.version };
}

/** The lookups that fill the shared pool: eight makers, each at its share of four. */
async function fillPool(
  hostOf: (maker: number) => string,
): Promise<{ client: MarfaClient; ids: string[] }[]> {
  const makers: { client: MarfaClient; ids: string[] }[] = [];
  for (let m = 0; m < 8; m++) {
    const client = await makerKey(`busy-${String(m)}`);
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      ids.push(
        await subscribe(client, hostOf(m), `busy-${String(m)}-${String(i)}`),
      );
    }
    makers.push({ client, ids });
  }
  return makers;
}

async function dropAll(
  makers: { client: MarfaClient; ids: string[] }[],
): Promise<void> {
  for (const { client, ids } of makers)
    for (const id of ids) await client.deleteWebhook(id);
}

describe("webhook host-name lookups", () => {
  it("delivers to a maker whose host name resolves while another maker's lookups do not finish", async () => {
    await server.setFault("resolve:stalled.test=stall:8000");
    const stuck = await makerKey("stuck");
    const well = await makerKey("well");
    const made: { client: MarfaClient; id: string }[] = [];
    try {
      for (let i = 0; i < 8; i++) {
        made.push({
          client: stuck,
          id: await subscribe(stuck, "stalled.test", `stuck-${String(i)}`),
        });
      }
      made.push({
        client: well,
        id: await subscribe(well, "localhost", "well"),
      });
      await write("one maker stalls");
      // By now the stalled lookups hold every slot a shared pool would have.
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      await write("one maker still stalls");
      await waitFor(
        "both deliveries to the maker whose host name resolves",
        async () =>
          receiver.received.filter((r) => r.path === "/hook/well").length >= 2
            ? true
            : undefined,
        8_000,
      );
      const rows = await well.listWebhookDeliveries(made[8]!.id);
      expect(rows.data.data.map((row) => row.error)).toEqual([null, null]);
    } finally {
      for (const { client, id } of made) await client.deleteWebhook(id);
      await server.clearFault();
    }
  }, 120_000);

  it("leaves a delivery due, with no attempt spent, when its maker has no lookup slot free", async () => {
    await server.setFault("resolve:stalled.test=stall:8000");
    const stuck = await makerKey("stuck-share");
    const ids: string[] = [];
    try {
      for (let i = 0; i < 8; i++) {
        ids.push(await subscribe(stuck, "stalled.test", `share-${String(i)}`));
      }
      await write("a maker at its share");
      // Observe after the slot wait expires, before the stalled lookups finish.
      await new Promise((resolve) => setTimeout(resolve, 6_000));
      const rows = await Promise.all(
        ids.map(async (id) => {
          const listed = await stuck.listWebhookDeliveries(id);
          expect(listed.ok).toBe(true);
          return listed.data.data[0];
        }),
      );
      const untouched = rows.filter((row) => row?.attempt === 0);
      expect(untouched.length, "deliveries left due").toBeGreaterThanOrEqual(4);
      for (const row of untouched) {
        expect(row?.status).toBe("pending");
        expect(row?.error).toBeNull();
      }
    } finally {
      for (const id of ids) await stuck.deleteWebhook(id);
      await server.clearFault();
    }
  }, 120_000);

  it("counts an attempt for a delivery that has had no lookup slot for 10 seconds, and offers it none meanwhile", async () => {
    await server.setFault("resolve:stalled.test=stall:30000");
    const stuck = await makerKey("stuck-limit");
    const ids: string[] = [];
    const offers = async (): Promise<number | undefined> =>
      (await server.faults()).find((f) => f.name === "resolve:stalled.test")
        ?.fired;
    try {
      for (let i = 0; i < 8; i++) {
        ids.push(await subscribe(stuck, "stalled.test", `limit-${String(i)}`));
      }
      await write("a maker holds its slots");
      // The first offers have waited and the second ones have been deferred.
      await new Promise((resolve) => setTimeout(resolve, 8_500));
      const before = await offers();
      expect(before, "lookups offered").toBeGreaterThanOrEqual(8);
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      expect(await offers(), "no offer while no slot can be free").toBe(before);
      await waitFor(
        "every delivery to count an attempt before the stalled lookups end",
        async () => {
          const rows = await Promise.all(
            ids.map(
              async (id) =>
                (await stuck.listWebhookDeliveries(id)).data.data[0],
            ),
          );
          return rows.every((row) => (row?.attempt ?? 0) >= 1)
            ? rows
            : undefined;
        },
        12_000,
      );
    } finally {
      for (const id of ids) await stuck.deleteWebhook(id);
      await server.clearFault();
    }
  }, 120_000);

  it("accepts a registration within its limit when it waits for a slot and then looks up", async () => {
    await server.restart({
      env: { MARFA_WEBHOOK_ALLOW_PRIVATE_ADDRESSES: "false" },
    });
    await server.setFault("resolve:stalled.test=stall:8000");
    const made: string[] = [];
    const register = async (label: string): Promise<number> => {
      const started = Date.now();
      const created = await owner().createWebhook({
        url: `http://stalled.test/hook/${label}`,
        events: ["item.created"],
      });
      expect(created.status, JSON.stringify(created.error)).toBe(201);
      made.push(created.data.id);
      return Date.now() - started;
    };
    try {
      // Two registrations take both of a maker's registration slots.
      await Promise.all([register("first"), register("second")]);
      await new Promise((resolve) => setTimeout(resolve, 2_500));
      // A slot comes free about 2.5 seconds into this one, and the name stalls again.
      expect(await register("third")).toBeLessThan(4_000);
    } finally {
      for (const id of made) await owner().deleteWebhook(id);
      await server.clearFault();
    }
  }, 120_000);

  it("delivers to a healthy maker without a failed attempt while another maker's lookups end and free their slots", async () => {
    const victim = await makerKey("victim");
    const other = await makerKey("other");
    const made: { client: MarfaClient; id: string }[] = [];
    try {
      for (let i = 0; i < 4; i++) {
        made.push({
          client: victim,
          id: await subscribe(
            victim,
            "victim-stalled.test",
            `held-${String(i)}`,
          ),
        });
      }
      made.push({
        client: other,
        id: await subscribe(other, "other-stalled.test", "other"),
      });
      await server.pauseClock(true);
      await server.setFault("resolve:victim-stalled.test=stall:8000");
      await server.setFault("resolve:other-stalled.test=stall:6000");
      await write("the victim's four slots and the other maker's one fill");
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      const good = await subscribe(victim, "localhost", "good");
      made.push({ client: victim, id: good });
      // The healthy maker's own name takes 2 of its 3 seconds once it has a slot.
      await server.setFault("resolve:localhost=stall:2000");
      await write("the healthy delivery waits for the victim's own slots");
      // The other maker's slot comes back at about 6 seconds, the victim's own four at about 8.
      await waitFor(
        "the healthy delivery to reach its receiver",
        async () =>
          receiver.received.some((r) => r.path === "/hook/good")
            ? true
            : undefined,
        20_000,
      );
      // The receiver answers before the server records the outcome.
      const rows = await waitFor(
        "the delivery's attempt to be recorded",
        async () => {
          const listed = (await victim.listWebhookDeliveries(good)).data.data;
          return listed.every((row) => row.attempt >= 1) ? listed : undefined;
        },
        10_000,
      );
      expect(rows.map((row) => [row.attempt, row.error])).toEqual([[1, null]]);
    } finally {
      for (const { client, id } of made) await client.deleteWebhook(id);
      await server.clearFault();
    }
  }, 120_000);

  it("leaves every delivery of a healthy maker uncharged while other makers hold every slot of the shared pool, more of them than its share", async () => {
    await server.pauseClock(true);
    await server.setFault("resolve:busy.test=stall:30000");
    const busy = await fillPool(() => "busy.test");
    const healthy = await makerKey("healthy");
    const ids: string[] = [];
    try {
      await write("the shared pool fills");
      // The first lookups have ended at their limit and still hold their slots.
      await new Promise((resolve) => setTimeout(resolve, 3_500));
      // One more than the maker's share of four.
      for (let i = 0; i < 5; i++)
        ids.push(await subscribe(healthy, "localhost", `healthy-${String(i)}`));
      const begun = Date.now();
      await write("the healthy maker's deliveries wait for a slot");
      // Past a share's 3 second wait, its 10 second limit and the 3 second wait after it.
      await new Promise((resolve) =>
        setTimeout(resolve, begun + 19_000 - Date.now()),
      );
      const listed = async (): Promise<[string, number, string | null][]> =>
        Promise.all(
          ids.map(async (id) => {
            const row = (await healthy.listWebhookDeliveries(id)).data.data[0];
            return [row?.status ?? "", row?.attempt ?? -1, row?.error ?? null];
          }),
        );
      expect(
        await listed(),
        "no delivery is charged for other makers' lookups",
      ).toEqual(ids.map(() => ["pending", 0, null]));
      // The receiver answers before the server records the outcome.
      const rows = await waitFor(
        "every healthy delivery to be recorded once the pool has slots",
        async () => {
          const now = await listed();
          return now.every(([, attempt]) => attempt >= 1) ? now : undefined;
        },
        30_000,
      );
      expect(rows).toEqual(ids.map(() => ["success", 1, null]));
    } finally {
      for (const id of ids) await healthy.deleteWebhook(id);
      await dropAll(busy);
      await server.clearFault();
    }
  }, 120_000);

  it("serves the makers waiting for the shared pool in turn, oldest first within each maker", async () => {
    await server.pauseClock(true);
    // Each busy maker's four slots come back together, one maker's after another's.
    const busy = await fillPool((m) => `busy-${String(m)}.test`);
    for (let m = 0; m < 8; m++)
      await server.setFault(
        `resolve:busy-${String(m)}.test=stall:${String(9_000 + 3_000 * m)}`,
      );
    const crowd = await makerKey("crowd");
    const single = await makerKey("single");
    const crowdIds: string[] = [];
    let singleId: string | undefined;
    try {
      const note = await write("the shared pool fills");
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      // The subscriptions come before the stall: a stall is chosen when a lookup is offered.
      for (let i = 0; i < 4; i++)
        crowdIds.push(
          await subscribe(crowd, "localhost", `crowd-${String(i)}`),
        );
      singleId = await subscribe(single, "localhost", "single", "item.updated");
      // Each lookup of the waiting deliveries holds its slot for 2 seconds, so a slot passes on only then.
      await server.setFault("resolve:localhost=stall:2000");
      // Four deliveries of one maker wait first, then one delivery of another.
      await write("one maker has four deliveries waiting");
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      const updated = await owner().updateItem(note.id, {
        version: note.version,
        properties: { body: "the other maker's delivery waits behind them" },
      });
      expect(updated.ok, JSON.stringify(updated.error)).toBe(true);
      // The first four slots come back at about 9 seconds, and each passes on at about 11.
      await waitFor(
        "the second maker's delivery to reach its receiver",
        async () =>
          receiver.received.some((r) => r.path === "/hook/single")
            ? true
            : undefined,
        20_000,
      );
      const crowded = new Set(
        receiver.received
          .filter((r) => r.path.startsWith("/hook/crowd-"))
          .map((r) => r.path),
      );
      expect(
        crowded.size,
        "the other maker's turn came before its fourth delivery",
      ).toBeLessThan(4);
    } finally {
      for (const id of crowdIds) await crowd.deleteWebhook(id);
      if (singleId !== undefined) await single.deleteWebhook(singleId);
      await dropAll(busy);
      await server.clearFault();
    }
  }, 120_000);
});
