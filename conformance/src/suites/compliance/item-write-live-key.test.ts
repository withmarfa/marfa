import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { ApiResponse } from "../../client/types.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { DISK_ONLY } from "../../utils/own-blob-server.js";
import { generateId } from "../../generators/items.js";

/**
 * An item write is judged by the key as it stands when it commits
 * (`items/write-race-key-narrowed`, `items/write-race-key-revoked`).
 *
 * Each case holds the key's write after the server has admitted it and before
 * it opens its transaction (`hold:write`), changes the key through the API,
 * and releases the write. A server that judged the write by the key it read
 * on admission would write with a grant already taken back. Each case first
 * sends the same write with no change to the key, which is written, so the
 * refusal is the change's and not the request's.
 */
let server: FreshServer;
let admin: MarfaClient;
let serial = 0;

beforeAll(async () => {
  server = await bootFreshServer("item-write-live-key", DISK_ONLY);
  admin = new MarfaClient({
    baseUrl: server.apiUrl,
    apiKey: server.workingKey,
  });
}, FRESH_SERVER_TIMEOUT_MS);
afterEach(async () => {
  await server.clearFault();
});
afterAll(async () => {
  await server.stop();
}, FRESH_SERVER_TIMEOUT_MS);

interface Writer {
  id: string;
  client: MarfaClient;
}

/** A key that writes notes and purges them, and does nothing else. */
async function writer(): Promise<Writer> {
  serial += 1;
  const source = `live-key-${String(serial)}`;
  const minted = await admin.createKey({
    label: source,
    source,
    permissions: ["items.purge"],
    type_permissions: { "core.note": "write" },
  });
  expect(minted.status, JSON.stringify(minted.error)).toBe(201);
  return {
    id: minted.data.id,
    client: new MarfaClient({
      baseUrl: server.apiUrl,
      apiKey: minted.data.key,
    }),
  };
}

async function note(body: string) {
  const made = await admin.createItem({
    type: "core.note",
    properties: { body },
  });
  expect(made.status, JSON.stringify(made.error)).toBe(201);
  return made.data.item;
}

/** What a door sends, and how to tell that it wrote. */
interface Door {
  /** The audit action the write is held under, so no other write is held. */
  action: string;
  /** Set the rows up as the working key, and answer the write. */
  prepare: (key: MarfaClient) => Promise<{
    send: () => Promise<ApiResponse<unknown>>;
    /** Whether the write is on the server now. */
    written: () => Promise<boolean>;
  }>;
}

const bodyOf = async (id: string): Promise<unknown> => {
  const read = await admin.getItem(id);
  return read.status === 200 ? read.data.item.properties.body : undefined;
};
/** Whether the bin holds the row, which is not readable by id. */
const binned = async (id: string): Promise<boolean> => {
  const listed = await admin.listItems({ state: "trashed", limit: 100 });
  return listed.data.data.some((item) => item.id === id);
};
const readable = async (id: string): Promise<boolean> =>
  (await admin.getItem(id)).ok;

const create: Door = {
  action: "item.create",
  prepare: (key) => {
    const id = generateId();
    return Promise.resolve({
      send: () =>
        key.createItem({
          id,
          type: "core.note",
          properties: { body: "created" },
        }),
      written: async () => (await bodyOf(id)) === "created",
    });
  },
};
const update: Door = {
  action: "item.update",
  prepare: async (key) => {
    const item = await note("before");
    return {
      send: () =>
        key.updateItem(item.id, {
          version: item.version,
          properties: { body: "after" },
        }),
      written: async () => (await bodyOf(item.id)) === "after",
    };
  },
};
const remove: Door = {
  action: "item.delete",
  prepare: async (key) => {
    const item = await note("before");
    return {
      send: () => key.deleteItem(item.id),
      written: () => binned(item.id),
    };
  },
};
const purge: Door = {
  action: "item.purge",
  prepare: async (key) => {
    const item = await note("before");
    expect((await admin.deleteItem(item.id)).status).toBe(200);
    return {
      send: () => key.purgeItem(item.id),
      written: async () => !(await binned(item.id)),
    };
  },
};
const restore: Door = {
  action: "item.restore",
  prepare: async (key) => {
    const item = await note("before");
    expect((await admin.deleteItem(item.id)).status).toBe(200);
    return {
      send: () => key.restoreItem(item.id),
      written: () => readable(item.id),
    };
  },
};
const transition: Door = {
  action: "item.transition",
  prepare: async (key) => {
    const item = await note("before");
    return {
      send: () => key.transitionItem(item.id, "archived"),
      written: async () =>
        (await admin.getItem(item.id)).data.item.state === "archived",
    };
  },
};
const bulk = (atomic: boolean): Door => ({
  action: "items.bulk",
  prepare: (key) => {
    const id = generateId();
    return Promise.resolve({
      send: () =>
        key.bulkItems({
          atomic,
          items: [{ id, type: "core.note", properties: { body: "bulk" } }],
        }),
      written: async () => (await bodyOf(id)) === "bulk",
    });
  },
});

type Change = (key: Writer) => Promise<void>;
const narrow: Change = async (key) => {
  const changed = await admin.updateKey(key.id, {
    type_permissions: { "core.note": "read" },
  });
  expect(changed.status, JSON.stringify(changed.error)).toBe(200);
};
const revoke: Change = async (key) => {
  const revoked = await admin.revokeKey(key.id);
  expect(revoked.status, JSON.stringify(revoked.error)).toBe(200);
};

/** The write, held after admission while `change` is made to its key. */
async function held(door: Door, change: Change | null) {
  const key = await writer();
  const { send, written } = await door.prepare(key.client);
  await server.setFault(`hold:write=${door.action}@1`);
  const pending = send();
  await server.waitForHold("hold:write");
  if (change) await change(key);
  await server.clearFault("hold:write");
  return { answer: await pending, written };
}

