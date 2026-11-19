import { afterAll, beforeAll, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { rmSync } from "node:fs";
import { dirname } from "node:path";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import { CliDevice, newStore } from "../../device/cli-adapter.js";
import type { Outcome, QueuedWrite } from "../../device/protocol.js";
import {
  cleanup,
  createTestContext,
  trackItem,
  trackKey,
} from "../../utils/setup.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import {
  connect,
  issuerOrigin,
  registerApp,
  signIn,
} from "../../utils/signed-in.js";
import { requireBinary } from "./harness.js";

/**
 * An update and a delete whose answers were lost under one key, drained under
 * the key that replaced it, against a real server and the real binary. The
 * server holds an idempotency key to the credential that sent it
 * (`items/idempotency-credential`), so the device reads what the server holds
 * before it sends either again (`queue-and-verdicts/resend-read-first`).
 */

let client: MarfaClient;
let ctx: TestContext;
let apiUrl: string;
beforeAll(async () => {
  ({ client, ctx, apiUrl } = await createTestContext(
    "device",
    "resend-credential",
  ));
});
afterAll(async () => {
  if (ctx) await cleanup(ctx);
});

function value<T>(answer: Outcome<T>): T {
  expect(answer.ok, JSON.stringify(answer)).toBe(true);
  if (!answer.ok) throw new Error(answer.refusal.raw);
  return answer.value;
}

async function keyHolding(
  label: string,
  type = "core.note",
  edges?: Record<string, string>,
): Promise<{ key: string; source: string }> {
  const source = `${ctx.source}-${label}-${randomUUID().slice(0, 8)}`;
  const minted = await client.createKey({
    label: source,
    source,
    type_permissions: { [type]: "write" },
    ...(edges ? { edge_permissions: edges } : {}),
  });
  expect(minted.ok, JSON.stringify(minted.error)).toBe(true);
  trackKey(ctx, minted.data.id);
  return { key: minted.data.key, source };
}

interface Sent {
  door: string;
  authorization: string | undefined;
  key: string | undefined;
  replayed: string | null;
}

/**
 * Forwards every request to the server. While `losing` is `"after"`, it
 * drops the answer to a write at one of `doors` once the server has
 * answered; while it is `"before"`, it drops the write unsent. While
 * `readsLost` is above 0, it drops that many reads of a door's subject.
 * It forwards to `target`, the shared server unless named.
 */
function proxyTo(doors: () => string[], target: string = apiUrl) {
  const sent: Sent[] = [];
  const state: { losing: "after" | "before" | null; readsLost: number } = {
    losing: null,
    readsLost: 0,
  };
  const proxy = createServer(async (request, response) => {
    try {
      const bytes: Buffer[] = [];
      for await (const chunk of request) bytes.push(Buffer.from(chunk));
      const body = Buffer.concat(bytes);
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) {
        if (
          value !== undefined &&
          ![
            "host",
            "connection",
            "transfer-encoding",
            "content-length",
          ].includes(name)
        )
          headers.set(name, Array.isArray(value) ? value.join(", ") : value);
      }
      const path = request.url?.split("?")[0];
      const door = `${request.method} ${path}`;
      const watched = doors().includes(door);
      if (
        request.method === "GET" &&
        state.readsLost > 0 &&
        doors().some((watched) => watched.endsWith(` ${path}`))
      ) {
        state.readsLost -= 1;
        request.socket.destroy();
        return;
      }
      if (watched && state.losing === "before") {
        sent.push({
          door,
          authorization: headers.get("authorization") ?? undefined,
          key: headers.get("idempotency-key") ?? undefined,
          replayed: null,
        });
        request.socket.destroy();
        return;
      }
      const upstream = await fetch(
        `${target.replace(/\/$/, "")}${request.url}`,
        {
          method: request.method,
          headers,
          ...(body.length === 0 ? {} : { body }),
        },
      );
      if (watched)
        sent.push({
          door,
          authorization: headers.get("authorization") ?? undefined,
          key: headers.get("idempotency-key") ?? undefined,
          replayed: upstream.headers.get("idempotency-replayed"),
        });
      if (watched && state.losing === "after") {
        await upstream.arrayBuffer();
        request.socket.destroy();
        return;
      }
      const returned = Object.fromEntries(upstream.headers);
      delete returned["content-length"];
      delete returned["content-encoding"];
      response.writeHead(upstream.status, returned);
      if (!upstream.body) response.end();
      else {
        const stream = Readable.fromWeb(
          upstream.body as import("node:stream/web").ReadableStream,
        );
        stream.on("error", () => response.destroy());
        response.on("close", () => stream.destroy());
        stream.pipe(response);
      }
    } catch {
      response.destroy();
    }
  });
  return { proxy, sent, state };
}

