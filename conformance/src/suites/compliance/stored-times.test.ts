import { afterAll, describe, expect, it } from "vitest";
import { MarfaClient } from "../../client/api.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  stopFreshServers,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { withInstanceDatabase } from "../../utils/instance-database.js";
import type { SseEvent } from "../../utils/sse.js";
import { collectUntil, withStream } from "../../utils/stream.js";
import { startReceiver } from "../../utils/webhook-receiver.js";

// The damage is written into the database as a hand edit would leave it: no
// door stores a time in any other form.

afterAll(stopFreshServers, 2 * FRESH_SERVER_TIMEOUT_MS);

const STORED = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const INTERNAL = {
  error: { code: "internal_error", message: "Internal server error" },
};

const send = (
  server: FreshServer,
  path: string,
  init: { key?: string; cookie?: string; method?: string; body?: unknown } = {},
) =>
  fetch(`${server.apiUrl}${path}`, {
    method: init.method ?? "GET",
    headers: {
      ...(init.key === undefined
        ? {}
        : { authorization: `Bearer ${init.key}` }),
      ...(init.cookie === undefined ? {} : { cookie: init.cookie }),
      ...(init.body === undefined
        ? {}
        : { "content-type": "application/json" }),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });

interface Held {
  table: string;
  column: string;
  value: unknown;
}

/** Every value of every column that holds a time, in every table. */
const storedTimes = (server: FreshServer): Held[] =>
  withInstanceDatabase(server.sqlitePath, (db) => {
    const held: Held[] = [];
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
      )
      .all() as { name: string }[];
    for (const { name: table } of tables) {
      const columns = db.prepare(`PRAGMA table_info("${table}")`).all() as {
        name: string;
      }[];
      for (const { name: column } of columns) {
        if (!column.endsWith("_at") && column !== "fresh_until") continue;
        const rows = db
          .prepare(
            `SELECT "${column}" AS value FROM "${table}" WHERE "${column}" IS NOT NULL`,
          )
          .all() as { value: unknown }[];
        for (const { value } of rows) held.push({ table, column, value });
      }
    }
    return held;
  });

const mintKey = async (
  server: FreshServer,
): Promise<{ id: string; key: string }> => {
  const minted = await send(server, "/keys", {
    key: server.managementKey,
    method: "POST",
    body: {
      label: "expiring",
      source: "expiring",
      permissions: [],
      expires_at: "2099-01-01T01:00:00+01:00",
    },
  });
  expect(minted.status).toBe(201);
  const body = (await minted.json()) as {
    key: string;
    id?: string;
    api_key?: { id: string };
  };
  const id = body.id ?? body.api_key?.id;
  expect(id).toEqual(expect.any(String));
  return { id: id as string, key: body.key };
};

const expiringAt = (server: FreshServer, id: string, value: string) =>
  withInstanceDatabase(server.sqlitePath, (db) =>
    db
      .prepare("UPDATE api_keys SET expires_at = ? WHERE id = ?")
      .run(value, id),
  );

