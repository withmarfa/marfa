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
    "versioned-deletes",
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

it.each([
  "newer-edit",
  "own-edit",
  "own-create",
  "merged-newer",
  "conflicted-newer",
] as const)("guards a queued delete through %s", async (scenario) => {
  const store = newStore("versioned-delete");
  const device = new CliDevice({
    binary: requireBinary(),
    store,
    url: apiUrl,
    key: apiKey,
  });
  let id = "";
  let version = 0;
  try {
    if (scenario !== "own-create") {
      const made = await client.createItem({
        type: "core.note",
        source: ctx.source,
        tier: "library",
        properties: { title: scenario, body: "held" },
      });
      expect(made.ok, JSON.stringify(made.error)).toBe(true);
      id = made.data.item.id;
      version = made.data.item.version;
      trackItem(ctx, id);
    }
    value(await device.hydrate(["core.note"], "library"));
    if (scenario === "own-create") {
      const made = value(
        await device.create({
          type: "core.note",
          properties: { title: scenario, body: "held" },
        }),
      );
      id = made.item_id!;
      trackItem(ctx, id);
    }
    if (scenario !== "newer-edit") {
      value(
        await device.update(id, {
          version,
          properties: { body: "first local edit" },
        }),
      );
      if (scenario === "own-edit" || scenario === "own-create")
        value(
          await device.update(id, {
            version,
            properties: { body: "second local edit" },
          }),
        );
    }
    const queued = value(await device.deleteItem(id));
    if (["newer-edit", "merged-newer", "conflicted-newer"].includes(scenario)) {
      const changed = await client.updateItem(id, {
        version,
        properties:
          scenario === "merged-newer"
            ? { notes: "unseen notes" }
            : { body: "unseen body" },
      });
      expect(changed.ok, JSON.stringify(changed.error)).toBe(true);
    }
    const report = value(await device.drain());
    const deletion = report.verdicts.find((row) => row.id === queued.id);
    const safe = scenario === "own-edit" || scenario === "own-create";
    expect(deletion, JSON.stringify(report)).toMatchObject(
      safe
        ? { verdict: "accepted" }
        : { verdict: "blocked", reason: "conflict_unresolved" },
    );
    expect(queued.base_version).toBe(version);
    const listed = await client.listItems({
      state: "any",
      filter: `id eq "${id}"`,
      limit: 100,
    });
    expect(listed.ok, JSON.stringify(listed.error)).toBe(true);
    expect(listed.data.data).toHaveLength(1);
    expect(listed.data.data[0]?.state).toBe(safe ? "trashed" : "active");
    if (!safe)
      expect(
        listed.data.data[0]?.properties[
          scenario === "merged-newer" ? "notes" : "body"
        ],
      ).toBe(scenario === "merged-newer" ? "unseen notes" : "unseen body");
  } finally {
    rmSync(dirname(store), { recursive: true, force: true });
  }
});

it("keeps the text and binned-row reason of an edit refused after another delete", async () => {
  const made = await client.createItem({
    type: "core.note",
    source: ctx.source,
    tier: "library",
    properties: { title: "kept refusal", body: "held" },
  });
  expect(made.ok, JSON.stringify(made.error)).toBe(true);
  const id = made.data.item.id;
  trackItem(ctx, id);
  const store = newStore("binned-edit");
  const device = new CliDevice({
    binary: requireBinary(),
    store,
    url: apiUrl,
    key: apiKey,
  });
  try {
    value(await device.hydrate(["core.note"], "library"));
    const edited = value(
      await device.update(id, {
        version: made.data.item.version,
        properties: { body: "kept offline text" },
      }),
    );
    expect((await client.deleteItem(id)).ok).toBe(true);
    expect(
      value(await device.drain()).verdicts.find((row) => row.id === edited.id),
    ).toMatchObject({ verdict: "refused", refusal: { trashed: true } });
    value(await device.forget());
    expect(
      value(await device.queue()).find((row) => row.id === edited.id),
    ).toMatchObject({
      body: { properties: { body: "kept offline text" } },
      refusal: { trashed: true },
    });
  } finally {
    rmSync(dirname(store), { recursive: true, force: true });
  }
});

it("replays a lost delete answer without deleting a restored newer item", async () => {
  const store = newStore("delete-replay-live");
  const sent: { body: string; url: string; key: string | undefined }[] = [];
  let id = "";
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
      const isDelete =
        request.method === "DELETE" &&
        request.url?.split("?")[0] === `/items/${id}`;
      if (isDelete)
        sent.push({
          body: body.toString(),
          url: request.url!,
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
      if (isDelete && sent.length === 1) {
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
    const made = await client.createItem({
      type: "core.note",
      source: ctx.source,
      tier: "library",
      properties: { title: "restored", body: "held" },
    });
    expect(made.ok, JSON.stringify(made.error)).toBe(true);
    id = made.data.item.id;
    trackItem(ctx, id);
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
    const deletion = value(await device.deleteItem(id));
    expect(value(await device.drain()).answered).toBe(0);
    const binned = await client.listItems({
      state: "trashed",
      filter: `id eq "${id}"`,
    });
    expect(binned.ok, JSON.stringify(binned.error)).toBe(true);
    expect(binned.data.data.map((row) => row.id)).toEqual([id]);
    const restored = await client.restoreItem(id);
    expect(restored.ok, JSON.stringify(restored.error)).toBe(true);
    const updated = await client.updateItem(id, {
      version: restored.data.item.version,
      properties: { body: "new content after restore" },
    });
    expect(updated.ok, JSON.stringify(updated.error)).toBe(true);
    value(await device.catchUp());
    expect(value(await device.drain()).verdicts).toMatchObject([
      { id: deletion.id, verdict: "accepted", replayed: true },
    ]);
    const final = await client.getItem(id);
    expect(final.ok, JSON.stringify(final.error)).toBe(true);
    expect(final.data.item.state).toBe("active");
    expect(final.data.item.properties.body).toBe("new content after restore");
    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual(sent[0]);
    expect(sent[0]?.key).toBe(deletion.idempotency_key);
    expect(new URL(sent[0]!.url, apiUrl).searchParams.get("version")).toBe(
      String(made.data.item.version),
    );
  } finally {
    proxy.closeAllConnections();
    proxy.close();
    rmSync(dirname(store), { recursive: true, force: true });
  }
});