async function note(title: string): Promise<{ id: string; version: number }> {
  const made = await client.createItem({
    type: "core.note",
    source: ctx.source,
    tier: "library",
    properties: { title, body: title },
  });
  expect(made.ok, JSON.stringify(made.error)).toBe(true);
  trackItem(ctx, made.data.item.id);
  return { id: made.data.item.id, version: made.data.item.version };
}

/**
 * Queues one write under `first` on a device of its own, sends it with its
 * answer lost as `losing` says, and drains again under `then`, through the
 * proxy, which no longer loses anything. A lost answer ends a drain, so the
 * edit and the delete each get their own device. With `readsLost`, a drain
 * under `then` first meets that many reads of the subject lost, and what it
 * left is returned as `held`. The device under `then` holds `thenType`, and
 * `between` runs before it drains. `after` gets a device on the same copy
 * under a key it names. With `upstream`, the proxy forwards to that server.
 */
async function lostOnce(
  losing: "after" | "before",
  keys: { first: string; then: string },
  door: string,
  write: (device: CliDevice) => Promise<QueuedWrite>,
  readsLost = 0,
  options: {
    thenType?: string;
    upstream?: string;
    between?: () => Promise<void>;
    after?: (
      device: CliDevice,
      queued: QueuedWrite,
      under: (key: string) => CliDevice,
    ) => Promise<void>;
  } = {},
) {
  const { proxy, sent, state } = proxyTo(() => [door], options.upstream);
  const store = newStore("resend-credential");
  try {
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    const address = proxy.address();
    if (!address || typeof address === "string")
      throw new Error("no proxy port");
    const url = `http://127.0.0.1:${address.port}`;
    const before = new CliDevice({
      binary: requireBinary(),
      store,
      url,
      key: keys.first,
    });
    value(await before.hydrate(["core.note"], "library"));
    const queued = await write(before);
    state.losing = losing;
    value(await before.drain());
    expect(
      sent.map((seen) => [seen.door, seen.authorization]),
      "the write never went out under the first key",
    ).toEqual([[door, `Bearer ${keys.first}`]]);
    state.losing = null;

    const after = new CliDevice({
      binary: requireBinary(),
      store,
      url,
      key: keys.then,
    });
    if (keys.then !== keys.first)
      value(await after.hydrate([options.thenType ?? "core.note"], "library"));
    await options.between?.();
    let held = null;
    if (readsLost > 0) {
      state.readsLost = readsLost;
      const drained = value(await after.drain());
      const queue = value(await after.queue());
      held = {
        drained,
        row: queue.find((row) => row.id === queued.id),
        again: sent.slice(1),
        readsLeft: state.readsLost,
      };
    }
    const drained = value(await after.drain());
    const queue = value(await after.queue());
    const row = queue.find((row) => row.id === queued.id);
    const again = sent.slice(1);
    await options.after?.(
      after,
      queued,
      (key) => new CliDevice({ binary: requireBinary(), store, url, key }),
    );
    return {
      drained,
      row,
      again,
      later: sent.slice(1 + again.length),
      held,
    };
  } finally {
    proxy.closeAllConnections();
    proxy.close();
    rmSync(dirname(store), { recursive: true, force: true });
  }
}

/**
 * Edits one note and deletes another under a first key, each answer lost as
 * `losing` says, then drains each under the first key or a second one.
 */
