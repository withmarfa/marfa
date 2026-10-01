import { describe, expect, it, beforeAll, afterAll } from "vitest";
import {
  __resetEventLogForTests,
  initEventLog,
  subscribeAll,
} from "../pubsub.js";
import type { LiveFrame } from "../pubsub.js";
import {
  createTestContext,
  request,
  seedOauthBearer,
  settle,
} from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import type { Connector } from "../storage/interface.js";

let ctx: TestContext;

beforeAll(async () => {
  // Short enough that a test can wait out a hold.
  ctx = await createTestContext({ connectorHoldMs: 300 });
  // The test context installs no event log, and a replay reads one.
  initEventLog(ctx.storage.eventLog);
});

afterAll(async () => {
  __resetEventLogForTests();
  await ctx.cleanup();
});

async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

let minted = 0;

/** A key of its own source, registered: one registration per key. */
async function connector(
  body: Record<string, unknown> = {},
): Promise<{ key: string; keyId: string; connector: Connector }> {
  minted += 1;
  const source = `state-process-${String(minted)}`;
  const res = await request(ctx.app, "POST", "/keys", {
    key: ctx.workingKey,
    body: { label: `${source} key`, source, ...body },
  });
  expect(res.status).toBe(201);
  const { key, id: keyId } = await json<{ key: string; id: string }>(res);
  const registered = await request(ctx.app, "POST", "/connectors", {
    key,
    body: { name: source },
  });
  expect(registered.status).toBe(201);
  return { key, keyId, connector: await json<Connector>(registered) };
}

/** Every state and agreement write needs the writing process to hold. */
async function hold(key: string, id: string, process = "p"): Promise<void> {
  const res = await request(ctx.app, "POST", `/connectors/${id}/hold`, {
    key,
    body: { process },
  });
  expect(res.status).toBe(200);
}

async function note(type = "core.note"): Promise<{
  id: string;
  updated_at: string;
  version: number;
}> {
  const res = await request(ctx.app, "POST", "/items", {
    key: ctx.workingKey,
    body:
      type === "core.note"
        ? { type, properties: { body: "agreed" } }
        : { type, properties: { title: "agreed" } },
  });
  expect(res.status).toBe(201);
  return (
    await json<{ item: { id: string; updated_at: string; version: number } }>(
      res,
    )
  ).item;
}

