import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { MarfaItem, TestContext } from "../../client/types.js";
import {
  createTestContext,
  createSecondClient,
  cleanup,
  getOwnerClient,
  removeTrackedRegistrations,
  trackItem,
  trackKey,
  trackWebhook,
} from "../../utils/setup.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { HOUR_MS, movedClock, writerOf } from "../../utils/moved-clock.js";
import { expectMatchesSchema } from "../../utils/openapi.js";
import { openEventStream } from "../../utils/sse.js";
import { collectUntil } from "../../utils/stream.js";
import { TEST_OWNER } from "../../utils/target.js";
import { startReceiver, type Receiver } from "../../utils/webhook-receiver.js";

let client: MarfaClient;
let ctx: TestContext;
let apiUrl: string;
let apiKey: string;
let receiver: Receiver;

beforeAll(async () => {
  ({ ctx, client, apiUrl, apiKey } = await createTestContext(
    "compliance",
    "connector-read-only",
  ));
  receiver = await startReceiver();
});

beforeEach(async () => {
  await removeTrackedRegistrations(ctx);
});

afterAll(async () => {
  await cleanup(ctx);
  await receiver.close();
});

/** `GET /events` as a working copy opens it (`reach/copy-bootstrap`). */
const COPY_QUERY: Array<[string, string]> = [
  ["edges", "all"],
  ["copy", "1"],
];

function declare(by: MarfaClient, readOnlyTypes?: string[]) {
  return by.registerConnector({
    name: `${ctx.runId} read only`,
    ...(readOnlyTypes && { read_only_types: readOnlyTypes }),
  });
}

async function write(
  by: MarfaClient,
  type: "core.note" | "core.task",
  tag: string,
): Promise<MarfaItem> {
  const result = await by.createItem({
    type,
    properties:
      type === "core.task"
        ? { title: `${ctx.runId} ${tag}` }
        : { body: `${ctx.runId} ${tag}` },
    tags: [tag],
  });
  expect(result.ok, JSON.stringify(result.error)).toBe(true);
  trackItem(ctx, result.data.item.id);
  return result.data.item;
}

/** A key of its own source, minted by the owner, and a client holding it. */
async function connectorKey(
  label: string,
): Promise<{ id: string; client: MarfaClient }> {
  const minted = await getOwnerClient().createKey({
    label: `${ctx.source}-${label}`,
    source: `${ctx.source}-${label}`,
    default_tier: "library",
  });
  expect(minted.ok, JSON.stringify(minted.error)).toBe(true);
  trackKey(ctx, minted.data.id);
  return {
    id: minted.data.id,
    client: new MarfaClient({ baseUrl: apiUrl, apiKey: minted.data.key }),
  };
}

async function readOnlyOf(id: string): Promise<boolean | undefined> {
  const read = await client.getItem(id);
  expect(read.status).toBe(200);
  return read.data.item.read_only;
}

describe("declaring read_only_types", () => {
  it("stores the declared types, replaces them on a repeat and clears them when left out", async () => {
    const created = await declare(client, [
      "core.note",
      "acme.never.written",
      "core.note",
    ]);
    expect(created.status).toBe(201);
    await expectMatchesSchema("POST", "/connectors", 201, created.data);
    expect(created.data.read_only_types).toEqual([
      "core.note",
      "acme.never.written",
    ]);

    const replaced = await declare(client, ["core.task"]);
    expect(replaced.status).toBe(200);
    expect(replaced.data.read_only_types).toEqual(["core.task"]);

    const cleared = await declare(client);
    expect(cleared.status).toBe(200);
    expect(cleared.data.read_only_types).toEqual([]);
    const read = await client.getConnector(created.data.id);
    expect(read.data.read_only_types).toEqual([]);
  });

  it("refuses a malformed type identifier and registers nothing", async () => {
    const refused = await client.rawRequest<unknown>("/connectors", {
      method: "POST",
      body: { name: `${ctx.runId} malformed`, read_only_types: ["Not a type"] },
    });
    expect(refused.status).toBe(400);
    expect(refused.error?.error.code).toBe("validation_error");
    expect((await client.listConnectors()).data.data).toEqual([]);
  });
});

describe("the number of read_only_types", () => {
  it("refuses more than 1,000 read_only_types and registers nothing", async () => {
    const types = (n: number): string[] =>
      Array.from({ length: n }, (_, i) => `acme.many.n${String(i)}`);
    const refused = await client.rawRequest<unknown>("/connectors", {
      method: "POST",
      body: { name: `${ctx.runId} too many`, read_only_types: types(1001) },
    });
    expect(
      refused.status,
      "a registration declaring 1,001 types was taken, so the list grows without bound",
    ).toBe(400);
    expect(refused.error?.error.code).toBe("validation_error");
    expect((await client.listConnectors()).data.data).toEqual([]);

    // The witness: exactly the cap is taken, so the refusal is the count.
    const atCap = await declare(client, types(1000));
    expect(atCap.status).toBe(201);
    expect(atCap.data.read_only_types).toHaveLength(1000);
  });
});