async function lostThenDrained(
  losing: "after" | "before",
  then: "first" | "second",
) {
  const first = await keyHolding(`${losing}-${then}-first`);
  const second = await keyHolding(`${losing}-${then}-second`);
  const keys = {
    first: first.key,
    then: then === "first" ? first.key : second.key,
  };
  const edited = await note(`edited ${losing} ${then}`);
  const deleted = await note(`deleted ${losing} ${then}`);
  const title = `edited ${losing} ${then} ${ctx.runId}`;
  const edit = await lostOnce(
    losing,
    keys,
    `PATCH /items/${edited.id}`,
    async (device) =>
      value(
        await device.update(edited.id, {
          properties: { title },
          version: edited.version,
        }),
      ),
  );
  const remove = await lostOnce(
    losing,
    keys,
    `DELETE /items/${deleted.id}`,
    async (device) => value(await device.deleteItem(deleted.id)),
  );
  return {
    drained: [edit.drained, remove.drained],
    edit: edit.row,
    remove: remove.row,
    again: [...edit.again, ...remove.again],
    title,
    edited,
    deleted,
    second,
  };
}

async function itemVersion(
  id: string,
): Promise<{ version: number; title: unknown }> {
  const read = await client.getItem(id);
  expect(read.ok, JSON.stringify(read.error)).toBe(true);
  return {
    version: read.data.item.version,
    title: read.data.item.properties.title,
  };
}

async function inBin(id: string): Promise<boolean> {
  const live = await client.getItem(id);
  const trashed = await client.getItem(id, "trashed");
  return !live.ok && trashed.ok && trashed.data.item.state === "trashed";
}

async function listedBy(source: string): Promise<string[]> {
  const listed = await client.listItems({
    type: "core.note",
    source,
    tier: "all",
  });
  expect(listed.ok, JSON.stringify(listed.error)).toBe(true);
  return listed.data.data.map((item) => item.id);
}

async function copiesBy(source: string): Promise<number> {
  const listed = await client.listItems({
    type: "core.note",
    source,
    tier: "all",
  });
  expect(listed.ok, JSON.stringify(listed.error)).toBe(true);
  return listed.data.data.length;
}

it("settles an edit and a delete whose answers were lost under a replaced key from what the server holds, writing neither again", async () => {
  const run = await lostThenDrained("after", "second");
  expect(
    [run.edit?.verdict, run.remove?.verdict],
    JSON.stringify(run.drained),
  ).toEqual(["accepted", "accepted"]);
  expect(run.edit?.conflicted_copy_id ?? null).toBeNull();
  expect(
    run.again,
    "a write the server had applied went out again under the new key",
  ).toEqual([]);
  expect(await itemVersion(run.edited.id)).toEqual({
    version: run.edited.version + 1,
    title: run.title,
  });
  expect(await inBin(run.deleted.id)).toBe(true);
  expect(await copiesBy(run.second.source)).toBe(0);
});

it("sends again under the replaced key's successor an edit and a delete the server never received, and each is applied once", async () => {
  const run = await lostThenDrained("before", "second");
  expect(
    [run.edit?.verdict, run.remove?.verdict],
    JSON.stringify(run.drained),
  ).toEqual(["accepted", "accepted"]);
  expect(run.again.map((seen) => [seen.door, seen.authorization])).toEqual(
    expect.arrayContaining([
      [`PATCH /items/${run.edited.id}`, `Bearer ${run.second.key}`],
      [`DELETE /items/${run.deleted.id}`, `Bearer ${run.second.key}`],
    ]),
  );
  expect(run.again).toHaveLength(2);
  expect(await itemVersion(run.edited.id)).toEqual({
    version: run.edited.version + 1,
    title: run.title,
  });
  expect(await inBin(run.deleted.id)).toBe(true);
});

