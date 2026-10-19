/**
 * An item write is judged by the key as it stands when its transaction
 * commits, on every door.
 *
 * The race each test stages is a change to the key landing after the door has
 * admitted the request and before its write transaction opens. `PATCH
 * /keys/{id}` narrows a type the key could write to read, or `DELETE
 * /keys/{id}` revokes it, at the moment the door opens its first transaction,
 * which is the latest point a key read outside it could have been read. A door
 * that holds the key it read first writes with a grant the owner has already
 * taken back.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { generateId, getTypeSchema } from "@withmarfa/shared";
import { hashApiKey } from "../middleware/auth.js";
import {
  createTestContext,
  mintWorkingKey,
  raceTheNextTransaction,
  request,
  TEST_API_KEY_SALT,
} from "../test-utils.js";
import type { TestContext } from "../test-utils.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.cleanup();
});

interface Minted {
  secret: string;
  id: string;
  source: string;
}

/** A key that writes notes and reads nothing else. */
async function mint(
  options: Parameters<typeof mintWorkingKey>[1] = {},
): Promise<Minted> {
  const secret = await mintWorkingKey(ctx, {
    type_permissions: { "core.note": "write" },
    ...options,
  });
  const stored = await ctx.storage.keys.validate(
    hashApiKey(secret, TEST_API_KEY_SALT),
  );
  if (!stored) throw new Error("Minted key missing");
  return { secret, id: stored.id, source: stored.source };
}