describe("a time the server keeps", () => {
  it(
    "keeps every time in its database as UTC text with milliseconds",
    async () => {
      const server = await bootFreshServer("stored-times-form");
      const made = await send(server, "/items", {
        key: server.workingKey,
        method: "POST",
        body: {
          type: "core.note",
          properties: { body: "kept" },
          occurred_at: "2026-01-01t01:00:00.5+01:00",
        },
      });
      expect(made.status).toBe(201);
      await mintKey(server);
      expect(
        (await send(server, "/owner/passkeys", { cookie: server.ownerCookie }))
          .status,
      ).toBe(200);

      const held = storedTimes(server);
      const tables = new Set(held.map((time) => time.table));
      for (const table of [
        "owner",
        "sign_ins",
        "api_keys",
        "items",
        "audit_log",
      ]) {
        expect(tables, table).toContain(table);
      }
      expect(
        held.filter(
          (time) => typeof time.value !== "string" || !STORED.test(time.value),
        ),
      ).toEqual([]);
    },
    FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "answers 500 internal_error to a key whose stored expiry does not read, and answers again once it reads",
    async () => {
      const server = await bootFreshServer("stored-times-key");
      const { id, key } = await mintKey(server);
      const expiring = (value: string) => expiringAt(server, id, value);
      expect((await send(server, "/keys/current", { key })).status).toBe(200);
      // The witness: the stored expiry decides, and one that reads as past refuses 401.
      expiring("2000-01-01T00:00:00.000Z");
      expect((await send(server, "/keys/current", { key })).status).toBe(401);

      // "0" sorts before any time it could be compared with as text, "z" after.
      for (const damaged of [
        "0",
        "z",
        "soon",
        "4070908800000",
        "2099-01-01T00:00:00Z",
      ]) {
        expiring(damaged);
        const refused = await send(server, "/keys/current", { key });
        expect(refused.status, damaged).toBe(500);
        expect(await refused.json()).toEqual(INTERNAL);
      }

      expiring("2099-01-01T00:00:00.000Z");
      expect((await send(server, "/keys/current", { key })).status).toBe(200);
    },
    FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "answers 500 internal_error to a browser session whose stored end does not read, and answers again once it reads",
    async () => {
      const server = await bootFreshServer("stored-times-session");
      const ending = (value: string) =>
        withInstanceDatabase(server.sqlitePath, (db) =>
          db.prepare("UPDATE sign_ins SET expires_at = ?").run(value),
        );
      expect(
        (await send(server, "/owner/passkeys", { cookie: server.ownerCookie }))
          .status,
      ).toBe(200);

      for (const damaged of [
        "0",
        "z",
        "soon",
        "4070908800",
        "2099-01-01T00:00:00Z",
      ]) {
        ending(damaged);
        const refused = await send(server, "/owner/passkeys", {
          cookie: server.ownerCookie,
        });
        expect(refused.status, damaged).toBe(500);
        expect(await refused.json()).toEqual(INTERNAL);
      }

      ending("2099-01-01T00:00:00.000Z");
      expect(
        (await send(server, "/owner/passkeys", { cookie: server.ownerCookie }))
          .status,
      ).toBe(200);
    },
    FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "answers 500 internal_error to GET /sources while a key's stored expiry does not read, and answers again once it reads",
    async () => {
      const server = await bootFreshServer("stored-times-sources");
      const { id } = await mintKey(server);
      const listed = async () => {
        const answer = await send(server, "/sources", {
          key: server.managementKey,
        });
        expect(answer.status).toBe(200);
        const body = (await answer.json()) as { data: { source: string }[] };
        return body.data.map((entry) => entry.source);
      };
      expect(await listed()).toContain("expiring");
      // The witness: the stored expiry decides, and a source held only by a key past its end goes.
      expiringAt(server, id, "2000-01-01T00:00:00.000Z");
      expect(await listed()).not.toContain("expiring");

      for (const damaged of ["0", "z", "soon", "2099-01-01T00:00:00Z"]) {
        expiringAt(server, id, damaged);
        const refused = await send(server, "/sources", {
          key: server.managementKey,
        });
        expect(refused.status, damaged).toBe(500);
        expect(await refused.json()).toEqual(INTERNAL);
      }

      expiringAt(server, id, "2099-01-01T00:00:00.000Z");
      expect(await listed()).toContain("expiring");
    },
    FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "goes on delivering to every other webhook while one webhook's key has a stored expiry that does not read",
    async () => {
      const server = await bootFreshServer("stored-times-webhooks");
      const receiver = await startReceiver({ status: 200 });
      try {
        const admin = new MarfaClient({
          baseUrl: server.apiUrl,
          apiKey: server.workingKey,
        });
        const subscribe = async (label: string) => {
          const minted = await admin.createKey({
            label,
            source: label,
            permissions: ["webhooks.manage"],
            type_permissions: { "core.note": "read" },
          });
          expect(minted.status).toBe(201);
          const hook = await new MarfaClient({
            baseUrl: server.apiUrl,
            apiKey: minted.data.key,
          }).createWebhook({
            url: receiver.hookUrl(label),
            events: ["item.created"],
          });
          expect(hook.status).toBe(201);
          return minted.data.id;
        };
        await subscribe("kept");
        const damagedKey = await subscribe("damaged");
        const note = async (body: string) => {
          const made = await admin.createItem({
            type: "core.note",
            properties: { body },
          });
          expect(made.status).toBe(201);
          return made.data.item.id;
        };
        const reaches = (label: string, id: string) =>
          receiver.waitFor(
            (r) => r.path === `/hook/${label}` && r.body.includes(id),
          );

        // The witness: both webhooks are sent what they subscribe to.
        const before = await note("before");
        await reaches("kept", before);
        await reaches("damaged", before);

        expiringAt(server, damagedKey, "0");
        const during = await note("during");
        await reaches("kept", during);

        expiringAt(server, damagedKey, "2099-01-01T00:00:00.000Z");
        const after = await note("after");
        await reaches("kept", after);
        await reaches("damaged", after);
        expect(
          receiver.received.filter(
            (r) => r.path === "/hook/damaged" && r.body.includes(during),
          ),
        ).toEqual([]);
      } finally {
        await receiver.close();
      }
    },
    FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "answers items of every other source while a connector key's stored expiry does not read, and 500 internal_error for its own",
    async () => {
      const server = await bootFreshServer("stored-times-read-only");
      const admin = new MarfaClient({
        baseUrl: server.apiUrl,
        apiKey: server.workingKey,
      });
      const minted = await admin.createKey({
        label: "connector",
        source: "connector",
        type_permissions: { "core.note": "write" },
      });
      expect(minted.status).toBe(201);
      const connector = new MarfaClient({
        baseUrl: server.apiUrl,
        apiKey: minted.data.key,
      });
      expect(
        (
          await connector.registerConnector({
            name: "connector",
            read_only_types: ["core.note"],
          })
        ).status,
      ).toBe(201);
      const written = async (by: MarfaClient) => {
        const made = await by.createItem({
          type: "core.note",
          properties: { body: "kept" },
        });
        expect(made.status).toBe(201);
        return made.data.item.id;
      };
      const held = await written(connector);
      const other = await written(admin);
      // The witness: the connector key's registration marks its own items.
      const read = await admin.getItem(held);
      expect(read.status).toBe(200);
      expect(read.data.item.read_only).toBe(true);

      for (const damaged of ["0", "z", "soon", "2099-01-01T00:00:00Z"]) {
        expiringAt(server, minted.data.id, damaged);
        const answered = await admin.getItem(other);
        expect(answered.status, damaged).toBe(200);
        expect(answered.data.item.read_only, damaged).toBe(false);
        const refused = await send(server, `/items/${held}`, {
          key: server.workingKey,
        });
        expect(refused.status, damaged).toBe(500);
        expect(await refused.json()).toEqual(INTERNAL);
      }

      expiringAt(server, minted.data.id, "2099-01-01T00:00:00.000Z");
      expect((await admin.getItem(held)).data.item.read_only).toBe(true);
    },
    FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "goes on delivering to webhooks, and ends a stream with catchup_too_old, at an event of a connector key's source while that key's stored expiry does not read",
    async ({ signal }) => {
      const server = await bootFreshServer("stored-times-connector-events");
      const receiver = await startReceiver({ status: 200 });
      try {
        const admin = new MarfaClient({
          baseUrl: server.apiUrl,
          apiKey: server.workingKey,
        });
        const connectorKey = await admin.createKey({
          label: "connector",
          source: "connector",
          type_permissions: { "core.note": "write" },
        });
        expect(connectorKey.status).toBe(201);
        const connector = new MarfaClient({
          baseUrl: server.apiUrl,
          apiKey: connectorKey.data.key,
        });
        expect(
          (
            await connector.registerConnector({
              name: "connector",
              read_only_types: ["core.note"],
            })
          ).status,
        ).toBe(201);
        const subscriberKey = await admin.createKey({
          label: "subscriber",
          source: "subscriber",
          permissions: ["webhooks.manage"],
          type_permissions: { "core.note": "read" },
        });
        expect(subscriberKey.status).toBe(201);
        const hook = await new MarfaClient({
          baseUrl: server.apiUrl,
          apiKey: subscriberKey.data.key,
        }).createWebhook({
          url: receiver.hookUrl("subscriber"),
          events: ["item.created", "item.deleted"],
        });
        expect(hook.status).toBe(201);
        const note = async (by: MarfaClient, body: string) => {
          const made = await by.createItem({
            type: "core.note",
            properties: { body },
          });
          expect(made.status).toBe(201);
          return made.data.item.id;
        };
        const reaches = (id: string) =>
          receiver.waitFor(
            (r) => r.path === "/hook/subscriber" && r.body.includes(id),
          );
        const itemOf = (e: SseEvent): string | undefined =>
          (e.data as { item?: { id?: string } }).item?.id;
        const ended = (seen: SseEvent[]) =>
          seen.some(
            (e) =>
              e.event === "catchup_too_old" || e.event === "stream_incomplete",
          );

        const held = await note(connector, "held");
        const before = await note(admin, "before");
        // The witness: the subscriber is sent the connector's items and the rest.
        await reaches(held);
        await reaches(before);
        const replayed = await withStream(
          server.apiUrl,
          server.workingKey,
          { lastEventId: "0" },
          (opened) =>
            collectUntil(
              opened,
              (seen) => seen.some((e) => itemOf(e) === before),
              `the replay to reach ${before}`,
              signal,
            ),
        );
        const cursor = replayed.events.find((e) => itemOf(e) === before)!.id!;

        expiringAt(server, connectorKey.data.id, "0");
        expect((await admin.deleteItem(held)).status).toBe(200);
        const during = await note(admin, "during");
        await reaches(during);

        const stream = await withStream(
          server.apiUrl,
          server.workingKey,
          { lastEventId: cursor },
          (opened) =>
            collectUntil(
              opened,
              ended,
              `the replay from ${cursor} to end`,
              signal,
            ),
        );
        expect(stream.events.some((e) => e.id !== undefined)).toBe(false);
        expect(stream.events.at(-1)?.event).toBe("catchup_too_old");
        expect(stream.events.at(-1)?.data).toMatchObject({
          requested: cursor,
        });
      } finally {
        await receiver.close();
      }
    },
    FRESH_SERVER_TIMEOUT_MS,
  );
});
