import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { controlRequest } from "../../utils/control-request.js";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import {
  cleanup,
  createTestContext,
  trackEdge,
  trackEdgeType,
  trackItem,
  trackWebhook,
} from "../../utils/setup.js";
import { createNote } from "../../generators/items.js";
import { pageDoors, servedDocument } from "../../utils/openapi.js";
import { startReceiver, type Receiver } from "../../utils/webhook-receiver.js";

/**
 * A page that holds the last row answers a null cursor, even when the rows
 * fill it exactly. Every door that takes a cursor is seeded with exactly
 * `LIMIT` rows and read at `LIMIT`. A door that decided "more follows" from a
 * full page rather than from a row past it would hand back a cursor to an
 * empty page here, and nowhere else, because every other fixture seeds more
 * rows than it reads.
 *
 * Each door is also read one short of its rows first. That page must carry
 * a cursor, and following it must reach the last row: the witness that the
 * seed is what the door reads, so the null below is about the boundary and
 * not about a door that never answers a cursor.
 */

const LIMIT = 3;

type Page = { data: { id?: string }[]; next_cursor: string | null };
type Read = (page: { limit: number; cursor?: string }) => Promise<Page>;

let client: MarfaClient;
let apiUrl: string;
let ctx: TestContext;
let receiver: Receiver;
const extra: TestContext[] = [];
const connectors: string[] = [];
const isolated: FreshServer[] = [];

beforeAll(async () => {
  ({ ctx, client, apiUrl } = await createTestContext(
    "compliance",
    "full-last-page",
  ));
  receiver = await startReceiver();
});

afterAll(async () => {
  await receiver.close();
  for (const server of isolated) await server.stop();
  for (const id of connectors) await client.deleteConnector(id);
  for (const own of extra) await cleanup(own);
  await cleanup(ctx);
});

function answered<T>(response: {
  ok: boolean;
  status: number;
  data: T;
  error?: unknown;
}): T {
  expect(response.ok, JSON.stringify(response.error)).toBe(true);
  return response.data;
}

async function notes(count: number, body?: string): Promise<string[]> {
  const created = answered(
    await client.bulkItems({
      items: Array.from({ length: count }, (_, i) =>
        createNote({
          source: ctx.source,
          properties: {
            title: `${body ?? "full-last-page"} ${String(i)}`,
            body: body ?? "full-last-page",
          },
        }),
      ),
    }),
  );
  const ids = created.results.map((entry) => String(entry.id));
  for (const id of ids) trackItem(ctx, id);
  expect(ids).toHaveLength(count);
  return ids;
}

async function edgesFrom(
  sources: string[],
  targets: string[],
  edgeType = "about",
): Promise<void> {
  const made = answered(
    await client.bulkEdges({
      edges: sources.map((source, i) => ({
        source_id: source,
        target_id: targets[i]!,
        edge_type: edgeType,
      })),
    }),
  );
  expect(made.counts.created).toBe(sources.length);
  for (const entry of made.results) trackEdge(ctx, entry.id!);
}

