import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { rmSync } from "node:fs";
import { dirname } from "node:path";
import { Readable } from "node:stream";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import { CliDevice, newStore } from "../../device/cli-adapter.js";
import type { DrainReport, Outcome } from "../../device/protocol.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { cleanup, createTestContext, trackItem } from "../../utils/setup.js";
import { requireBinary } from "./harness.js";

/**
 * Which key a released item write goes out under (`queue-and-verdicts.md`,
 * "Releasing, withdrawing and discarding"), against the real server through a
 * proxy that can lose an answer after the server has written it.
 */

let client: MarfaClient;
let ctx: TestContext;
let apiUrl: string;
let apiKey: string;
const proxies: Server[] = [];
const stores: string[] = [];
const servers: FreshServer[] = [];

beforeAll(async () => {
  ({ client, ctx, apiUrl, apiKey } = await createTestContext(
    "device",
    "release-key-live",
  ));
});

afterAll(async () => {
  for (const proxy of proxies) {
    proxy.closeAllConnections();
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
  }
  for (const store of stores)
    rmSync(dirname(store), { recursive: true, force: true });
  for (const server of servers) await server.stop();
  if (ctx) await cleanup(ctx);
}, FRESH_SERVER_TIMEOUT_MS);

function value<T>(answer: Outcome<T>): T {
  expect(answer.ok, JSON.stringify(answer)).toBe(true);
  if (!answer.ok) throw new Error(answer.refusal.raw);
  return answer.value;
}

/** What the proxy does with a write to the watched path once the server has written it. */
type Fate = "pass" | "lose" | "in-flight";

interface Sent {
  key: string | undefined;
  body: string;
  replayed: boolean;
  code: string | null;
}

/**
 * Passes every request to the server. A request to `watched` is written by
 * the server whatever `fate` says, and then answered as it says.
 */
async function proxy(
  watched: (request: IncomingMessage) => boolean,
  upstreamUrl: () => string = () => apiUrl,
): Promise<{
  url: string;
  sent: Sent[];
  fate: { next: Fate; contract?: string };
}> {
  const sent: Sent[] = [];
  const fate: { next: Fate; contract?: string } = { next: "pass" };
  const listener = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks);
      const headers = new Headers();
      for (const [name, held] of Object.entries(request.headers)) {
        if (
          held !== undefined &&
          !["host", "connection", "content-length"].includes(name)
        )
          headers.set(name, Array.isArray(held) ? held.join(", ") : held);
      }
      const upstream = await fetch(
        `${upstreamUrl().replace(/\/$/, "")}${request.url}`,
        {
          method: request.method,
          headers,
          ...(body.length === 0 ? {} : { body }),
          redirect: "manual",
        },
      );
      const returned: Record<string, string> = {};
      upstream.headers.forEach((kept, name) => {
        if (
          !["content-length", "content-encoding", "transfer-encoding"].includes(
            name,
          )
        )
          returned[name] = kept;
      });
      if (fate.contract !== undefined)
        returned["x-marfa-contract"] = fate.contract;
      if (watched(request)) {
        sent.push({
          key: headers.get("idempotency-key") ?? undefined,
          body: body.toString("utf8"),
          replayed: upstream.headers.get("idempotency-replayed") === "true",
          code: upstream.headers.get("x-error-code"),
        });
        if (fate.next === "lose") {
          await upstream.arrayBuffer();
          request.socket.destroy();
          return;
        }
        if (fate.next === "in-flight") {
          await upstream.arrayBuffer();
          response.writeHead(409, {
            ...returned,
            "content-type": "application/json",
          });
          response.end(
            JSON.stringify({
              error: {
                code: "idempotency_key_in_flight",
                message: "The first request under this key is still running.",
              },
            }),
          );
          return;
        }
      }
      response.writeHead(upstream.status, returned);
      if (upstream.body === null) {
        response.end();
        return;
      }
      const stream = Readable.fromWeb(upstream.body as never);
      stream.on("error", () => response.destroy());
      response.on("close", () => stream.destroy());
      stream.pipe(response);
    })().catch(() => response.destroy());
  });
  await new Promise<void>((resolve) =>
    listener.listen(0, "127.0.0.1", resolve),
  );
  proxies.push(listener);
  const { port } = listener.address() as AddressInfo;
  return { url: `http://127.0.0.1:${String(port)}`, sent, fate };
}

