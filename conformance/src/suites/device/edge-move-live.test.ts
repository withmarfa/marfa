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
  createTestContext,
  cleanup,
  trackEdge,
  trackItem,
} from "../../utils/setup.js";
import { collectUntil, withStream } from "../../utils/stream.js";
import { requireBinary } from "./harness.js";

/**
 * A move of an edge's end made through a working copy, against a real
 * server (`queue-and-verdicts.md` 60 to 62): one write, sent when the copy
 * comes back online, refused as a whole, and held for the create of the row
 * it moves to. Every call to the device is a process of its own, so each
 * step reads the queue and the copy a restart left.
 */

let client: MarfaClient;
let ctx: TestContext;
let apiUrl: string;
let apiKey: string;
beforeAll(async () => {
  ({ client, ctx, apiUrl, apiKey } = await createTestContext(
    "device",
    "edge-move",
  ));
});
afterAll(async () => {
  if (ctx) await cleanup(ctx);
});

function value<T>(result: Outcome<T>): T {
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (!result.ok) throw new Error(result.refusal.raw);
  return result.value;
}

/**
 * A proxy in front of the server that can be taken offline, and records
 * every write the device sends through it.
 */
async function proxied(): Promise<{
  url: string;
  writes: string[];
  setOnline: (online: boolean) => void;
  close: () => void;
}> {
  let online = true;
  const writes: string[] = [];
  const proxy: Server = createServer(async (request, response) => {
    if (!online) {
      request.socket.destroy();
      return;
    }
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
      if (request.method !== "GET")
        writes.push(`${request.method} ${request.url?.split("?")[0]}`);
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
    writes,
    setOnline: (next) => {
      online = next;
    },
    close: () => {
      proxy.closeAllConnections();
      proxy.close();
    },
  };
}

async function note(title: string, sourceId?: string): Promise<string> {
  const made = await client.createItem({
    type: "core.note",
    source: ctx.source,
    ...(sourceId === undefined ? {} : { source_id: sourceId }),
    tier: "library",
    properties: { title, body: title },
  });
  expect(made.ok, JSON.stringify(made.error)).toBe(true);
  trackItem(ctx, made.data.item.id);
  return made.data.item.id;
}

async function parentOf(
  parent: string,
  child: string,
): Promise<{ id: string; version: number }> {
  const made = await client.createEdge({
    source_id: parent,
    target_id: child,
    edge_type: "parent-of",
  });
  expect(made.ok, JSON.stringify(made.error)).toBe(true);
  trackEdge(ctx, made.data.edge.id);
  return made.data.edge;
}

/** The parents the server holds for `child`, read from its backrefs. */
async function serverParents(child: string): Promise<string[]> {
  const read = await client.listItemBackrefs(child, { edge_type: "parent-of" });
  expect(read.ok, JSON.stringify(read.error)).toBe(true);
  return read.data.data.map((edge) => edge.source_id);
}

it("re-parents a note offline in one write a real server takes, never leaving it without a parent", async ({
  signal,
}) => {
  const store = newStore("edge-move-live-reparent");
  const proxy = await proxied();
  try {
    const first = await note("first project");
    const second = await note("second project");
    const child = await note("child note");
    const edge = await parentOf(first, child);
    const device = () =>
      new CliDevice({
        binary: requireBinary(),
        store,
        url: proxy.url,
        key: apiKey,
      });
    value(await device().hydrate(["core.note"], "library"));

    proxy.setOnline(false);
    const queued = value(
      await device().updateEdge(edge.id, {
        properties: {},
        version: edge.version,
        source_id: second,
      }),
    );
    const offline = value(await device().drain());
    expect(offline.answered, "a drain offline answered something").toBe(0);
    expect(
      value(await device().edgesTo(child)).map((held) => held.source_id),
      "the copy did not show the move, offline, after a restart",
    ).toEqual([second]);
    expect(value(await device().edgesFrom(first))).toEqual([]);
    expect(await serverParents(child)).toEqual([first]);

    proxy.setOnline(true);
    await withStream(apiUrl, apiKey, {}, async (stream) => {
      await new Promise((settle) => setTimeout(settle, 200));
      // A move of an edge's source changes the server's read view
      // (`read-views.md` 3): the move is answered, and the copy expires.
      const drained = await device().drain();
      expect(drained.ok).toBe(false);
      if (!drained.ok) expect(drained.refusal.code).toBe("copy_expired");
      const sentinel = await note("after the move");
      const { events } = await collectUntil(
        stream,
        (seen) =>
          seen.some(
            (event) =>
              (event.data as { item?: { id?: string } }).item?.id === sentinel,
          ),
        `the sentinel ${sentinel} after the move`,
        signal,
      );
      expect(
        events
          .filter(
            (event) =>
              (event.data as { edge?: { target_id?: string } }).edge
                ?.target_id === child,
          )
          .map((event) => event.event),
        "the server announced the move as more than one change",
      ).toEqual(["edge.updated"]);
    });
    expect(
      value(await device().queue()).map((row) => [row.id, row.verdict]),
    ).toEqual([[queued.id, "accepted"]]);
    expect(
      proxy.writes.filter((write) => write.includes("/edges")),
      "the device sent the move as something other than one update of the edge",
    ).toEqual([`PATCH /edges/${edge.id}`]);
    const moved = await client.getEdge(edge.id);
    expect(moved.ok, JSON.stringify(moved.error)).toBe(true);
    expect([moved.data.edge.source_id, moved.data.edge.version]).toEqual([
      second,
      edge.version + 1,
    ]);
    expect(await serverParents(child)).toEqual([second]);

    value(await device().hydrate(["core.note"], "library"));
    expect(value(await device().edgesFrom(first))).toEqual([]);
    expect(
      value(await device().edgesTo(child)).map((held) => [
        held.id,
        held.source_id,
        held.version,
      ]),
    ).toEqual([[edge.id, second, edge.version + 1]]);
  } finally {
    proxy.close();
    rmSync(dirname(store), { recursive: true, force: true });
  }
});

it("puts the edge back at its old parent when the server refuses the move for a cycle", async () => {
  const store = newStore("edge-move-live-cycle");
  try {
    const top = await note("top");
    const middle = await note("middle");
    const bottom = await note("bottom");
    const upper = await parentOf(top, middle);
    await parentOf(middle, bottom);
    const device = new CliDevice({
      binary: requireBinary(),
      store,
      url: apiUrl,
      key: apiKey,
    });
    value(await device.hydrate(["core.note"], "library"));

    const queued = value(
      await device.updateEdge(upper.id, {
        properties: {},
        version: upper.version,
        source_id: bottom,
      }),
    );
    // The witness: the copy showed the move before the server refused it.
    expect(
      value(await device.edgesTo(middle)).map((held) => held.source_id),
    ).toEqual([bottom]);

    const report = value(await device.drain());
    expect(
      report.verdicts.map((row) => [row.id, row.verdict, row.reason]),
    ).toEqual([[queued.id, "refused", "edge_cycle"]]);
    expect(
      value(await device.edgesTo(middle)).map((held) => held.source_id),
      "a refused move left the edge at the parent it was moving to",
    ).toEqual([top]);
    expect(await serverParents(middle)).toEqual([top]);
    const kept = value(await device.queue()).find(
      (row) => row.id === queued.id,
    );
    expect(kept?.body, "the refused move's content was not kept").toMatchObject(
      { source_id: bottom },
    );
  } finally {
    rmSync(dirname(store), { recursive: true, force: true });
  }
});

it("holds a move onto its own unanswered create, and sends it naming the row the create landed on", async () => {
  const store = newStore("edge-move-live-create");
  const proxy = await proxied();
  try {
    const first = await note("first");
    const child = await note("child");
    const edge = await parentOf(first, child);
    const key = `edge-move-${ctx.runId}`;
    const landing = await note("held under its key", key);
    const device = () =>
      new CliDevice({
        binary: requireBinary(),
        store,
        url: proxy.url,
        key: apiKey,
      });
    value(await device().hydrate(["core.note"], "library"));

    proxy.setOnline(false);
    const created = value(
      await device().create({
        type: "core.note",
        source: ctx.source,
        sourceId: key,
        properties: { title: "new parent", body: "new parent" },
      }),
    );
    const minted = created.item_id!;
    expect(minted).not.toBe(landing);
    const queued = value(
      await device().updateEdge(edge.id, {
        properties: {},
        version: edge.version,
        source_id: minted,
      }),
    );
    expect(queued.depends_on).toEqual([created.id]);
    expect(
      value(await device().edgesTo(child)).map((held) => held.source_id),
    ).toEqual([minted]);

    proxy.setOnline(true);
    const drained = await device().drain();
    expect(drained.ok).toBe(false);
    if (!drained.ok) expect(drained.refusal.code).toBe("copy_expired");
    expect(
      value(await device().queue()).map((row) => [row.kind, row.verdict]),
    ).toEqual([
      ["create_item", "accepted"],
      ["update_edge", "accepted"],
    ]);
    const moved = await client.getEdge(edge.id);
    expect(moved.ok, JSON.stringify(moved.error)).toBe(true);
    expect(
      moved.data.edge.source_id,
      "the move named the id the device minted, not the row its create landed on",
    ).toBe(landing);
    value(await device().hydrate(["core.note"], "library"));
    expect(
      value(await device().edgesTo(child)).map((held) => held.source_id),
    ).toEqual([landing]);
  } finally {
    proxy.close();
    rmSync(dirname(store), { recursive: true, force: true });
  }
});