async function trashSummaryPage(): Promise<Read> {
  const query = `last-page-trash-${ctx.runId}`;
  const ids = await notes(LIMIT, query);
  for (const id of ids) expect((await client.deleteItem(id)).ok).toBe(true);
  const cookie = process.env.MARFA_OWNER_COOKIE;
  expect(cookie, "MARFA_OWNER_COOKIE is required").toBeTruthy();
  return async ({ limit, cursor }) => {
    const params = new URLSearchParams({ q: query, limit: String(limit) });
    if (cursor) params.set("cursor", cursor);
    const response = await fetch(`${apiUrl}/trash?${params}`, {
      headers: { cookie: cookie! },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as Page;
    expect(body.data.every((row) => ids.includes(row.id!))).toBe(true);
    return body;
  };
}

/** Seeds exactly `LIMIT` rows behind a door and returns how to read them. */
const seeds: Record<string, () => Promise<Read>> = {
  "GET /folders": async () => {
    const server = await bootFreshServer("full-last-page-folders");
    isolated.push(server);
    const writer = new MarfaClient({
      baseUrl: server.apiUrl,
      apiKey: server.workingKey,
    });
    const ids: string[] = [];
    for (let i = 0; i < LIMIT; i++) {
      ids.push(
        answered(await writer.createFolder({ title: `Folder ${String(i)}` }))
          .item.id,
      );
    }
    for (const key of [server.workingKey, server.managementKey]) {
      const refused = await fetch(`${server.apiUrl}/folders`, {
        headers: { Authorization: `Bearer ${key}` },
      });
      expect(refused.status).toBe(403);
    }
    return async ({ limit, cursor }) => {
      const query = new URLSearchParams({ limit: String(limit) });
      if (cursor) query.set("cursor", cursor);
      const path = `/folders?${query}`;
      const response = await fetch(`${server.apiUrl}${path}`, {
        headers: { cookie: server.ownerCookie },
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as Page;
      const local = await controlRequest(server.controlSocket, path);
      expect(local.status).toBe(200);
      expect(local.body).toEqual(body);
      expect(body.data.every((row) => ids.includes(row.id!))).toBe(true);
      return body;
    };
  },
  "GET /items/summaries": async () => {
    const name = `fullsummary${ctx.runId.replace(/[^a-z0-9]/gi, "")}`;
    const ids = await notes(LIMIT, name);
    const owner = process.env.MARFA_OWNER_COOKIE;
    expect(owner, "MARFA_OWNER_COOKIE is required").toBeTruthy();
    return async (page) => {
      const query = new URLSearchParams({
        type: "core.note",
        q: name,
        limit: String(page.limit),
        ...(page.cursor === undefined ? {} : { cursor: page.cursor }),
      });
      const response = await fetch(`${apiUrl}/items/summaries?${query}`, {
        headers: {
          cookie: owner!,
          origin: new URL(apiUrl).origin,
        },
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as Page;
      expect(body.data.every((row) => ids.includes(row.id!))).toBe(true);
      return body;
    };
  },
  "GET /items": async () => {
    const own = await createTestContext("compliance", "full-last-page-items");
    extra.push(own.ctx);
    const created = answered(
      await own.client.bulkItems({
        items: Array.from({ length: LIMIT }, () =>
          createNote({ source: own.ctx.source }),
        ),
      }),
    );
    for (const entry of created.results) trackItem(own.ctx, String(entry.id));
    return async (page) =>
      answered(
        await client.listItems({ source: own.ctx.source, ...page }),
      ) as Page;
  },
  "GET /trash": async () => trashSummaryPage(),
  "GET /edges": async () => {
    const edgeType = `mock.fulllastpage.${ctx.runId}`;
    const registered = await client.registerEdgeType({
      label: "Test edge type",
      id: edgeType,
      cardinality: "many-to-many",
    });
    expect(registered.status, JSON.stringify(registered.error)).toBe(201);
    trackEdgeType(ctx, edgeType);
    const [hub, ...ends] = await notes(1 + LIMIT);
    await edgesFrom(
      ends.map(() => hub!),
      ends,
      edgeType,
    );
    return async (page) =>
      answered(
        await client.listEdges({ edge_type: edgeType, ...page }),
      ) as Page;
  },
  "GET /items/{id}/edges": async () => {
    const [hub, ...ends] = await notes(1 + LIMIT);
    await edgesFrom(
      ends.map(() => hub!),
      ends,
    );
    return async (page) =>
      answered(await client.listItemEdges(hub!, page)) as Page;
  },
  "GET /items/{id}/versions": async () => {
    const [id] = await notes(1);
    // Each update leaves one snapshot behind.
    for (let version = 1; version <= LIMIT; version++) {
      answered(
        await client.updateItem(id!, {
          properties: { title: `history ${String(version)}` },
          version,
        }),
      );
    }
    return async (page) =>
      answered(await client.getVersions(id!, page)) as Page;
  },
  "GET /items/{id}/backrefs": async () => {
    const [target, ...sources] = await notes(1 + LIMIT);
    await edgesFrom(
      sources,
      sources.map(() => target!),
    );
    return async (page) =>
      answered(await client.listItemBackrefs(target!, page)) as Page;
  },
  "GET /audit": async () => {
    const [id] = await notes(1);
    for (let i = 0; i < LIMIT; i++) {
      answered(await client.addTags(id!, [`full-last-page-${String(i)}`]));
    }
    return async (page) =>
      answered(
        await client.listAudit({
          resource_id: id!,
          action: "item.tag",
          ...page,
        }),
      ) as Page;
  },
  "GET /search": async () => {
    const token = `fulllastpage${ctx.runId.replace(/[^a-z0-9]/gi, "")}`;
    await notes(LIMIT, token);
    return async (page) => answered(await client.search(token, page)) as Page;
  },
  "GET /webhooks/{id}/deliveries": async () => {
    const itemType = `mock.lastpage.${ctx.runId}`;
    answered(await client.registerType({ id: itemType, fields: {} }));
    const hook = answered(
      await client.createWebhook({
        url: receiver.hookUrl("full-last-page"),
        events: ["item.created"],
        type_filter: itemType,
      }),
    );
    trackWebhook(ctx, hook.id, client);
    const unrelated = answered(
      await client.createItem(createNote({ source: ctx.source })),
    );
    trackItem(ctx, unrelated.item.id);
    // One at a time: the bulk door sends nothing to a webhook unless asked
    // to with `enable_fanout`.
    const ids: string[] = [];
    for (let i = 0; i < LIMIT; i++) {
      const created = answered(
        await client.createItem({
          type: itemType,
          source: ctx.source,
          properties: {},
        }),
      );
      trackItem(ctx, created.item.id);
      ids.push(created.item.id);
    }
    for (const id of ids) {
      await receiver.waitFor(
        (r) => r.path === "/hook/full-last-page" && r.body.includes(id),
      );
    }
    // The delivery is logged after the receiver answers, and the hook is
    // retired once all are logged so no later write adds a row.
    let logged = 0;
    for (let attempt = 0; attempt < 40 && logged < LIMIT; attempt++) {
      logged = answered(await client.listWebhookDeliveries(hook.id)).data
        .length;
      if (logged < LIMIT) await new Promise((r) => setTimeout(r, 250));
    }
    expect(logged).toBe(LIMIT);
    answered(await client.updateWebhook(hook.id, { active: false }));
    return async (page) =>
      answered(await client.listWebhookDeliveries(hook.id, page)) as Page;
  },
  "GET /connectors/{id}/runs": async () => {
    const connector = answered(
      await client.registerConnector({ name: `full-last-page ${ctx.runId}` }),
    );
    connectors.push(connector.id);
    const now = Date.now();
    for (let i = 0; i < LIMIT; i++) {
      answered(
        await client.reportConnectorRun(connector.id, {
          outcome: "succeeded",
          started_at: new Date(now - 2_000).toISOString(),
          finished_at: new Date(now - 1_000).toISOString(),
          summary: `run ${String(i)}`,
        }),
      );
    }
    return async (page) =>
      answered(await client.listConnectorRuns(connector.id, page)) as Page;
  },
  "GET /connectors/{id}/deliveries": async () => {
    // The same key's registration as the runs seed's: one per key.
    const connector = answered(
      await client.registerConnector({ name: `full-last-page ${ctx.runId}` }),
    );
    if (!connectors.includes(connector.id)) connectors.push(connector.id);
    const endpoint = answered(await client.createInboundEndpoint(connector.id));
    for (let i = 0; i < LIMIT; i++) {
      const sent = await fetch(`${apiUrl}${endpoint.path}`, {
        method: "POST",
        body: `delivery ${String(i)}`,
      });
      expect(sent.status).toBe(202);
    }
    return async (page) =>
      answered(await client.listInboundDeliveries(connector.id, page)) as Page;
  },
  "GET /connectors/{id}/agreements": async () => {
    // The same key's registration as the runs seed's: one per key.
    const connector = answered(
      await client.registerConnector({ name: `full-last-page ${ctx.runId}` }),
    );
    if (!connectors.includes(connector.id)) connectors.push(connector.id);
    const rows = await notes(LIMIT, "agreement");
    answered(await client.takeConnectorHold(connector.id, "full-last-page"));
    answered(
      await client.writeConnectorAgreements(connector.id, {
        process: "full-last-page",
        set: rows.map((item_id) => ({ item_id, waiting: true, record: {} })),
      }),
    );
    return async (page) =>
      answered(
        await client.listConnectorAgreements(connector.id, page),
      ) as Page;
  },
};

describe("a full last page answers a null cursor", () => {
  it("covers every door that takes a cursor", async () => {
    // Derived from the document, so a door that starts taking a cursor
    // without a seed here turns this red.
    const document = await servedDocument();
    const cursorDoors = pageDoors(document).filter((door) => {
      const path = door.slice("GET ".length);
      return (document.paths[path]?.get?.parameters ?? []).some(
        (parameter) => parameter.in === "query" && parameter.name === "cursor",
      );
    });
    expect(cursorDoors).toHaveLength(14);
    expect(Object.keys(seeds).sort()).toEqual(cursorDoors.sort());
  });

  const seededDoors = Object.keys(seeds);
  it.each(seededDoors)(
    "%s answers null when the rows fill the page exactly",
    async (door) => {
      const read = await seeds[door]!();

      const short = await read({ limit: LIMIT - 1 });
      expect(short.data, door).toHaveLength(LIMIT - 1);
      expect(short.next_cursor, door).not.toBeNull();
      const rest = await read({ limit: LIMIT, cursor: short.next_cursor! });
      expect(rest.data, door).toHaveLength(1);
      expect(rest.next_cursor, door).toBeNull();

      const full = await read({ limit: LIMIT });
      expect(full.data, door).toHaveLength(LIMIT);
      expect(full.next_cursor, door).toBeNull();
    },
    FRESH_SERVER_TIMEOUT_MS + 120_000,
  );
});
