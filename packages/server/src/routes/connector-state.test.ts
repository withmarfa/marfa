import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { LiveFrame } from "../pubsub.js";
import {
  __resetEventLogForTests,
  initEventLog,
  subscribeAll,
} from "../pubsub.js";
import type { Connector } from "../storage/interface.js";
import { itemWrites } from "../storage/item-writes.js";
import type { TestContext } from "../test-utils.js";
import {
  createTestContext,
  request,
  seedOauthBearer,
  settle,
  sweepTrashBefore,
} from "../test-utils.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
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
  context: TestContext = ctx,
): Promise<{ key: string; keyId: string; connector: Connector }> {
  minted += 1;
  const source = `state-process-${String(minted)}`;
  const res = await request(context.app, "POST", "/keys", {
    key: context.workingKey,
    body: { label: `${source} key`, source, ...body },
  });
  expect(res.status).toBe(201);
  const { key, id: keyId } = await json<{ key: string; id: string }>(res);
  const registered = await request(context.app, "POST", "/connectors", {
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
    const expiry = await createTestContext({ connectorHoldMs: 300 });
    try {
      const { key, connector: mine } = await connector({}, expiry);
      const hold = (process: string) =>
        request(expiry.app, "POST", `/connectors/${mine.id}/hold`, {
          key,
          body: { process },
        });
      const taken = await hold("first");
      expect(taken.status).toBe(200);
      const { expires_at } = await json<{ expires_at: string }>(taken);
      const refused = await hold("second");
      expect(refused.status).toBe(409);
      expect(
        await json<{ error: { details: unknown } }>(refused),
      ).toMatchObject({
        error: { code: "connector_held", details: { expires_at } },
      });
      await sleep(Date.parse(expires_at) - Date.now() + 50);
      expect(
        (await expiry.storage.connectors.get(mine.id))?.hold_expires_at,
      ).toBeNull();
      expect((await hold("second")).status).toBe(200);
    } finally {
      await expiry.cleanup();
    }
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
        await request(ctx.app, "POST", `/items/${row.id}/purge`, {
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
      `/connectors/${mine.id}/agreements/lookup`,
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
      for await (const batch of subscribeAll({ signal: controller.signal })) {
        frames.push(...batch);
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

    await itemWrites(ctx.storage).purge(bulk.id);
    expect(await agreements()).toEqual([{ item_id: swept.id }]);
    await sweepTrashBefore(
      ctx.storage,
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
      ["POST", `/connectors/${id}/agreements/lookup`, { item_ids: ["x"] }],
      ["GET", `/connectors/${id}/agreements`, undefined],
      ["DELETE", `/connectors/${id}/hold?process=p`, undefined],
    ] as const;

  it("refuses an app's session token on every state door and hides the registration", async () => {
    const { key, connector: mine } = await connector();
    const { token } = await seedOauthBearer(ctx, ["openid"]);
    expect(
      (await request(ctx.app, "GET", `/connectors/${mine.id}`, { key: token }))
        .status,
    ).toBe(404);
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

describe("source problems", () => {
  it("publishes problems with state, preserves omission, clears explicitly and survives registration replacement", async () => {
    const { key, connector: mine } = await connector();
    await hold(key, mine.id);
    const problems = JSON.parse(
      '{"__proto__":"Opaque key", "vendor/feed":"Feed unavailable"}',
    ) as Record<string, string>;
    const write = (body: Record<string, unknown>) =>
      request(ctx.app, "PUT", `/connectors/${mine.id}/state`, {
        key,
        body: { process: "p", state: { private: "cursor" }, ...body },
      });
    expect((await write({ problems })).status).toBe(200);
    const get = async () =>
      json<{ problems: Record<string, string> }>(
        await request(ctx.app, "GET", `/connectors/${mine.id}/state`, { key }),
      );
    expect((await get()).problems).toEqual(problems);
    expect(
      (
        await json<Connector>(
          await request(ctx.app, "GET", `/connectors/${mine.id}`, { key }),
        )
      ).problems,
    ).toEqual(problems);
    expect((await write({})).status).toBe(200);
    expect((await get()).problems).toEqual(problems);
    expect((await write({ process: "other", problems: {} })).status).toBe(409);
    expect((await get()).problems).toEqual(problems);
    const repeated = await request(ctx.app, "POST", "/connectors", {
      key,
      body: { name: "Repeated" },
    });
    expect((await json<Connector>(repeated)).problems).toEqual(problems);
    expect(
      (await request(ctx.app, "DELETE", `/connectors/${mine.id}`, { key }))
        .status,
    ).toBe(200);
    const replacement = await json<Connector>(
      await request(ctx.app, "POST", "/connectors", {
        key,
        body: { name: "Replacement" },
      }),
    );
    expect(replacement.problems).toEqual(problems);
    await hold(key, replacement.id);
    expect(
      (
        await request(ctx.app, "PUT", `/connectors/${replacement.id}/state`, {
          key,
          body: { process: "p", state: {}, problems: {} },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await json<Connector>(
          await request(ctx.app, "GET", `/connectors/${replacement.id}`, {
            key,
          }),
        )
      ).problems,
    ).toEqual({});
  });
  it("accepts both maximum documents and rejects message, count and UTF-8 map bounds atomically", async () => {
    const { key, connector: mine } = await connector();
    await hold(key, mine.id);
    const state = { bytes: "x".repeat(512 * 1024 - 12) };
    const legal = { ["k".repeat(512 * 1024 - 7)]: "" };
    const write = (problems: unknown) =>
      request(ctx.app, "PUT", `/connectors/${mine.id}/state`, {
        key,
        body: { process: "p", state, problems },
      });
    expect((await write(legal)).status).toBe(200);
    for (const problems of [
      { bad: "x".repeat(501) },
      Object.fromEntries(
        Array.from({ length: 201 }, (_, i) => [String(i), "bad"]),
      ),
      { ["é".repeat(256 * 1024)]: "bad" },
      { bad: 3 },
    ])
      expect((await write(problems)).status).toBe(400);
    expect(
      (
        await json<{ problems: unknown }>(
          await request(ctx.app, "GET", `/connectors/${mine.id}/state`, {
            key,
          }),
        )
      ).problems,
    ).toEqual(legal);
  });
});

it("refuses a revoked key's in-flight state write after a successor publishes problems", async () => {
  const { key, keyId, connector: mine } = await connector();
  await hold(key, mine.id);
  const original = ctx.storage.connectorState.putState.bind(
    ctx.storage.connectorState,
  );
  let entered!: () => void;
  let release!: () => void;
  const reached = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const spy = vi
    .spyOn(ctx.storage.connectorState, "putState")
    .mockImplementationOnce(async (...args) => {
      entered();
      await blocked;
      return original(...args);
    });
  const stale = request(ctx.app, "PUT", `/connectors/${mine.id}/state`, {
    key,
    body: {
      process: "p",
      state: { cursor: "old" },
      problems: { feed: "Old problem" },
    },
  });
  try {
    await reached;
    expect(
      (
        await request(ctx.app, "DELETE", `/keys/${keyId}`, {
          key: ctx.workingKey,
        })
      ).status,
    ).toBe(200);
    const minted = await request(ctx.app, "POST", "/keys", {
      key: ctx.workingKey,
      body: { label: "successor", source: mine.source },
    });
    expect(minted.status).toBe(201);
    const { key: successorKey } = await json<{ key: string }>(minted);
    const successor = await json<Connector>(
      await request(ctx.app, "POST", "/connectors", {
        key: successorKey,
        body: { name: "successor" },
      }),
    );
    await hold(successorKey, successor.id);
    expect(
      (
        await request(ctx.app, "PUT", `/connectors/${successor.id}/state`, {
          key: successorKey,
          body: {
            process: "p",
            state: { cursor: "new" },
            problems: { feed: "New problem" },
          },
        })
      ).status,
    ).toBe(200);
    release();
    expect((await stale).status).toBe(401);
    expect(
      await json(
        await request(ctx.app, "GET", `/connectors/${successor.id}/state`, {
          key: successorKey,
        }),
      ),
    ).toMatchObject({
      state: { cursor: "new" },
      problems: { feed: "New problem" },
    });
    expect(
      (
        await request(ctx.app, "DELETE", `/connectors/${successor.id}/state`, {
          key: successorKey,
        })
      ).status,
    ).toBe(200);
    expect(
      await json(
        await request(ctx.app, "GET", `/connectors/${successor.id}/state`, {
          key: successorKey,
        }),
      ),
    ).toEqual({ state: {}, problems: {}, updated_at: null });
  } finally {
    release();
    await stale;
    spy.mockRestore();
  }
});
