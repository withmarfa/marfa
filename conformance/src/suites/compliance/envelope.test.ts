import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import {
  cleanup,
  createTestContext,
  trackEdge,
  trackItem,
  trackKey,
  trackWebhook,
} from "../../utils/setup.js";
import { createNote } from "../../generators/items.js";
import {
  expectMatchesSchema,
  pageDoors,
  servedDocument,
} from "../../utils/openapi.js";
import { uploadReferenced } from "../../utils/blobs.js";

/**
 * Every list and every search answers one envelope: the rows under `data`
 * and the cursor that continues them under `next_cursor`, `null` on the
 * last page. Two doors carry a sibling about the answer rather than the
 * page. Nothing else stands beside the two keys.
 */

let client: MarfaClient;
let ctx: TestContext;
let apiUrl: string;
let apiKey: string;
const managementKey = process.env.MARFA_MANAGEMENT_KEY ?? "";

let itemId: string;
let targetId: string;
let webhookId: string;
let connectorId: string;
let blobHash: string;
let title: string;

beforeAll(async () => {
  ({ ctx, client, apiUrl, apiKey } = await createTestContext(
    "compliance",
    "envelope",
  ));
  title = `envelope-${ctx.runId}`;
  const a = await client.createItem(
    createNote({ source: ctx.source, properties: { title, body: title } }),
  );
  const b = await client.createItem(createNote({ source: ctx.source }));
  expect(a.ok && b.ok).toBe(true);
  itemId = a.data.item.id;
  trackItem(ctx, itemId);
  trackItem(ctx, b.data.item.id);
  targetId = b.data.item.id;
  const edge = await client.createEdge({
    source_id: itemId,
    target_id: b.data.item.id,
    edge_type: "about",
  });
  expect(edge.ok).toBe(true);
  trackEdge(ctx, edge.data.edge.id);
  const webhook = await client.createWebhook({
    url: "https://example.com/hook",
    events: ["item.created"],
  });
  expect(webhook.ok).toBe(true);
  webhookId = webhook.data.id;
  trackWebhook(ctx, webhookId);
  const connector = await client.registerConnector({ name: title });
  expect(connector.ok).toBe(true);
  connectorId = connector.data.id;
  const blob = await uploadReferenced(
    client,
    ctx,
    new TextEncoder().encode(title),
    "text/plain",
  );
  expect(blob.ok).toBe(true);
  blobHash = blob.data.hash;
});

afterAll(async () => {
  await cleanup(ctx);
});

/** Answers the owner's own doors, which no key opens. */
const ownerCookie = process.env.MARFA_OWNER_COOKIE ?? "";

async function read(path: string, key = apiKey): Promise<unknown> {
  const response = await fetch(`${apiUrl}${path}`, {
    headers:
      key === ownerCookie
        ? { cookie: ownerCookie }
        : { Authorization: `Bearer ${key}` },
  });
  expect(response.status, path).toBe(200);
  return response.json();
}