async function note(title: string): Promise<{ id: string; version: number }> {
  const made = await client.createItem({
    type: "core.note",
    source: ctx.source,
    tier: "library",
    properties: { title, body: "held" },
  });
  expect(made.ok, JSON.stringify(made.error)).toBe(true);
  trackItem(ctx, made.data.item.id);
  return { id: made.data.item.id, version: made.data.item.version };
}

async function deviceAt(label: string, url: string): Promise<CliDevice> {
  const store = newStore(label);
  stores.push(store);
  const device = new CliDevice({
    binary: requireBinary(),
    store,
    url,
    key: apiKey,
  });
  value(await device.hydrate(["core.note"], "library"));
  return device;
}

async function drainWith(
  device: CliDevice,
  fault: string,
): Promise<Outcome<DrainReport>> {
  process.env.MARFA_TEST_FAULT = fault;
  try {
    return await device.drain();
  } finally {
    delete process.env.MARFA_TEST_FAULT;
  }
}

function told(report: DrainReport, id: string) {
  return report.verdicts
    .filter((entry) => entry.id === id)
    .map((entry) => [entry.verdict, entry.reason ?? null]);
}

async function queued(device: CliDevice, id: string) {
  const found = value(await device.queue()).find((write) => write.id === id);
  expect(found, `the write ${id} left the queue`).toBeDefined();
  return found!;
}

it("sends a set-aside write again under its key once a caller releases it, so the server answers it from its record and keeps the change made since", async () => {
  const { id } = await note("set aside");
  const other = await note("witness");
  const { url, sent, fate } = await proxy(
    (request) =>
      request.method === "PUT" && request.url === `/items/${id}/metadata`,
  );
  const device = await deviceAt("release-key-aside", url);
  const write = value(await device.replaceMetadata(id, ["mine"]));

  fate.next = "lose";
  for (let pass = 0; pass < 3; pass += 1) value(await device.drain());
  const landed = await client.getMetadata(id);
  expect(landed.ok, JSON.stringify(landed.error)).toBe(true);
  expect(
    landed.data.metadata.tags,
    "the server did not write the metadata whose answer the proxy lost, so nothing below is about a write applied twice",
  ).toEqual(["mine"]);
  const since = await client.replaceMetadata(id, { tags: ["theirs"] });
  expect(since.ok, JSON.stringify(since.error)).toBe(true);

  // A write the server answers, which tells a write failing alone from an
  // outage.
  value(
    await device.update(other.id, {
      version: other.version,
      properties: { body: "witness" },
    }),
  );
  const stuck = value(await drainWith(device, "clock-offset=360000"));
  expect(told(stuck, write.id)).toEqual([["blocked", "failing_alone"]]);
  expect((await queued(device, write.id)).idempotency_key).toBe(
    write.idempotency_key,
  );

  expect(value(await device.release({ id: write.id }))).toBe(1);
  expect(
    (await queued(device, write.id)).idempotency_key,
    "a released write whose answer was never read went back out under a key the server holds nothing under, so the server writes it a second time",
  ).toBe(write.idempotency_key);

  // The first send after the release is cut short too: the write goes again
  // under the same key.
  const cut = value(await device.drain());
  expect(told(cut, write.id).map(([verdict]) => verdict)).toEqual([null]);
  fate.next = "pass";
  const again = value(await device.drain());
  expect(told(again, write.id)).toEqual([["accepted", null]]);
  expect(sent.at(-1)?.replayed).toBe(true);
  expect(
    sent.map((one) => one.key),
    "a send went under another key than the write was queued with",
  ).toEqual(sent.map(() => write.idempotency_key));

  const after = await client.getMetadata(id);
  expect(after.ok, JSON.stringify(after.error)).toBe(true);
  expect(
    after.data.metadata.tags,
    "the release wrote the metadata a second time, undoing the change made since",
  ).toEqual(["theirs"]);
  value(await device.catchUp());
  expect(value(await device.get(id)).tags).toEqual(["theirs"]);
});