it("sends again under the same key an edit and a delete whose answers were lost, and the server answers each from its record", async () => {
  const run = await lostThenDrained("after", "first");
  expect(
    [run.edit?.verdict, run.remove?.verdict],
    JSON.stringify(run.drained),
  ).toEqual(["accepted", "accepted"]);
  expect(run.again.map((seen) => [seen.door, seen.replayed])).toEqual(
    expect.arrayContaining([
      [`PATCH /items/${run.edited.id}`, "true"],
      [`DELETE /items/${run.deleted.id}`, "true"],
    ]),
  );
  expect(run.again).toHaveLength(2);
  expect(await itemVersion(run.edited.id)).toEqual({
    version: run.edited.version + 1,
    title: run.title,
  });
  expect(await inBin(run.deleted.id)).toBe(true);
});

it("leaves an edit whose answer was lost under a replaced key unsent and waiting while the read of what the server holds gets no answer", async () => {
  const first = await keyHolding("unread-first");
  const second = await keyHolding("unread-second");
  const edited = await note("edited unread");
  const title = `edited unread ${ctx.runId}`;
  const run = await lostOnce(
    "after",
    { first: first.key, then: second.key },
    `PATCH /items/${edited.id}`,
    async (device) =>
      value(
        await device.update(edited.id, {
          properties: { title },
          version: edited.version,
        }),
      ),
    1,
  );
  expect(run.held?.readsLeft, "the drain never read the edit's item").toBe(0);
  expect(run.held?.row?.verdict ?? null).toBeNull();
  expect(run.held?.drained.unavailable ?? null).not.toBeNull();
  expect(run.held?.again, "the edit went out unread").toEqual([]);
  // The witness: the next drain reads the item and settles the edit.
  expect(run.row?.verdict, JSON.stringify(run.drained)).toBe("accepted");
  expect(run.again).toEqual([]);
  expect(await itemVersion(edited.id)).toEqual({
    version: edited.version + 1,
    title,
  });
});

it("settles a move to the bin whose answer was lost under a replaced key from the item it finds in the bin, sending nothing again", async () => {
  const first = await keyHolding("trash-first");
  const second = await keyHolding("trash-second");
  const trashed = await note("trashed lost");
  const run = await lostOnce(
    "after",
    { first: first.key, then: second.key },
    `POST /items/${trashed.id}/transition`,
    async (device) => value(await device.transitionItem(trashed.id, "trashed")),
  );
  expect(run.row?.verdict, JSON.stringify(run.drained)).toBe("accepted");
  expect(
    run.again,
    "a move the server had made went out again under the new key",
  ).toEqual([]);
  expect(await inBin(trashed.id)).toBe(true);
});

it("leaves a delete unsettled and unsent where the replaced key's successor cannot read the item it deletes", async () => {
  const first = await keyHolding("unseen-first");
  const second = await keyHolding("unseen-second", "core.task");
  const kept = await note("deleted unseen");
  const run = await lostOnce(
    "before",
    { first: first.key, then: second.key },
    `DELETE /items/${kept.id}`,
    async (device) => value(await device.deleteItem(kept.id)),
    0,
    { thenType: "core.task" },
  );
  expect(run.row?.verdict ?? null, JSON.stringify(run.drained)).toBeNull();
  expect(run.row?.last_failure?.status).toBe(404);
  expect(run.row?.refusals).toBe(1);
  expect(
    run.again,
    "a delete the new key could not judge went out under it",
  ).toEqual([]);
  // The delete never reached the server, which an `accepted` would hide.
  expect((await client.getItem(kept.id)).ok).toBe(true);
});