describe("read_only on items", () => {
  it("reads an item read only while its connector declares the type, and editable once the declaration is gone", async () => {
    const tag = `read-only-${ctx.runId}`;
    const note = await write(client, "core.note", tag);
    const task = await write(client, "core.task", tag);
    const elsewhere = await write(
      await createSecondClient(ctx, "unregistered"),
      "core.note",
      tag,
    );
    expect(note.read_only).toBe(false);
    expect((await declare(client, ["core.note"])).status).toBe(201);

    // One page across two sources and two types.
    const shown = async (): Promise<Record<string, boolean>> => {
      const page = await client.listItems({ tags: [tag], limit: 10 });
      expect(page.status).toBe(200);
      await expectMatchesSchema("GET", "/items", 200, page.data);
      return Object.fromEntries(
        page.data.data.map((item) => [item.id, item.read_only]),
      );
    };
    expect(await shown()).toEqual({
      [note.id]: true,
      [task.id]: false,
      [elsewhere.id]: false,
    });
    const one = await client.getItem(note.id);
    await expectMatchesSchema("GET", "/items/{id}", 200, one.data);
    expect(one.data.item.read_only).toBe(true);
    const found = await client.search(`${ctx.runId} ${tag}`, {
      type: "core.note",
      source: ctx.source,
    });
    expect(found.status).toBe(200);
    expect(found.data.data.map((r) => [r.item.id, r.item.read_only])).toEqual([
      [note.id, true],
    ]);

    // The change frame is worked out as it is sent, on the event stream,
    // the copy stream and an outbound webhook delivery.
    const hook = await client.createWebhook({
      url: receiver.hookUrl(`read-only-${ctx.runId}`),
      events: ["item.updated"],
      type_filter: "core.note",
    });
    expect(hook.status).toBe(201);
    trackWebhook(ctx, hook.data.id, client);
    const delivered = async (body: string): Promise<unknown> => {
      const received = await receiver.waitFor((r) => {
        if (!r.path.endsWith(`read-only-${ctx.runId}`)) return false;
        const sent = JSON.parse(r.body) as {
          item?: { id?: string; properties?: { body?: string } };
        };
        return sent.item?.id === note.id && sent.item.properties?.body === body;
      });
      return JSON.parse(received.body);
    };
    let version = note.version;
    const updatedFrame = async (
      body: string,
      query?: Array<[string, string]>,
    ): Promise<unknown> => {
      const stream = await openEventStream(
        apiUrl,
        apiKey,
        query ? { query } : {},
      );
      try {
        const edited = await client.updateItem(note.id, {
          properties: { body },
          version,
        });
        expect(edited.status).toBe(200);
        version = edited.data.item.version;
        expect(edited.data.item.read_only).toBe(body.startsWith("held"));
        const { events } = await collectUntil(
          stream,
          (seen) =>
            seen.some(
              (e) =>
                e.event === "item.updated" &&
                (e.data as { item: MarfaItem }).item.id === note.id,
            ),
          "the note's item.updated frame",
        );
        return events.find(
          (e) =>
            e.event === "item.updated" &&
            (e.data as { item: MarfaItem }).item.id === note.id,
        )?.data;
      } finally {
        await stream.close();
      }
    };
    expect(await updatedFrame("held")).toMatchObject({
      item: { read_only: true },
    });
    expect(await updatedFrame("held on copy", COPY_QUERY)).toMatchObject({
      item: { read_only: true },
    });
    expect(await delivered("held")).toMatchObject({
      item: { read_only: true },
    });

    expect((await declare(client)).status).toBe(200);
    expect(await shown()).toEqual({
      [note.id]: false,
      [task.id]: false,
      [elsewhere.id]: false,
    });
    expect((await client.getItem(note.id)).data.item.read_only).toBe(false);
    expect(await updatedFrame("released")).toMatchObject({
      item: { read_only: false },
    });
    expect(await updatedFrame("released on copy", COPY_QUERY)).toMatchObject({
      item: { read_only: false },
    });
    expect(await delivered("released")).toMatchObject({
      item: { read_only: false },
    });
  });

  it("keeps an item editable while another connector that claims its source does not declare its type", async () => {
    const tag = `read-only-claimed-${ctx.runId}`;
    const note = await write(client, "core.note", tag);
    const minted = await getOwnerClient().createKey({
      label: `${ctx.source}-claimant`,
      source: `${ctx.source}-claimant`,
      sources: [ctx.source],
      // A key that may not write a type holds none of it read only.
      type_permissions: { "core.note": "write", "core.task": "write" },
      default_tier: "library",
    });
    expect(minted.ok, JSON.stringify(minted.error)).toBe(true);
    trackKey(ctx, minted.data.id);
    const claimant = new MarfaClient({
      baseUrl: apiUrl,
      apiKey: minted.data.key,
    });
    const readOnly = async () =>
      (await client.getItem(note.id)).data.item.read_only;

    expect((await declare(client, ["core.note"])).status).toBe(201);
    expect((await declare(claimant, ["core.task"])).status).toBe(201);
    expect(await readOnly()).toBe(false);
    expect((await declare(claimant, ["core.note"])).status).toBe(200);
    expect(await readOnly()).toBe(true);
  });

  it("reads an item editable once the key of the connector that held it is revoked", async () => {
    const connector = await connectorKey("revoked");
    const note = await write(
      connector.client,
      "core.note",
      `read-only-revoked-${ctx.runId}`,
    );
    expect((await declare(connector.client, ["core.note"])).status).toBe(201);
    expect(await readOnlyOf(note.id)).toBe(true);

    expect((await getOwnerClient().revokeKey(connector.id)).ok).toBe(true);
    expect(await readOnlyOf(note.id)).toBe(false);
  });

  it("reads an item editable once the key of the connector that held it may no longer write its type", async () => {
    const connector = await connectorKey("narrowed");
    const note = await write(
      connector.client,
      "core.note",
      `read-only-narrowed-${ctx.runId}`,
    );
    expect((await declare(connector.client, ["core.note"])).status).toBe(201);
    expect(await readOnlyOf(note.id)).toBe(true);

    const narrowed = await getOwnerClient().updateKey(connector.id, {
      type_permissions: { "core.note": "read" },
    });
    expect(narrowed.ok, JSON.stringify(narrowed.error)).toBe(true);
    expect(await readOnlyOf(note.id)).toBe(false);
  });

  it("answers read_only on a replayed write as registrations stand at the replay", async () => {
    const idempotencyKey = `read-only-replay-${ctx.runId}`;
    const create = () =>
      client.rawRequest<{ item: MarfaItem }>("/items", {
        method: "POST",
        headers: { "Idempotency-Key": idempotencyKey },
        body: {
          type: "core.note",
          properties: { body: `${ctx.runId} replayed` },
        },
      });
    expect((await declare(client, ["core.note"])).status).toBe(201);
    const first = await create();
    expect(first.status).toBe(201);
    trackItem(ctx, first.data.item.id);
    expect(first.data.item.read_only).toBe(true);

    expect((await declare(client)).status).toBe(200);
    const replayed = await create();
    expect(replayed.status).toBe(201);
    expect(replayed.headers.get("Idempotency-Replayed")).toBe("true");
    expect(replayed.data.item.id).toBe(first.data.item.id);
    expect(replayed.data.item.read_only).toBe(false);
  });
});

