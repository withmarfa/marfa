import { afterAll, beforeAll, expect, it } from "vitest";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { rmSync } from "node:fs";
import { dirname } from "node:path";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import { CliDevice, newStore } from "../../device/cli-adapter.js";
import type { Outcome } from "../../device/protocol.js";
import { createTestContext, cleanup, trackItem } from "../../utils/setup.js";
import { requireBinary } from "./harness.js";

let client: MarfaClient;
let ctx: TestContext;
let apiUrl: string;
let apiKey: string;
beforeAll(async () => {
  ({ client, ctx, apiUrl, apiKey } = await createTestContext(
    "device",
    "waiting-projections",
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

it.each(["edit", "create"] as const)(
  "keeps a dead %s visible over real later changes and on release",
  async (kind) => {
    const store = newStore("waiting-projections-live");
    let id = "";
    const sent: string[] = [];
    const upstreamStatuses: number[] = [];
    const proxy = createServer(async (request, response) => {
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
            headers.set(
              name,
              Array.isArray(header) ? header.join(", ") : header,
            );
        }
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
        if (
          (kind === "edit" &&
            request.method === "PATCH" &&
            request.url?.split("?")[0] === `/items/${id}`) ||
          (kind === "create" &&
            request.method === "POST" &&
            request.url?.split("?")[0] === "/items")
        ) {
          sent.push(headers.get("idempotency-key") ?? "");
          upstreamStatuses.push(upstream.status);
          await upstream.arrayBuffer();
          response.end("unreadable answer");
        } else if (!upstream.body) response.end();
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
      const made = await client.createItem({
        type: "core.note",
        source: ctx.source,
        tier: "library",
        properties: { title: "held", body: "held" },
      });
      expect(made.ok, JSON.stringify(made.error)).toBe(true);
      id = made.data.item.id;
      trackItem(ctx, id);
      await new Promise<void>((resolve) =>
        proxy.listen(0, "127.0.0.1", resolve),
      );
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
      const edit =
        kind === "edit"
          ? value(
              await device.update(id, {
                version: made.data.item.version,
                properties: { body: "still mine" },
              }),
            )
          : value(
              await device.create({
                type: "core.note",
                properties: { title: "held", body: "still mine" },
              }),
            );
      if (kind === "create") {
        id = edit.item_id!;
        trackItem(ctx, id);
      }
      for (let attempt = 0; attempt < 5; attempt++) value(await device.drain());
      expect(upstreamStatuses).toEqual(
        Array(5).fill(kind === "edit" ? 200 : 201),
      );
      expect(new Set(sent).size).toBe(1);
      expect(
        value(await device.queue()).find((row) => row.id === edit.id)?.verdict,
      ).toBe("dead");
      const committed = await client.getItem(id);
      expect(committed.ok, JSON.stringify(committed.error)).toBe(true);
      const later = await client.updateItem(id, {
        version: committed.data.item.version,
        properties: {
          title: "new elsewhere",
          body: "later elsewhere",
          notes: "new field",
        },
      });
      expect(later.ok, JSON.stringify(later.error)).toBe(true);
      value(await device.catchUp());
      expect(value(await device.get(id)).properties).toMatchObject({
        title: kind === "edit" ? "new elsewhere" : "held",
        body: "still mine",
        notes: "new field",
      });
      expect(value(await device.release({ id: edit.id }))).toBe(1);
      expect(value(await device.get(id)).properties).toMatchObject({
        title: kind === "edit" ? "new elsewhere" : "held",
        body: "still mine",
        notes: "new field",
      });
      expect(sent).toHaveLength(5);
    } finally {
      proxy.closeAllConnections();
      proxy.close();
      rmSync(dirname(store), { recursive: true, force: true });
    }
  },
);
