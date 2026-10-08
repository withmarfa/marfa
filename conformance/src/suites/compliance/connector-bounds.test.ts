import { randomUUID } from "node:crypto";
import { v7 as uuidv7 } from "uuid";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { MarfaItem, TestContext } from "../../client/types.js";
import { createNote, createTask } from "../../generators/items.js";
import { declareOversizeBody } from "../../utils/oversize.js";
import {
  cleanup,
  createTestContext,
  getClientFromEnv,
  getManagementClient,
  trackItem,
  trackKey,
} from "../../utils/setup.js";

/**
 * The sizes the connector doors that carry documents take and refuse: the
 * request cap the state door shares with most doors, the bulk cap the
 * agreements door has, and a page that is short with a cursor to follow.
 */

let ctx: TestContext;
let apiUrl: string;
let client: MarfaClient;

const REQUEST_CAP = 1024 * 1024;
const BULK_CAP = 16 * 1024 * 1024;
const STATE_CAP = 512 * 1024;
const RECORD_CAP = 16 * 1024;

interface Connector {
  client: MarfaClient;
  key: string;
  id: string;
}

const made: Connector[] = [];

beforeAll(async () => {
  ({ ctx, apiUrl, client } = await createTestContext(
    "compliance",
    "connector-bounds",
  ));
});

afterAll(async () => {
  // A source's state outlives its registration, so it goes first.
  for (const mine of made) {
    await getManagementClient().deleteConnectorState(mine.id);
  }
  await cleanup(ctx);
});

async function connector(
  label: string,
  request: Record<string, unknown> = {},
): Promise<Connector> {
  const source = `${ctx.source}-${label}`;
  const minted = await getClientFromEnv().client.createKey({
    label: `${source}-key`,
    source,
    default_tier: "library",
    ...request,
  });
  expect(minted.status).toBe(201);
  trackKey(ctx, minted.data.id);
  const own = new MarfaClient({ baseUrl: apiUrl, apiKey: minted.data.key });
  const registered = await own.registerConnector({
    name: `${ctx.runId} ${label}`,
  });
  expect(registered.status).toBe(201);
  const mine = { client: own, key: minted.data.key, id: registered.data.id };
  made.push(mine);
  return mine;
}

async function holding(mine: Connector): Promise<string> {
  const process = randomUUID();
  expect((await mine.client.holdConnector(mine.id, process)).status).toBe(200);
  return process;
}

async function note(): Promise<MarfaItem> {
  const created = await client.createItem(
    createNote({
      source: ctx.source,
      properties: { title: "kept", body: "kept" },
    }),
  );
  expect(created.ok).toBe(true);
  trackItem(ctx, created.data.item.id);
  return created.data.item;
}

/** A JSON text of exactly `bytes` bytes: `document` and then spaces. */
function paddedTo(document: unknown, bytes: number): string {
  const text = JSON.stringify(document);
  expect(text.length).toBeLessThanOrEqual(bytes);
  return text + " ".repeat(bytes - text.length);
}

async function post(
  mine: Connector,
  method: string,
  path: string,
  text: string,
): Promise<{ status: number; code?: string }> {
  const res = await fetch(`${apiUrl}/connectors/${mine.id}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${mine.key}`,
      "Content-Type": "application/json",
    },
    body: text,
  });
  const body = (await res.json().catch(() => ({}))) as {
    error?: { code?: string };
  };
  return { status: res.status, code: body.error?.code };
}

async function declared(
  mine: Connector,
  method: string,
  path: string,
  bytes: number,
): Promise<{ status: number; code?: string }> {
  const res = await declareOversizeBody(
    `${apiUrl}/connectors/${mine.id}${path}`,
    {
      method,
      headers: {
        Authorization: `Bearer ${mine.key}`,
        "content-type": "application/json",
      },
      bytes,
    },
  );
  return {
    status: res.status,
    code: (JSON.parse(res.body) as { error?: { code?: string } }).error?.code,
  };
}

describe("the request cap on the state door", () => {
  it("takes a state body of exactly the request cap, refuses a state over its own cap inside it, and answers 413 to one byte more", async () => {
    const mine = await connector("state-request-cap");
    const process = await holding(mine);

    // A state far under its own cap, in a body of exactly the request cap.
    const atCap = paddedTo(
      { process, state: { cursor: "at the cap" } },
      REQUEST_CAP,
    );
    expect(atCap).toHaveLength(REQUEST_CAP);
    const taken = await post(mine, "PUT", "/state", atCap);
    expect(taken.status).toBe(200);
    const stored = await mine.client.getConnectorState(mine.id);
    expect(stored.data.state).toEqual({ cursor: "at the cap" });

    // A state over its own cap that fits the request cap is the state's
    // refusal, a 400, and not the cap's.
    const bulky = { process, state: { s: "x".repeat(STATE_CAP + 1) } };
    const overState = paddedTo(bulky, REQUEST_CAP);
    expect(overState).toHaveLength(REQUEST_CAP);
    const refused = await post(mine, "PUT", "/state", overState);
    expect(refused.status).toBe(400);
    expect(refused.code).toBe("validation_error");

    const past = await declared(mine, "PUT", "/state", REQUEST_CAP + 1);
    expect(past.status).toBe(413);
    expect(past.code).toBe("request_too_large");
    expect((await mine.client.getConnectorState(mine.id)).data).toEqual(
      stored.data,
    );
  });
});

