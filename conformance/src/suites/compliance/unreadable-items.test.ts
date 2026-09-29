import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { TestContext } from "../../client/types.js";
import {
  createTestContext,
  trackEdge,
  trackItem,
  trackKey,
  cleanup,
} from "../../utils/setup.js";
import {
  createBookmark,
  createNote,
  createTask,
  generateId,
} from "../../generators/items.js";
import type { MarfaClient } from "../../client/api.js";

let client: MarfaClient;
let ctx: TestContext;
let apiUrl: string;

/** What a caller can observe of one answer. */
interface Seen {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

/** Headers that differ between any two requests, whatever they asked. */
const PER_REQUEST_HEADERS = new Set(["date", "x-request-id"]);

async function ask(
  key: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<Seen> {
  const res = await fetch(`${apiUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const headers: Record<string, string> = {};
  for (const [name, value] of res.headers) {
    if (!PER_REQUEST_HEADERS.has(name)) headers[name] = value;
  }
  const text = await res.text();
  return {
    status: res.status,
    headers,
    body: text.length === 0 ? null : (JSON.parse(text) as unknown),
  };
}

/** The answer with the id it named written out of it, so two ids compare. */
function without(seen: Seen, id: string): Seen {
  return {
    ...seen,
    body: JSON.parse(JSON.stringify(seen.body).replaceAll(id, "<id>")),
  };
}

beforeAll(async () => {
  ({ ctx, client, apiUrl } = await createTestContext(
    "compliance",
    "unreadable-items",
  ));
});

afterAll(async () => {
  await cleanup(ctx);
});

describe("an item the key cannot read answers as a missing one", () => {
  /** Reads and writes notes, reads tasks, and holds nothing on bookmarks. */
  let key: string;
  let hidden: string;
  let hiddenTrashed: string;
  let hiddenEdge: string;
  let task: string;

  async function ownerItem(
    make: typeof createBookmark,
    trashed = false,
  ): Promise<string> {
    const r = await client.createItem(make({ source: ctx.source }));
    expect(r.status).toBe(201);
    trackItem(ctx, r.data.item.id);
    if (trashed)
      expect((await client.deleteItem(r.data.item.id)).ok).toBe(true);
    return r.data.item.id;
  }

  async function note(trashed = false): Promise<string> {
    const r = await ask(key, "POST", "/items", createNote());
    expect(r.status).toBe(201);
    const id = (r.body as { item: { id: string } }).item.id;
    trackItem(ctx, id);
    if (trashed) {
      expect((await ask(key, "DELETE", `/items/${id}`)).status).toBe(200);
    }
    return id;
  }

  async function edge(
    source: string,
    target: string,
    edgeType = "about",
  ): Promise<string> {
    const r = await client.createEdge({
      source_id: source,
      target_id: target,
      edge_type: edgeType,
    });
    expect(r.status).toBe(201);
    trackEdge(ctx, r.data.edge.id);
    return r.data.edge.id;
  }

  beforeAll(async () => {
    const minted = await client.createKey({
      label: "unreadable-items",
      source: `${ctx.source}-unreadable-items`,
      permissions: ["items.purge"],
      type_permissions: { "core.note": "write", "core.task": "read" },
      edge_permissions: { "*": "write" },
      extension_permissions: { "*": "write" },
    });
    expect(minted.ok).toBe(true);
    trackKey(ctx, minted.data.id);
    key = minted.data.key;

    hidden = await ownerItem(createBookmark);
    hiddenTrashed = await ownerItem(createBookmark, true);
    task = await ownerItem(createTask);
    hiddenEdge = await edge(hidden, await note());
    await edge(hidden, task, "references");
  });

  /**
   * One door, asked of an item the key may not read and of an id nothing
   * holds, and asked of an item it may read as the witness.
   */
  interface Door {
    name: string;
    method: string;
    path: (id: string) => string;
    body?: (id: string) => unknown;
    /** Which unreadable row the door is asked of. */
    unreadable?: () => string;
    /** A row the key may reach there, and what the door answers for it. */
    witness: () => Promise<string>;
    served: number;
  }

  const live = (): Promise<string> => note();
  const trashed = (): Promise<string> => note(true);

  const doors: Door[] = [
    {
      name: "GET /items/{id}",
      method: "GET",
      path: (id) => `/items/${id}`,
      witness: live,
      served: 200,
    },
    {
      name: "GET /items/{id} with every include",
      method: "GET",
      path: (id) => `/items/${id}?include=backrefs,neighbors,versions`,
      witness: live,
      served: 200,
    },
    {
      name: "PATCH /items/{id}",
      method: "PATCH",
      path: (id) => `/items/${id}`,
      body: () => ({ version: 1, properties: { title: "changed" } }),
      witness: live,
      served: 200,
    },
    {
      name: "DELETE /items/{id}",
      method: "DELETE",
      path: (id) => `/items/${id}`,
      witness: live,
      served: 200,
    },
    {
      name: "POST /items/{id}/restore",
      method: "POST",
      path: (id) => `/items/${id}/restore`,
      unreadable: () => hiddenTrashed,
      witness: trashed,
      served: 200,
    },
    {
      name: "POST /items/{id}/transition",
      method: "POST",
      path: (id) => `/items/${id}/transition`,
      body: () => ({ state: "archived" }),
      witness: live,
      served: 200,
    },
    {
      name: "POST /items/{id}/transition, out of the trash",
      method: "POST",
      path: (id) => `/items/${id}/transition`,
      body: () => ({ state: "active" }),
      unreadable: () => hiddenTrashed,
      witness: trashed,
      served: 200,
    },
    {
      name: "GET /items/{id}/versions",
      method: "GET",
      path: (id) => `/items/${id}/versions`,
      witness: live,
      served: 200,
    },
    {
      name: "GET /items/{id}/metadata",
      method: "GET",
      path: (id) => `/items/${id}/metadata`,
      witness: live,
      served: 200,
    },
    {
      name: "PUT /items/{id}/metadata",
      method: "PUT",
      path: (id) => `/items/${id}/metadata`,
      body: () => ({ tags: ["unreadable"] }),
      witness: live,
      served: 200,
    },
    {
      name: "PATCH /items/{id}/metadata",
      method: "PATCH",
      path: (id) => `/items/${id}/metadata`,
      body: () => ({ tags: ["unreadable"] }),
      witness: live,
      served: 200,
    },
    {
      name: "POST /items/{id}/tags",
      method: "POST",
      path: (id) => `/items/${id}/tags`,
      body: () => ({ tags: ["unreadable"] }),
      witness: live,
      served: 200,
    },
    {
      name: "DELETE /items/{id}/tags/{tag}",
      method: "DELETE",
      path: (id) => `/items/${id}/tags/unreadable`,
      witness: live,
      served: 200,
    },
    {
      name: "DELETE /items/{id}/purge",
      method: "DELETE",
      path: (id) => `/items/${id}/purge`,
      unreadable: () => hiddenTrashed,
      witness: trashed,
      served: 200,
    },
    {
      name: "DELETE /items/{id}/purge, of a live row",
      method: "DELETE",
      path: (id) => `/items/${id}/purge`,
      witness: live,
      served: 400,
    },
    {
      name: "GET /items/{id}/extensions",
      method: "GET",
      path: (id) => `/items/${id}/extensions`,
      witness: live,
      served: 200,
    },
    {
      name: "GET /items/{id}/extensions/{namespace}",
      method: "GET",
      path: (id) => `/items/${id}/extensions/unreadable`,
      witness: live,
      served: 200,
    },
    {
      name: "PUT /items/{id}/extensions/{namespace}",
      method: "PUT",
      path: (id) => `/items/${id}/extensions/unreadable`,
      body: () => ({ held: true }),
      witness: live,
      served: 200,
    },
    {
      name: "DELETE /items/{id}/extensions/{namespace}",
      method: "DELETE",
      path: (id) => `/items/${id}/extensions/unreadable`,
      witness: live,
      served: 200,
    },
    {
      name: "GET /items/{id}/edges",
      method: "GET",
      path: (id) => `/items/${id}/edges`,
      witness: live,
      served: 200,
    },
    {
      name: "GET /items/{id}/backrefs",
      method: "GET",
      path: (id) => `/items/${id}/backrefs`,
      witness: live,
      served: 200,
    },
    {
      name: "POST /edges, naming the source",
      method: "POST",
      path: () => "/edges",
      body: (id) => ({ source_id: id, target_id: task, edge_type: "about" }),
      witness: live,
      served: 201,
    },
    {
      name: "POST /edges/bulk, naming the source",
      method: "POST",
      path: () => "/edges/bulk",
      body: (id) => ({
        edges: [{ source_id: id, target_id: task, edge_type: "about" }],
      }),
      witness: live,
      served: 200,
    },
    {
      name: "POST /edges/bulk, naming the source, not atomic",
      method: "POST",
      path: () => "/edges/bulk",
      body: (id) => ({
        atomic: false,
        edges: [{ source_id: id, target_id: task, edge_type: "about" }],
      }),
      witness: live,
      served: 200,
    },
    {
      name: "POST /edges/bulk, where an edge from the source already exists",
      method: "POST",
      path: () => "/edges/bulk",
      body: (id) => ({
        atomic: false,
        edges: [
          {
            source_id: id,
            target_id: task,
            edge_type: "references",
          },
        ],
      }),
      unreadable: () => hidden,
      witness: live,
      served: 200,
    },
    {
      name: "GET /edges/{id}, of an edge whose source it cannot read",
      method: "GET",
      path: (id) => `/edges/${id}`,
      unreadable: () => hiddenEdge,
      witness: async () => edge(await note(), task),
      served: 200,
    },
    {
      name: "PATCH /edges/{id}, of an edge whose source it cannot read",
      method: "PATCH",
      path: (id) => `/edges/${id}`,
      body: () => ({ version: 1, properties: { weight: 1 } }),
      unreadable: () => hiddenEdge,
      witness: async () => edge(await note(), task),
      served: 200,
    },
    {
      name: "DELETE /edges/{id}, of an edge whose source it cannot read",
      method: "DELETE",
      path: (id) => `/edges/${id}`,
      unreadable: () => hiddenEdge,
      witness: async () => edge(await note(), task),
      served: 200,
    },
  ];

  it.each(doors)("$name", async (door) => {
    const unreadable = door.unreadable?.() ?? hidden;
    const missing = generateId();
    const asked = async (id: string): Promise<Seen> =>
      without(await ask(key, door.method, door.path(id), door.body?.(id)), id);

    const refused = await asked(unreadable);
    const absent = await asked(missing);
    expect(refused.status).toBe(absent.status);
    expect(refused.headers).toEqual(absent.headers);
    expect(refused.body).toEqual(absent.body);
    expect(JSON.stringify(refused.body)).not.toContain("core.bookmark");

    // The witness: the same key is served there, so the door is open to it.
    const witness = await door.witness();
    expect(
      (await ask(key, door.method, door.path(witness), door.body?.(witness)))
        .status,
    ).toBe(door.served);
  });

  it("PATCH /edges/{id} moving the source onto an item it cannot read", async () => {
    const moved = async (to: string): Promise<Seen> => {
      const child = await note();
      const parent = await note();
      const made = await ask(key, "POST", "/edges", {
        source_id: parent,
        target_id: child,
        edge_type: "parent-of",
      });
      expect(made.status).toBe(201);
      const id = (made.body as { edge: { id: string } }).edge.id;
      trackEdge(ctx, id);
      return without(
        await ask(key, "PATCH", `/edges/${id}`, { version: 1, source_id: to }),
        to,
      );
    };

    const refused = await moved(hidden);
    const absent = await moved(generateId());
    expect(refused.status).toBe(absent.status);
    expect(refused.headers).toEqual(absent.headers);
    expect(refused.body).toEqual(absent.body);

    expect((await moved(await note())).status).toBe(200);
  });

  it("POST /items naming the id of an item it cannot read learns the id is taken, and not the type", async () => {
    const refused = await ask(key, "POST", "/items", {
      ...createNote(),
      id: hidden,
    });
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ error: { code: "conflict" } });
    expect(JSON.stringify(refused.body)).not.toContain("core.bookmark");

    // The witness: an id held by a type the key may read is named, with it.
    const named = await ask(key, "POST", "/items", {
      ...createNote(),
      id: task,
    });
    expect(named.status).toBe(409);
    expect(named.body).toMatchObject({
      error: { code: "id_reused", details: { actual_type: "core.task" } },
    });
  });

  it("POST /items/bulk naming the id of an item it cannot read answers alike whether the item is live or trashed, and not with its type", async () => {
    const upsert = async (id: string): Promise<Seen> =>
      without(
        await ask(key, "POST", "/items/bulk", {
          mode: "upsert",
          items: [{ ...createNote(), id }],
        }),
        id,
      );
    const live = await upsert(hidden);
    const binned = await upsert(hiddenTrashed);
    expect(live.status).toBe(binned.status);
    expect(live.body).toEqual(binned.body);
    expect(live.body).toMatchObject({
      error: { code: "bulk_atomic_rollback", details: { code: "conflict" } },
    });
    expect(JSON.stringify(live.body)).not.toContain("core.bookmark");

    // The witness: an id held by a type the key reads is refused the write.
    const read = await ask(key, "POST", "/items/bulk", {
      mode: "upsert",
      items: [{ ...createNote(), id: task }],
    });
    expect(read.status).toBe(403);
    expect(read.body).toMatchObject({
      error: { details: { code: "type_not_permitted" } },
    });
  });

  it("POST /edges and POST /edges/bulk naming the id of an edge it cannot read learn the id is taken, and nothing of the edge", async () => {
    const source = await note();
    const body = (id: string) => ({
      id,
      source_id: source,
      target_id: task,
      edge_type: "about",
    });
    const single = await ask(key, "POST", "/edges", body(hiddenEdge));
    expect(single.status).toBe(409);
    expect(single.body).toEqual({
      error: {
        code: "id_reused",
        message: `Edge id ${hiddenEdge} already names a different edge`,
        details: { existing_id: hiddenEdge },
      },
    });
    const bulk = await ask(key, "POST", "/edges/bulk", {
      atomic: false,
      edges: [body(hiddenEdge)],
    });
    expect(bulk.status).toBe(200);
    expect(JSON.stringify(bulk.body)).not.toContain("differs");

    // The witness: an edge it may read is described, with what differs.
    const own = await edge(await note(), task);
    const named = await ask(key, "POST", "/edges", body(own));
    expect(named.status).toBe(409);
    expect(named.body).toMatchObject({
      error: { code: "id_reused", details: { differs: ["source_id"] } },
    });
  });

  it("a write to a type the key reads and does not write is still refused 403", async () => {
    const refused = await ask(key, "PATCH", `/items/${task}`, {
      version: 1,
      properties: { title: "changed" },
    });
    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({
      error: { code: "type_not_permitted" },
    });
    expect((await ask(key, "GET", `/items/${task}`)).status).toBe(200);
  });

  it("a key reaching no type is refused a single row, whatever the id names", async () => {
    const operator = process.env.MARFA_OPERATOR_KEY;
    if (!operator) throw new Error("MARFA_OPERATOR_KEY is required");
    const refused = without(
      await ask(operator, "GET", `/items/${hidden}`),
      hidden,
    );
    const missing = generateId();
    const absent = without(
      await ask(operator, "GET", `/items/${missing}`),
      missing,
    );
    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({
      error: { code: "type_not_permitted" },
    });
    expect(absent).toEqual(refused);
  });
});