it("sends a tag the server never received again naming the version it was sent at, and blocks it as a conflict once the item has moved", async () => {
  const first = await keyHolding("tag-first");
  const second = await keyHolding("tag-second");
  const tagged = await note("tagged moved");
  const tag = `kept-${randomUUID().slice(0, 8)}`;
  let released: QueuedWrite | undefined;
  let blockedTags: string[] = [];
  const run = await lostOnce(
    "before",
    { first: first.key, then: second.key },
    `POST /items/${tagged.id}/tags`,
    async (device) => value(await device.addTag(tagged.id, tag)),
    0,
    {
      between: async () => {
        const moved = await client.updateItem(tagged.id, {
          properties: { title: "moved elsewhere" },
          version: tagged.version,
        });
        expect(moved.ok, JSON.stringify(moved.error)).toBe(true);
      },
      after: async (device, queued) => {
        const read = await client.getItem(tagged.id);
        expect(read.ok, JSON.stringify(read.error)).toBe(true);
        blockedTags = read.data.metadata.tags;
        value(await device.release({ id: queued.id }));
        value(await device.drain());
        released = value(await device.queue()).find(
          (row) => row.id === queued.id,
        );
      },
    },
  );
  expect(
    [run.row?.verdict, run.row?.reason],
    JSON.stringify(run.drained),
  ).toEqual(["blocked", "conflict_unresolved"]);
  expect(run.again.map((seen) => seen.authorization)).toEqual([
    `Bearer ${second.key}`,
  ]);
  expect(blockedTags).not.toContain(tag);
  // The witness: released, the tag goes under a fresh key and lands.
  expect(released?.verdict).toBe("accepted");
  expect(run.later).toHaveLength(1);
  expect(run.later[0]?.key).not.toBe(run.again[0]?.key);
  const after = await client.getItem(tagged.id);
  expect(after.ok && after.data.metadata.tags).toContain(tag);
});

it("leaves a create naming no source unsent where the replaced key's successor has another source, making no second item", async () => {
  const first = await keyHolding("create-first");
  const second = await keyHolding("create-second");
  const sourceId = `ext-${randomUUID()}`;
  let backAgain: QueuedWrite | undefined;
  const run = await lostOnce(
    "before",
    { first: first.key, then: second.key },
    "POST /items",
    async (device) =>
      value(
        await device.create({
          type: "core.note",
          properties: { title: `made ${sourceId}`, body: "" },
          sourceId,
        }),
      ),
    0,
    {
      after: async (_device, queued, under) => {
        // The witness: under the key that sent it, it goes again and lands.
        const back = under(first.key);
        value(await back.hydrate(["core.note"], "library"));
        value(await back.drain());
        backAgain = value(await back.queue()).find(
          (row) => row.id === queued.id,
        );
      },
    },
  );
  for (const made of await listedBy(first.source)) trackItem(ctx, made);
  expect(run.row?.verdict ?? null, JSON.stringify(run.drained)).toBeNull();
  expect(run.row?.refusals).toBe(1);
  expect(run.again, "the create went out under the new key").toEqual([]);
  expect(await copiesBy(second.source)).toBe(0);
  expect(backAgain?.verdict).toBe("accepted");
  expect(run.later.map((seen) => seen.authorization)).toEqual([
    `Bearer ${first.key}`,
  ]);
  expect(await copiesBy(first.source)).toBe(1);
});

it("settles a create whose edge type holds more targets than one block of an item read carries from every page, sending nothing again", async () => {
  const first = await keyHolding("edges-first", "core.note", {
    references: "write",
  });
  const second = await keyHolding("edges-second", "core.note", {
    references: "write",
  });
  const targets = await Promise.all(
    Array.from({ length: 51 }, (_, n) => note(`target ${n}`)),
  );
  const sourceId = `ext-${randomUUID()}`;
  const run = await lostOnce(
    "after",
    { first: first.key, then: second.key },
    "POST /items",
    async (device) =>
      value(
        await device.create({
          type: "core.note",
          properties: { title: `linked ${sourceId}`, body: "" },
          sourceId,
          edges: { references: targets.map((target) => target.id) },
        }),
      ),
  );
  for (const made of await listedBy(first.source)) trackItem(ctx, made);
  expect(run.row?.verdict, JSON.stringify(run.drained)).toBe("accepted");
  expect(
    run.again,
    "a create the server had made went out again under the new key",
  ).toEqual([]);
  expect(await copiesBy(first.source)).toBe(1);
  expect(await copiesBy(second.source)).toBe(0);
});