describe("one envelope for every list and search", () => {
  const doors: {
    template: string;
    path: () => string;
    siblings?: string[];
    operator?: boolean;
    owner?: boolean;
  }[] = [
    { template: "/items", path: () => `/items?source=${ctx.source}` },
    { template: "/edges", path: () => "/edges" },
    { template: "/items/{id}/edges", path: () => `/items/${itemId}/edges` },
    {
      template: "/items/{id}/backrefs",
      path: () => `/items/${itemId}/backrefs`,
    },
    { template: "/audit", path: () => "/audit" },
    { template: "/search", path: () => `/search?q=${title}` },
    { template: "/types", path: () => "/types" },
    { template: "/edge-types", path: () => "/edge-types" },
    { template: "/keys", path: () => "/keys" },
    { template: "/webhooks", path: () => "/webhooks" },
    {
      template: "/webhooks/{id}/deliveries",
      path: () => `/webhooks/${webhookId}/deliveries`,
    },
    { template: "/metadata/tags", path: () => "/metadata/tags" },
    {
      template: "/items/{id}/versions",
      path: () => `/items/${itemId}/versions`,
    },
    { template: "/connectors", path: () => "/connectors" },
    {
      template: "/connectors/{id}/runs",
      path: () => `/connectors/${connectorId}/runs`,
    },
    {
      template: "/connectors/{id}/endpoints",
      path: () => `/connectors/${connectorId}/endpoints`,
    },
    {
      template: "/connectors/{id}/deliveries",
      path: () => `/connectors/${connectorId}/deliveries`,
    },
    {
      template: "/connectors/{id}/agreements",
      path: () => `/connectors/${connectorId}/agreements`,
    },
    { template: "/housekeeping", path: () => "/housekeeping", operator: true },
    {
      template: "/blobs/orphans",
      path: () => "/blobs/orphans",
      operator: true,
    },
    {
      template: "/blobs/stores",
      path: () => "/blobs/stores",
      siblings: ["min_copies"],
      operator: true,
    },
    {
      template: "/blobs/{hash}/locations",
      path: () => `/blobs/${blobHash}/locations`,
    },
    {
      template: "/platform-types/drift",
      path: () => "/platform-types/drift",
      operator: true,
    },
    {
      template: "/occurrences",
      path: () =>
        "/occurrences?from=2026-01-01T00:00:00Z&to=2026-02-01T00:00:00Z",
      siblings: ["window", "scan"],
    },
    { template: "/owner/sign-ins", path: () => "/owner/sign-ins", owner: true },
  ];
  const credentialOf = (door: (typeof doors)[number]) =>
    door.owner ? ownerCookie : door.operator ? managementKey : apiKey;

  it("names twenty-five doors, every one the document publishes as a page", async () => {
    // The derived set holds the rows to the document, so a door that starts
    // answering a page without a row here turns this red. The count holds
    // both to the number the specification states, so a new page added with
    // a row beside it turns this red too.
    expect(doors).toHaveLength(25);
    expect(doors.map((door) => `GET ${door.template}`).sort()).toEqual(
      pageDoors(await servedDocument()).sort(),
    );
  });

  it("answers a null cursor from every door that takes none", async () => {
    // A door that declares no cursor has no way to be asked for a second
    // page, so it answers its whole set and says so. Derived from the
    // document rather than listed, and counted, so a door that starts or
    // stops taking a cursor turns this red.
    const document = await servedDocument();
    const whole = doors.filter(
      (door) =>
        !(document.paths[door.template]?.get?.parameters ?? []).some(
          (parameter) =>
            parameter.in === "query" && parameter.name === "cursor",
        ),
    );
    expect(whole).toHaveLength(14);
    for (const door of whole) {
      const body = (await read(door.path(), credentialOf(door))) as Record<
        string,
        unknown
      >;
      expect(body.next_cursor, door.template).toBeNull();
    }
  });

  it("answers GET /auth/grants, which the document does not publish, in the same envelope", async () => {
    // Outside the twenty-five: the owner's approved-apps list is served
    // beside the document rather than in it, and answers the same two keys.
    expect((await servedDocument()).paths["/auth/grants"]).toBeUndefined();
    const minted = await client.createKey({
      label: "envelope-grants",
      source: `${ctx.source}-grants`,
      permissions: ["grants.manage"],
      type_permissions: { "*": "read" },
    });
    expect(minted.ok, JSON.stringify(minted.error)).toBe(true);
    trackKey(ctx, minted.data.id);
    const body = (await read("/auth/grants", minted.data.key)) as Record<
      string,
      unknown
    >;
    expect(Object.keys(body).sort()).toEqual(["data", "next_cursor"]);
    expect(Array.isArray(body.data)).toBe(true);
    // The whole set in one answer: the door takes no cursor.
    expect(body.next_cursor).toBeNull();
  });

  const doorRows = doors.map((door) => [door.template, door] as const);
  it.each(doorRows)(
    "GET %s answers data and next_cursor",
    async (_template, door) => {
      const body = (await read(door.path(), credentialOf(door))) as Record<
        string,
        unknown
      >;
      await expectMatchesSchema("GET", door.template, 200, body);
      // The occurrence door adds its diagnostics only when there are any,
      // so on that door alone they are set aside from the key set.
      const diagnostics =
        door.template === "/occurrences"
          ? ["series_errors", "series_errors_truncated", "expansion_incomplete"]
          : [];
      expect(
        Object.keys(body)
          .filter((key) => !diagnostics.includes(key))
          .sort(),
      ).toEqual(["data", "next_cursor", ...(door.siblings ?? [])].sort());
      expect(Array.isArray(body.data)).toBe(true);
      expect(
        body.next_cursor === null || typeof body.next_cursor === "string",
      ).toBe(true);
    },
  );

  it("carries each hydrated edge block as a page", async () => {
    type Blocks = Record<string, Record<string, unknown>>;
    const isPage = (block: Record<string, unknown> | undefined) => {
      expect(Object.keys(block ?? {}).sort()).toEqual(["data", "next_cursor"]);
      expect(block?.next_cursor).toBeNull();
    };
    const detail = (await read(`/items/${itemId}?include=backrefs`)) as {
      item: { edges: Blocks };
    };
    isPage(detail.item.edges.about);
    const target = (await read(`/items/${targetId}?include=backrefs`)) as {
      backrefs: Blocks;
    };
    isPage(target.backrefs.about);
    const listed = (await read(
      `/items?source=${ctx.source}&include=edges`,
    )) as { data: { id: string; edges?: Blocks }[] };
    isPage(listed.data.find((row) => row.id === itemId)?.edges?.about);
  });

  it("carries an item's hydrated history as a page", async () => {
    const detail = (await read(`/items/${itemId}?include=versions`)) as {
      versions?: Record<string, unknown>;
    };
    await expectMatchesSchema("GET", "/items/{id}", 200, detail);
    expect(Object.keys(detail.versions ?? {}).sort()).toEqual([
      "data",
      "next_cursor",
    ]);
    expect(Array.isArray(detail.versions?.data)).toBe(true);
    expect(detail.versions?.next_cursor).toBeNull();
  });
});

