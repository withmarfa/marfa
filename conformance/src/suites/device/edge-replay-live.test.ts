import { expect, it } from "vitest";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { rmSync } from "node:fs";
import { dirname } from "node:path";
import { CliDevice, newStore } from "../../device/cli-adapter.js";
import type { Outcome } from "../../device/protocol.js";
import { createTestContext, cleanup, trackItem } from "../../utils/setup.js";
import { requireBinary } from "./harness.js";

function value<T>(result: Outcome<T>): T {
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (!result.ok) throw new Error(result.refusal.raw);
  return result.value;
}
it("sends an edge edit after catching up an earlier write whose real answer was lost", async () => {
  const { client, ctx, apiUrl, apiKey } = await createTestContext(
    "device",
    "edge-replay",
  );
  const store = newStore("edge-replay-live");
  const sent: { body: string; key: string | undefined }[] = [];
  let edgeId = "";
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
      const isEdit =
        request.method === "PATCH" &&
        request.url?.split("?")[0] === `/edges/${edgeId}`;
      if (isEdit)
        sent.push({
          body: body.toString(),
          key: headers.get("idempotency-key") ?? undefined,
        });
      const upstream = await fetch(
        `${apiUrl.replace(/\/$/, "")}${request.url}`,
        {
          method: request.method,
          headers,
          ...(body.length === 0 ? {} : { body }),
        },
      );
      if (isEdit && sent.length === 1) {
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
  try {
    const items: string[] = [];
    for (const title of ["source", "target"]) {
      const made = await client.createItem({
        type: "core.note",
        source: ctx.source,
        tier: "library",
        properties: { title, body: title },
      });
      expect(made.ok, JSON.stringify(made.error)).toBe(true);
      trackItem(ctx, made.data.item.id);
      items.push(made.data.item.id);
    }
    const made = await client.createEdge({
      source_id: items[0]!,
      target_id: items[1]!,
      edge_type: "references",
      properties: { weight: 1 },
    });
    expect(made.ok, JSON.stringify(made.error)).toBe(true);
    edgeId = made.data.edge.id;
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    const address = proxy.address();
    if (!address || typeof address === "string")
      throw new Error("no proxy port");
    const device = new CliDevice({
      binary: requireBinary(),
      store,
      url: `http://127.0.0.1:${address.port}`,
      key: apiKey,
    });
    value(await device.hydrate(["core.note"], "library"));
    const first = value(
      await device.updateEdge(edgeId, {
        properties: { weight: 2 },
        version: made.data.edge.version,
      }),
    );
    expect(value(await device.drain()).answered).toBe(0);
    const landed = await client.getEdge(edgeId);
    expect(landed.ok, JSON.stringify(landed.error)).toBe(true);
    expect(landed.data.edge.properties.weight).toBe(2);
    value(await device.catchUp());
    const second = value(
      await device.updateEdge(edgeId, {
        properties: { weight: 3 },
        version: landed.data.edge.version,
      }),
    );
    expect(
      value(await device.drain()).verdicts.map((row) => row.verdict),
    ).toEqual(["accepted", "accepted"]);
    const final = await client.getEdge(edgeId);
    expect(final.ok, JSON.stringify(final.error)).toBe(true);
    expect(final.data.edge.properties.weight).toBe(3);
    expect(sent).toHaveLength(3);
    expect(sent[1]).toEqual(sent[0]);
    expect(sent.map((row) => row.key)).toEqual([
      first.idempotency_key,
      first.idempotency_key,
      second.idempotency_key,
    ]);
    expect(JSON.parse(sent[2]!.body).version).toBe(landed.data.edge.version);
  } finally {
    proxy.closeAllConnections();
    proxy.close();
    rmSync(dirname(store), { recursive: true, force: true });
    await cleanup(ctx);
  }
});