it("leaves a create unsent where the replaced key's successor may not read an edge type it names", async () => {
  const first = await keyHolding("hidden-first", "core.note", {
    references: "write",
  });
  const second = await keyHolding("hidden-second");
  const target = await note("hidden target");
  const sourceId = `ext-${randomUUID()}`;
  let backAgain: QueuedWrite | undefined;
  const run = await lostOnce(
    "after",
    { first: first.key, then: second.key },
    "POST /items",
    async (device) =>
      value(
        await device.create({
          type: "core.note",
          properties: { title: `hidden ${sourceId}`, body: "" },
          source: first.source,
          sourceId,
          edges: { references: [target.id] },
        }),
      ),
    0,
    {
      after: async (_device, queued, under) => {
        // The witness: under the key that sent it, the server answers it
        // from its record.
        const back = under(first.key);
        value(await back.hydrate(["core.note"], "library"));
        value(await back.drain());
        backAgain = value(await back.queue()).find(
          (row) => row.id === queued.id,
        );
      },
    },
  );
  for (const made of await listedBy(first.source)) trackItem(ctx, made);
  expect(run.row?.verdict ?? null, JSON.stringify(run.drained)).toBeNull();
  expect(run.row?.refusals).toBe(1);
  expect(run.again, "the create went out under the new key").toEqual([]);
  expect(backAgain?.verdict).toBe("accepted");
  expect(run.later.map((seen) => [seen.authorization, seen.replayed])).toEqual([
    [`Bearer ${first.key}`, "true"],
  ]);
  expect(await copiesBy(first.source)).toBe(1);
});

/** The items under the natural key `sourceId` on `server`, as its working key reads them. */
async function underKey(
  server: FreshServer,
  sourceId: string,
): Promise<string[]> {
  const response = await fetch(
    `${server.apiUrl}/items?type=core.note&tier=all&limit=100`,
    { headers: { authorization: `Bearer ${server.workingKey}` } },
  );
  expect(response.status).toBe(200);
  const listed = (await response.json()) as {
    data: { id: string; source_id: string | null }[];
  };
  return listed.data
    .filter((item) => item.source_id === sourceId)
    .map((item) => item.id);
}

const APP_SCOPE = "core.note:read core.note:write";

it(
  "sends again under a new sign-in of the same app a create naming no source whose answer was lost, and settles it with the one item the server answers from its record",
  async () => {
    // Signing an app in changes the instance's grants, so it gets its own.
    const server = await bootFreshServer("resend-credential-tokens");
    try {
      const origin = await issuerOrigin(server);
      const cookie = await signIn(server, origin);
      const app = await registerApp(server, APP_SCOPE);
      const first = await connect(server, origin, cookie, app, APP_SCOPE);
      const second = await connect(server, origin, cookie, app, APP_SCOPE);
      const tokens = {
        first: first.access_token ?? "",
        then: second.access_token ?? "",
      };
      expect(tokens.first).not.toBe(tokens.then);
      const sourceId = `ext-${randomUUID()}`;
      let landed: string[] = [];
      const run = await lostOnce(
        "after",
        tokens,
        "POST /items",
        async (device) =>
          value(
            await device.create({
              type: "core.note",
              properties: { title: `made ${sourceId}`, body: "" },
              sourceId,
            }),
          ),
        0,
        {
          upstream: server.apiUrl,
          between: async () => {
            landed = await underKey(server, sourceId);
          },
        },
      );
      expect(landed, "the first send never landed").toHaveLength(1);
      expect(run.row?.verdict, JSON.stringify(run.drained)).toBe("accepted");
      // Another token of the same app and person is the same credential to
      // the server (`items/idempotency-signed-in`), so it answers the key.
      expect(
        run.again.map((seen) => [seen.authorization, seen.replayed]),
        "the create did not go again under the new sign-in",
      ).toEqual([[`Bearer ${tokens.then}`, "true"]]);
      expect(
        await underKey(server, sourceId),
        "a second item was made under the natural key",
      ).toEqual(landed);
    } finally {
      await server.stop();
    }
  },
  FRESH_SERVER_TIMEOUT_MS * 2,
);