describe("an item's neighbors stand outside the envelope", () => {
  type Detail = {
    item: {
      edges: Record<
        string,
        { data: { target_id: string }[]; next_cursor: unknown }
      >;
    };
    neighbors?: { item: { id: string } }[];
    neighbors_truncated?: boolean;
  };

  it("hydrates the far ends as a list, flagging no truncation below the cap", async () => {
    const detail = (await read(`/items/${itemId}?include=neighbors`)) as Detail;
    await expectMatchesSchema("GET", "/items/{id}", 200, detail);
    expect(Array.isArray(detail.neighbors)).toBe(true);
    expect(detail.neighbors?.map((n) => n.item.id)).toEqual([targetId]);
    expect(detail.neighbors_truncated).toBe(false);
  });

  /**
   * A hub with the given number of far ends under each edge type, all of
   * them notes the fixture's own key reads, read back with its neighbors.
   */
  async function hubWith(blocks: Record<string, number>) {
    const edgeTypes = Object.entries(blocks).flatMap(([type, count]) =>
      Array.from({ length: count }, () => type),
    );
    const created = await client.bulkItems({
      items: Array.from({ length: 1 + edgeTypes.length }, () =>
        createNote({ source: ctx.source }),
      ),
    });
    expect(created.ok).toBe(true);
    const ids = created.data.results.map((entry) => String(entry.id));
    for (const id of ids) trackItem(ctx, id);
    const [hub, ...farEnds] = ids;
    const edges = await client.bulkEdges({
      edges: farEnds.map((target, i) => ({
        source_id: hub!,
        target_id: target,
        edge_type: edgeTypes[i]!,
      })),
    });
    expect(edges.ok).toBe(true);
    expect(edges.data.counts.created).toBe(farEnds.length);
    for (const entry of edges.data.results) trackEdge(ctx, entry.id!);

    const detail = (await read(`/items/${hub!}?include=neighbors`)) as Detail;
    await expectMatchesSchema("GET", "/items/{id}", 200, detail);
    for (const [type, count] of Object.entries(blocks)) {
      expect(detail.item.edges[type]?.data, type).toHaveLength(count);
      expect(detail.item.edges[type]?.next_cursor, type).toBeNull();
    }
    // The blocks name every far end, whatever the list beside them holds.
    expect(
      Object.values(detail.item.edges)
        .flatMap((block) => block.data.map((edge) => edge.target_id))
        .sort(),
    ).toEqual([...farEnds].sort());
    return { detail, farEnds };
  }

  it("hydrates every far end at the cap, flagging no truncation", async () => {
    // Exactly the cap of 100, as four edge types of 25 rather than two of
    // 50, so no block sits at its own per-type cap of 50 and the combined
    // cap is the only bound in reach.
    const { detail, farEnds } = await hubWith({
      about: 25,
      references: 25,
      "derived-from": 25,
      "attached-to": 25,
    });
    expect(farEnds).toHaveLength(100);
    expect(detail.neighbors_truncated).toBe(false);
    expect((detail.neighbors?.map((n) => n.item.id) ?? []).sort()).toEqual(
      [...farEnds].sort(),
    );
  });

  it("flags neighbors_truncated one past the cap, hydrating exactly the cap", async () => {
    // 101 far ends across four edge types, so every block is whole, with no
    // cursor to follow, and only their combined count passes the cap. That
    // is the case the flag exists for, since no block's cursor can say it.
    // One past the cap rather than more, so this and the case at the cap
    // above pin it from both sides: a cap of 101 fails here, one of 99
    // fails there.
    const { detail, farEnds } = await hubWith({
      about: 26,
      references: 25,
      "derived-from": 25,
      "attached-to": 25,
    });
    expect(farEnds).toHaveLength(101);
    expect(detail.neighbors_truncated).toBe(true);
    const hydrated = detail.neighbors?.map((n) => n.item.id) ?? [];
    expect(hydrated).toHaveLength(100);
    expect(new Set(hydrated).size).toBe(100);
    expect(farEnds).toEqual(expect.arrayContaining(hydrated));
  });
});

