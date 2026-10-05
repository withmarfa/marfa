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
    // An edge each way before the trash, so an answer that leaked it could show.
    hiddenTrashed = await ownerItem(createBookmark);
    await edge(hiddenTrashed, await note());
    await edge(await note(), hiddenTrashed);
    expect((await client.deleteItem(hiddenTrashed)).ok).toBe(true);
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
    /** What an id no row holds answers there, if not `404 item_not_found`. */
    absent?: (seen: Seen) => void;
  }

  const live = (): Promise<string> => note();
  const trashed = (): Promise<string> => note(true);
  const itemNotFound = (seen: Seen): void => {
    expect(seen.status).toBe(404);
    expect(seen.body).toMatchObject({ error: { code: "item_not_found" } });
  };
  const edgeNotFound = (seen: Seen): void => {
    expect(seen.status).toBe(404);
    expect(seen.body).toMatchObject({ error: { code: "edge_not_found" } });
  };
  const entryNotFound = (seen: Seen): void => {
    expect(seen.status).toBe(200);
    expect(seen.body).toMatchObject({
      results: [{ outcome: "errored", error: { code: "item_not_found" } }],
    });
  };
  const pageRolledBack = (seen: Seen): void => {
    expect(seen.status).toBe(404);
    expect(seen.body).toMatchObject({
      error: {
        code: "bulk_atomic_rollback",
        details: { code: "item_not_found" },
      },
    });
  };

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
      name: "POST /items/{id}/purge",
      method: "POST",
      path: (id) => `/items/${id}/purge`,
      unreadable: () => hiddenTrashed,
      witness: trashed,
      served: 200,
    },
    {
      name: "POST /items/{id}/purge, of a live row",
      method: "POST",
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
      name: "GET /items/{id}/edges, of a trashed item",
      method: "GET",
      path: (id) => `/items/${id}/edges`,
      unreadable: () => hiddenTrashed,
      witness: trashed,
      served: 200,
    },
    {
      name: "GET /items/{id}/backrefs, of a trashed item",
      method: "GET",
      path: (id) => `/items/${id}/backrefs`,
      unreadable: () => hiddenTrashed,
      witness: trashed,
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
      absent: pageRolledBack,
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
      absent: entryNotFound,
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
      absent: entryNotFound,
    },
    {
      name: "GET /edges/{id}, of an edge whose source it cannot read",
      method: "GET",
      path: (id) => `/edges/${id}`,
      unreadable: () => hiddenEdge,
      witness: async () => edge(await note(), task),
      served: 200,
      absent: edgeNotFound,
    },
    {
      name: "PATCH /edges/{id}, of an edge whose source it cannot read",
      method: "PATCH",
      path: (id) => `/edges/${id}`,
      body: () => ({ version: 1, properties: { weight: 1 } }),
      unreadable: () => hiddenEdge,
      witness: async () => edge(await note(), task),
      served: 200,
      absent: edgeNotFound,
    },
    {
      name: "DELETE /edges/{id}, of an edge whose source it cannot read",
      method: "DELETE",
      path: (id) => `/edges/${id}`,
      unreadable: () => hiddenEdge,
      witness: async () => edge(await note(), task),
      served: 200,
      absent: edgeNotFound,
    },
  ];

  it.each(doors)("$name", async (door) => {
    const unreadable = door.unreadable?.() ?? hidden;
    const missing = generateId();
    const asked = async (id: string): Promise<Seen> =>
      without(await ask(key, door.method, door.path(id), door.body?.(id)), id);

    const refused = await asked(unreadable);
    const absent = await asked(missing);
    (door.absent ?? itemNotFound)(absent);
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
    expect((bulk.body as { results: unknown[] }).results).toEqual([
      {
        index: 0,
        outcome: "errored",
        error: {
          code: "id_reused",
          message: `Edge id ${hiddenEdge} already names a different edge`,
          details: { existing_id: hiddenEdge },
        },
      },
    ]);

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
    const missing = generateId();
    const own = await note();
    const ownEdge = await edge(own, task);
    const entry = (source: string) => ({
      edges: [{ source_id: source, target_id: task, edge_type: "about" }],
    });
    // Each door, asked of a row that exists and of an id nothing holds, and
    // what a key reaching one type is answered there.
    type Reached = [
      string,
      string,
      (id: string) => string,
      (id: string) => unknown,
      string,
      string,
      number,
    ];
    const doors: Reached[] = [
      [
        "GET",
        "/items/{id}",
        (id) => `/items/${id}`,
        () => undefined,
        hidden,
        own,
        200,
      ],
      ...[
        "edges",
        "backrefs",
        "versions",
        "metadata",
        "extensions",
        "extensions/unreadable",
      ].map((door): Reached => [
        "GET",
        `/items/{id}/${door}`,
        (id) => `/items/${id}/${door}`,
        () => undefined,
        hidden,
        own,
        200,
      ]),
      [
        "GET",
        "/edges/{id}",
        (id) => `/edges/${id}`,
        () => undefined,
        hiddenEdge,
        ownEdge,
        200,
      ],
      [
        "POST",
        "/edges/bulk, one entry",
        () => "/edges/bulk",
        entry,
        hidden,
        own,
        200,
      ],
      [
        "POST",
        "/edges/bulk, no entry",
        () => "/edges/bulk",
        () => ({ edges: [] }),
        hidden,
        own,
        200,
      ],
    ];
    for (const [method, name, path, body, held, reached, served] of doors) {
      const refused = without(
        await ask(operator, method, path(held), body(held)),
        held,
      );
      const absent = without(
        await ask(operator, method, path(missing), body(missing)),
        missing,
      );
      expect(refused.status, name).toBe(403);
      expect(refused.body, name).toMatchObject({
        error: { code: "type_not_permitted" },
      });
      expect(absent, name).toEqual(refused);
      // The witness: a key reaching one type is served at the same door.
      expect(
        (await ask(key, method, path(reached), body(reached))).status,
        name,
      ).toBe(served);
    }
  });

  it("a filter term anchored on an item it cannot read matches as one anchored on no item", async () => {
    const source = encodeURIComponent(`${ctx.source}-unreadable-items`);
    const terms: [string, (id: string) => string][] = [
      ["GET /items, backref shorthand", (id) => `/items?backref[about]=${id}`],
      [
        "GET /items, backref neq",
        (id) =>
          `/items?source=${source}&limit=200&filter=${encodeURIComponent(`backref[about] neq "${id}"`)}`,
      ],
      [
        "GET /search, backref",
        (id) =>
          `/search?q=note&filter=${encodeURIComponent(`backref[about] eq "${id}"`)}`,
      ],
      [
        "POST /items/bulk-actions, backref dry run",
        (id) => `/items/bulk-actions#${id}`,
      ],
    ];
    const asked = async (path: string): Promise<Seen> => {
      if (!path.startsWith("/items/bulk-actions#"))
        return ask(key, "GET", path);
      const id = path.slice("/items/bulk-actions#".length);
      return ask(key, "POST", "/items/bulk-actions", {
        filter: { filter: `backref[about] eq "${id}"` },
        action: "update_tags",
        add: ["unreadable-anchor"],
        dry_run: true,
      });
    };
    for (const anchor of [hidden, hiddenTrashed]) {
      for (const [name, path] of terms) {
        const missing = generateId();
        const seen = without(await asked(path(anchor)), anchor);
        const absent = without(await asked(path(missing)), missing);
        expect([200, 202], name).toContain(absent.status);
        expect(seen, name).toEqual(absent);
      }
    }

    // The witness: the hidden anchors do have edges out, which the owner's
    // listing finds, so the pages above hid them rather than lacked them.
    for (const anchor of [hidden, hiddenTrashed]) {
      const owned = await client.listItems({
        backref: { about: anchor },
        limit: 100,
      });
      expect(owned.data.data.length, anchor).toBeGreaterThan(0);
    }
    // And one anchored on an item the key may read matches.
    const pointer = await note();
    const target = await note();
    const readable = await ask(key, "POST", "/edges", {
      source_id: pointer,
      target_id: target,
      edge_type: "about",
    });
    expect(readable.status).toBe(201);
    trackEdge(ctx, (readable.body as { edge: { id: string } }).edge.id);
    const back = await ask(key, "GET", `/items?backref[about]=${pointer}`);
    expect(
      (back.body as { data: { id: string }[] }).data.map((row) => row.id),
    ).toContain(target);
  });

  it("an outbound term naming an item it cannot read matches the readable edges to it", async () => {
    // A readable edge names its target whoever reads it (`edges.md` 22), so
    // the term answers from that edge, as a device holding it does.
    const pointer = await note();
    const into = await client.createEdge({
      source_id: pointer,
      target_id: hidden,
      edge_type: "about",
    });
    expect(into.status).toBe(201);
    trackEdge(ctx, into.data.edge.id);
    const matched = await ask(key, "GET", `/items?edge[about]=${hidden}`);
    expect(matched.status).toBe(200);
    expect(
      (matched.body as { data: { id: string }[] }).data.map((row) => row.id),
    ).toContain(pointer);
  });

  it("replays a hidden row's 404 under its Idempotency-Key, as it replays a missing id's", async () => {
    const replayed = async (id: string): Promise<[Seen, Seen]> => {
      const headers = {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        "Idempotency-Key": generateId(),
      };
      const send = async (): Promise<Seen> => {
        const res = await fetch(`${apiUrl}/items/${id}/transition`, {
          method: "POST",
          headers,
          body: JSON.stringify({ state: "archived" }),
        });
        const kept: Record<string, string> = {};
        for (const [name, value] of res.headers) {
          if (!PER_REQUEST_HEADERS.has(name)) kept[name] = value;
        }
        return without(
          {
            status: res.status,
            headers: kept,
            body: JSON.parse(await res.text()) as unknown,
          },
          id,
        );
      };
      return [await send(), await send()];
    };
    const [hiddenFirst, hiddenAgain] = await replayed(hidden);
    const [missingFirst, missingAgain] = await replayed(generateId());
    // The witness: a missing id's 404 is recorded, and its repeat is a replay.
    expect(missingFirst.status).toBe(404);
    expect(missingFirst.headers["idempotency-replayed"]).toBeUndefined();
    expect(missingAgain.headers["idempotency-replayed"]).toBe("true");
    expect(hiddenFirst).toEqual(missingFirst);
    expect(hiddenAgain).toEqual(missingAgain);
  });

  it("an edge of a type it cannot read answers as a missing edge on every door naming it", async () => {
    const hiddenKind = await client.createKey({
      label: "unreadable-edge-kind",
      source: `${ctx.source}-unreadable-edge-kind`,
      permissions: [],
      type_permissions: { "core.note": "write", "core.task": "read" },
      edge_permissions: { references: "write" },
    });
    expect(hiddenKind.ok).toBe(true);
    trackKey(ctx, hiddenKind.data.id);
    const narrow = hiddenKind.data.key;
    const from = await note();
    const aboutEdge = await edge(from, task);
    const doors: [string, unknown][] = [
      ["GET", undefined],
      ["PATCH", { version: 1, properties: { weight: 2 } }],
      ["DELETE", undefined],
    ];
    for (const [method, body] of doors) {
      const missing = generateId();
      const seen = without(
        await ask(narrow, method, `/edges/${aboutEdge}`, body),
        aboutEdge,
      );
      const absent = without(
        await ask(narrow, method, `/edges/${missing}`, body),
        missing,
      );
      expect(absent.status, method).toBe(404);
      expect(absent.body, method).toMatchObject({
        error: { code: "edge_not_found" },
      });
      expect(seen, method).toEqual(absent);
    }
    // The witness: an edge of a type it holds is served at the same door.
    const own = await edge(from, task, "references");
    expect((await ask(narrow, "GET", `/edges/${own}`)).status).toBe(200);
  });
});
