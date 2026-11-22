import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { rmSync } from "node:fs";
import { dirname } from "node:path";
import { Readable } from "node:stream";
import { afterAll, beforeAll, expect, it } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import { CliDevice, newStore } from "../../device/cli-adapter.js";
import type {
  DrainReport,
  Outcome,
  QueuedWrite,
} from "../../device/protocol.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import {
  DAY_MS,
  movedClock,
  QUIET_SCHEDULE,
  quiet,
  runJob,
} from "../../utils/moved-clock.js";
import { cleanup, createTestContext, trackItem } from "../../utils/setup.js";
import { requireBinary } from "./harness.js";

/**
 * An extension write a device queues names the namespace's revision the
 * caller read (`queue-and-verdicts.md`, "The version a write carries"),
 * against the real server and the real binary.
 */

let client: MarfaClient;
let ctx: TestContext;
let apiUrl: string;
let apiKey: string;
const stores: string[] = [];
const proxies: Server[] = [];
let fresh: FreshServer | undefined;

beforeAll(async () => {
  ({ client, ctx, apiUrl, apiKey } = await createTestContext(
    "device",
    "extension-revision",
  ));
});

afterAll(async () => {
  for (const proxy of proxies) {
    proxy.closeAllConnections();
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
  }
  for (const store of stores)
    rmSync(dirname(store), { recursive: true, force: true });
  if (fresh) await fresh.stop();
  if (ctx) await cleanup(ctx);
}, FRESH_SERVER_TIMEOUT_MS);

function value<T>(answer: Outcome<T>): T {
  expect(answer.ok, JSON.stringify(answer)).toBe(true);
  if (!answer.ok) throw new Error(answer.refusal.raw);
  return answer.value;
}

function told(report: DrainReport, id: string) {
  return report.verdicts
    .filter((entry) => entry.id === id)
    .map((entry) => [entry.verdict, entry.reason ?? null]);
}

async function note(writer: MarfaClient, title: string): Promise<string> {
  const made = await writer.createItem({
    type: "core.note",
    tier: "library",
    properties: { title, body: "held" },
  });
  expect(made.status, JSON.stringify(made.error)).toBe(201);
  return made.data.item.id;
}

async function revision(
  writer: MarfaClient,
  id: string,
  namespace: string,
): Promise<string> {
  const read = await writer.getItemExtension(id, namespace);
  expect(read.status, JSON.stringify(read.error)).toBe(200);
  return read.data.revision;
}

async function document(writer: MarfaClient, id: string, namespace: string) {
  return (await writer.getItemExtension(id, namespace)).data.document;
}

async function deviceAt(label: string, url: string, key: string) {
  const store = newStore(label);
  stores.push(store);
  const device = new CliDevice({ binary: requireBinary(), store, url, key });
  value(await device.hydrate(["core.note"], "library"));
  return device;
}

it("sends an extension write and delete naming the revision the caller read, and blocks each as a conflict once another key has changed the namespace, keeping the person's value", async () => {
  const moved = await note(client, "moved");
  const quiet = await note(client, "quiet");
  trackItem(ctx, moved);
  trackItem(ctx, quiet);
  for (const id of [moved, quiet]) {
    expect((await client.setItemExtension(id, "app", { v: "read" })).ok).toBe(
      true,
    );
    expect(
      (await client.setItemExtension(id, "app.gone", { v: "read" })).ok,
    ).toBe(true);
  }
  const device = await deviceAt("extension-revision-moved", apiUrl, apiKey);

  const write = value(
    await device.writeExtension(
      moved,
      "app",
      { v: "mine" },
      await revision(client, moved, "app"),
    ),
  );
  const remove = value(
    await device.deleteExtension(
      moved,
      "app.gone",
      await revision(client, moved, "app.gone"),
    ),
  );
  // The witness: the same writes over namespaces nobody changes land.
  const witnessWrite = value(
    await device.writeExtension(
      quiet,
      "app",
      { v: "mine" },
      await revision(client, quiet, "app"),
    ),
  );
  const witnessRemove = value(
    await device.deleteExtension(
      quiet,
      "app.gone",
      await revision(client, quiet, "app.gone"),
    ),
  );

  // Another key changes both namespaces after the caller read them. An
  // extension write leaves the item's version as it is.
  const version = (await client.getItem(moved)).data.item.version;
  for (const namespace of ["app", "app.gone"]) {
    const since = await client.setItemExtension(moved, namespace, {
      v: "theirs",
    });
    expect(since.status, JSON.stringify(since.error)).toBe(200);
  }
  expect((await client.getItem(moved)).data.item.version).toBe(version);

  const report = value(await device.drain());
  expect(told(report, witnessWrite.id), JSON.stringify(report)).toEqual([
    ["accepted", null],
  ]);
  expect(told(report, witnessRemove.id)).toEqual([["accepted", null]]);
  expect(
    told(report, write.id),
    "the write went over a namespace another key changed since the caller read it",
  ).toEqual([["blocked", "conflict_unresolved"]]);
  expect(told(report, remove.id)).toEqual([["blocked", "conflict_unresolved"]]);
  expect(await document(client, quiet, "app")).toEqual({ v: "mine" });
  expect(await document(client, quiet, "app.gone")).toBeNull();
  expect(await document(client, moved, "app")).toEqual({ v: "theirs" });
  expect(await document(client, moved, "app.gone")).toEqual({ v: "theirs" });
  // The queue keeps what the person wrote while the write is blocked.
  const held = value(await device.queue()).find((one) => one.id === write.id);
  expect(held?.body).toEqual({ v: "mine" });

  // Released, the person chose to write over the namespace as it now stands.
  expect(value(await device.release({ id: write.id }))).toBe(1);
  expect(value(await device.release({ id: remove.id }))).toBe(1);
  const again = value(await device.drain());
  expect(told(again, write.id), JSON.stringify(again)).toEqual([
    ["accepted", null],
  ]);
  expect(told(again, remove.id)).toEqual([["accepted", null]]);
  expect(await document(client, moved, "app")).toEqual({ v: "mine" });
  expect(await document(client, moved, "app.gone")).toBeNull();
});