describe("search pages by cursor", () => {
  it("walks to a null cursor, delivering every hit once", async () => {
    const tag = `envelope-search-${ctx.runId}`;
    for (let i = 0; i < 5; i++) {
      const r = await client.createItem(
        createNote({
          source: ctx.source,
          properties: { title: `${tag} ${String(i)}`, body: tag },
        }),
      );
      expect(r.ok).toBe(true);
      trackItem(ctx, r.data.item.id);
    }
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    for (let page = 0; page < 10; page++) {
      const answer = await client.search(tag, {
        limit: 2,
        ...(cursor === undefined ? {} : { cursor }),
      });
      expect(answer.ok).toBe(true);
      pages += 1;
      seen.push(...answer.data.data.map((hit) => hit.item.id));
      if (answer.data.next_cursor === null) break;
      cursor = answer.data.next_cursor;
    }
    // Five hits two to a page is three pages. A first page that answered
    // all five with a null cursor would deliver every hit once and pass the
    // two assertions below without paging at all.
    expect(pages).toBe(3);
    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
  });

  it("refuses a cursor minted for another search", async () => {
    const token = `envelope-bound-${ctx.runId}`;
    for (let i = 0; i < 2; i++) {
      const r = await client.createItem(
        createNote({ source: ctx.source, properties: { body: token } }),
      );
      expect(r.ok).toBe(true);
      trackItem(ctx, r.data.item.id);
    }
    const first = await client.search(token, { limit: 1 });
    expect(first.data.next_cursor).not.toBeNull();
    // The witness: the same cursor on the same search continues it.
    const same = await client.search(token, {
      limit: 1,
      cursor: first.data.next_cursor!,
    });
    expect(same.status).toBe(200);
    const refused = await client.search(`${token} other`, {
      limit: 1,
      cursor: first.data.next_cursor!,
    });
    expect(refused.status).toBe(400);
    expect(refused.error?.error.code).toBe("validation_error");
  });

  it("refuses an offset query key", async () => {
    // A search pages by cursor alone. The refusal names the key, so a 400
    // for some other reason, such as a missing `q`, cannot pass for it.
    const response = await fetch(`${apiUrl}/search?q=${title}&offset=1`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as {
      error: { code: string; details?: { unknown_parameters?: string[] } };
    };
    expect(body.error.code).toBe("validation_error");
    expect(body.error.details?.unknown_parameters).toEqual(["offset"]);
  });

  it("refuses a cursor another listing issued, and one it cannot read", async () => {
    const listing = await client.listItems({ source: ctx.source, limit: 1 });
    expect(listing.data.next_cursor).not.toBeNull();
    for (const cursor of [listing.data.next_cursor!, "not-a-cursor"]) {
      const refused = await client.search(title, { cursor });
      expect(refused.status).toBe(400);
      expect(refused.error?.error.code).toBe("validation_error");
    }
  });
});
