import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterAll, describe, expect, it } from "vitest";
import { MarfaClient } from "../../client/api.js";
import { CliDevice, newStore } from "../../device/cli-adapter.js";
import type {
  DrainReport,
  Outcome,
  QueuedWrite,
} from "../../device/protocol.js";
import { ownerOf } from "../../utils/backups.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { parseEnvFile } from "../../utils/target.js";
import { tempFolder } from "../../utils/temp-folder.js";
import { bootServer, stopServer } from "../../../scripts/marfa-server.js";
import { requireBinary } from "./harness.js";

/**
 * A server put back to an earlier copy of its data directory, as a volume
 * snapshot or a file backup puts it back, with a device that wrote to it
 * after the copy was taken (`device.md`, "A server restored to an earlier
 * point"). The device reaches the server through a proxy whose address stays
 * the same when the restored server takes the original's place, as an
 * instance restored behind the same address does.
 */

const TIMEOUT = FRESH_SERVER_TIMEOUT_MS * 2;
const proxies: Server[] = [];
const servers: FreshServer[] = [];
const restoredStates: string[] = [];

afterAll(async () => {
  for (const proxy of proxies) {
    proxy.closeAllConnections();
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
  }
  for (const state of restoredStates.splice(0)) {
    await stopServer({ state });
    rmSync(state, { recursive: true, force: true });
  }
  for (const server of servers) await server.stop();
}, FRESH_SERVER_TIMEOUT_MS);

function value<T>(answer: Outcome<T>): T {
  expect(answer.ok, JSON.stringify(answer)).toBe(true);
  if (!answer.ok) throw new Error(answer.refusal.raw);
  return answer.value;
}

/** A server, the device that writes to it and a client of its own. */
interface World {
  original: FreshServer;
  device: CliDevice;
  /** A client of the server the proxy reaches now. */
  client(): MarfaClient;
  /** The requests the device sent, as `METHOD /path`, oldest first. */
  sent: string[];
  /** Stops the original and puts the server booted from `image` in its place. */
  restore(image: string): Promise<void>;
}

