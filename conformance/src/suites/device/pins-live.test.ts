import { afterAll, beforeAll, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { Readable } from "node:stream";
import { rmSync } from "node:fs";
import { dirname } from "node:path";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import { CliDevice, newStore } from "../../device/cli-adapter.js";
import type { Outcome } from "../../device/protocol.js";
import {
  cleanup,
  createTestContext,
  trackFolder,
  trackItem,
  trackType,
} from "../../utils/setup.js";
import { requireBinary } from "./harness.js";

/**
 * The rows a working copy pins outside its slice, read again by a hydration
 * against a real server (`device/hydration-pins-batched`,
 * `device/pin-read-on-hydration` and `device/pin-gone-kept`), through a proxy
 * that records every request the device sends.
 */

let client: MarfaClient;
let ctx: TestContext;
let apiUrl: string;
let apiKey: string;
/** A type of this file's own, so the slice holds only what the file writes. */
let slice: string;
beforeAll(async () => {
  ({ client, ctx, apiUrl, apiKey } = await createTestContext("device", "pins"));
  slice = `user.pin_slice_${ctx.runId.replace(/[^a-z0-9]/gi, "").toLowerCase()}`;
  const registered = await client.registerType({
    id: slice,
    fields: { title: { type: "string" } },
  });
  expect(registered.ok, JSON.stringify(registered.error)).toBe(true);
  trackType(ctx, slice, client);
});
afterAll(async () => {
  if (ctx) await cleanup(ctx);
});

function value<T>(answer: Outcome<T>): T {
  expect(answer.ok, JSON.stringify(answer)).toBe(true);
  if (!answer.ok) throw new Error(answer.refusal.raw);
  return answer.value;
}

interface Sent {
  method: string;
  path: string;
  readView: string | undefined;
  body: string;
}

/** A proxy in front of the server that records every request it passes on. */
async function recording(): Promise<{
  url: string;
  sent: Sent[];
  close: () => void;
}> {
  const sent: Sent[] = [];
  const proxy: Server = createServer(async (request, response) => {
    try {
      const bytes: Buffer[] = [];
      for await (const chunk of request) bytes.push(Buffer.from(chunk));
      const body = Buffer.concat(bytes);
      const headers = new Headers();
      for (const [name, header] of Object.entries(request.headers)) {
        if (
          header !== undefined &&
          ![
            "host",
            "connection",
            "transfer-encoding",
            "content-length",
          ].includes(name)
        )
          headers.set(name, Array.isArray(header) ? header.join(", ") : header);
      }
      const view = request.headers["x-marfa-read-view"];
      sent.push({
        method: request.method ?? "GET",
        path: request.url?.split("?")[0] ?? "/",
        readView: Array.isArray(view) ? view.join(", ") : view,
        body: body.toString("utf8"),
      });
      const upstream = await fetch(
        `${apiUrl.replace(/\/$/, "")}${request.url}`,
        {
          method: request.method,
          headers,
          ...(body.length ? { body } : {}),
        },
      );
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
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const address = proxy.address();
  if (!address || typeof address === "string") throw new Error("no proxy port");
  return {
    url: `http://127.0.0.1:${address.port}`,
    sent,
    close: () => {
      proxy.closeAllConnections();
      proxy.close();
    },
  };
}

/** A read of one row by id, which a hydration must not send for a pin. */
const readById = (request: Sent): boolean =>
  request.method === "GET" && /^\/items\/[^/]+$/.test(request.path);

const bulkReads = (sent: Sent[]): Sent[] =>
  sent.filter(
    (request) =>
      request.method === "POST" && request.path === "/items/bulk-get",
  );

async function bookmarks(count: number, label: string): Promise<string[]> {
  const made = await client.bulkItems({
    mode: "create_only",
    items: Array.from({ length: count }, (_, at) => ({
      type: "core.bookmark",
      source: ctx.source,
      tier: "library",
      properties: {
        title: `${label} ${String(at)}`,
        url: `https://example.com/${label}/${String(at)}`,
      },
    })),
  });
  expect(made.ok, JSON.stringify(made.error)).toBe(true);
  const ids = made.data.results.map((row) => row.id ?? "");
  expect(ids.filter((id) => id !== "")).toHaveLength(count);
  for (const id of ids) trackItem(ctx, id);
  return ids;
}

it("reads the pinned rows outside its slice 100 to a request under its read view, not one request each", async () => {
  const pinned = await bookmarks(250, "pinned");
  const proxy = await recording();
  const store = newStore("pins-batched");
  const device = new CliDevice({
    binary: requireBinary(),
    store,
    url: proxy.url,
    key: apiKey,
  });
  try {
    value(await device.hydrate([slice], "library"));
    for (const id of pinned) value(await device.pin(id));
    // The witness: each pin read its row, so the copy holds every one.
    expect(value(await device.status()).items).toBe(pinned.length);

    proxy.sent.length = 0;
    const again = value(await device.hydrate([slice], "library"));
    expect(again.items).toBe(pinned.length);
    expect(
      proxy.sent.filter(readById).length,
      "a hydration read a pinned row by id, one request for each pin",
    ).toBe(0);
    const reads = bulkReads(proxy.sent);
    expect(
      reads.length,
      "a hydration did not read 250 pinned rows in three requests",
    ).toBe(3);
    const named: string[] = [];
    for (const read of reads) {
      const body = JSON.parse(read.body) as { ids: string[] };
      expect(body.ids.length).toBeLessThanOrEqual(100);
      named.push(...body.ids);
      expect(
        read.readView,
        "a bulk read of pinned rows was sent outside the copy's read view",
      ).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(named.sort()).toEqual([...pinned].sort());
    const status = value(await device.status());
    expect([status.hydration, status.pinned.length]).toEqual([
      "complete",
      pinned.length,
    ]);
    expect(value(await device.get(pinned[249]!)).properties.title).toBe(
      "pinned 249",
    );
  } finally {
    proxy.close();
    rmSync(dirname(store), { recursive: true, force: true });
  }
});

it("holds a pinned folder row, and keeps a pin whose row went to the bin without a row", async () => {
  const folder = await client.createFolder({
    title: `Pins ${ctx.runId}`,
    search: { types: [slice], filter: `source eq "${ctx.source}"` },
  });
  expect(folder.ok, JSON.stringify(folder.error)).toBe(true);
  trackFolder(ctx, folder.data.item.id);
  expect(folder.data.item.type).toBe("system.folder");
  const [kept, gone] = await bookmarks(2, "kept-or-gone");
  const proxy = await recording();
  const store = newStore("pins-gone");
  const device = new CliDevice({
    binary: requireBinary(),
    store,
    url: proxy.url,
    key: apiKey,
  });
  try {
    value(await device.hydrate([slice], "library"));
    for (const id of [folder.data.item.id, kept!, gone!])
      value(await device.pin(id));
    // The witness: every pinned row was held before the next hydration.
    expect(value(await device.get(gone!)).id).toBe(gone);
    expect(value(await device.get(folder.data.item.id)).type).toBe(
      "system.folder",
    );
    const trashed = await client.deleteItem(gone!);
    expect(trashed.ok, JSON.stringify(trashed.error)).toBe(true);

    proxy.sent.length = 0;
    value(await device.hydrate([slice], "library"));
    expect(proxy.sent.filter(readById)).toEqual([]);
    expect(bulkReads(proxy.sent)).toHaveLength(1);
    const status = value(await device.status());
    expect(status.hydration).toBe("complete");
    expect(
      [...status.pinned].sort(),
      "a hydration dropped the pin of a row the server no longer answers",
    ).toEqual([folder.data.item.id, kept!, gone!].sort());
    expect(
      (await device.get(gone!)).ok,
      "a hydration kept a pinned row the server holds in the bin",
    ).toBe(false);
    expect(
      value(await device.get(folder.data.item.id)).type,
      "a hydration left out a pinned system.folder row",
    ).toBe("system.folder");
    expect(value(await device.get(kept!)).id).toBe(kept);
  } finally {
    proxy.close();
    rmSync(dirname(store), { recursive: true, force: true });
  }
});

it("keeps the pin of its own create outside its slice past the answer and the next hydration, until it is taken off", async () => {
  const proxy = await recording();
  const store = newStore("pins-create");
  const device = new CliDevice({
    binary: requireBinary(),
    store,
    url: proxy.url,
    key: apiKey,
  });
  try {
    value(await device.hydrate([slice], "library"));
    const created = value(
      await device.create({
        type: "core.bookmark",
        properties: {
          title: `created ${ctx.runId}`,
          url: "https://example.com/pins-create",
        },
      }),
    );
    const id = created.item_id!;
    trackItem(ctx, id);
    // The witness: the create the slice does not take is pinned when queued.
    expect(value(await device.status()).pinned).toEqual([id]);

    const drained = value(await device.drain());
    expect(drained.verdicts.map((row) => row.verdict)).toEqual(["accepted"]);
    expect(
      value(await device.status()).pinned,
      "the pin a create made ended when the create was answered",
    ).toEqual([id]);

    proxy.sent.length = 0;
    value(await device.hydrate([slice], "library"));
    expect(
      value(await device.status()).pinned,
      "the pin a create made ended at the next hydration",
    ).toEqual([id]);
    expect(value(await device.get(id)).properties.title).toBe(
      `created ${ctx.runId}`,
    );
    expect(bulkReads(proxy.sent)).toHaveLength(1);

    expect(value(await device.unpin(id)).was_pinned).toBe(true);
    expect(value(await device.status()).pinned).toEqual([]);
    expect((await device.get(id)).ok).toBe(false);
  } finally {
    proxy.close();
    rmSync(dirname(store), { recursive: true, force: true });
  }
});