describe("the bulk cap on the agreements door", () => {
  it("takes an agreements batch past the request cap, and one of exactly the bulk cap, and answers 413 to one byte more", async () => {
    const mine = await connector("agreements-bulk-cap");
    const process = await holding(mine);
    const rows = [await note(), await note(), await note()];
    const record = { r: "x".repeat(RECORD_CAP - 8) };
    expect(JSON.stringify(record)).toHaveLength(RECORD_CAP);

    // A hundred records of 16 KiB: the body is past the request cap the
    // state door holds, and under the bulk cap this door has.
    const set = [
      ...rows.map((row) => ({ item_id: row.id, waiting: true, record })),
      ...Array.from({ length: 97 }, () => ({
        item_id: uuidv7(),
        waiting: true,
        record,
      })),
    ];
    const batch = JSON.stringify({ process, set });
    expect(batch.length).toBeGreaterThan(REQUEST_CAP);
    expect(batch.length).toBeLessThan(BULK_CAP);
    const written = await post(mine, "POST", "/agreements", batch);
    expect(written.status).toBe(200);
    const read = await mine.client.lookupConnectorAgreements(
      mine.id,
      rows.map((row) => row.id),
    );
    expect(read.data.data.map((row) => row.record)).toEqual([
      record,
      record,
      record,
    ]);

    // The same size at the state door is over its cap: the witness that the
    // two doors answer one body differently.
    const atState = await declared(mine, "PUT", "/state", REQUEST_CAP + 1);
    expect(atState.status).toBe(413);

    const atCap = paddedTo({ process, set: [] }, BULK_CAP);
    expect(atCap).toHaveLength(BULK_CAP);
    const empty = await post(mine, "POST", "/agreements", atCap);
    expect(empty.status).toBe(200);

    const past = await declared(mine, "POST", "/agreements", BULK_CAP + 1);
    expect(past.status).toBe(413);
    expect(past.code).toBe("request_too_large");
  });
});

describe("a page of agreements", () => {
  it("answers a short page with a cursor still to follow, over rows the key no longer reads", async () => {
    const source = `${ctx.source}-short-page`;
    const minted = await client.createKey({
      label: `${source}-key`,
      source,
      default_tier: "library",
      type_permissions: { "core.note": "write", "core.task": "read" },
    });
    expect(minted.status).toBe(201);
    trackKey(ctx, minted.data.id);
    const mine = {
      client: new MarfaClient({ baseUrl: apiUrl, apiKey: minted.data.key }),
      key: minted.data.key,
      id: "",
    };
    const registered = await mine.client.registerConnector({
      name: `${ctx.runId} short-page`,
    });
    expect(registered.status).toBe(201);
    mine.id = registered.data.id;
    made.push(mine);
    const process = await holding(mine);

    const kept = await note();
    const tasks: string[] = [];
    for (let i = 0; i < 5; i++) {
      const task = await client.createItem(createTask({ source: ctx.source }));
      expect(task.ok).toBe(true);
      trackItem(ctx, task.data.item.id);
      tasks.push(task.data.item.id);
    }
    for (const id of [...tasks, kept.id]) {
      const written = await mine.client.writeConnectorAgreements(mine.id, {
        process,
        set: [{ item_id: id, waiting: true, record: {} }],
      });
      expect(written.data.written).toBe(1);
    }
    // The witness: while the key reads both types, a page of two is full.
    const whole = await mine.client.listConnectorAgreements(mine.id, {
      limit: 2,
    });
    expect(whole.data.data).toHaveLength(2);
    expect(whole.data.next_cursor).not.toBeNull();

    expect(
      (
        await client.updateKey(minted.data.id, {
          type_permissions: { "core.note": "write" },
        })
      ).status,
    ).toBe(200);

    // Two rows are scanned and at most one is readable, so the first page is
    // short, and six rows are not two.
    const first = await mine.client.listConnectorAgreements(mine.id, {
      limit: 2,
    });
    expect(first.status).toBe(200);
    expect(first.data.data.length).toBeLessThan(2);
    expect(first.data.next_cursor).not.toBeNull();

    const seen = first.data.data.map((row) => row.item_id);
    let cursor = first.data.next_cursor;
    while (cursor !== null) {
      const page = await mine.client.listConnectorAgreements(mine.id, {
        limit: 2,
        cursor,
      });
      expect(page.status).toBe(200);
      seen.push(...page.data.data.map((row) => row.item_id));
      cursor = page.data.next_cursor;
    }
    expect(seen).toEqual([kept.id]);
  });
});