async function world(
  label: string,
  env: Record<string, string> = {},
): Promise<World> {
  const original = await bootFreshServer(label, env);
  servers.push(original);
  let upstream = original.apiUrl;
  const sent: string[] = [];
  const listener = createServer((request, response) => {
    void (async () => {
      sent.push(`${request.method ?? ""} ${(request.url ?? "").split("?")[0]}`);
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
      const answer = await fetch(
        `${upstream.replace(/\/$/, "")}${request.url ?? ""}`,
        {
          method: request.method,
          headers,
          ...(body.length === 0 ? {} : { body }),
          redirect: "manual",
        },
      );
      const returned: Record<string, string> = {};
      answer.headers.forEach((kept, name) => {
        if (
          !["content-length", "content-encoding", "transfer-encoding"].includes(
            name,
          )
        )
          returned[name] = kept;
      });
      response.writeHead(answer.status, returned);
      if (answer.body === null) {
        response.end();
        return;
      }
      const stream = Readable.fromWeb(answer.body as never);
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
  const device = new CliDevice({
    binary: requireBinary(),
    store: newStore(label),
    url: `http://127.0.0.1:${String(port)}`,
    key: original.workingKey,
  });
  value(await device.hydrate(["core.note"], "library"));
  return {
    original,
    device,
    sent,
    client: () =>
      new MarfaClient({ baseUrl: upstream, apiKey: original.workingKey }),
    async restore(image) {
      await original.stop();
      restoredStates.push(image);
      await bootServer({ state: image });
      const restored = parseEnvFile(
        readFileSync(join(image, "env"), "utf8"),
      ).MARFA_API_URL;
      if (!restored) throw new Error("the restored boot wrote no address");
      upstream = restored;
    },
  };
}

async function note(
  client: MarfaClient,
  title: string,
): Promise<{ id: string; version: number }> {
  const made = await client.createItem({
    type: "core.note",
    tier: "library",
    properties: { title },
  });
  expect(made.ok, JSON.stringify(made.error)).toBe(true);
  return { id: made.data.item.id, version: made.data.item.version };
}

/**
 * Drains the queue and clears the writes the server answered, so the queue
 * holds only what the copy queues after.
 */
async function sent(device: CliDevice): Promise<DrainReport> {
  const report = value(await device.drain());
  value(await device.forget());
  return report;
}

async function made(device: CliDevice, title: string): Promise<string> {
  const queued = value(
    await device.create({ type: "core.note", properties: { title } }),
  );
  return queued.item_id ?? "";
}

async function queue(device: CliDevice): Promise<QueuedWrite[]> {
  return value(await device.queue());
}

/**
 * The writes queued, each blocked as one that would put back what the
 * restored server lost, as `[kind, the item or edge it names]`, sorted.
 */
async function keptBlocked(
  device: CliDevice,
): Promise<Array<[string, string]>> {
  const queued = await queue(device);
  for (const write of queued)
    expect(
      [write.verdict, write.reason],
      `${write.kind} of ${String(write.edge_id ?? write.item_id)} was not held for the person`,
    ).toEqual(["blocked", "server_restored"]);
  return queued
    .map((write): [string, string] => [
      write.kind,
      write.edge_id ?? write.item_id ?? "",
    ])
    .sort((left, right) => left.join(" ").localeCompare(right.join(" ")));
}

function expired(answer: Outcome<unknown>): string {
  return answer.ok ? "caught up" : answer.refusal.code;
}

async function title(client: MarfaClient, id: string): Promise<unknown> {
  const read = await client.getItem(id);
  expect(read.ok, `${id}: ${JSON.stringify(read.error)}`).toBe(true);
  return read.data.item.properties.title;
}

describe("a server restored behind work this device sent it", () => {
  it(
    "keeps an item made since the backup, blocked until released, where the copy had not caught up past it",
    async () => {
      const w = await world("restored-level");
      value(await w.device.catchUp());
      const image = await w.original.image();
      const id = await made(w.device, "made since the backup");
      expect((await sent(w.device)).answered).toBe(1);
      expect(await title(w.client(), id)).toBe("made since the backup");

      await w.restore(image);
      expect(
        (await w.client().getItem(id)).status,
        "the restored server holds the item, so it lost nothing",
      ).toBe(404);
      expect(
        expired(await w.device.catchUp()),
        "a copy level with the restored server's log took it as holding the item",
      ).toBe("copy_expired");
      value(await w.device.hydrate(["core.note"], "library"));

      expect(await keptBlocked(w.device)).toEqual([["create_item", id]]);
      const kept = value(await w.device.get(id));
      expect(kept.properties.title).toBe("made since the backup");

      // An edit made to the kept item waits on its create.
      const edit = value(
        await w.device.update(id, {
          properties: { title: "edited once kept" },
          version: kept.version,
        }),
      );
      const create = (await queue(w.device)).find(
        (write) => write.kind === "create_item",
      );
      expect(edit.depends_on).toContain(create?.id);
      const before = w.sent.length;
      value(await w.device.drain());
      expect(
        w.sent
          .slice(before)
          .filter((line) => /^(POST|PATCH) \/items/.test(line)),
        "a blocked write, or one waiting on it, was sent",
      ).toEqual([]);
      expect((await w.client().getItem(id)).status).toBe(404);

      expect(value(await w.device.release({ reason: "server_restored" }))).toBe(
        1,
      );
      value(await w.device.drain());
      expect(await title(w.client(), id)).toBe("edited once kept");
      expect(
        (await queue(w.device)).filter((write) => write.verdict === "blocked"),
      ).toEqual([]);
    },
    TIMEOUT,
  );

  it(
    "keeps an item made since the backup where the server's log ends behind the copy's cursor",
    async () => {
      const w = await world("restored-ahead");
      value(await w.device.catchUp());
      const image = await w.original.image();
      const id = await made(w.device, "taken back by the stream");
      await sent(w.device);
      // The stream carries the item's own event, which shows the server holds
      // it, and moves the cursor past the head the restored log ends at.
      value(await w.device.catchUp());

      await w.restore(image);
      expect(expired(await w.device.catchUp())).toBe("copy_expired");
      value(await w.device.hydrate(["core.note"], "library"));
      expect(await keptBlocked(w.device)).toEqual([["create_item", id]]);

      value(await w.device.release({ reason: "server_restored" }));
      value(await w.device.drain());
      expect(await title(w.client(), id)).toBe("taken back by the stream");
    },
    TIMEOUT,
  );

  it(
    "keeps an item made since the backup where the restored server has written past the copy's cursor",
    async () => {
      const w = await world("restored-anchor");
      value(await w.device.catchUp());
      const image = await w.original.image();
      // Made by another client, so only the log can tell the copy it is gone.
      const elsewhere = await note(w.client(), "made elsewhere");
      expect(value(await w.device.catchUp()).applied).toBe(1);

      await w.restore(image);
      // The restored log numbers these as the event the copy took and the one
      // after it, so its head is past the copy's cursor.
      const first = await note(w.client(), "written after the restore");
      const second = await note(w.client(), "and again");
      expect(
        expired(await w.device.catchUp()),
        "a log that numbers other events as the one the copy took was read as the same log",
      ).toBe("copy_expired");
      value(await w.device.hydrate(["core.note"], "library"));

      expect(await keptBlocked(w.device)).toEqual([
        ["create_item", elsewhere.id],
      ]);
      const held = value(await w.device.list())
        .map((item) => item.id)
        .sort();
      expect(held).toEqual([elsewhere.id, first.id, second.id].sort());

      value(await w.device.release({ reason: "server_restored" }));
      value(await w.device.drain());
      expect(await title(w.client(), elsewhere.id)).toBe("made elsewhere");
    },
    TIMEOUT,
  );

  it(
    "puts back an edit the restored server lost to an item it still holds",
    async () => {
      const w = await world("restored-edit");
      const held = await note(w.client(), "before the backup");
      value(await w.device.catchUp());
      const image = await w.original.image();
      value(
        await w.device.update(held.id, {
          properties: { title: "after the backup" },
          version: held.version,
        }),
      );
      expect((await sent(w.device)).answered).toBe(1);

      await w.restore(image);
      expect(await title(w.client(), held.id)).toBe("before the backup");
      expect(expired(await w.device.catchUp())).toBe("copy_expired");
      value(await w.device.hydrate(["core.note"], "library"));

      expect(await keptBlocked(w.device)).toEqual([["update_item", held.id]]);
      expect(value(await w.device.get(held.id)).properties.title).toBe(
        "after the backup",
      );

      value(await w.device.release({ reason: "server_restored" }));
      value(await w.device.drain());
      expect(await title(w.client(), held.id)).toBe("after the backup");
    },
    TIMEOUT,
  );

  it(
    "removes again an edge the restored server holds after this device deleted it",
    async () => {
      const w = await world("restored-edge");
      const from = await note(w.client(), "from");
      const to = await note(w.client(), "to");
      const edge = await w.client().createEdge({
        from_id: from.id,
        to_id: to.id,
        edge_type: "references",
      });
      expect(edge.ok, JSON.stringify(edge.error)).toBe(true);
      const edgeId = edge.data.edge.id;
      value(await w.device.catchUp());
      expect(
        value(await w.device.edgesFrom(from.id)).map((held) => held.id),
      ).toEqual([edgeId]);
      const image = await w.original.image();
      value(await w.device.deleteEdge(edgeId));
      expect((await sent(w.device)).answered).toBe(1);

      await w.restore(image);
      expect((await w.client().getEdge(edgeId)).status).toBe(200);
      expect(expired(await w.device.catchUp())).toBe("copy_expired");
      value(await w.device.hydrate(["core.note"], "library"));

      expect(await keptBlocked(w.device)).toEqual([["delete_edge", edgeId]]);
      expect(value(await w.device.edgesFrom(from.id))).toEqual([]);

      value(await w.device.release({ reason: "server_restored" }));
      value(await w.device.drain());
      expect((await w.client().getEdge(edgeId)).status).toBe(404);
    },
    TIMEOUT,
  );
});

describe("a server restored behind nothing this device holds", () => {
  it(
    "clears and fills as before where the copy holds nothing the restored server lacks",
    async () => {
      const w = await world("restored-nothing-lost");
      const kept = await note(w.client(), "before the backup");
      value(await w.device.catchUp());
      const image = await w.original.image();
      // Made and purged after the copy was taken: the device takes both, so
      // its cursor is past the restored log's head and it holds nothing the
      // restored server lacks.
      const gone = await note(w.client(), "made and purged");
      expect((await w.client().deleteItem(gone.id)).ok).toBe(true);
      expect((await w.client().purgeItem(gone.id)).ok).toBe(true);
      value(await w.device.catchUp());

      await w.restore(image);
      expect(
        expired(await w.device.catchUp()),
        "the restore was not seen, so nothing was compared",
      ).toBe("copy_expired");
      value(await w.device.hydrate(["core.note"], "library"));

      expect(await queue(w.device)).toEqual([]);
      expect(value(await w.device.list()).map((item) => item.id)).toEqual([
        kept.id,
      ]);
    },
    TIMEOUT,
  );
});

describe("an archive restore and a backup restore", () => {
  it(
    "keeps newer work through an archive restore and a backup restore, expiring nothing",
    async () => {
      const folder = tempFolder("marfa-restored-backups-");
      const w = await world("restored-additive", {
        MARFA_OBJECT_STORE_BUCKET: "",
        MARFA_BACKUP_PATH: folder,
        MARFA_BACKUP_INTERVAL_SECONDS: "0",
      });
      const owner = ownerOf(w.original);
      value(await w.device.catchUp());
      const archive = await w.client().exportArchive();
      expect(archive.ok, JSON.stringify(archive.error)).toBe(true);
      const backup = await owner.runBackup();
      expect(backup.ok, JSON.stringify(backup.error)).toBe(true);

      const first = await made(w.device, "made after the archive");
      value(await w.device.drain());
      value(await w.device.catchUp());
      const restored = await owner.restoreArchive(archive.data);
      expect(restored.status, JSON.stringify(restored.error)).toBe(200);
      expect(expired(await w.device.catchUp())).toBe("caught up");

      const second = await made(w.device, "made after the backup");
      value(await w.device.drain());
      const fromBackup = await owner.restoreBackup(
        backup.data.backup.instance_id,
        backup.data.backup.name,
      );
      expect(fromBackup.status, JSON.stringify(fromBackup.error)).toBe(200);
      expect(expired(await w.device.catchUp())).toBe("caught up");

      expect(
        (await queue(w.device)).filter(
          (write) => write.reason === "server_restored",
        ),
      ).toEqual([]);
      expect(await title(w.client(), first)).toBe("made after the archive");
      expect(await title(w.client(), second)).toBe("made after the backup");
    },
    TIMEOUT,
  );
});