async function seedNote(
  key: Minted,
  marker: string,
): Promise<{ id: string; version: number }> {
  const res = await request(ctx.app, "POST", "/items", {
    key: key.secret,
    body: { type: "core.note", properties: { body: marker } },
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { item: { id: string; version: number } }).item;
}

async function bodyOf(id: string): Promise<unknown> {
  return (await ctx.storage.items.getIncludingTrashed(id))?.properties.body;
}

/** `PATCH /keys/{id}`, as the owner makes it. */
function narrow(key: Minted, body: object): () => Promise<void> {
  return async () => {
    const res = await ctx.ownerRequest(`/keys/${key.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(200);
  };
}

/** `DELETE /keys/{id}`, as the owner makes it. */
function revokeKey(key: Minted): () => Promise<void> {
  return async () => {
    const res = await ctx.ownerRequest(`/keys/${key.id}`, { method: "DELETE" });
    expect(res.status).toBe(200);
  };
}

const CHANGES = {
  narrowed: {
    status: 403,
    code: "type_not_permitted",
    change: (key: Minted) =>
      narrow(key, { type_permissions: { "core.note": "read" } }),
  },
  revoked: {
    status: 401,
    code: "unauthorized",
    change: (key: Minted) => async (): Promise<void> => {
      const res = await ctx.ownerRequest(`/keys/${key.id}`, {
        method: "DELETE",
      });
      expect(res.status).toBe(200);
    },
  },
} as const;

/** What a door needs on the row before the race, and the request it sends. */
interface Door {
  name: string;
  /** Put the row in the state the request acts on; answers its id. */
  prepare: (
    key: Minted,
  ) => Promise<{ id: string; send: () => Promise<Response> }>;
  /** Whether the row is as it was after a refused request. */
  untouched: (id: string) => Promise<void>;
}

const send = (
  key: Minted,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> =>
  request(ctx.app, method, path, {
    key: key.secret,
    ...(body !== undefined && { body }),
  });

async function trash(key: Minted, id: string): Promise<void> {
  expect((await send(key, "DELETE", `/items/${id}`)).status).toBe(200);
}

async function rowIs(id: string, marker: string, state: string): Promise<void> {
  const row = await ctx.storage.items.getIncludingTrashed(id);
  expect(row?.state).toBe(state);
  expect(row?.properties.body).toBe(marker);
}

const DOORS: Door[] = [
  {
    name: "POST /items",
    prepare: (key) => {
      const id = generateId();
      return Promise.resolve({
        id,
        send: () =>
          send(key, "POST", "/items", {
            id,
            type: "core.note",
            properties: { body: "created" },
          }),
      });
    },
    untouched: async (id) => {
      expect(await ctx.storage.items.getIncludingTrashed(id)).toBeNull();
    },
  },
  {
    name: "PATCH /items/{id}",
    prepare: async (key) => {
      const { id, version } = await seedNote(key, "before");
      return {
        id,
        send: () =>
          send(key, "PATCH", `/items/${id}`, {
            properties: { body: "after" },
            version,
          }),
      };
    },
    untouched: (id) => rowIs(id, "before", "active"),
  },
  {
    name: "DELETE /items/{id}",
    prepare: async (key) => {
      const { id } = await seedNote(key, "before");
      return { id, send: () => send(key, "DELETE", `/items/${id}`) };
    },
    untouched: (id) => rowIs(id, "before", "active"),
  },
  {
    name: "POST /items/{id}/purge",
    prepare: async (key) => {
      const { id } = await seedNote(key, "before");
      await trash(key, id);
      return { id, send: () => send(key, "POST", `/items/${id}/purge`) };
    },
    untouched: (id) => rowIs(id, "before", "trashed"),
  },
  {
    name: "POST /items/{id}/restore",
    prepare: async (key) => {
      const { id } = await seedNote(key, "before");
      await trash(key, id);
      return { id, send: () => send(key, "POST", `/items/${id}/restore`) };
    },
    untouched: (id) => rowIs(id, "before", "trashed"),
  },
  {
    name: "POST /items/{id}/transition",
    prepare: async (key) => {
      const { id } = await seedNote(key, "before");
      return {
        id,
        send: () =>
          send(key, "POST", `/items/${id}/transition`, { state: "archived" }),
      };
    },
    untouched: (id) => rowIs(id, "before", "active"),
  },
];

describe("an item write is judged by the key as it stands inside its transaction", () => {
  for (const door of DOORS) {
    it(`${door.name} proceeds when nothing changes`, async () => {
      const key = await mint();
      const { id, send: go } = await door.prepare(key);
      const res = await go();
      expect(res.status).toBeLessThan(300);
      // The witness: the row the refusals leave alone is one this request
      // does change.
      await expect(door.untouched(id)).rejects.toThrow();
    });

    for (const [kind, expected] of Object.entries(CHANGES)) {
      it(`${door.name} is refused after the key is ${kind}`, async () => {
        const key = await mint();
        const { id, send: go } = await door.prepare(key);
        const race = raceTheNextTransaction(ctx.storage, expected.change(key));
        let res: Response;
        try {
          res = await go();
        } finally {
          race.restore();
        }
        expect(race.fired()).toBe(true);
        expect(res.status).toBe(expected.status);
        expect(res.headers.get("X-Error-Code")).toBe(expected.code);
        await door.untouched(id);
      });
    }
  }

  for (const atomic of [true, false]) {
    it(`POST /items/bulk, atomic: ${String(atomic)}, proceeds when nothing changes`, async () => {
      const key = await mint();
      const id = generateId();
      const res = await send(key, "POST", "/items/bulk", {
        atomic,
        items: [{ id, type: "core.note", properties: { body: "bulk" } }],
      });
      expect(res.status).toBe(200);
      expect(await bodyOf(id)).toBe("bulk");
    });

    for (const [kind, expected] of Object.entries(CHANGES)) {
      it(`POST /items/bulk, atomic: ${String(atomic)}, is refused after the key is ${kind}`, async () => {
        const key = await mint();
        const id = generateId();
        const race = raceTheNextTransaction(ctx.storage, expected.change(key));
        let res: Response;
        try {
          res = await send(key, "POST", "/items/bulk", {
            atomic,
            items: [{ id, type: "core.note", properties: { body: "bulk" } }],
          });
        } finally {
          race.restore();
        }
        expect(race.fired()).toBe(true);
        if (kind === "revoked" || atomic) {
          expect(res.status).toBe(kind === "revoked" ? 401 : 403);
          if (kind === "narrowed") {
            const { error } = (await res.json()) as {
              error: { details: { code: string } };
            };
            expect(error.details.code).toBe(expected.code);
          }
        } else {
          expect(res.status).toBe(200);
          const { results } = (await res.json()) as {
            results: { outcome: string; error?: { code: string } }[];
          };
          expect(results[0]?.outcome).toBe("errored");
          expect(results[0]?.error?.code).toBe(expected.code);
        }
        expect(await ctx.storage.items.getIncludingTrashed(id)).toBeNull();
      });
    }
  }
});

/**
 * A door that is not an item write but judges its caller by the key's grants
 * does so on the key as it stands inside its own transaction as well.
 */
describe("the doors beside the item writes are judged by the key as it stands", () => {
  async function raced<T>(
    change: () => Promise<void>,
    go: () => Promise<T>,
  ): Promise<T> {
    const race = raceTheNextTransaction(ctx.storage, change);
    try {
      const res = await go();
      expect(race.fired()).toBe(true);
      return res;
    } finally {
      race.restore();
    }
  }

  for (const door of ["PUT", "DELETE"] as const) {
    it(`${door} /items/{id}/extensions/{namespace} after the extension grant is narrowed`, async () => {
      const key = await mint({ extension_permissions: { "*": "write" } });
      const { id } = await seedNote(key, "before");
      const call = () =>
        send(
          key,
          door,
          `/items/${id}/extensions/live-key`,
          door === "PUT" ? { a: 1 } : undefined,
        );
      if (door === "DELETE") {
        expect(
          (await send(key, "PUT", `/items/${id}/extensions/live-key`, { a: 1 }))
            .status,
        ).toBe(200);
      }
      const res = await raced(
        narrow(key, { extension_permissions: { "*": "read" } }),
        call,
      );
      expect(res.status).toBe(403);
      const held = (await ctx.storage.metadata.getExtensions(id))["live-key"];
      expect(held).toEqual(door === "PUT" ? undefined : { a: 1 });
    });
  }

  it("POST /items/tombstones after the type is narrowed", async () => {
    const key = await mint();
    const body = {
      type: "core.note",
      source: key.source,
      source_ids: ["gone"],
      settled_at: "2026-01-01T00:00:00Z",
    };
    expect((await send(key, "POST", "/items/tombstones", body)).status).toBe(
      200,
    );
    const res = await raced(
      narrow(key, { type_permissions: { "core.note": "read" } }),
      () => send(key, "POST", "/items/tombstones", body),
    );
    expect(res.status).toBe(403);
    expect(res.headers.get("X-Error-Code")).toBe("type_not_permitted");
  });

  it("POST /blobs after the key stops writing any type", async () => {
    const key = await mint();
    const upload = async (bytes: string): Promise<Response> =>
      await ctx.app.request("/blobs", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key.secret}`,
          "Content-Type": "text/plain",
        },
        body: bytes,
      });
    expect((await upload("allowed bytes")).status).toBe(201);
    const refused = "refused bytes";
    const res = await raced(
      narrow(key, { type_permissions: { "core.note": "read" } }),
      () => upload(refused),
    );
    expect(res.status).toBe(403);
    const hash = `sha256:${createHash("sha256").update(refused).digest("hex")}`;
    expect(await ctx.storage.blobs.get(hash)).toBeNull();
  });

  for (const door of [
    "POST /folders",
    "PATCH /folders/{id}",
    "POST /folders/{id}/revoke",
  ] as const) {
    it(`${door} after the folder type is narrowed`, async () => {
      const key = await mint({
        type_permissions: { "system.folder": "write" },
      });
      const made = await send(key, "POST", "/folders", { title: "Before" });
      expect(made.status).toBe(201);
      const folder = (
        (await made.json()) as {
          item: { id: string; version: number };
        }
      ).item;
      const call = () =>
        door === "POST /folders"
          ? send(key, "POST", "/folders", { title: "After" })
          : door === "PATCH /folders/{id}"
            ? send(key, "PATCH", `/folders/${folder.id}`, {
                title: "After",
                version: folder.version,
              })
            : send(key, "POST", `/folders/${folder.id}/revoke`);
      const res = await raced(
        narrow(key, { type_permissions: { "system.folder": "read" } }),
        call,
      );
      expect(res.status).toBe(403);
      const row = await ctx.storage.items.getIncludingTrashed(folder.id);
      if (door === "PATCH /folders/{id}")
        expect(row?.properties.title).toBe("Before");
      if (door === "POST /folders/{id}/revoke")
        expect(row?.state).toBe("active");
    });
  }

  it("POST /types after the key loses write on the type's id", async () => {
    const key = await mint({
      type_permissions: { "*": "write" },
      metadata_permissions: { types: "write" },
    });
    const register = (id: string) =>
      send(key, "POST", "/types", {
        id,
        label: "Live key",
        version: 1,
        fields: { body: { type: "string" } },
      });
    const suffix = key.id.slice(-8).replace(/[^a-z0-9]/g, "x");
    expect((await register(`user.livekey${suffix}a`)).status).toBe(201);
    const refused = `user.livekey${suffix}b`;
    const res = await raced(
      narrow(key, { type_permissions: { "core.note": "read" } }),
      () => register(refused),
    );
    expect(res.status).toBe(403);
    expect(getTypeSchema(refused)).toBeUndefined();
  });

  it("PUT /types/{id} after the key loses write on the type", async () => {
    const key = await mint({
      type_permissions: { "*": "write" },
      metadata_permissions: { types: "write" },
    });
    const suffix = key.id.slice(-8).replace(/[^a-z0-9]/g, "x");
    const id = `user.livekey${suffix}c`;
    const definition = (label: string) => ({
      id,
      label,
      version: 1,
      fields: { body: { type: "string" } },
    });
    expect(
      (await send(key, "POST", "/types", definition("Before"))).status,
    ).toBe(201);
    const res = await raced(
      narrow(key, { type_permissions: { "core.note": "read" } }),
      () => send(key, "PUT", `/types/${id}`, definition("After")),
    );
    expect(res.status).toBe(403);
    expect(getTypeSchema(id)?.label).toBe("Before");
  });

  it("POST /edges/bulk answers a source the key can no longer read as an unknown one", async () => {
    const key = await mint({ edge_permissions: { "*": "write" } });
    const { id: from } = await seedNote(key, "from");
    const { id: to } = await seedNote(key, "to");
    const edge = { source_id: from, target_id: to, edge_type: "about" };
    const bulk = () =>
      send(key, "POST", "/edges/bulk", { atomic: false, edges: [edge] });
    const witness = await bulk();
    expect(witness.status).toBe(200);
    expect(
      ((await witness.json()) as { results: { outcome: string }[] }).results[0]
        ?.outcome,
    ).toBe("created");
    const res = await raced(
      narrow(key, { type_permissions: { "core.task": "read" } }),
      bulk,
    );
    expect(res.status).toBe(200);
    const { results } = (await res.json()) as {
      results: { outcome: string; error?: { code: string } }[];
    };
    expect(results[0]?.outcome).toBe("errored");
    expect(results[0]?.error?.code).toBe("item_not_found");
  });

  async function connectorKey(): Promise<{ key: Minted; id: string }> {
    const key = await mint({
      type_permissions: { "core.note": "read" },
    });
    const registered = await send(key, "POST", "/connectors", {
      name: key.source,
    });
    expect(registered.status).toBe(201);
    const { id } = (await registered.json()) as { id: string };
    const held = await send(key, "POST", `/connectors/${id}/hold`, {
      process: "p",
    });
    expect(held.status).toBe(200);
    return { key, id };
  }

  it("POST /connectors/{id}/agreements skips a row the key can no longer read", async () => {
    const { key, id } = await connectorKey();
    const row = await seedNote(await mint(), "agreed");
    const write = () =>
      send(key, "POST", `/connectors/${id}/agreements`, {
        process: "p",
        set: [{ item_id: row.id, waiting: false, record: {} }],
      });
    const witness = await write();
    expect(witness.status).toBe(200);
    expect(await witness.json()).toMatchObject({ written: 1, skipped: [] });
    const res = await raced(
      narrow(key, { type_permissions: { "core.task": "read" } }),
      write,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      written: 0,
      skipped: [row.id],
    });
  });

  for (const [door, path, body] of [
    ["POST /connectors/{id}/hold", "hold", { process: "p" }],
    ["POST /connectors/{id}/heartbeat", "heartbeat", undefined],
  ] as const) {
    it(`${door} after the connector's key is revoked`, async () => {
      const { key, id } = await connectorKey();
      const call = () => send(key, "POST", `/connectors/${id}/${path}`, body);
      expect((await call()).status).toBeLessThan(300);
      const res = await raced(revokeKey(key), call);
      expect(res.status).toBe(401);
    });
  }
});
