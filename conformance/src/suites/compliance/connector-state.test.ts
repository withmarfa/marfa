import { randomUUID } from "node:crypto";
import { v7 as uuidv7 } from "uuid";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { MarfaItem, TestContext } from "../../client/types.js";
import {
  cleanup,
  createSecondClient,
  createTestContext,
  getClientFromEnv,
  getOperatorClient,
  trackItem,
  trackKey,
} from "../../utils/setup.js";
import { expectMatchesSchema } from "../../utils/openapi.js";
import { createNote, createTask } from "../../generators/items.js";
import { collectUntil, withStream } from "../../utils/stream.js";
import { bootFreshServer, type FreshServer } from "../../utils/fresh-server.js";

/**
 * The hold, the state document and the agreements a connector keeps on the
 * instance rather than beside itself: `connectors.md` 12 to 22.
 */

let ctx: TestContext;
let client: MarfaClient;
let apiUrl: string;
let apiKey: string;
let other: MarfaClient;

beforeAll(async () => {
  ({ ctx, client, apiUrl, apiKey } = await createTestContext(
    "compliance",
    "connector-state",
  ));
  other = await createSecondClient(ctx, "stranger");
});

interface Connector {
  client: MarfaClient;
  id: string;
  keyId: string;
  source: string;
}

const made: Connector[] = [];

afterAll(async () => {
  // A source's state outlives its registration, so it goes first.
  for (const mine of made) {
    await getOperatorClient().clearConnectorState(mine.id);
  }
  await cleanup(ctx);
});

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const STATE_CAP = 512 * 1024;
const RECORD_CAP = 16 * 1024;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function register(own: MarfaClient, label: string): Promise<Connector> {
  const registered = await own.registerConnector({
    name: `${ctx.runId} ${label}`,
  });
  expect(registered.status).toBe(201);
  const mine = {
    client: own,
    id: registered.data.id,
    keyId: registered.data.key_id,
    source: registered.data.source,
  };
  made.push(mine);
  return mine;
}

/** A registration of its own: one per key, so one key per connector. */
async function connector(label: string): Promise<Connector> {
  return register(await createSecondClient(ctx, label), label);
}

async function note(body = "agreed"): Promise<MarfaItem> {
  const created = await client.createItem(
    createNote({ source: ctx.source, properties: { title: body, body } }),
  );
  expect(created.ok).toBe(true);
  trackItem(ctx, created.data.item.id);
  return created.data.item;
}

/** A key of its own under `source`, which a revoked key may have held. */
async function mintUnder(source: string, label: string): Promise<MarfaClient> {
  const minted = await getClientFromEnv().client.createKey({
    label: `${source}-${label}`,
    source,
    default_tier: "library",
  });
  expect(minted.status).toBe(201);
  trackKey(ctx, minted.data.id);
  return new MarfaClient({ baseUrl: apiUrl, apiKey: minted.data.key });
}

async function found(mine: Connector, ids: string[]): Promise<string[]> {
  const res = await mine.client.findConnectorAgreements(mine.id, ids);
  expect(res.status).toBe(200);
  return res.data.data.map((row) => row.item_id);
}

/** Every state and agreement write needs the writing process to hold. */
async function holding(
  mine: Connector,
  process: string = randomUUID(),
): Promise<string> {
  const held = await mine.client.holdConnector(mine.id, process);
  expect(held.status).toBe(200);
  return process;
}

describe("the hold", () => {
  it("takes and renews the hold for one process, and shows it on the registration", async () => {
    const mine = await connector("hold-take");
    const process = randomUUID();
    expect(
      (await mine.client.getConnector(mine.id)).data.hold_expires_at,
    ).toBeNull();
    // A heartbeat takes no hold.
    const beat = await mine.client.heartbeatConnector(mine.id);
    expect(beat.status).toBe(200);
    expect(
      (await mine.client.getConnector(mine.id)).data.hold_expires_at,
    ).toBeNull();

    const before = Date.now();
    const taken = await mine.client.holdConnector(mine.id, process);
    expect(taken.status).toBe(200);
    await expectMatchesSchema("POST", "/connectors/{id}/hold", 200, taken.data);
    expect(taken.data.expires_at).toMatch(ISO);
    expect(taken.data.renewed).toBe(false);
    // The server's clock plus the window, three minutes unless named.
    const window = Date.parse(taken.data.expires_at) - before;
    expect(window).toBeGreaterThanOrEqual(179_000);
    expect(window).toBeLessThanOrEqual(185_000);

    const read = await other.getConnector(mine.id);
    expect(read.status).toBe(200);
    await expectMatchesSchema("GET", "/connectors/{id}", 200, read.data);
    expect(read.data.hold_expires_at).toBe(taken.data.expires_at);
    // A hold stamps no heartbeat.
    expect(read.data.last_heartbeat_at).toBe(beat.data.last_heartbeat_at);
    const listed = await other.listConnectors();
    await expectMatchesSchema("GET", "/connectors", 200, listed.data);
    expect(
      listed.data.data.find((row) => row.id === mine.id)?.hold_expires_at,
    ).toBe(taken.data.expires_at);

    await sleep(5);
    const renewed = await mine.client.holdConnector(mine.id, process);
    expect(renewed.status).toBe(200);
    expect(renewed.data.renewed).toBe(true);
    expect(Date.parse(renewed.data.expires_at)).toBeGreaterThan(
      Date.parse(taken.data.expires_at),
    );
    expect((await other.getConnector(mine.id)).data.hold_expires_at).toBe(
      renewed.data.expires_at,
    );
  });

  it("refuses a process outside its bounds", async () => {
    const mine = await connector("hold-bounds");
    for (const process of ["", "p".repeat(101)]) {
      const taken = await mine.client.holdConnector(mine.id, process);
      expect(taken.status, `take ${String(process.length)}`).toBe(400);
      expect(taken.error?.error.code).toBe("validation_error");
      const released = await mine.client.releaseConnectorHold(mine.id, process);
      expect(released.status, `release ${String(process.length)}`).toBe(400);
      expect(released.error?.error.code).toBe("validation_error");
    }
    const bare = await mine.client.rawRequest<unknown>(
      `/connectors/${mine.id}/hold`,
      { method: "POST", body: {} },
    );
    expect(bare.status).toBe(400);
    expect(bare.error?.error.code).toBe("missing_required_field");
    const unnamed = await mine.client.rawRequest<unknown>(
      `/connectors/${mine.id}/hold`,
      { method: "DELETE" },
    );
    expect(unnamed.status).toBe(400);
    expect(unnamed.error?.error.code).toBe("missing_required_field");
    expect(
      (await mine.client.getConnector(mine.id)).data.hold_expires_at,
    ).toBeNull();

    const longest = "p".repeat(100);
    expect((await mine.client.holdConnector(mine.id, longest)).status).toBe(
      200,
    );
    expect(
      (await mine.client.releaseConnectorHold(mine.id, longest)).status,
    ).toBe(200);
  });

  it("refuses a second process while the hold is live", async () => {
    const mine = await connector("hold-held");
    const first = randomUUID();
    const second = randomUUID();
    const taken = await mine.client.holdConnector(mine.id, first);
    expect(taken.status).toBe(200);

    const refused = await mine.client.holdConnector(mine.id, second);
    expect(refused.status).toBe(409);
    expect(refused.error?.error.code).toBe("connector_held");
    expect(refused.error?.error.details?.["expires_at"]).toBe(
      taken.data.expires_at,
    );
    await expectMatchesSchema(
      "POST",
      "/connectors/{id}/hold",
      409,
      refused.error,
    );
    expect((await mine.client.getConnector(mine.id)).data.hold_expires_at).toBe(
      taken.data.expires_at,
    );
  });

  it("releases the hold for its holder alone, and answers the same when there is nothing to release", async () => {
    const mine = await connector("hold-release");
    const first = randomUUID();
    const second = randomUUID();
    const taken = await mine.client.holdConnector(mine.id, first);
    expect(taken.status).toBe(200);

    const notTheirs = await mine.client.releaseConnectorHold(mine.id, second);
    expect(notTheirs.status).toBe(200);
    expect(notTheirs.data).toEqual({ ok: true });
    expect((await mine.client.getConnector(mine.id)).data.hold_expires_at).toBe(
      taken.data.expires_at,
    );

    const released = await mine.client.releaseConnectorHold(mine.id, first);
    expect(released.status).toBe(200);
    await expectMatchesSchema(
      "DELETE",
      "/connectors/{id}/hold",
      200,
      released.data,
    );
    expect(released.data).toEqual({ ok: true });
    expect(
      (await mine.client.getConnector(mine.id)).data.hold_expires_at,
    ).toBeNull();
    expect(
      (await mine.client.releaseConnectorHold(mine.id, first)).status,
    ).toBe(200);
    expect((await mine.client.holdConnector(mine.id, second)).status).toBe(200);
  });

  it("holds for the connector's own key alone", async () => {
    const mine = await connector("hold-own");
    const process = randomUUID();
    for (const c of [other, getOperatorClient()]) {
      const taken = await c.holdConnector(mine.id, process);
      expect(taken.status).toBe(403);
      expect(taken.error?.error.code).toBe("forbidden");
    }
    expect(
      (await mine.client.getConnector(mine.id)).data.hold_expires_at,
    ).toBeNull();
    const held = await mine.client.holdConnector(mine.id, process);
    expect(held.status).toBe(200);
    for (const c of [other, getOperatorClient()]) {
      const released = await c.releaseConnectorHold(mine.id, process);
      expect(released.status).toBe(403);
      expect(released.error?.error.code).toBe("forbidden");
    }
    expect((await mine.client.getConnector(mine.id)).data.hold_expires_at).toBe(
      held.data.expires_at,
    );
  });
});

