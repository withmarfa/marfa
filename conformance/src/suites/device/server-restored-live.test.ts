import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { v7 as uuidv7 } from "uuid";
import { afterAll, describe, expect, it } from "vitest";
import { MarfaClient } from "../../client/api.js";
import { CliDevice, newStore } from "../../device/cli-adapter.js";
import type {
  DrainReport,
  Outcome,
  QueuedWrite,
} from "../../device/protocol.js";
import { ownerOf } from "../../utils/backups.js";
import { controlRequest } from "../../utils/control-request.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { parseEnvFile } from "../../utils/target.js";
import { tempFolder } from "../../utils/temp-folder.js";
import {
  advanceClock,
  bootServer,
  stopServer,
} from "../../../scripts/marfa-server.js";
import { DAY_MS } from "../../utils/moved-clock.js";
import { collectUntil, withStream } from "../../utils/stream.js";
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
  /** An operator client of the server the proxy reaches now. */
  operator(): MarfaClient;
  /** The private control socket of the server the proxy reaches now. */
  socket(): string;
  /** The address of the server the proxy reaches now. */
  upstream(): string;
  /** The requests the device sent, as `METHOD /path`, oldest first. */
  sent: string[];
  /** Stops the original and puts the server booted from `image` in its place. */
  restore(image: string): Promise<void>;
  /** From now on, answers in the server's place each request `answer` returns an answer for. */
  answerInstead(answer: Instead): void;
}

/**
 * An answer the proxy gives in the server's place, by method and path, naming
 * the contract the server's own answers name.
 */
type Instead = (
  method: string,
  path: string,
) => { status: number; body: unknown } | undefined;