it(
  "accepts a guarded extension write and delete sent again after a lost answer, once the server keeps no answer under the key, where the namespace holds what the write leaves",
  async () => {
    fresh = await bootFreshServer("device-extension-revision", QUIET_SCHEDULE);
    const server = fresh;
    await quiet(server, ["event-log-cleanup"]);
    const writer = new MarfaClient({
      baseUrl: server.apiUrl,
      apiKey: server.workingKey,
    });
    const id = await note(writer, "lost answers");
    expect((await writer.setItemExtension(id, "app.gone", { v: 1 })).ok).toBe(
      true,
    );
    expect((await writer.setItemExtension(id, "app.moved", { v: 1 })).ok).toBe(
      true,
    );

    // Passes every request to the server, and loses the answer to an
    // extension write while `lose` is set, after the server has written it.
    const sent: { url: string; replayed: boolean; code: string | null }[] = [];
    const fate = { lose: true };
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
        const upstream = await fetch(`${server.apiUrl}${request.url}`, {
          method: request.method,
          headers,
          ...(body.length === 0 ? {} : { body }),
          redirect: "manual",
        });
        if (request.method !== "GET" && request.url?.includes("/extensions/")) {
          sent.push({
            url: request.url,
            replayed: upstream.headers.get("idempotency-replayed") === "true",
            code: upstream.headers.get("x-error-code"),
          });
          if (fate.lose) {
            await upstream.arrayBuffer();
            request.socket.destroy();
            return;
          }
        }
        const returned: Record<string, string> = {};
        upstream.headers.forEach((kept, name) => {
          if (
            ![
              "content-length",
              "content-encoding",
              "transfer-encoding",
            ].includes(name)
          )
            returned[name] = kept;
        });
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
    const url = `http://127.0.0.1:${String(port)}`;
    // A lost answer ends a drain, so each write goes from a device of its own.
    const lostFrom = async (
      label: string,
      queue: (device: CliDevice) => Promise<Outcome<QueuedWrite>>,
    ) => {
      const device = await deviceAt(label, url, server.workingKey);
      const write = value(await queue(device));
      value(await device.drain());
      const held = value(await device.queue()).find(
        (one) => one.id === write.id,
      );
      expect(held?.verdict ?? null, "the lost answer was taken as one").toBe(
        null,
      );
      return { device, write };
    };
    const created = await lostFrom(
      "extension-revision-created",
      async (device) =>
        device.writeExtension(
          id,
          "app.new",
          { v: "mine" },
          await revision(writer, id, "app.new"),
        ),
    );
    const removed = await lostFrom(
      "extension-revision-removed",
      async (device) =>
        device.deleteExtension(
          id,
          "app.gone",
          await revision(writer, id, "app.gone"),
        ),
    );
    // The witness: a write whose namespace another key changes after the lost
    // answer is still refused when it goes again.
    const overtaken = await lostFrom(
      "extension-revision-overtaken",
      async (device) =>
        device.writeExtension(
          id,
          "app.moved",
          { v: "mine" },
          await revision(writer, id, "app.moved"),
        ),
    );
    expect(sent.map((one) => one.replayed)).toEqual([false, false, false]);
    expect(await document(writer, id, "app.new")).toEqual({ v: "mine" });
    expect(await document(writer, id, "app.gone")).toBeNull();
    expect(await document(writer, id, "app.moved")).toEqual({ v: "mine" });
    expect(
      (await writer.setItemExtension(id, "app.moved", { v: "theirs" })).ok,
    ).toBe(true);

    // The server keeps the answers under an Idempotency-Key only as long as
    // the event log.
    const set = await writer.patchConfig({ event_log_retention_days: 1 });
    expect(set.status, JSON.stringify(set.error)).toBe(200);
    await movedClock(server).advance(2 * DAY_MS);
    const swept = await runJob(server, "event-log-cleanup");
    expect(swept.outcome, String(swept.error)).toBe("succeeded");
    expect(
      (swept.result as { purged_records: number }).purged_records,
    ).toBeGreaterThanOrEqual(3);

    fate.lose = false;
    const settled = async ({
      device,
      write,
    }: {
      device: CliDevice;
      write: QueuedWrite;
    }) => {
      const before = sent.length;
      const report = value(await device.drain());
      expect(
        sent.slice(before).map((one) => [one.replayed, one.code]),
        "the server answered the send again from a kept answer, so nothing below is about a guarded write meeting its own revision",
      ).toEqual([[false, "version_conflict"]]);
      return told(report, write.id);
    };
    expect(
      await settled(created),
      "the device blocked a write whose first send took",
    ).toEqual([["accepted", null]]);
    expect(await settled(removed)).toEqual([["accepted", null]]);
    expect(await settled(overtaken)).toEqual([
      ["blocked", "conflict_unresolved"],
    ]);
    expect(await document(writer, id, "app.new")).toEqual({ v: "mine" });
    expect(await document(writer, id, "app.gone")).toBeNull();
    expect(await document(writer, id, "app.moved")).toEqual({ v: "theirs" });
  },
  4 * FRESH_SERVER_TIMEOUT_MS,
);