describe("the hold on an instance that names its window", () => {
  let server: FreshServer | undefined;
  const WINDOW_MS = 2_000;

  beforeAll(async () => {
    server = await bootFreshServer("connector-hold", {
      MARFA_CONNECTOR_HOLD_MS: String(WINDOW_MS),
    });
  }, 300_000);

  afterAll(() => {
    server?.stop();
  });

  async function registered(
    label: string,
  ): Promise<{ own: MarfaClient; id: string; row: string }> {
    if (server === undefined) throw new Error("no server");
    const minter = new MarfaClient({
      baseUrl: server.apiUrl,
      apiKey: server.workingKey,
    });
    const minted = await minter.createKey({
      label,
      source: `connector-hold-${label}`,
      default_tier: "library",
    });
    expect(minted.status).toBe(201);
    const own = new MarfaClient({
      baseUrl: server.apiUrl,
      apiKey: minted.data.key,
    });
    const registration = await own.registerConnector({ name: label });
    expect(registration.status).toBe(201);
    const created = await minter.createItem(createNote());
    expect(created.ok, JSON.stringify(created.error)).toBe(true);
    return { own, id: registration.data.id, row: created.data.item.id };
  }

  const lapse = (hold: { expires_at: string }) =>
    sleep(Date.parse(hold.expires_at) - Date.now() + 250);

  /** Both fenced writes from `process`, answered in turn. */
  async function write(
    { own, id, row }: { own: MarfaClient; id: string; row: string },
    process: string,
    cursor: string,
  ) {
    return [
      await own.replaceConnectorState(id, { process, state: { cursor } }),
      await own.writeConnectorAgreements(id, {
        process,
        set: [{ item_id: row, waiting: true, record: { cursor } }],
      }),
    ] as const;
  }

  /** The state and the one agreement as a process re-reading would. */
  async function kept({
    own,
    id,
    row,
  }: {
    own: MarfaClient;
    id: string;
    row: string;
  }) {
    return {
      state: (await own.getConnectorState(id)).data.state,
      records: (await own.findConnectorAgreements(id, [row])).data.data.map(
        (r) => r.record,
      ),
    };
  }

  it("lets another process take a hold that lapsed, and takes its writes once it holds it", async () => {
    const reg = await registered("lapse");
    const { own, id } = reg;
    const first = randomUUID();
    const second = randomUUID();

    const before = Date.now();
    const taken = await own.holdConnector(id, first);
    expect(taken.status).toBe(200);
    const window = Date.parse(taken.data.expires_at) - before;
    expect(window).toBeGreaterThanOrEqual(WINDOW_MS - 1_000);
    expect(window).toBeLessThanOrEqual(WINDOW_MS + 1_000);
    const live = await own.holdConnector(id, second);
    expect(live.status).toBe(409);
    expect(live.error?.error.code).toBe("connector_held");
    for (const fenced of await write(reg, second, "early")) {
      expect(fenced.status).toBe(409);
      expect(fenced.error?.error.details?.["expires_at"]).toBe(
        taken.data.expires_at,
      );
    }

    await lapse(taken.data);
    expect((await own.getConnector(id)).data.hold_expires_at).toBeNull();
    for (const unheld of await write(reg, second, "unheld")) {
      expect(unheld.status).toBe(409);
      expect(unheld.error?.error.code).toBe("connector_held");
      expect(unheld.error?.error.details?.["expires_at"]).toBeUndefined();
    }
    expect(await kept(reg)).toEqual({ state: {}, records: [] });

    const retaken = await own.holdConnector(id, second);
    expect(retaken.status).toBe(200);
    for (const written of await write(reg, second, "after")) {
      expect(written.status).toBe(200);
    }
    expect(await kept(reg)).toEqual({
      state: { cursor: "after" },
      records: [{ cursor: "after" }],
    });
    const displaced = await own.holdConnector(id, first);
    expect(displaced.status).toBe(409);
    expect(displaced.error?.error.details?.["expires_at"]).toBe(
      retaken.data.expires_at,
    );
  });

  it("refuses a write from a process whose hold lapsed, whether its successor released the hold or let it lapse", async () => {
    const reg = await registered("stale");
    const { own, id } = reg;
    const first = randomUUID();
    const second = randomUUID();

    const taken = await own.holdConnector(id, first);
    expect(taken.status).toBe(200);
    for (const written of await write(reg, first, "first")) {
      expect(written.status).toBe(200);
    }
    await lapse(taken.data);
    const successor = await own.holdConnector(id, second);
    expect(successor.status).toBe(200);
    for (const written of await write(reg, second, "second")) {
      expect(written.status).toBe(200);
    }
    const theirs = {
      state: { cursor: "second" },
      records: [{ cursor: "second" }],
    };
    expect(await kept(reg)).toEqual(theirs);
    // The witness for the `expires_at` absent below.
    for (const stale of await write(reg, first, "stale")) {
      expect(stale.status).toBe(409);
      expect(stale.error?.error.details?.["expires_at"]).toBe(
        successor.data.expires_at,
      );
    }

    expect((await own.releaseConnectorHold(id, second)).status).toBe(200);
    for (const stale of await write(reg, first, "stale")) {
      expect(stale.status).toBe(409);
      expect(stale.error?.error.code).toBe("connector_held");
      expect(stale.error?.error.details?.["expires_at"]).toBeUndefined();
    }
    expect(await kept(reg)).toEqual(theirs);

    const again = await own.holdConnector(id, second);
    expect(again.status).toBe(200);
    await lapse(again.data);
    for (const process of [first, second]) {
      for (const stale of await write(reg, process, "stale")) {
        expect(stale.status).toBe(409);
        expect(stale.error?.error.code).toBe("connector_held");
        expect(stale.error?.error.details?.["expires_at"]).toBeUndefined();
      }
    }
    expect(await kept(reg)).toEqual(theirs);
  });

  it("tells a process whose hold lapsed that it did not renew it", async () => {
    const { own, id } = await registered("renewal");
    const first = randomUUID();
    const second = randomUUID();

    const taken = await own.holdConnector(id, first);
    expect(taken.status).toBe(200);
    expect(taken.data.renewed).toBe(false);
    // The witness: a renewal while the hold is live says so.
    const unbroken = await own.holdConnector(id, first);
    expect(unbroken.status).toBe(200);
    expect(unbroken.data.renewed).toBe(true);

    // Lapsed with nothing between, the same process's take is not a renewal.
    await lapse(unbroken.data);
    const alone = await own.holdConnector(id, first);
    expect(alone.status).toBe(200);
    expect(alone.data.renewed).toBe(false);

    // Lapsed while another process took it, wrote and gave it up.
    await lapse(alone.data);
    const between = await own.holdConnector(id, second);
    expect(between.status).toBe(200);
    expect(between.data.renewed).toBe(false);
    const written = await own.replaceConnectorState(id, {
      process: second,
      state: { cursor: "second" },
    });
    expect(written.status).toBe(200);
    expect((await own.releaseConnectorHold(id, second)).status).toBe(200);
    const back = await own.holdConnector(id, first);
    expect(back.status).toBe(200);
    expect(back.data.renewed).toBe(false);
    // What it re-reads before writing again: the other process's work.
    expect((await own.getConnectorState(id)).data).toEqual(written.data);
  });
});