async function world(
  label: string,
  env: Record<string, string> = {},
  types: string[] = ["core.note"],
): Promise<World> {
  const original = await bootFreshServer(label, env);
  servers.push(original);
  let upstream = original.apiUrl;
  let state = original.stateDir;
  let instead: Instead = () => undefined;
  let contract: string | null = null;
  const sent: string[] = [];
  const listener = createServer((request, response) => {
    void (async () => {
      const method = request.method ?? "";
      const path = (request.url ?? "").split("?")[0] ?? "";
      sent.push(`${method} ${path}`);
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks);
      const given = instead(method, path);
      if (given !== undefined) {
        response.writeHead(given.status, {
          "content-type": "application/json",
          ...(contract === null ? {} : { "x-marfa-contract": contract }),
        });
        response.end(JSON.stringify(given.body));
        return;
      }
      const headers = new Headers();
      for (const [name, held] of Object.entries(request.headers)) {
        if (
          held !== undefined &&
          ![
            "host",
            "connection",
            "content-length",
            "transfer-encoding",
            "expect",
          ].includes(name)
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
      contract = answer.headers.get("x-marfa-contract") ?? contract;
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
  value(await device.hydrate(types, "library"));
  return {
    original,
    device,
    sent,
    client: () =>
      new MarfaClient({ baseUrl: upstream, apiKey: original.workingKey }),
    operator: () =>
      new MarfaClient({ baseUrl: upstream, apiKey: original.managementKey }),
    socket: () =>
      parseEnvFile(readFileSync(join(state, "env"), "utf8"))
        .MARFA_CONTROL_SOCKET ?? "",
    upstream: () => upstream,
    async restore(image) {
      await original.stop();
      restoredStates.push(image);
      await bootServer({ state: image });
      const restored = parseEnvFile(
        readFileSync(join(image, "env"), "utf8"),
      ).MARFA_API_URL;
      if (!restored) throw new Error("the restored boot wrote no address");
      upstream = restored;
      state = image;
    },
    answerInstead(answer) {
      instead = answer;
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

  // The restored server's clock moves on and its log loses events, which a
  // second run against the same image could not undo.
  it(
    "puts back an edit the stream showed where the restored server's log has aged past the copy's cursor",
    { retry: 0, timeout: TIMEOUT },
    async ({ signal }) => {
      const w = await world("restored-aged");
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
      // The stream shows the edit, so no receipt of it is left unseen.
      const cursor = value(await w.device.catchUp()).cursor;

      await w.restore(image);
      expect(await title(w.client(), held.id)).toBe("before the backup");
      const config = (await w.operator().getConfig()).data as Record<
        string,
        unknown
      >;
      const set = await w.operator().updateConfig({
        ...config,
        event_log_retention_days: 1,
      });
      expect(set.status, JSON.stringify(set.error)).toBe(200);
      for (const n of [1, 2, 3]) {
        await note(w.client(), `written after the restore ${String(n)}`);
      }
      await advanceClock(image, 2 * DAY_MS);
      await note(w.client(), "written a day past the retention");
      await note(w.client(), "and again");
      // Until the sweep retires the events after the copy's cursor, and with
      // them the event the copy took last.
      for (;;) {
        const run = await w.operator().runHousekeeping("event-log-cleanup");
        expect(
          [200, 409],
          `event-log-cleanup: ${JSON.stringify(run.error)}`,
        ).toContain(run.status);
        const ending = await withStream(
          w.upstream(),
          w.original.workingKey,
          { lastEventId: cursor },
          async (stream) => {
            const { events } = await collectUntil(
              stream,
              (seen) =>
                seen.some((e) =>
                  ["catchup_too_old", "stream_live", "cursor_ahead"].includes(
                    e.event,
                  ),
                ),
              `the end of a replay from ${cursor}`,
              signal,
            );
            return events.find((e) => e.event !== "stream_cursor")?.event;
          },
        );
        expect(
          ending,
          "the restored log ends behind the copy's cursor",
        ).not.toBe("cursor_ahead");
        if (ending === "catchup_too_old") break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      expect(expired(await w.device.catchUp())).toBe("copy_expired");
      const filled = value(await w.device.hydrate(["core.note"], "library"));
      expect(
        filled.in_place,
        "the copy took the log as aged out, not as a server restored to an earlier point",
      ).toBe(true);

      expect(await keptBlocked(w.device)).toEqual([["update_item", held.id]]);
      expect(value(await w.device.get(held.id)).properties.title).toBe(
        "after the backup",
      );

      value(await w.device.release({ reason: "server_restored" }));
      value(await w.device.drain());
      expect(await title(w.client(), held.id)).toBe("after the backup");
    },
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

  it(
    "keeps an item made since the backup, with an edit the restored server refused before the copy expired waiting on its create",
    async () => {
      const w = await world("restored-refused-edit");
      value(await w.device.catchUp());
      const image = await w.original.image();
      const id = await made(w.device, "made since the backup");
      await sent(w.device);

      await w.restore(image);
      const version = value(await w.device.get(id)).version;
      value(
        await w.device.update(id, {
          properties: { title: "edited after the restore" },
          version,
        }),
      );
      const refused = value(await w.device.drain());
      expect(refused.verdicts.map((verdict) => verdict.verdict)).toEqual([
        "refused",
      ]);
      // A refused edit is not shown, and the item it was refused for stays.
      expect(
        value(await w.device.get(id)).properties.title,
        "the read after the refusal let go of an item the server gave the copy",
      ).toBe("made since the backup");

      expect(expired(await w.device.catchUp())).toBe("copy_expired");
      value(await w.device.hydrate(["core.note"], "library"));
      expect(await keptBlocked(w.device)).toEqual([
        ["create_item", id],
        ["update_item", id],
      ]);
      const queued = await queue(w.device);
      const create = queued.find((write) => write.kind === "create_item");
      const edit = queued.find((write) => write.kind === "update_item");
      expect(
        edit?.depends_on,
        "the refused edit was not made to wait on the create that puts its item back",
      ).toContain(create?.id);

      expect(value(await w.device.release({ reason: "server_restored" }))).toBe(
        2,
      );
      // The edit was queued before its create, so it waits a drain for it.
      value(await w.device.drain());
      value(await w.device.drain());
      expect(await title(w.client(), id)).toBe("edited after the restore");
    },
    TIMEOUT,
  );

  it(
    "sends a tag replace the restored server refused, once its item is made again, naming no tags it read",
    async () => {
      const w = await world("restored-refused-tags");
      value(await w.device.catchUp());
      const image = await w.original.image();
      const id = await made(w.device, "tagged since the backup");
      value(await w.device.replaceTags(id, ["before"]));
      await sent(w.device);

      await w.restore(image);
      value(await w.device.replaceTags(id, ["after"]));
      const refused = value(await w.device.drain());
      expect(refused.verdicts.map((verdict) => verdict.verdict)).toEqual([
        "refused",
      ]);
      expect(expired(await w.device.catchUp())).toBe("copy_expired");
      value(await w.device.hydrate(["core.note"], "library"));
      const replace = (await queue(w.device)).find(
        (write) =>
          write.kind === "replace_tags" &&
          (write.body as { tags?: string[] }).tags?.[0] === "after",
      );
      expect(replace, "the refused replace was not kept").toBeDefined();
      expect(
        replace?.body,
        "a replace sent over an item its create puts back still names tags the server never held",
      ).toEqual({ tags: ["after"] });

      value(await w.device.release({ reason: "server_restored" }));
      value(await w.device.drain());
      value(await w.device.drain());
      const verdict = (await queue(w.device)).find(
        (write) => write.id === replace?.id,
      );
      expect(
        verdict?.verdict ?? "accepted",
        "the replace was refused for tags the item put back never had",
      ).not.toBe("blocked");
      const read = await w.client().getItem(id);
      expect(read.ok && read.data.metadata.tags).toContain("after");
    },
    TIMEOUT,
  );

  it(
    "puts back the tags the restored server lost from an item it still holds",
    async () => {
      const w = await world("restored-tags");
      const held = await note(w.client(), "tagged after the backup");
      value(await w.device.catchUp());
      const image = await w.original.image();
      value(await w.device.replaceTags(held.id, ["kept"]));
      await sent(w.device);
      // A tag write keeps no receipt, so only the log shows what it lost.
      value(await w.device.catchUp());

      await w.restore(image);
      const before = await w.client().getItem(held.id);
      expect(before.ok && before.data.metadata.tags).toEqual([]);
      expect(expired(await w.device.catchUp())).toBe("copy_expired");
      value(await w.device.hydrate(["core.note"], "library"));

      expect(await keptBlocked(w.device)).toEqual([["replace_tags", held.id]]);
      expect(value(await w.device.get(held.id)).tags).toEqual(["kept"]);

      value(await w.device.release({ reason: "server_restored" }));
      value(await w.device.drain());
      const after = await w.client().getItem(held.id);
      expect(after.ok && after.data.metadata.tags).toEqual(["kept"]);
    },
    TIMEOUT,
  );

  it(
    "puts back the tags of an item made since the backup, named as the tags the item it makes holds",
    async () => {
      const w = await world("restored-create-tags");
      value(await w.device.catchUp());
      const image = await w.original.image();
      const queued = value(
        await w.device.create({
          type: "core.note",
          properties: { title: "made with tags" },
          tags: ["born-a", "born-b"],
        }),
      );
      const id = queued.item_id ?? "";
      await sent(w.device);
      expect((await w.client().getItem(id)).status).toBe(200);

      await w.restore(image);
      expect((await w.client().getItem(id)).status).toBe(404);
      expect(expired(await w.device.catchUp())).toBe("copy_expired");
      value(await w.device.hydrate(["core.note"], "library"));

      expect(await keptBlocked(w.device)).toEqual([
        ["create_item", id],
        ["replace_tags", id],
      ]);
      const kept = (await queue(w.device)).find(
        (write) => write.kind === "replace_tags",
      );
      expect(
        kept?.body,
        "the replace did not name the tags the kept create makes the item hold",
      ).toEqual({ tags: ["born-a", "born-b"], read_tags: [] });

      value(await w.device.release({ reason: "server_restored" }));
      const report = value(await w.device.drain());
      expect(
        report.verdicts.map((entry) => [entry.verdict, entry.reason]),
        JSON.stringify(report),
      ).toEqual([
        ["accepted", null],
        ["accepted", null],
      ]);
      const after = await w.client().getItem(id);
      expect(after.ok && [...after.data.metadata.tags].sort()).toEqual([
        "born-a",
        "born-b",
      ]);
    },
    TIMEOUT,
  );

  it(
    "puts back an edit and a tag change together on the tags the restored server holds, and blocks the tags where another writer changed them since",
    async () => {
      const w = await world("restored-edit-and-tags");
      const held = await note(w.client(), "before the backup");
      const tagged = await w.client().addTags(held.id, ["before"]);
      expect(tagged.status, JSON.stringify(tagged.error)).toBe(200);
      const other = await note(w.client(), "another item, before the backup");
      await w.client().addTags(other.id, ["before"]);
      value(await w.device.catchUp());
      const image = await w.original.image();
      for (const item of [held, other]) {
        value(
          await w.device.update(item.id, {
            properties: { title: "edited after the backup" },
            version: item.version,
          }),
        );
        value(await w.device.replaceTags(item.id, ["after"]));
      }
      await sent(w.device);
      value(await w.device.catchUp());

      await w.restore(image);
      expect(await title(w.client(), held.id)).toBe("before the backup");
      expect(expired(await w.device.catchUp())).toBe("copy_expired");
      value(await w.device.hydrate(["core.note"], "library"));

      const kept = (await queue(w.device)).filter(
        (write) => write.kind === "replace_tags",
      );
      expect(kept.map((write) => write.body)).toEqual([
        { tags: ["after"], read_tags: ["before"] },
        { tags: ["after"], read_tags: ["before"] },
      ]);
      expect((await queue(w.device)).map((write) => write.kind).sort()).toEqual(
        ["replace_tags", "replace_tags", "update_item", "update_item"],
      );

      // Another writer changes the tags of one item before the person releases.
      const changed = await w.client().addTags(other.id, ["added-since"]);
      expect(changed.status, JSON.stringify(changed.error)).toBe(200);
      value(await w.device.release({ reason: "server_restored" }));
      const report = value(await w.device.drain());
      const verdictOf = (id: string) =>
        report.verdicts.find((entry) => entry.id === id);

      for (const write of kept) {
        const landed = write.item_id === held.id;
        expect(
          [verdictOf(write.id)?.verdict, verdictOf(write.id)?.reason],
          `${String(write.item_id)}: ${JSON.stringify(report)}`,
        ).toEqual(
          landed ? ["accepted", null] : ["blocked", "conflict_unresolved"],
        );
      }
      expect(await title(w.client(), held.id)).toBe("edited after the backup");
      expect(await title(w.client(), other.id)).toBe("edited after the backup");
      const tags = async (id: string) => {
        const read = await w.client().getItem(id);
        return read.ok ? read.data.metadata.tags : undefined;
      };
      expect(await tags(held.id)).toEqual(["after"]);
      expect(await tags(other.id)).toEqual(["before", "added-since"]);
      expect(value(await w.device.get(other.id)).tags).toEqual(["after"]);
    },
    TIMEOUT,
  );

  it(
    "puts back in the bin an item the restored server holds out of it after this device trashed it",
    async () => {
      const w = await world("restored-bin");
      const held = await note(w.client(), "trashed after the backup");
      value(await w.device.catchUp());
      const image = await w.original.image();
      value(await w.device.deleteItem(held.id));
      expect((await sent(w.device)).answered).toBe(1);

      await w.restore(image);
      expect((await w.client().getItem(held.id)).status).toBe(200);
      expect(expired(await w.device.catchUp())).toBe("copy_expired");
      value(await w.device.hydrate(["core.note"], "library"));

      expect(await keptBlocked(w.device)).toEqual([["delete_item", held.id]]);

      value(await w.device.release({ reason: "server_restored" }));
      value(await w.device.drain());
      expect((await w.client().getItem(held.id)).status).toBe(404);
      const binned = await w.client().getItem(held.id, "trashed");
      expect(binned.ok && binned.data.item.state).toBe("trashed");
    },
    TIMEOUT,
  );

  it(
    "keeps a file attached since the backup, with an upload of the bytes the restored server lacks",
    async () => {
      const w = await world("restored-upload", {}, ["core.note", "core.file"]);
      const host = await note(w.client(), "holds the attachment");
      value(await w.device.catchUp());
      const image = await w.original.image();
      const folder = tempFolder("marfa-restored-upload-");
      const path = join(folder, "attached.bin");
      writeFileSync(path, `attached ${randomUUID()}`);
      const attached = value(await w.device.attach(host.id, path));
      const fileId = attached.item.item_id ?? "";
      const edgeId = attached.edge.edge_id ?? "";
      const report = await sent(w.device);
      expect(report.answered, JSON.stringify(report)).toBe(3);
      const hash = String(
        value(await w.device.get(fileId)).properties.blob_ref,
      );
      expect((await w.client().downloadBlob(hash)).status).toBe(200);

      await w.restore(image);
      expect(
        (await w.client().downloadBlob(hash)).status,
        "the restored server still holds the bytes, so it lost nothing",
      ).toBe(404);
      expect(expired(await w.device.catchUp())).toBe("copy_expired");
      value(await w.device.hydrate(["core.note", "core.file"], "library"));

      expect(await keptBlocked(w.device)).toEqual([
        ["create_edge", edgeId],
        ["create_item", fileId],
        ["upload_blob", ""],
      ]);

      value(await w.device.release({ reason: "server_restored" }));
      value(await w.device.drain());
      expect((await w.client().downloadBlob(hash)).status).toBe(200);
      expect(await title(w.client(), fileId)).toBe("attached.bin");
    },
    TIMEOUT,
  );

  it(
    "keeps an item made since the backup through a hydration of another slice before any catch-up",
    async () => {
      const w = await world("restored-other-slice");
      value(await w.device.catchUp());
      const image = await w.original.image();
      const id = await made(w.device, "made since the backup");
      await sent(w.device);

      await w.restore(image);
      // A slice of other types clears the copy rather than fill it again.
      value(await w.device.hydrate(["core.note", "core.task"], "library"));

      expect(await keptBlocked(w.device)).toEqual([["create_item", id]]);
      value(await w.device.release({ reason: "server_restored" }));
      value(await w.device.drain());
      expect(await title(w.client(), id)).toBe("made since the backup");
    },
    TIMEOUT,
  );

  it(
    "keeps nothing of a change another client made at the version the copy held",
    async () => {
      const w = await world("restored-moved-on");
      const held = await note(w.client(), "tagged elsewhere");
      value(await w.device.catchUp());
      const image = await w.original.image();
      const id = await made(w.device, "made since the backup");
      await sent(w.device);

      await w.restore(image);
      expect(expired(await w.device.catchUp())).toBe("copy_expired");
      // After the copy expired, so it holds the item as it was before.
      const tagged = await w.client().addTags(held.id, ["elsewhere"]);
      expect(tagged.ok, JSON.stringify(tagged.error)).toBe(true);
      const now = await w.client().getItem(held.id);
      expect(
        now.ok && now.data.item.version,
        "the tags moved the item to another version",
      ).toBe(held.version);
      value(await w.device.hydrate(["core.note"], "library"));

      expect(
        await keptBlocked(w.device),
        "a change the restored server made after the copy held the item was put back over",
      ).toEqual([["create_item", id]]);
      expect(value(await w.device.get(held.id)).tags).toEqual(["elsewhere"]);
    },
    TIMEOUT,
  );

  it(
    "keeps an item made since the backup under a source its key claims, under that source",
    async () => {
      const w = await world("restored-claimed");
      const own = await claim(w, "restored-claimed-folder");
      value(await w.device.catchUp());
      const image = await w.original.image();
      const sourceId = `${randomUUID()}.md`;
      const id = await keyed(
        w,
        "made under the claim",
        "restored-claimed-folder",
        sourceId,
      );

      await w.restore(image);
      expect((await w.client().getItem(id)).status).toBe(404);
      const clash = await w.client().createItem({
        type: "core.note",
        tier: "library",
        properties: { title: "under the key's own source" },
        source_id: sourceId,
      });
      expect(clash.ok, JSON.stringify(clash.error)).toBe(true);
      expect(clash.data.item.source).toBe(own);
      expect(expired(await w.device.catchUp())).toBe("copy_expired");
      value(await w.device.hydrate(["core.note"], "library"));
      expect(await keptBlocked(w.device)).toEqual([["create_item", id]]);

      value(await w.device.release({ reason: "server_restored" }));
      const report = value(await w.device.drain());
      expect(
        report.verdicts.map((entry) => [entry.verdict, entry.reason ?? null]),
        JSON.stringify(report),
      ).toEqual([["accepted", null]]);
      const back = await w.client().getItem(id);
      expect(back.ok, JSON.stringify(back.error)).toBe(true);
      expect(
        [back.data.item.source, back.data.item.source_id],
        "the kept create came back under the key's own source",
      ).toEqual(["restored-claimed-folder", sourceId]);
      expect(back.data.item.properties.title).toBe("made under the claim");
      const left = await w.client().getItem(clash.data.item.id);
      expect(left.ok && left.data.item.properties.title).toBe(
        "under the key's own source",
      );
    },
    TIMEOUT,
  );

  it(
    "keeps an item made since the backup under a source the restored key does not claim, blocked until it does",
    async () => {
      const w = await world("restored-unclaimed");
      value(await w.device.catchUp());
      const image = await w.original.image();
      // Claimed after the backup, so the restored server's key lacks it.
      await claim(w, "restored-unclaimed-folder");
      const id = await keyed(
        w,
        "made under a later claim",
        "restored-unclaimed-folder",
        `${randomUUID()}.md`,
      );

      await w.restore(image);
      expect(expired(await w.device.catchUp())).toBe("copy_expired");
      value(await w.device.hydrate(["core.note"], "library"));
      expect(await keptBlocked(w.device)).toEqual([["create_item", id]]);

      value(await w.device.release({ reason: "server_restored" }));
      const refused = value(await w.device.drain());
      expect(
        refused.verdicts.map((entry) => [entry.verdict, entry.reason]),
        "a create the restored key may not send under its source was dropped or sent under another",
      ).toEqual([["blocked", "credential_refused"]]);
      expect(refused.unclaimed_sources).toEqual(["restored-unclaimed-folder"]);
      expect((await w.client().getItem(id)).status).toBe(404);
      expect(value(await w.device.get(id)).properties.title).toBe(
        "made under a later claim",
      );

      await claim(w, "restored-unclaimed-folder");
      value(await w.device.drain());
      const back = await w.client().getItem(id);
      expect(back.ok, JSON.stringify(back.error)).toBe(true);
      expect(back.data.item.source).toBe("restored-unclaimed-folder");
    },
    TIMEOUT,
  );
});

async function keyed(
  w: World,
  title: string,
  source: string,
  sourceId: string,
): Promise<string> {
  value(
    await w.device.create({
      type: "core.note",
      properties: { title },
      source,
      sourceId,
    }),
  );
  expect((await sent(w.device)).answered).toBe(1);
  const held = value(await w.device.list()).find(
    (item) => item.source === source && item.source_id === sourceId,
  );
  expect(
    held,
    "the copy holds no item under the key it was made with",
  ).toBeDefined();
  const id = held?.id ?? "";
  expect((await w.client().getItem(id)).status).toBe(200);
  return id;
}

async function claim(w: World, source: string): Promise<string> {
  const current = await w.client().getCurrentKey();
  expect(current.ok, JSON.stringify(current.error)).toBe(true);
  const granted = await controlRequest(w.socket(), `/keys/${current.data.id}`, {
    method: "PATCH",
    body: { sources: [source] },
  });
  expect(granted.status, JSON.stringify(granted.body)).toBe(200);
  expect(granted.body.sources).toEqual([source]);
  return current.data.source ?? "";
}

type Operation = Record<string, unknown>;

/** A type with a `steps` table, and an item of it with the rows `operations` write. */
async function steps(
  client: MarfaClient,
  label: string,
  items: Operation[][],
): Promise<{ type: string; items: string[] }> {
  const type = `user.${label}`;
  const registered = await client.registerType({
    id: type,
    fields: { title: { type: "string" } },
    tables: {
      steps: {
        columns: { count: { type: "integer" }, note: { type: "string" } },
      },
    },
  } as never);
  expect(registered.status, JSON.stringify(registered.error)).toBe(201);
  const made: string[] = [];
  for (const operations of items) {
    const item = await client.createItem({
      type,
      tier: "library",
      properties: { title: "Steps" },
    } as never);
    expect(item.ok, JSON.stringify(item.error)).toBe(true);
    const written = await client.writeRows(item.data.item.id, "steps", {
      operations,
    });
    expect(written.status, JSON.stringify(written.error)).toBe(200);
    made.push(item.data.item.id);
  }
  return { type, items: made };
}

/** The rows of an item's `steps` table the server holds now, as `id: count`. */
async function serverSteps(
  client: MarfaClient,
  item: string,
): Promise<Record<string, unknown>> {
  const read = await client.rawRequest<{
    data: { id: string; values: Record<string, unknown> }[];
  }>(`/items/${item}/tables/steps/rows?limit=1000`);
  expect(read.status, JSON.stringify(read.error)).toBe(200);
  return Object.fromEntries(
    read.data.data.map((row) => [row.id, row.values.count]),
  );
}

/** The rows of an item's `steps` table the copy shows, as `id: count`. */
async function copySteps(
  device: CliDevice,
  item: string,
): Promise<Record<string, unknown>> {
  const page = value(
    await device.tableRead<{
      data: { id: string; values: Record<string, unknown> }[];
    }>(["list", item, "steps", "--limit", "1000"]),
  );
  expect(page.held, "the copy does not hold the table whole").toBe(true);
  return Object.fromEntries(page.data.map((row) => [row.id, row.values.count]));
}

function put(id: string, count: number): Operation {
  return { op: "put", id, values: { count } };
}

describe("table rows a server restored behind lost", () => {
  it(
    "keeps the rows this device wrote and removed since the backup, blocked until released, where the copy had not caught up past them",
    async () => {
      const w = await world("restored-rows-level");
      const [kept, changed, removed] = [uuidv7(), uuidv7(), uuidv7()];
      const { type, items } = await steps(w.client(), "restored-rows-level", [
        [put(kept, 1), put(changed, 2), put(removed, 3)],
      ]);
      const item = items[0] ?? "";
      value(await w.device.hydrate([type], "library"));
      value(await w.device.holdTable(type, "steps"));
      value(await w.device.catchUp());
      const image = await w.original.image();
      const added = uuidv7();
      value(
        await w.device.writeRows(item, "steps", [
          put(changed, 20),
          put(added, 4),
          { op: "delete", id: removed },
        ]),
      );
      expect((await sent(w.device)).answered).toBe(1);

      await w.restore(image);
      expect(await serverSteps(w.client(), item)).toEqual({
        [kept]: 1,
        [changed]: 2,
        [removed]: 3,
      });
      expect(
        expired(await w.device.catchUp()),
        "a copy level with the restored server's log took it as holding the rows",
      ).toBe("copy_expired");
      value(await w.device.hydrate([type], "library"));
      value(await w.device.fillTables());

      expect(await keptBlocked(w.device)).toEqual([["write_rows", item]]);
      const written = { [kept]: 1, [changed]: 20, [added]: 4 };
      expect(await copySteps(w.device, item)).toEqual(written);
      const before = w.sent.length;
      value(await w.device.drain());
      expect(
        w.sent.slice(before).filter((line) => line.startsWith("POST /items")),
        "a blocked row write was sent",
      ).toEqual([]);

      expect(value(await w.device.release({ reason: "server_restored" }))).toBe(
        1,
      );
      value(await w.device.drain());
      expect(await serverSteps(w.client(), item)).toEqual(written);
      expect(
        (await queue(w.device)).filter((write) => write.verdict === "blocked"),
      ).toEqual([]);
    },
    TIMEOUT,
  );

  it(
    "keeps the rows this device wrote since the backup where the restored server has written past the copy's cursor, and nothing of a table it holds as the copy did",
    async () => {
      const w = await world("restored-rows-anchor");
      const [lost, untouched] = [uuidv7(), uuidv7()];
      const { type, items } = await steps(w.client(), "restored-rows-anchor", [
        [put(lost, 1)],
        [put(untouched, 1)],
      ]);
      const [written, whole] = [items[0] ?? "", items[1] ?? ""];
      value(await w.device.hydrate([type], "library"));
      value(await w.device.holdTable(type, "steps"));
      value(await w.device.catchUp());
      const image = await w.original.image();
      value(await w.device.writeRows(written, "steps", [put(lost, 10)]));
      await sent(w.device);
      // The stream shows the batch, so no receipt of it is left unseen.
      value(await w.device.catchUp());

      await w.restore(image);
      await note(w.client(), "written after the restore");
      await note(w.client(), "and again");
      expect(expired(await w.device.catchUp())).toBe("copy_expired");
      value(await w.device.hydrate([type], "library"));
      value(await w.device.fillTables());

      expect(
        await keptBlocked(w.device),
        "the rows the restored server lost were not kept, or a table it holds as the copy did kept a write",
      ).toEqual([["write_rows", written]]);
      expect(await copySteps(w.device, written)).toEqual({ [lost]: 10 });
      expect(await copySteps(w.device, whole)).toEqual({ [untouched]: 1 });

      value(await w.device.release({ reason: "server_restored" }));
      value(await w.device.drain());
      expect(await serverSteps(w.client(), written)).toEqual({ [lost]: 10 });
    },
    TIMEOUT,
  );

  it(
    "sends a row write queued before the restore once the kept rows are withdrawn, refusing none of it",
    async () => {
      const w = await world("restored-rows-withdrawn");
      const row = uuidv7();
      const { type, items } = await steps(
        w.client(),
        "restored-rows-withdrawn",
        [[put(row, 1)]],
      );
      const item = items[0] ?? "";
      value(await w.device.hydrate([type], "library"));
      value(await w.device.holdTable(type, "steps"));
      value(await w.device.catchUp());
      const image = await w.original.image();
      value(await w.device.writeRows(item, "steps", [put(row, 2)]));
      await sent(w.device);
      const later = value(
        await w.device.writeRows(item, "steps", [
          { op: "patch", id: row, values: { note: "later" } },
        ]),
      );

      await w.restore(image);
      expect(expired(await w.device.catchUp())).toBe("copy_expired");
      value(await w.device.hydrate([type], "library"));
      value(await w.device.fillTables());
      const [kept] = (await queue(w.device)).filter(
        (write) => write.reason === "server_restored",
      );
      expect(kept, "no row write was kept").toBeDefined();
      expect(
        (await queue(w.device)).find((write) => write.id === later.id),
      ).toMatchObject({ follows: kept?.id, verdict: null });
      const held = w.sent.length;
      value(await w.device.drain());
      expect(
        w.sent
          .slice(held)
          .filter((line) => line === `POST /items/${item}/tables/steps/rows`),
        "the later write went ahead of the kept one",
      ).toEqual([]);

      value(await w.device.withdraw(kept?.id));
      value(await w.device.drain());
      expect(
        (await queue(w.device)).find((write) => write.id === later.id),
      ).toMatchObject({ verdict: "accepted" });
      const read = await w.client().rawRequest<{
        data: { id: string; values: Record<string, unknown> }[];
      }>(`/items/${item}/tables/steps/rows?limit=1000`);
      expect(read.data.data.find((one) => one.id === row)?.values).toEqual({
        count: 1,
        note: "later",
      });
    },
    TIMEOUT,
  );

  it(
    "holds a row write queued before the restore until the rows set aside are compared, so the values the restored server lost in the row's other columns are kept",
    async () => {
      const w = await world("restored-rows-held-back");
      const row = uuidv7();
      const { type, items } = await steps(
        w.client(),
        "restored-rows-held-back",
        [[put(row, 1)]],
      );
      const item = items[0] ?? "";
      value(await w.device.hydrate([type], "library"));
      value(await w.device.holdTable(type, "steps"));
      value(await w.device.catchUp());
      const image = await w.original.image();
      value(await w.device.writeRows(item, "steps", [put(row, 2)]));
      await sent(w.device);
      const later = value(
        await w.device.writeRows(item, "steps", [
          { op: "patch", id: row, values: { note: "later" } },
        ]),
      );

      await w.restore(image);
      expect(expired(await w.device.catchUp())).toBe("copy_expired");
      value(await w.device.hydrate([type], "library"));
      const before = w.sent.length;
      value(await w.device.drain());
      expect(
        w.sent
          .slice(before)
          .filter((line) => line === `POST /items/${item}/tables/steps/rows`),
        "a row write was sent before the rows set aside were compared",
      ).toEqual([]);
      value(await w.device.fillTables());

      const [kept] = (await queue(w.device)).filter(
        (write) => write.reason === "server_restored",
      );
      expect(kept, "no row write was kept").toBeDefined();
      expect(
        (await queue(w.device)).find((write) => write.id === later.id)?.follows,
      ).toBe(kept?.id);
      const held = w.sent.length;
      value(await w.device.drain());
      expect(
        w.sent
          .slice(held)
          .filter((line) => line === `POST /items/${item}/tables/steps/rows`),
        "the later write went ahead of the kept one",
      ).toEqual([]);

      expect(value(await w.device.release({ reason: "server_restored" }))).toBe(
        1,
      );
      value(await w.device.drain());
      const read = await w.client().rawRequest<{
        data: { id: string; values: Record<string, unknown> }[];
      }>(`/items/${item}/tables/steps/rows?limit=1000`);
      expect(read.data.data.find((one) => one.id === row)?.values).toEqual({
        count: 2,
        note: "later",
      });
      expect(
        (await queue(w.device)).find((write) => write.id === later.id),
      ).toMatchObject({ verdict: "accepted" });
    },
    TIMEOUT,
  );

  it(
    "sets aside a row write whose rows the restored server answers 400 validation_failed, and reads them no more",
    async () => {
      const w = await world("restored-rows-unreadable");
      const row = uuidv7();
      const { type, items } = await steps(
        w.client(),
        "restored-rows-unreadable",
        [[put(row, 1)]],
      );
      const item = items[0] ?? "";
      value(await w.device.hydrate([type], "library"));
      value(await w.device.holdTable(type, "steps"));
      value(await w.device.catchUp());
      const image = await w.original.image();
      value(await w.device.writeRows(item, "steps", [put(row, 2)]));
      await sent(w.device);

      await w.restore(image);
      const read = `GET /items/${item}/tables/steps/rows`;
      const reads = (): number => w.sent.filter((line) => line === read).length;
      w.answerInstead((method, path) =>
        `${method} ${path}` === read
          ? {
              status: 400,
              body: {
                error: {
                  code: "validation_failed",
                  message: "the request does not read",
                },
              },
            }
          : undefined,
      );
      const before = reads();
      expect(
        expired(await w.device.catchUp()),
        "an answer about one table's rows ended the catch-up",
      ).toBe("caught up");
      // The witness: the check read the rows the write changed.
      expect(reads()).toBeGreaterThan(before);
      const checked = reads();
      expect(expired(await w.device.catchUp())).toBe("caught up");
      expect(reads(), "the device read again rows it had set aside").toBe(
        checked,
      );
    },
    TIMEOUT,
  );
});

describe("a server that was not restored", () => {
  it(
    "reads no item again after this device trashed it and another client took it out of the bin",
    async () => {
      const w = await world("not-restored-trash");
      const held = await note(w.client(), "trashed here, restored there");
      value(await w.device.catchUp());
      value(await w.device.deleteItem(held.id));
      await sent(w.device);
      const restored = await w.client().restoreItem(held.id);
      expect(restored.ok, JSON.stringify(restored.error)).toBe(true);
      // The witness: the log of requests holds the device's reads of the item.
      expect(w.sent).toContain(`GET /items/${held.id}`);

      const before = w.sent.length;
      expect(
        expired(await w.device.catchUp()),
        "a trash undone elsewhere was taken as a removal the server lost",
      ).toBe("caught up");
      expect(value(await w.device.get(held.id)).state).toBe("active");
      expect(
        w.sent.slice(before).filter((line) => line.startsWith("GET /items/")),
        "the stream showed the trash, yet the device read the item again",
      ).toEqual([]);
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
