import { afterAll, describe, expect, it } from "vitest";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  stopFreshServers,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { withInstanceDatabase } from "../../utils/instance-database.js";

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
      type_permissions: { "core.note": "read" },
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
        (await send(server, "/owner", { cookie: server.ownerCookie })).status,
      ).toBe(200);

      const held = storedTimes(server);
      const tables = new Set(held.map((time) => time.table));
      for (const table of [
        "auth_user",
        "auth_account",
        "auth_session",
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
      const expiring = (value: string) =>
        withInstanceDatabase(server.sqlitePath, (db) =>
          db
            .prepare("UPDATE api_keys SET expires_at = ? WHERE id = ?")
            .run(value, id),
        );
      expect(
        (await send(server, "/items?type=core.note", { key })).status,
      ).toBe(200);

      for (const damaged of ["soon", "4070908800000", "2099-01-01T00:00:00Z"]) {
        expiring(damaged);
        const refused = await send(server, "/items?type=core.note", { key });
        expect(refused.status, damaged).toBe(500);
        expect(await refused.json()).toEqual(INTERNAL);
      }

      expiring("2099-01-01T00:00:00.000Z");
      expect(
        (await send(server, "/items?type=core.note", { key })).status,
      ).toBe(200);
    },
    FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "answers 500 internal_error to a browser session whose stored end does not read, and answers again once it reads",
    async () => {
      const server = await bootFreshServer("stored-times-session");
      const ending = (value: string) =>
        withInstanceDatabase(server.sqlitePath, (db) =>
          db.prepare("UPDATE auth_session SET expires_at = ?").run(value),
        );
      expect(
        (await send(server, "/owner", { cookie: server.ownerCookie })).status,
      ).toBe(200);

      for (const damaged of ["soon", "4070908800", "2099-01-01T00:00:00Z"]) {
        ending(damaged);
        const refused = await send(server, "/owner", {
          cookie: server.ownerCookie,
        });
        expect(refused.status, damaged).toBe(500);
        expect(await refused.json()).toEqual(INTERNAL);
      }

      ending("2099-01-01T00:00:00.000Z");
      expect(
        (await send(server, "/owner", { cookie: server.ownerCookie })).status,
      ).toBe(200);
    },
    FRESH_SERVER_TIMEOUT_MS,
  );
});
