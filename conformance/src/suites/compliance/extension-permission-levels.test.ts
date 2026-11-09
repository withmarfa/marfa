import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { localFetch } from "../../utils/control-request.js";

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
  const minted = await localFetch(
    server.controlSocket,
    `${server.apiUrl}/keys`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        label: "extension-levels",
        source: "extension-levels-fixture",
        type_permissions: { "*": "write" },
        extension_permissions: { "*": "write" },
        permissions: ["keys.mint"],
      }),
    },
  );
  expect(minted.status).toBe(201);
  key = (await minted.json()) as typeof key;
}, 2 * FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  await server?.stop();
}, 2 * FRESH_SERVER_TIMEOUT_MS);

let holders = 0;
async function mint(
  extensions: Record<string, "read" | "write">,
): Promise<{ id: string; key: string }> {
  const minted = await localFetch(
    server.controlSocket,
    `${server.apiUrl}/keys`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        label: "extension-levels-held",
        source: `extension-levels-held-${String(++holders)}`,
        type_permissions: { "*": "write" },
        extension_permissions: extensions,
      }),
    },
  );
  expect(minted.status).toBe(201);
  return (await minted.json()) as { id: string; key: string };
}

describe("extension permission levels", () => {
  it("keeps an exact read ceiling when minting or updating wildcard write", async () => {
    // Set the valid map through the API, without changing a stored row.
    const narrowed = await api(
      "PATCH",
      `/keys/${key.id}`,
      {
        extension_permissions: { "*": "write", named: "read" },
      },
      key.key,
    );
    expect(narrowed.status).toBe(200);
    expect(
      (
        await api(
          "GET",
          `/items/${itemId}/extensions/named`,
          undefined,
          key.key,
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await api(
          "PUT",
          `/items/${itemId}/extensions/named`,
          { marker: "refused" },
          key.key,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await api(
          "POST",
          "/keys",
          {
            label: "wildcard-child",
            source: "wildcard-child",
            extension_permissions: { "*": "write" },
          },
          key.key,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await api(
          "PATCH",
          `/keys/${key.id}`,
          {
            extension_permissions: { "*": "write" },
          },
          key.key,
        )
      ).status,
    ).toBe(403);
    const witness = await api("PUT", `/items/${itemId}/extensions/named`, {
      marker: "named-extension-value",
    });
    expect(witness.status).toBe(200);
  });
  it.each([
    ["read", "write"],
    ["write", "read"],
  ] as const)(
    "grants a normal %s level on its namespace in place of the wildcard's",
    async (level, wildcard) => {
      const held = await mint({ "*": wildcard, named: level });
      const read = await api(
        "GET",
        `/items/${itemId}/extensions/named`,
        undefined,
        held.key,
      );
      expect(read.status).toBe(200);
      expect(await read.text()).toContain("named-extension-value");
      const writeNamed = await api(
        "PUT",
        `/items/${itemId}/extensions/named`,
        { marker: "named-extension-value" },
        held.key,
      );
      expect(writeNamed.status).toBe(level === "write" ? 200 : 403);
      const writeOther = await api(
        "PUT",
        `/items/${itemId}/extensions/other`,
        { marker: "other-extension-value" },
        held.key,
      );
      expect(writeOther.status).toBe(wildcard === "write" ? 200 : 403);
    },
  );
});
