import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { withInstanceDatabase } from "../../utils/instance-database.js";

let server: FreshServer;
let itemId: string;
let key: { id: string; key: string };

async function api(
  method: string,
  path: string,
  body?: unknown,
  bearer = server.workingKey,
): Promise<Response> {
  return fetch(`${server.apiUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${bearer}`,
      "Content-Type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

beforeAll(async () => {
  server = await bootFreshServer("extension-levels");
  const created = await api("POST", "/items", {
    type: "core.note",
    properties: { body: "extensionlevelword" },
  });
  expect(created.status).toBe(201);
  itemId = ((await created.json()) as { item: { id: string } }).item.id;
  for (const namespace of ["named", "other"]) {
    expect(
      (
        await api("PUT", `/items/${itemId}/extensions/${namespace}`, {
          marker: `${namespace}-extension-value`,
        })
      ).status,
    ).toBe(200);
  }
  const minted = await fetch(`${server.apiUrl}/keys`, {
    method: "POST",
    headers: {
      cookie: server.ownerCookie,
      origin: server.apiUrl,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      label: "extension-levels",
      source: "extension-levels-fixture",
      type_permissions: { "*": "write" },
      extension_permissions: { "*": "write" },
      permissions: ["keys.mint"],
    }),
  });
  expect(minted.status).toBe(201);
  key = (await minted.json()) as typeof key;
}, 2 * FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  await server?.stop();
}, 2 * FRESH_SERVER_TIMEOUT_MS);

function storedMap(map: Record<string, unknown>): void {
  withInstanceDatabase(server.sqlitePath, (db) => {
    expect(
      db
        .prepare("UPDATE api_keys SET extension_permissions = ? WHERE id = ?")
        .run(JSON.stringify(map), key.id).changes,
    ).toBe(1);
  });
}

describe("stored extension permission levels", () => {
  it.each(["read", "write"])("grants a normal %s level", async (level) => {
    storedMap({ named: level });
    const read = await api(
      "GET",
      `/items/${itemId}/extensions/named`,
      undefined,
      key.key,
    );
    expect(read.status).toBe(200);
    expect(await read.text()).toContain("named-extension-value");
  });

  it.each(["unknown", "", false, 0, null])(
    "denies malformed exact level %j ahead of wildcard access",
    async (level) => {
      storedMap({ "*": "write", named: level });
      const answer = await api("GET", `/items/${itemId}`, undefined, key.key);
      expect(answer.status).toBe(200);
      const text = await answer.text();
      expect(text).toContain("other-extension-value");
      expect(text).not.toContain("named-extension-value");
      for (const method of ["GET", "PUT", "DELETE"]) {
        expect(
          (
            await api(
              method,
              `/items/${itemId}/extensions/named`,
              method === "PUT" ? { marker: "replacement" } : undefined,
              key.key,
            )
          ).status,
        ).toBe(403);
      }
      expect(
        (
          await api(
            "POST",
            "/keys",
            {
              label: "narrowed",
              source: "narrowed",
              extension_permissions: { "*": "read" },
            },
            key.key,
          )
        ).status,
      ).toBe(403);
      const witness = await api("GET", `/items/${itemId}/extensions/named`);
      expect(witness.status).toBe(200);
      expect(await witness.text()).toContain("named-extension-value");
    },
  );

  it.each(["unknown", "", false, 0, null])(
    "denies malformed wildcard level %j",
    async (level) => {
      storedMap({ "*": level, other: "read" });
      const answer = await api("GET", `/items/${itemId}`, undefined, key.key);
      expect(answer.status).toBe(200);
      const text = await answer.text();
      expect(text).toContain("other-extension-value");
      expect(text).not.toContain("named-extension-value");
    },
  );
});