it("sends a dead write again under its key once a caller releases it", async () => {
  const { id } = await note("dead");
  const { url, sent, fate } = await proxy(
    (request) =>
      request.method === "PUT" &&
      request.url === `/items/${id}/extensions/notes`,
  );
  const device = await deviceAt("release-key-dead", url);
  const write = value(
    await device.writeExtension(id, "notes", { body: "mine" }),
  );

  fate.next = "in-flight";
  for (let pass = 0; pass < 5; pass += 1) value(await device.drain());
  expect((await queued(device, write.id)).verdict).toBe("dead");
  const since = await client.setItemExtension(id, "notes", { body: "theirs" });
  expect(since.ok, JSON.stringify(since.error)).toBe(true);

  expect(value(await device.release({ id: write.id }))).toBe(1);
  expect((await queued(device, write.id)).idempotency_key).toBe(
    write.idempotency_key,
  );
  fate.next = "pass";
  const again = value(await device.drain());
  expect(told(again, write.id)).toEqual([["accepted", null]]);
  expect(sent.at(-1)?.replayed).toBe(true);
  expect(sent.map((one) => one.key)).toEqual(
    sent.map(() => write.idempotency_key),
  );
  const read = await client.getItemExtension(id, "notes");
  expect(read.ok, JSON.stringify(read.error)).toBe(true);
  expect(
    read.data.data,
    "the release wrote the extension a second time, undoing the change made since",
  ).toEqual({ body: "theirs" });
});

it("sends a write blocked conflict_unresolved again under a fresh key once a caller releases it, so the server judges it again", async () => {
  const { id, version } = await note("conflicted");
  const { url, sent } = await proxy(
    (request) =>
      request.method === "DELETE" &&
      request.url?.split("?")[0] === `/items/${id}`,
  );
  const device = await deviceAt("release-key-conflict", url);
  const write = value(await device.deleteItem(id));
  const changed = await client.updateItem(id, {
    version,
    properties: { body: "theirs" },
  });
  expect(changed.ok, JSON.stringify(changed.error)).toBe(true);
  const blocked = value(await device.drain());
  expect(told(blocked, write.id)).toEqual([["blocked", "conflict_unresolved"]]);

  expect(value(await device.release({ id: write.id }))).toBe(1);
  const released = await queued(device, write.id);
  expect(
    released.idempotency_key,
    "a write the server refused under its key went back out under it, so the server answers it from its record with the refusal that stopped it",
  ).not.toBe(write.idempotency_key);
  value(await device.drain());
  expect(sent.map((one) => [one.key, one.replayed])).toEqual([
    [write.idempotency_key, false],
    [released.idempotency_key, false],
  ]);
});

it(
  "takes a write the server applied before it moved to another contract version as accepted, and never writes it again",
  async () => {
    const server = await bootFreshServer("release-key-contract");
    servers.push(server);
    const call = (method: string, path: string, body?: unknown) =>
      fetch(`${server.apiUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${server.workingKey}`,
          "Content-Type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    const tags = async (id: string) => {
      const read = await call("GET", `/items/${id}/metadata`);
      expect(read.status).toBe(200);
      return ((await read.json()) as { metadata: { tags: string[] } }).metadata
        .tags;
    };
    const made = await call("POST", "/items", {
      type: "core.note",
      tier: "library",
      properties: { title: "across contracts", body: "held" },
    });
    expect(made.status).toBe(201);
    const { id } = ((await made.json()) as { item: { id: string } }).item;
    const { url, sent, fate } = await proxy(
      (request) =>
        request.method === "PUT" && request.url === `/items/${id}/metadata`,
      () => server.apiUrl,
    );
    const store = newStore("release-key-contract");
    stores.push(store);
    const device = new CliDevice({
      binary: requireBinary(),
      store,
      url,
      key: server.workingKey,
    });
    value(await device.hydrate(["core.note"], "library"));
    const write = value(await device.replaceMetadata(id, ["mine"]));

    // The write reaches the server before it moves on to the device's
    // contract, and its answer is lost.
    await server.restart({ env: { MARFA_TEST_CONTRACT_VERSION: "1" } });
    fate.contract = "0";
    fate.next = "lose";
    value(await device.drain());
    expect((await queued(device, write.id)).verdict).toBeNull();
    expect(
      await tags(id),
      "the server did not write the metadata on the other contract, so nothing below is about a write applied twice",
    ).toEqual(["mine"]);
    const since = await call("PUT", `/items/${id}/metadata`, {
      tags: ["theirs"],
    });
    expect(since.status).toBe(200);

    await server.restart();
    delete fate.contract;
    fate.next = "pass";
    const back = value(await device.drain());
    expect(
      told(back, write.id),
      "a write the server applied under its key was taken as one it never applied",
    ).toEqual([["accepted", null]]);
    expect(sent.map((one) => [one.key, one.code])).toEqual([
      [write.idempotency_key, null],
      [write.idempotency_key, "idempotency_contract_changed"],
    ]);
    expect(
      await tags(id),
      "the write was applied a second time, undoing the change made since",
    ).toEqual(["theirs"]);
  },
  4 * FRESH_SERVER_TIMEOUT_MS,
);