describe("what a connector keeps on the instance", () => {
  it("reads an empty state, and replaces it whole", async () => {
    const mine = await connector("state-replace");
    const process = await holding(mine);
    const empty = await mine.client.getConnectorState(mine.id);
    expect(empty.status).toBe(200);
    await expectMatchesSchema("GET", "/connectors/{id}/state", 200, empty.data);
    expect(empty.data).toEqual({ state: {}, updated_at: null });

    const first = await mine.client.replaceConnectorState(mine.id, {
      process,
      state: { cursor: "c1", seen: { mail: 3 } },
    });
    expect(first.status).toBe(200);
    await expectMatchesSchema("PUT", "/connectors/{id}/state", 200, first.data);
    expect(first.data.state).toEqual({ cursor: "c1", seen: { mail: 3 } });
    expect(first.data.updated_at).toMatch(ISO);
    expect((await mine.client.getConnectorState(mine.id)).data).toEqual(
      first.data,
    );

    await sleep(5);
    const second = await mine.client.replaceConnectorState(mine.id, {
      process,
      state: { page: 2 },
    });
    expect(second.status).toBe(200);
    expect(Date.parse(second.data.updated_at)).toBeGreaterThan(
      Date.parse(first.data.updated_at),
    );
    expect((await mine.client.getConnectorState(mine.id)).data).toEqual({
      state: { page: 2 },
      updated_at: second.data.updated_at,
    });

    for (const [body, code] of [
      [{ process, state: ["not", "an", "object"] }, "validation_error"],
      [{ process, state: "text" }, "validation_error"],
      [{ process: "", state: {} }, "validation_error"],
      [{ state: {} }, "missing_required_field"],
      [{ process }, "missing_required_field"],
    ] as const) {
      const refused = await mine.client.rawRequest<unknown>(
        `/connectors/${mine.id}/state`,
        { method: "PUT", body },
      );
      expect(refused.status, JSON.stringify(body)).toBe(400);
      expect(refused.error?.error.code, JSON.stringify(body)).toBe(code);
    }
    expect((await mine.client.getConnectorState(mine.id)).data.state).toEqual({
      page: 2,
    });
  });

  it("refuses a state over its cap and takes one at it", async () => {
    const mine = await connector("state-cap");
    const process = await holding(mine);
    const atCap = { s: "x".repeat(STATE_CAP - 8) };
    expect(JSON.stringify(atCap)).toHaveLength(STATE_CAP);
    const over = { s: "x".repeat(STATE_CAP - 7) };

    const refused = await mine.client.replaceConnectorState(mine.id, {
      process,
      state: over,
    });
    expect(refused.status).toBe(400);
    expect(refused.error?.error.code).toBe("validation_error");
    expect((await mine.client.getConnectorState(mine.id)).data).toEqual({
      state: {},
      updated_at: null,
    });

    const taken = await mine.client.replaceConnectorState(mine.id, {
      process,
      state: atCap,
    });
    expect(taken.status).toBe(200);
    expect((await mine.client.getConnectorState(mine.id)).data.state).toEqual(
      atCap,
    );
  });

  it("writes and clears agreements, skipping an id it cannot hold", async () => {
    // A key reading notes and nothing else.
    const source = `${ctx.source}-narrow`;
    const minted = await getClientFromEnv().client.createKey({
      label: `${source}-key`,
      source,
      default_tier: "library",
      type_permissions: { "core.note": "write" },
    });
    expect(minted.status).toBe(201);
    trackKey(ctx, minted.data.id);
    const mine = await register(
      new MarfaClient({ baseUrl: apiUrl, apiKey: minted.data.key }),
      "agreements",
    );
    const process = await holding(mine);

    const kept = await note();
    const waiting = await note();
    const trashed = await note();
    const bystander = await note();
    expect((await client.deleteItem(trashed.id)).status).toBe(200);
    const task = await client.createItem(createTask({ source: ctx.source }));
    expect(task.ok).toBe(true);
    trackItem(ctx, task.data.item.id);
    // The witness that the key's type map does not read the task: the item
    // door answers it as a missing one, and the key's map says why.
    const unreadable = await mine.client.getItem(task.data.item.id);
    expect(unreadable.status).toBe(404);
    expect(unreadable.error?.error.code).toBe("item_not_found");
    expect((await mine.client.getCurrentKey()).data.type_permissions).toEqual({
      "core.note": "write",
    });
    const missing = uuidv7();

    const written = await mine.client.writeConnectorAgreements(mine.id, {
      process,
      set: [
        { item_id: kept.id, waiting: false, record: { etag: "k1" } },
        { item_id: task.data.item.id, waiting: true, record: { etag: "t1" } },
        { item_id: waiting.id, waiting: true, record: { etag: "w1" } },
        { item_id: missing, waiting: true, record: { etag: "m1" } },
        { item_id: trashed.id, waiting: true, record: { etag: "x1" } },
      ],
    });
    expect(written.status).toBe(200);
    await expectMatchesSchema(
      "POST",
      "/connectors/{id}/agreements",
      200,
      written.data,
    );
    expect(written.data).toEqual({
      written: 3,
      cleared: 0,
      skipped: [task.data.item.id, missing],
    });

    const read = await mine.client.findConnectorAgreements(mine.id, [
      trashed.id,
      task.data.item.id,
      missing,
      kept.id,
      waiting.id,
    ]);
    expect(read.status).toBe(200);
    await expectMatchesSchema(
      "POST",
      "/connectors/{id}/agreements/find",
      200,
      read.data,
    );
    // The rows named, and no cursor: nothing is left to page.
    expect(Object.keys(read.data)).toEqual(["data"]);
    expect(
      read.data.data.map(({ item_id, waiting: w, record }) => ({
        item_id,
        waiting: w,
        record,
      })),
    ).toEqual([
      { item_id: trashed.id, waiting: true, record: { etag: "x1" } },
      { item_id: kept.id, waiting: false, record: { etag: "k1" } },
      { item_id: waiting.id, waiting: true, record: { etag: "w1" } },
    ]);
    for (const row of read.data.data) expect(row.updated_at).toMatch(ISO);

    // A record is replaced whole, and a clear of a row with none clears
    // nothing and skips nothing.
    const changed = await mine.client.writeConnectorAgreements(mine.id, {
      process,
      set: [{ item_id: kept.id, waiting: true, record: { etag: "k2" } }],
      clear: [waiting.id, bystander.id, task.data.item.id, missing],
    });
    expect(changed.status).toBe(200);
    expect(changed.data).toEqual({
      written: 1,
      cleared: 1,
      skipped: [task.data.item.id, missing],
    });
    const after = await mine.client.findConnectorAgreements(mine.id, [
      kept.id,
      waiting.id,
    ]);
    expect(after.data.data).toHaveLength(1);
    expect(after.data.data[0]).toMatchObject({
      item_id: kept.id,
      waiting: true,
      record: { etag: "k2" },
    });
  });

  it("refuses a batch over its caps and writes nothing", async () => {
    const mine = await connector("agreement-caps");
    const process = await holding(mine);
    const row = await note();
    const second = await note();
    const atCap = { r: "x".repeat(RECORD_CAP - 8) };
    expect(JSON.stringify(atCap)).toHaveLength(RECORD_CAP);
    const over = { r: "x".repeat(RECORD_CAP - 7) };
    const many = (n: number) => Array.from({ length: n }, () => uuidv7());

    for (const [what, body] of [
      [
        "a record over its cap",
        {
          process,
          set: [
            { item_id: row.id, waiting: true, record: {} },
            { item_id: second.id, waiting: true, record: over },
          ],
        },
      ],
      [
        "a record that is not an object",
        {
          process,
          set: [{ item_id: row.id, waiting: true, record: ["etag"] }],
        },
      ],
      [
        "a waiting that is not a boolean",
        { process, set: [{ item_id: row.id, waiting: "yes", record: {} }] },
      ],
      [
        "501 to set",
        {
          process,
          set: [row.id, ...many(500)].map((item_id) => ({
            item_id,
            waiting: true,
            record: {},
          })),
        },
      ],
      ["501 to clear", { process, set: [], clear: [row.id, ...many(500)] }],
      [
        "an id named twice",
        {
          process,
          set: [
            { item_id: row.id, waiting: true, record: {} },
            { item_id: row.id, waiting: false, record: {} },
          ],
        },
      ],
      [
        "an id both set and cleared",
        {
          process,
          set: [{ item_id: row.id, waiting: true, record: {} }],
          clear: [row.id],
        },
      ],
    ] as const) {
      const refused = await mine.client.rawRequest<unknown>(
        `/connectors/${mine.id}/agreements`,
        { method: "POST", body: body as unknown as Record<string, unknown> },
      );
      expect(refused.status, what).toBe(400);
      expect(refused.error?.error.code, what).toBe("validation_error");
    }
    for (const [what, body] of [
      ["no process", { set: [{ item_id: row.id, waiting: true, record: {} }] }],
      [
        "an entry with no waiting",
        { process, set: [{ item_id: row.id, record: {} }] },
      ],
    ] as const) {
      const refused = await mine.client.rawRequest<unknown>(
        `/connectors/${mine.id}/agreements`,
        { method: "POST", body: body as unknown as Record<string, unknown> },
      );
      expect(refused.status, what).toBe(400);
      expect(refused.error?.error.code, what).toBe("missing_required_field");
    }
    expect(await found(mine, [row.id, second.id])).toEqual([]);

    // A misspelled list would otherwise answer a write of nothing.
    const misspelled = await mine.client.rawRequest<unknown>(
      `/connectors/${mine.id}/agreements`,
      {
        method: "POST",
        body: {
          process,
          sets: [{ item_id: row.id, waiting: true, record: {} }],
        },
      },
    );
    expect(misspelled.status).toBe(400);
    expect(misspelled.error?.error.code).toBe("validation_error");
    expect(misspelled.error?.error.details?.["unknown_body_fields"]).toEqual([
      "sets",
    ]);
    expect(await found(mine, [row.id])).toEqual([]);

    for (const ids of [[], [row.id, ...many(500)]]) {
      const refused = await mine.client.findConnectorAgreements(mine.id, ids);
      expect(refused.status, `find ${String(ids.length)}`).toBe(400);
      expect(refused.error?.error.code).toBe("validation_error");
    }
    const unnamed = await mine.client.rawRequest<unknown>(
      `/connectors/${mine.id}/agreements/find`,
      { method: "POST", body: {} },
    );
    expect(unnamed.status).toBe(400);
    expect(unnamed.error?.error.code).toBe("missing_required_field");

    // At the caps: five hundred each way, and a record at its size.
    const full = await mine.client.writeConnectorAgreements(mine.id, {
      process,
      set: [row.id, ...many(499)].map((item_id) => ({
        item_id,
        waiting: true,
        record: item_id === row.id ? atCap : {},
      })),
    });
    expect(full.status).toBe(200);
    expect(full.data.written).toBe(1);
    expect(full.data.skipped).toHaveLength(499);
    const cleared = await mine.client.writeConnectorAgreements(mine.id, {
      process,
      clear: many(500),
    });
    expect(cleared.status).toBe(200);
    expect(cleared.data).toMatchObject({ written: 0, cleared: 0 });
    const read = await mine.client.findConnectorAgreements(mine.id, [
      row.id,
      ...many(499),
    ]);
    expect(read.status).toBe(200);
    expect(read.data.data.map((r) => r.record)).toEqual([atCap]);
  });

  it("refuses a top-level body field the hold, the state and the find doors do not declare", async () => {
    const mine = await connector("undeclared");
    const process = randomUUID();
    const row = await note("undeclared");
    const refusedFor = async (
      method: "POST" | "PUT",
      door: string,
      body: Record<string, unknown>,
      field: string,
    ) => {
      const refused = await mine.client.rawRequest<unknown>(
        `/connectors/${mine.id}/${door}`,
        { method, body },
      );
      expect(refused.status, door).toBe(400);
      expect(refused.error?.error.code, door).toBe("validation_error");
      expect(
        refused.error?.error.details?.["unknown_body_fields"],
        door,
      ).toEqual([field]);
    };

    await refusedFor(
      "POST",
      "hold",
      { process, window_ms: 3_600_000 },
      "window_ms",
    );
    expect(
      (await mine.client.getConnector(mine.id)).data.hold_expires_at,
    ).toBeNull();
    await holding(mine, process);

    await refusedFor(
      "PUT",
      "state",
      { process, state: { cursor: "merged" }, merge: true },
      "merge",
    );
    expect((await mine.client.getConnectorState(mine.id)).data).toEqual({
      state: {},
      updated_at: null,
    });
    expect(
      (
        await mine.client.replaceConnectorState(mine.id, {
          process,
          state: { cursor: "whole" },
        })
      ).status,
    ).toBe(200);

    expect(
      (
        await mine.client.writeConnectorAgreements(mine.id, {
          process,
          set: [{ item_id: row.id, waiting: true, record: {} }],
        })
      ).data.written,
    ).toBe(1);
    await refusedFor(
      "POST",
      "agreements/find",
      { item_ids: [row.id], waiting: true },
      "waiting",
    );
    expect(await found(mine, [row.id])).toEqual([row.id]);
  });

  it("leaves a row the key no longer reads out of its reads and its clears", async () => {
    const source = `${ctx.source}-narrowed`;
    const minted = await client.createKey({
      label: `${source}-key`,
      source,
      default_tier: "library",
      type_permissions: { "core.note": "write", "core.task": "read" },
    });
    expect(minted.status).toBe(201);
    trackKey(ctx, minted.data.id);
    const mine = await register(
      new MarfaClient({ baseUrl: apiUrl, apiKey: minted.data.key }),
      "narrowed",
    );
    const process = await holding(mine);
    const kept = await note("kept");
    const task = await client.createItem(createTask({ source: ctx.source }));
    expect(task.ok).toBe(true);
    trackItem(ctx, task.data.item.id);
    const taskId = task.data.item.id;
    const written = await mine.client.writeConnectorAgreements(mine.id, {
      process,
      set: [kept.id, taskId].map((item_id) => ({
        item_id,
        waiting: true,
        record: {},
      })),
    });
    expect(written.data).toEqual({ written: 2, cleared: 0, skipped: [] });
    // The witness: both are read while the key reads both types.
    expect(await found(mine, [taskId, kept.id])).toEqual([taskId, kept.id]);

    const narrowed = await client.updateKey(minted.data.id, {
      type_permissions: { "core.note": "write" },
    });
    expect(narrowed.status).toBe(200);
    expect(await found(mine, [taskId, kept.id])).toEqual([kept.id]);
    expect(
      (
        await mine.client.listConnectorAgreements(mine.id, { waiting: true })
      ).data.data.map((r) => r.item_id),
    ).toEqual([kept.id]);
    const clear = await mine.client.writeConnectorAgreements(mine.id, {
      process,
      clear: [taskId],
    });
    expect(clear.data).toEqual({ written: 0, cleared: 0, skipped: [taskId] });

    // Widened again, the record it could not reach is still there.
    expect(
      (
        await client.updateKey(minted.data.id, {
          type_permissions: { "core.note": "write", "core.task": "read" },
        })
      ).status,
    ).toBe(200);
    expect(await found(mine, [taskId])).toEqual([taskId]);
  });

  it("finds agreements by row and lists the waiting ones a page at a time", async () => {
    const mine = await connector("agreement-list");
    const process = await holding(mine);
    const [x1, x2, x3, settled] = [
      await note("x1"),
      await note("x2"),
      await note("x3"),
      await note("settled"),
    ];
    for (const [row, waiting] of [
      [x1, true],
      [x2, true],
      [x3, true],
      [settled, false],
    ] as const) {
      const res = await mine.client.writeConnectorAgreements(mine.id, {
        process,
        set: [{ item_id: row.id, waiting, record: { title: row.id } }],
      });
      expect(res.status).toBe(200);
      await sleep(5);
    }

    const all = await mine.client.listConnectorAgreements(mine.id, {
      waiting: true,
    });
    expect(all.status).toBe(200);
    await expectMatchesSchema(
      "GET",
      "/connectors/{id}/agreements",
      200,
      all.data,
    );
    expect(all.data.data.map((r) => r.item_id)).toEqual([x1.id, x2.id, x3.id]);
    expect(all.data.next_cursor).toBeNull();

    const page = await mine.client.listConnectorAgreements(mine.id, {
      waiting: true,
      limit: 2,
    });
    expect(page.data.data.map((r) => r.item_id)).toEqual([x1.id, x2.id]);
    expect(page.data.next_cursor).not.toBeNull();
    const rest = await mine.client.listConnectorAgreements(mine.id, {
      waiting: true,
      limit: 2,
      cursor: page.data.next_cursor!,
    });
    expect(rest.data.data.map((r) => r.item_id)).toEqual([x3.id]);
    expect(rest.data.next_cursor).toBeNull();

    expect(
      (
        await mine.client.listConnectorAgreements(mine.id, { waiting: false })
      ).data.data.map((r) => r.item_id),
    ).toEqual([settled.id]);
    expect(
      (await mine.client.listConnectorAgreements(mine.id)).data.data.map(
        (r) => r.item_id,
      ),
    ).toEqual([x1.id, x2.id, x3.id, settled.id]);

    // Oldest first by when the record was written: a rewrite moves it last.
    const rewritten = await mine.client.writeConnectorAgreements(mine.id, {
      process,
      set: [{ item_id: x1.id, waiting: true, record: { title: "again" } }],
    });
    expect(rewritten.status).toBe(200);
    expect(
      (
        await mine.client.listConnectorAgreements(mine.id, { waiting: true })
      ).data.data.map((r) => r.item_id),
    ).toEqual([x2.id, x3.id, x1.id]);

    expect(
      await found(mine, [settled.id, x3.id, settled.id, x1.id, x3.id]),
    ).toEqual([settled.id, x3.id, x1.id]);

    const unknown = await mine.client.rawRequest<unknown>(
      `/connectors/${mine.id}/agreements?state=waiting`,
    );
    expect(unknown.status).toBe(400);
    expect(unknown.error?.error.code).toBe("validation_error");
    expect(unknown.error?.error.details?.["unknown_parameters"]).toEqual([
      "state",
    ]);
    for (const query of ["limit=201", "limit=0", "waiting=yes"]) {
      const refused = await mine.client.rawRequest<unknown>(
        `/connectors/${mine.id}/agreements?${query}`,
      );
      expect(refused.status, query).toBe(400);
      expect(refused.error?.error.code, query).toBe("validation_error");
    }
  });

  it("writes an agreement without touching the row or announcing it", async ({
    signal,
  }) => {
    const mine = await connector("agreement-quiet");
    const process = await holding(mine);
    const row = await note("quiet");
    const aboutRow = (data: unknown) =>
      JSON.stringify(data ?? null).includes(row.id);
    // Read to the update itself, so a frame before it cannot end the read.
    const updateSeen = (evts: { data: unknown }[]) =>
      evts.some(
        (e) =>
          aboutRow(e.data) &&
          (e.data as { item?: { version?: number } }).item?.version ===
            row.version + 1,
      );

    const cursor = await withStream(apiUrl, apiKey, {}, async (stream) => {
      await sleep(250);
      for (const input of [
        { set: [{ item_id: row.id, waiting: true, record: { etag: "1" } }] },
        { set: [{ item_id: row.id, waiting: false, record: { etag: "2" } }] },
        { clear: [row.id] },
        { set: [{ item_id: row.id, waiting: true, record: { etag: "3" } }] },
      ]) {
        const res = await mine.client.writeConnectorAgreements(mine.id, {
          process,
          ...input,
        });
        expect(res.status).toBe(200);
      }
      const untouched = await client.getItem(row.id);
      expect(untouched.data.item.updated_at).toBe(row.updated_at);
      expect(untouched.data.item.version).toBe(row.version);

      // The witness: an ordinary update to the same row moves both and is
      // announced.
      const updated = await client.updateItem(row.id, {
        version: row.version,
        properties: { title: "quiet", body: "changed" },
      });
      expect(updated.ok).toBe(true);
      expect(updated.data.item.version).toBe(row.version + 1);
      expect(Date.parse(updated.data.item.updated_at ?? "")).toBeGreaterThan(
        Date.parse(row.updated_at ?? ""),
      );
      const { events } = await collectUntil(
        stream,
        updateSeen,
        "the update to the row",
        signal,
      );
      expect(
        events.filter((e) => aboutRow(e.data)).map((e) => e.event),
      ).toEqual(["item.updated"]);
      const announced = events.find((e) => e.event === "stream_cursor");
      return (announced?.data as { cursor?: unknown } | undefined)?.cursor;
    });

    // The live stream announced this cursor before the writes.
    expect(typeof cursor).toBe("string");
    await withStream(
      apiUrl,
      apiKey,
      { lastEventId: String(cursor) },
      async (replay) => {
        const { events } = await collectUntil(
          replay,
          updateSeen,
          "the update to the row on the replay",
          signal,
        );
        expect(
          events.filter((e) => aboutRow(e.data)).map((e) => e.event),
        ).toEqual(["item.updated"]);
      },
    );
  });

  it("goes with a purged row", async () => {
    const mine = await connector("agreement-purge");
    const process = await holding(mine);
    const row = await note("purged");
    const kept = await note("kept");
    const written = await mine.client.writeConnectorAgreements(mine.id, {
      process,
      set: [row, kept].map(({ id }) => ({
        item_id: id,
        waiting: true,
        record: { etag: "p" },
      })),
    });
    expect(written.data.written).toBe(2);
    expect((await client.deleteItem(row.id)).status).toBe(200);
    // The witness: a trashed row keeps its agreement.
    expect(await found(mine, [row.id])).toEqual([row.id]);
    expect((await client.purgeItem(row.id)).status).toBe(200);
    expect(await found(mine, [row.id, kept.id])).toEqual([kept.id]);
    expect(
      (await mine.client.listConnectorAgreements(mine.id)).data.data.map(
        (r) => r.item_id,
      ),
    ).toEqual([kept.id]);

    // Reads join the rows, so only the clear's count shows the store itself.
    expect((await mine.client.clearConnectorState(mine.id)).status).toBe(200);
    const audited = await client.listAudit({
      resource_id: mine.id,
      action: "connector_state.clear",
    });
    expect(audited.data.data.map((r) => r.details)).toEqual([
      { source: mine.source, state: false, agreements: 1 },
    ]);
  });

  it("fences the state and the agreements to the process that holds the registration", async () => {
    const mine = await connector("fence");
    const holder = randomUUID();
    const intruder = randomUUID();
    const row = await note("fenced");
    const unheld = async () => {
      for (const res of [
        await mine.client.replaceConnectorState(mine.id, {
          process: intruder,
          state: { cursor: "unheld" },
        }),
        await mine.client.writeConnectorAgreements(mine.id, {
          process: intruder,
          set: [{ item_id: row.id, waiting: true, record: { etag: "u" } }],
        }),
      ]) {
        expect(res.status).toBe(409);
        expect(res.error?.error.code).toBe("connector_held");
        expect(res.error?.error.details?.["expires_at"]).toBeUndefined();
      }
    };

    await unheld();
    expect((await mine.client.getConnectorState(mine.id)).data).toEqual({
      state: {},
      updated_at: null,
    });
    expect(await found(mine, [row.id])).toEqual([]);

    const held = await mine.client.holdConnector(mine.id, holder);
    expect(held.status).toBe(200);

    const state = await mine.client.replaceConnectorState(mine.id, {
      process: intruder,
      state: { cursor: "intruder" },
    });
    expect(state.status).toBe(409);
    expect(state.error?.error.code).toBe("connector_held");
    expect(state.error?.error.details?.["expires_at"]).toBe(
      held.data.expires_at,
    );
    await expectMatchesSchema(
      "PUT",
      "/connectors/{id}/state",
      409,
      state.error,
    );
    const agreements = await mine.client.writeConnectorAgreements(mine.id, {
      process: intruder,
      set: [{ item_id: row.id, waiting: true, record: { etag: "i" } }],
    });
    expect(agreements.status).toBe(409);
    expect(agreements.error?.error.code).toBe("connector_held");
    expect(agreements.error?.error.details?.["expires_at"]).toBe(
      held.data.expires_at,
    );
    await expectMatchesSchema(
      "POST",
      "/connectors/{id}/agreements",
      409,
      agreements.error,
    );
    expect((await mine.client.getConnectorState(mine.id)).data).toEqual({
      state: {},
      updated_at: null,
    });
    expect(await found(mine, [row.id])).toEqual([]);

    const written = await mine.client.replaceConnectorState(mine.id, {
      process: holder,
      state: { cursor: "holder" },
    });
    expect(written.status).toBe(200);
    expect(
      (
        await mine.client.writeConnectorAgreements(mine.id, {
          process: holder,
          set: [{ item_id: row.id, waiting: true, record: { etag: "h" } }],
        })
      ).data.written,
    ).toBe(1);

    expect(
      (await mine.client.releaseConnectorHold(mine.id, holder)).status,
    ).toBe(200);
    await unheld();
    expect((await mine.client.getConnectorState(mine.id)).data).toEqual(
      written.data,
    );
    expect(
      (await mine.client.findConnectorAgreements(mine.id, [row.id])).data.data,
    ).toMatchObject([{ record: { etag: "h" } }]);
  });

  it("keeps state and agreements to the connector's own key", async () => {
    const mine = await connector("own-only");
    const process = await holding(mine);
    const row = await note("own");
    expect(
      (
        await mine.client.replaceConnectorState(mine.id, {
          process,
          state: { cursor: "mine" },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await mine.client.writeConnectorAgreements(mine.id, {
          process,
          set: [{ item_id: row.id, waiting: true, record: { etag: "m" } }],
        })
      ).status,
    ).toBe(200);

    for (const c of [other, getOperatorClient()]) {
      for (const [door, res] of [
        ["GET state", await c.getConnectorState(mine.id)],
        [
          "PUT state",
          await c.replaceConnectorState(mine.id, {
            process,
            state: { cursor: "theirs" },
          }),
        ],
        [
          "POST agreements",
          await c.writeConnectorAgreements(mine.id, {
            process,
            clear: [row.id],
          }),
        ],
        [
          "POST agreements/find",
          await c.findConnectorAgreements(mine.id, [row.id]),
        ],
        ["GET agreements", await c.listConnectorAgreements(mine.id)],
      ] as const) {
        expect(res.status, door).toBe(403);
        expect(res.error?.error.code, door).toBe("forbidden");
      }
    }
    expect((await mine.client.getConnectorState(mine.id)).data.state).toEqual({
      cursor: "mine",
    });
    expect(await found(mine, [row.id])).toEqual([row.id]);
  });

  it("clears the state and the agreements for the own key or the operator, and audits it", async () => {
    const mine = await connector("clear");
    const process = await holding(mine);
    const rows = [await note("c1"), await note("c2")];
    const seed = async () => {
      expect(
        (
          await mine.client.replaceConnectorState(mine.id, {
            process,
            state: { cursor: "seeded" },
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await mine.client.writeConnectorAgreements(mine.id, {
            process,
            set: rows.map((row) => ({
              item_id: row.id,
              waiting: true,
              record: {},
            })),
          })
        ).data.written,
      ).toBe(2);
    };
    await seed();

    const refused = await other.clearConnectorState(mine.id);
    expect(refused.status).toBe(403);
    expect(refused.error?.error.code).toBe("forbidden");
    expect((await mine.client.getConnectorState(mine.id)).data.state).toEqual({
      cursor: "seeded",
    });
    expect(
      await found(
        mine,
        rows.map((row) => row.id),
      ),
    ).toHaveLength(2);

    const own = await mine.client.clearConnectorState(mine.id);
    expect(own.status).toBe(200);
    await expectMatchesSchema(
      "DELETE",
      "/connectors/{id}/state",
      200,
      own.data,
    );
    expect(own.data).toEqual({ ok: true });
    expect((await mine.client.getConnectorState(mine.id)).data).toEqual({
      state: {},
      updated_at: null,
    });
    expect(
      await found(
        mine,
        rows.map((row) => row.id),
      ),
    ).toEqual([]);

    await seed();
    const current = await getOperatorClient().rawRequest<{ id: string }>(
      "/keys/current",
    );
    expect(current.status).toBe(200);
    const operator = await getOperatorClient().clearConnectorState(mine.id);
    expect(operator.status).toBe(200);
    expect((await mine.client.getConnectorState(mine.id)).data).toEqual({
      state: {},
      updated_at: null,
    });
    expect(
      await found(
        mine,
        rows.map((row) => row.id),
      ),
    ).toEqual([]);

    const audited = await client.listAudit({
      resource_id: mine.id,
      action: "connector_state.clear",
    });
    expect(audited.status).toBe(200);
    expect(audited.data.data.map((row) => row.details)).toEqual([
      { source: mine.source, state: true, agreements: 2 },
      { source: mine.source, state: true, agreements: 2 },
    ]);
    expect(audited.data.data.map((row) => row.key_id)).toEqual([
      current.data.id,
      mine.keyId,
    ]);
  });

  it("keeps each source's state and agreements apart", async () => {
    const a = await connector("apart-a");
    const b = await connector("apart-b");
    expect(a.source).not.toBe(b.source);
    const process = await holding(a);
    await holding(b, process);
    const row = await note("shared");
    for (const mine of [a, b]) {
      const written = await mine.client.writeConnectorAgreements(mine.id, {
        process,
        set: [{ item_id: row.id, waiting: true, record: { etag: mine.id } }],
      });
      expect(written.data).toEqual({ written: 1, cleared: 0, skipped: [] });
    }
    for (const mine of [a, b]) {
      const own = [
        { item_id: row.id, waiting: true, record: { etag: mine.id } },
      ];
      const read = await mine.client.findConnectorAgreements(mine.id, [row.id]);
      expect(read.data.data.map(({ updated_at: _, ...rest }) => rest)).toEqual(
        own,
      );
      const waiting = await mine.client.listConnectorAgreements(mine.id, {
        waiting: true,
      });
      expect(
        waiting.data.data.map(({ updated_at: _, ...rest }) => rest),
      ).toEqual(own);
    }

    const cleared = await a.client.writeConnectorAgreements(a.id, {
      process,
      clear: [row.id],
    });
    expect(cleared.data).toEqual({ written: 0, cleared: 1, skipped: [] });
    expect(await found(a, [row.id])).toEqual([]);
    expect(
      (await b.client.findConnectorAgreements(b.id, [row.id])).data.data.map(
        (r) => r.record,
      ),
    ).toEqual([{ etag: b.id }]);
    expect(
      (
        await a.client.writeConnectorAgreements(a.id, {
          process,
          set: [{ item_id: row.id, waiting: true, record: { etag: a.id } }],
        })
      ).data.written,
    ).toBe(1);

    const aState = await a.client.replaceConnectorState(a.id, {
      process,
      state: { cursor: "a" },
    });
    expect(aState.status).toBe(200);
    expect((await b.client.getConnectorState(b.id)).data).toEqual({
      state: {},
      updated_at: null,
    });
    const bState = await b.client.replaceConnectorState(b.id, {
      process,
      state: { cursor: "b" },
    });
    expect(bState.status).toBe(200);
    expect((await a.client.getConnectorState(a.id)).data).toEqual(aState.data);

    expect((await a.client.clearConnectorState(a.id)).status).toBe(200);
    // The witness: A's own went.
    expect((await a.client.getConnectorState(a.id)).data).toEqual({
      state: {},
      updated_at: null,
    });
    expect(await found(a, [row.id])).toEqual([]);
    expect((await b.client.getConnectorState(b.id)).data).toEqual(bState.data);
    expect(await found(b, [row.id])).toEqual([row.id]);
  });

  it("hands the state and the agreements to the next key with the same source", async () => {
    const source = `${ctx.source}-successor`;
    const operator = getOperatorClient();
    const process = randomUUID();
    const row = await note("handed on");

    const first = await register(
      await mintUnder(source, "first"),
      "predecessor",
    );
    await holding(first, process);
    const state = await first.client.replaceConnectorState(first.id, {
      process,
      state: { cursor: "handed on" },
    });
    expect(state.status).toBe(200);
    expect(
      (
        await first.client.writeConnectorAgreements(first.id, {
          process,
          set: [{ item_id: row.id, waiting: true, record: { etag: "e1" } }],
        })
      ).data.written,
    ).toBe(1);
    expect((await operator.revokeKey(first.keyId)).status).toBe(200);

    // Revoked, not removed: the first registration stands beside the next.
    const next = await register(await mintUnder(source, "second"), "successor");
    expect(next.id).not.toBe(first.id);
    expect(next.keyId).not.toBe(first.keyId);
    expect(next.source).toBe(source);
    expect((await operator.getConnector(first.id)).status).toBe(200);
    expect((await next.client.getConnectorState(next.id)).data).toEqual(
      state.data,
    );
    const handed = await next.client.findConnectorAgreements(next.id, [row.id]);
    expect(handed.data.data).toHaveLength(1);
    expect(handed.data.data[0]).toMatchObject({
      item_id: row.id,
      waiting: true,
      record: { etag: "e1" },
    });
    expect(
      (
        await next.client.listConnectorAgreements(next.id, { waiting: true })
      ).data.data.map((r) => r.item_id),
    ).toEqual([row.id]);

    // The operator's clear through the first registration takes the
    // successor's live state too, and no hold fences it.
    const held = await next.client.holdConnector(next.id, process);
    expect(held.status).toBe(200);
    const live = await next.client.replaceConnectorState(next.id, {
      process,
      state: { cursor: "live" },
    });
    expect(live.status).toBe(200);
    expect((await operator.clearConnectorState(first.id)).status).toBe(200);
    expect((await next.client.getConnectorState(next.id)).data).toEqual({
      state: {},
      updated_at: null,
    });
    expect(await found(next, [row.id])).toEqual([]);
    const audited = await client.listAudit({
      resource_id: first.id,
      action: "connector_state.clear",
    });
    expect(audited.status).toBe(200);
    expect(audited.data.data.map((r) => r.details)).toEqual([
      { source, state: true, agreements: 1 },
    ]);
    expect(
      (
        await client.listAudit({
          resource_id: next.id,
          action: "connector_state.clear",
        })
      ).data.data,
    ).toEqual([]);
  });

  it("clears what a removed registration left, through a later registration of its source", async () => {
    const source = `${ctx.source}-orphaned`;
    const operator = getOperatorClient();
    const process = randomUUID();
    const row = await note("left behind");

    const gone = await register(await mintUnder(source, "gone"), "removed");
    await holding(gone, process);
    expect(
      (
        await gone.client.replaceConnectorState(gone.id, {
          process,
          state: { cursor: "left behind" },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await gone.client.writeConnectorAgreements(gone.id, {
          process,
          set: [{ item_id: row.id, waiting: true, record: {} }],
        })
      ).data.written,
    ).toBe(1);
    expect((await operator.revokeKey(gone.keyId)).status).toBe(200);
    expect((await operator.deleteConnector(gone.id)).status).toBe(200);

    const later = await register(await mintUnder(source, "later"), "clearer");
    // The witness: what the removed registration kept is still there.
    expect((await later.client.getConnectorState(later.id)).data.state).toEqual(
      { cursor: "left behind" },
    );
    expect(await found(later, [row.id])).toEqual([row.id]);
    expect((await operator.clearConnectorState(later.id)).status).toBe(200);
    expect((await later.client.getConnectorState(later.id)).data).toEqual({
      state: {},
      updated_at: null,
    });
    expect(await found(later, [row.id])).toEqual([]);
  });
});