describe("a connector whose key has expired", () => {
  let moving: FreshServer;

  beforeAll(async () => {
    moving = await bootFreshServer("connector-read-only-clock");
  }, FRESH_SERVER_TIMEOUT_MS);

  afterAll(async () => {
    await moving.stop();
  }, FRESH_SERVER_TIMEOUT_MS);

  it("reads an item editable once the key of the connector that held it expires", async () => {
    const clock = movedClock(moving);
    const owner = new MarfaClient({
      baseUrl: moving.apiUrl,
      ownerCookie: moving.ownerCookie,
      ownerCredentials: TEST_OWNER,
    });
    const minted = await owner.createKey({
      label: "read-only-expiring",
      source: "read-only-expiring",
      default_tier: "library",
      expires_at: new Date(clock.now() + HOUR_MS).toISOString(),
    });
    expect(minted.status, JSON.stringify(minted.error)).toBe(201);
    const connector = new MarfaClient({
      baseUrl: moving.apiUrl,
      apiKey: minted.data.key,
    });
    const created = await connector.createItem({
      type: "core.note",
      properties: { body: "read only until the key expires" },
    });
    expect(created.status, JSON.stringify(created.error)).toBe(201);
    const id = created.data.item.id;
    expect(
      (
        await connector.registerConnector({
          name: "read only expiring",
          read_only_types: ["core.note"],
        })
      ).status,
    ).toBe(201);

    const reader = writerOf(moving);
    const readOnly = async (): Promise<boolean | undefined> => {
      const read = await reader.getItem(id);
      expect(read.status).toBe(200);
      return read.data.item.read_only;
    };
    // The witness: before its expiry the key is not revoked and holds the item.
    expect(await readOnly()).toBe(true);

    await clock.advance(2 * HOUR_MS);

    // The key is unrevoked, so only its expiry can have released the item.
    expect((await connector.getCurrentKey()).status).toBe(401);
    expect(await readOnly()).toBe(false);
  });
});