/** The write with no change is written; the same with `change` is not. */
async function refusedAfter(
  door: Door,
  change: Change,
  status: number,
  code: string,
  detailsCode?: string,
): Promise<void> {
  const witness = await held(door, null);
  expect(
    witness.answer.status,
    JSON.stringify(witness.answer.error),
  ).toBeLessThan(300);
  expect(await witness.written(), "the witness write did not land").toBe(true);

  const refused = await held(door, change);
  expect(refused.answer.status).toBe(status);
  expect(refused.answer.error?.error.code).toBe(code);
  if (detailsCode !== undefined) {
    const details = refused.answer.error?.error.details as
      { code?: string } | undefined;
    expect(details?.code).toBe(detailsCode);
  }
  expect(await refused.written()).toBe(false);
}

const NARROWED = [403, "type_not_permitted"] as const;
const ROLLED_BACK = [
  403,
  "bulk_atomic_rollback",
  "type_not_permitted",
] as const;
const REVOKED = [401, "unauthorized"] as const;

it("refuses a create 403 type_not_permitted when its key is narrowed to read after the write is held", async () => {
  await refusedAfter(create, narrow, ...NARROWED);
});

it("refuses an update 403 type_not_permitted when its key is narrowed to read after the write is held", async () => {
  await refusedAfter(update, narrow, ...NARROWED);
});

it("refuses a delete 403 type_not_permitted when its key is narrowed to read after the write is held", async () => {
  await refusedAfter(remove, narrow, ...NARROWED);
});

it("refuses a purge 403 type_not_permitted when its key is narrowed to read after the write is held", async () => {
  await refusedAfter(purge, narrow, ...NARROWED);
});

it("refuses a restore 403 type_not_permitted when its key is narrowed to read after the write is held", async () => {
  await refusedAfter(restore, narrow, ...NARROWED);
});

it("refuses a transition 403 type_not_permitted when its key is narrowed to read after the write is held", async () => {
  await refusedAfter(transition, narrow, ...NARROWED);
});

it("refuses an atomic bulk page 403 bulk_atomic_rollback with type_not_permitted in details.code when its key is narrowed to read after the write is held", async () => {
  await refusedAfter(bulk(true), narrow, ...ROLLED_BACK);
});

it("errors a best-effort bulk entry type_not_permitted when its key is narrowed to read after the write is held", async () => {
  const door = bulk(false);
  const witness = await held(door, null);
  expect(witness.answer.status).toBe(200);
  expect(await witness.written(), "the witness write did not land").toBe(true);

  const refused = await held(door, narrow);
  expect(refused.answer.status).toBe(200);
  const { results } = refused.answer.data as {
    results: { outcome: string; error?: { code: string } }[];
  };
  expect(results[0]?.outcome).toBe("errored");
  expect(results[0]?.error?.code).toBe("type_not_permitted");
  expect(await refused.written()).toBe(false);
});

it("refuses a create 401 when its key is revoked after the write is held", async () => {
  await refusedAfter(create, revoke, ...REVOKED);
});

it("refuses an update 401 when its key is revoked after the write is held", async () => {
  await refusedAfter(update, revoke, ...REVOKED);
});

it("refuses a delete 401 when its key is revoked after the write is held", async () => {
  await refusedAfter(remove, revoke, ...REVOKED);
});

it("refuses a purge 401 when its key is revoked after the write is held", async () => {
  await refusedAfter(purge, revoke, ...REVOKED);
});

it("refuses a restore 401 when its key is revoked after the write is held", async () => {
  await refusedAfter(restore, revoke, ...REVOKED);
});

it("refuses a transition 401 when its key is revoked after the write is held", async () => {
  await refusedAfter(transition, revoke, ...REVOKED);
});

it("refuses an atomic bulk page 401 when its key is revoked after the write is held", async () => {
  await refusedAfter(bulk(true), revoke, ...REVOKED);
});

it("refuses a best-effort bulk page 401 when its key is revoked before its first entry is written", async () => {
  await refusedAfter(bulk(false), revoke, ...REVOKED);
});

/** A best-effort page of two entries, held as its second entry is reached. */
async function secondEntryHeld(change: Change) {
  const key = await writer();
  const ids = [generateId(), generateId()];
  await server.setFault("hold:write=items.bulk@2");
  const pending = key.client.bulkItems({
    atomic: false,
    items: ids.map((id) => ({
      id,
      type: "core.note",
      properties: { body: "bulk" },
    })),
  });
  await server.waitForHold("hold:write");
  await change(key);
  await server.clearFault("hold:write");
  const answer = await pending;
  expect(answer.status, JSON.stringify(answer.error)).toBe(200);
  const { results } = answer.data as {
    results: { outcome: string; error?: { code: string } }[];
  };
  return {
    results,
    first: await bodyOf(ids[0]!),
    second: await bodyOf(ids[1]!),
  };
}

it("errors a later best-effort bulk entry type_not_permitted when its key is narrowed to read after an earlier entry is written", async () => {
  const { results, first, second } = await secondEntryHeld(narrow);
  expect(results.map((r) => r.outcome)).toEqual(["created", "errored"]);
  expect(results[1]?.error?.code).toBe("type_not_permitted");
  expect(first).toBe("bulk");
  expect(second).toBeUndefined();
});

it("errors a later best-effort bulk entry unauthorized when its key is revoked after an earlier entry is written", async () => {
  const { results, first, second } = await secondEntryHeld(revoke);
  expect(results.map((r) => r.outcome)).toEqual(["created", "errored"]);
  expect(results[1]?.error?.code).toBe("unauthorized");
  expect(first).toBe("bulk");
  expect(second).toBeUndefined();
});