async function rows(query: string): Promise<unknown[]> {
  return (
    ctx.storage as unknown as {
      __sqliteAll: (query: string) => Promise<unknown[]>;
    }
  ).__sqliteAll(query);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("the hold", () => {
  it("goes to exactly one of two processes that take it at once", async () => {
    const { key, connector: mine } = await connector();
    const [a, b] = await Promise.all(
      ["first", "second"].map((process) =>
        request(ctx.app, "POST", `/connectors/${mine.id}/hold`, {
          key,
          body: { process },
        }),
      ),
    );
    expect([a?.status, b?.status].sort()).toEqual([200, 409]);
  });

  it("lapses at the end of the window, after which another process takes it", async () => {
    const { key, connector: mine } = await connector();
    const hold = (process: string) =>
      request(ctx.app, "POST", `/connectors/${mine.id}/hold`, {
        key,
        body: { process },
      });
    const taken = await hold("first");
    expect(taken.status).toBe(200);
    const { expires_at } = await json<{ expires_at: string }>(taken);
    const refused = await hold("second");
    expect(refused.status).toBe(409);
    expect(await json<{ error: { details: unknown } }>(refused)).toMatchObject({
      error: { code: "connector_held", details: { expires_at } },
    });
    await sleep(Date.parse(expires_at) - Date.now() + 50);
    expect(
      (await ctx.storage.connectors.get(mine.id))?.hold_expires_at,
    ).toBeNull();
    expect((await hold("second")).status).toBe(200);
  });

  it("goes with its registration", async () => {
    const { key, connector: mine } = await connector();
    const taken = await request(
      ctx.app,
      "POST",
      `/connectors/${mine.id}/hold`,
      {
        key,
        body: { process: "p" },
      },
    );
    expect(taken.status).toBe(200);
    const holds = () =>
      rows(
        `SELECT process FROM connector_holds WHERE connector_id = '${mine.id}'`,
      );
    expect(await holds()).toHaveLength(1);
    const removed = await request(ctx.app, "DELETE", `/connectors/${mine.id}`, {
      key,
    });
    expect(removed.status).toBe(200);
    expect(await holds()).toEqual([]);
  });
});

describe("what a connector keeps", () => {
  it("stays with the source when the registration goes, and a purge takes a row's agreements", async () => {
    const { key, connector: mine } = await connector();
    await hold(key, mine.id);
    const row = await note();
    expect(
      (
        await request(ctx.app, "PUT", `/connectors/${mine.id}/state`, {
          key,
          body: { process: "p", state: { cursor: "c" } },
        })
      ).status,
    ).toBe(200);
    const written = await request(
      ctx.app,
      "POST",
      `/connectors/${mine.id}/agreements`,
      {
        key,
        body: {
          process: "p",
          set: [{ item_id: row.id, waiting: true, record: { etag: "e" } }],
        },
      },
    );
    expect(await json(written)).toEqual({
      written: 1,
      cleared: 0,
      skipped: [],
    });

    expect(
      (await request(ctx.app, "DELETE", `/connectors/${mine.id}`, { key }))
        .status,
    ).toBe(200);
    expect(
      await rows(
        `SELECT source FROM connector_states WHERE source = '${mine.source}'`,
      ),
    ).toHaveLength(1);
    const agreements = () =>
      rows(
        `SELECT source FROM connector_agreements WHERE item_id = '${row.id}'`,
      );
    expect(await agreements()).toHaveLength(1);

    expect(
      (
        await request(ctx.app, "DELETE", `/items/${row.id}`, {
          key: ctx.workingKey,
        })
      ).status,
    ).toBe(200);
    expect(await agreements()).toHaveLength(1);
    expect(
      (
        await request(ctx.app, "DELETE", `/items/${row.id}/purge`, {
          key: ctx.workingKey,
        })
      ).status,
    ).toBe(200);
    expect(await agreements()).toEqual([]);
  });

  it("keeps a top-level __proto__ key in the state and in a record as sent", async () => {
    const { key, connector: mine } = await connector();
    await hold(key, mine.id);
    const row = await note();
    const sent = '{"__proto__":{"vendor":"v"},"cursor":"c"}';
    const document = JSON.parse(sent) as Record<string, unknown>;
    expect(Object.keys(document)).toEqual(["__proto__", "cursor"]);
    expect(JSON.stringify({ state: document })).toBe(`{"state":${sent}}`);

    const put = await request(ctx.app, "PUT", `/connectors/${mine.id}/state`, {
      key,
      body: { process: "p", state: document },
    });
    expect(put.status).toBe(200);
    expect(JSON.stringify((await json<{ state: unknown }>(put)).state)).toBe(
      sent,
    );
    const read = await request(ctx.app, "GET", `/connectors/${mine.id}/state`, {
      key,
    });
    expect(JSON.stringify((await json<{ state: unknown }>(read)).state)).toBe(
      sent,
    );

    await hold(key, mine.id);
    expect(
      (
        await request(ctx.app, "POST", `/connectors/${mine.id}/agreements`, {
          key,
          body: {
            process: "p",
            set: [{ item_id: row.id, waiting: false, record: document }],
          },
        })
      ).status,
    ).toBe(200);
    const found = await request(
      ctx.app,
      "POST",
      `/connectors/${mine.id}/agreements/find`,
      { key, body: { item_ids: [row.id] } },
    );
    expect(
      JSON.stringify(
        (await json<{ data: { record: unknown }[] }>(found)).data[0]?.record,
      ),
    ).toBe(sent);
  });

  it("writes an agreement without an event of any kind, a version or a touch to the row", async () => {
    const { key, connector: mine } = await connector();
    await hold(key, mine.id);
    const row = await note();
    const cursor = (await ctx.storage.eventLog.getMaxId()) ?? 0n;
    const logged = async () =>
      (await ctx.storage.eventLog.getAfter(cursor, 1000)).map((e) => [
        e.event_type,
        e.item_id,
      ]);
    const controller = new AbortController();
    const frames: LiveFrame[] = [];
    const done = (async () => {
      for await (const frame of subscribeAll({ signal: controller.signal })) {
        frames.push(frame);
      }
    })();
    await settle();
    const opened = frames.length;
    for (const body of [
      { process: "p", set: [{ item_id: row.id, waiting: true, record: {} }] },
      { process: "p", clear: [row.id] },
    ]) {
      const res = await request(
        ctx.app,
        "POST",
        `/connectors/${mine.id}/agreements`,
        {
          key,
          body,
        },
      );
      expect(res.status).toBe(200);
    }
    await settle();
    const closed = frames.length;
    expect(await logged()).toEqual([]);
    const read = await request(ctx.app, "GET", `/items/${row.id}`, {
      key: ctx.workingKey,
    });
    expect((await json<{ item: typeof row }>(read)).item).toMatchObject({
      updated_at: row.updated_at,
      version: row.version,
    });
    // The witness: the same subscription sees an ordinary write to the row.
    const patched = await request(ctx.app, "PATCH", `/items/${row.id}`, {
      key: ctx.workingKey,
      body: { version: row.version, properties: { body: "changed" } },
    });
    expect(patched.status).toBe(200);
    await settle();
    controller.abort();
    await done;
    expect(frames.slice(opened, closed)).toEqual([]);
    expect(
      frames
        .slice(closed)
        .filter((f) => f.kind === "item" && f.event.item.id === row.id)
        .map((f) => f.event.type),
    ).toEqual(["updated"]);
    expect(await logged()).toEqual([["updated", row.id]]);
  });

  it("takes an agreements batch past the request cap, under the bulk one", async () => {
    const { key, connector: mine } = await connector();
    await hold(key, mine.id);
    const record = { r: "x".repeat(15 * 1024) };
    const body = {
      process: "p",
      set: Array.from({ length: 100 }, (_, i) => ({
        item_id: `missing-${String(i)}`,
        waiting: true,
        record,
      })),
    };
    expect(JSON.stringify(body).length).toBeGreaterThan(
      ctx.config.maxRequestBytes,
    );
    const res = await request(
      ctx.app,
      "POST",
      `/connectors/${mine.id}/agreements`,
      {
        key,
        body,
      },
    );
    expect(res.status).toBe(200);
    expect((await json<{ skipped: string[] }>(res)).skipped).toHaveLength(100);
    // The witness: the state door, on the request cap, refuses the same size.
    const state = await request(
      ctx.app,
      "PUT",
      `/connectors/${mine.id}/state`,
      {
        key,
        body: { process: "p", state: body },
      },
    );
    expect(state.status).toBe(413);
  });

  it("goes with a row a bulk purge or the trash sweep takes", async () => {
    const { key, connector: mine } = await connector();
    await hold(key, mine.id);
    const bulk = await note();
    const swept = await note();
    const agreements = () =>
      rows(
        `SELECT item_id FROM connector_agreements WHERE source = '${mine.source}' ORDER BY item_id`,
      );
    const written = await request(
      ctx.app,
      "POST",
      `/connectors/${mine.id}/agreements`,
      {
        key,
        body: {
          process: "p",
          set: [bulk, swept].map(({ id }) => ({
            item_id: id,
            waiting: true,
            record: {},
          })),
        },
      },
    );
    expect(await json(written)).toMatchObject({ written: 2 });
    for (const { id } of [bulk, swept]) {
      const trashed = await request(ctx.app, "DELETE", `/items/${id}`, {
        key: ctx.workingKey,
      });
      expect(trashed.status).toBe(200);
    }
    expect(await agreements()).toHaveLength(2);

    expect(await ctx.storage.items.bulkPurge([bulk.id])).toEqual([bulk.id]);
    expect(await agreements()).toEqual([{ item_id: swept.id }]);
    await ctx.storage.items.purgeTrashedOlderThan(
      new Date(Date.now() + 86_400_000).toISOString(),
    );
    expect(await agreements()).toEqual([]);
  });

  it("pages past a whole page of rows the key no longer reads", async () => {
    const {
      key,
      keyId,
      connector: mine,
    } = await connector({
      type_permissions: { "core.note": "write", "core.task": "read" },
    });
    await hold(key, mine.id);
    const tasks = [await note("core.task"), await note("core.task")];
    const kept = await note();
    for (const { id } of [...tasks, kept]) {
      const res = await request(
        ctx.app,
        "POST",
        `/connectors/${mine.id}/agreements`,
        {
          key,
          body: {
            process: "p",
            set: [{ item_id: id, waiting: true, record: {} }],
          },
        },
      );
      expect(res.status).toBe(200);
      // Distinct instants, so the first page is the two tasks.
      await sleep(3);
    }
    const narrowed = await request(ctx.app, "PATCH", `/keys/${keyId}`, {
      key: ctx.workingKey,
      body: { type_permissions: { "core.note": "write" } },
    });
    expect(narrowed.status).toBe(200);

    const pages: string[][] = [];
    let cursor: string | null = null;
    do {
      const res = await request(
        ctx.app,
        "GET",
        `/connectors/${mine.id}/agreements?limit=2${cursor === null ? "" : `&cursor=${cursor}`}`,
        { key },
      );
      expect(res.status).toBe(200);
      const page = await json<{
        data: { item_id: string }[];
        next_cursor: string | null;
      }>(res);
      pages.push(page.data.map((row) => row.item_id));
      cursor = page.next_cursor;
    } while (cursor !== null && pages.length < 5);
    expect(pages).toEqual([[], [kept.id]]);
  });
});

describe("who reaches these doors", () => {
  // The release goes last, so the writes before it are the holder's.
  const doors = (id: string) =>
    [
      ["POST", `/connectors/${id}/hold`, { process: "p" }],
      ["GET", `/connectors/${id}/state`, undefined],
      ["PUT", `/connectors/${id}/state`, { process: "p", state: {} }],
      ["DELETE", `/connectors/${id}/state`, undefined],
      ["POST", `/connectors/${id}/agreements`, { process: "p" }],
      ["POST", `/connectors/${id}/agreements/find`, { item_ids: ["x"] }],
      ["GET", `/connectors/${id}/agreements`, undefined],
      ["DELETE", `/connectors/${id}/hold?process=p`, undefined],
    ] as const;

  it("refuses an app's session token on every one, where the same token reads the registration", async () => {
    const { key, connector: mine } = await connector();
    const { token } = await seedOauthBearer(ctx.storage, ["openid"]);
    expect(
      (await request(ctx.app, "GET", `/connectors/${mine.id}`, { key: token }))
        .status,
    ).toBe(200);
    for (const [method, path, body] of doors(mine.id)) {
      const res = await request(ctx.app, method, path, { key: token, body });
      expect(res.status, `${method} ${path}`).toBe(403);
      expect(await json(res)).toMatchObject({ error: { code: "forbidden" } });
    }
    // The witness: the connector's own key is answered on each.
    for (const [method, path, body] of doors(mine.id)) {
      const res = await request(ctx.app, method, path, { key, body });
      expect(res.status, `${method} ${path}`).toBe(200);
    }
  });

  it("answers 404 connector_not_found on every one for an id nothing carries", async () => {
    for (const [method, path, body] of doors(
      "01a0c000-0000-7000-8000-000000000000",
    )) {
      const res = await request(ctx.app, method, path, {
        key: ctx.workingKey,
        body,
      });
      expect(res.status, `${method} ${path}`).toBe(404);
      expect(await json(res)).toMatchObject({
        error: { code: "connector_not_found" },
      });
    }
  });
});
