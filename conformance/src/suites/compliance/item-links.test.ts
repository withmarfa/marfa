import { afterAll, beforeAll, expect, it } from "vitest";
import { MarfaClient } from "../../client/api.js";
import { controlRequest } from "../../utils/control-request.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  stopFreshServers,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { callTool, connectMcp, toolResult } from "../../utils/mcp.js";
import { collectUntil, withStreamAtCursor } from "../../utils/stream.js";

/**
 * The addresses an answered item carries (`items/item-web-url`,
 * `items/item-app-url`, `items/item-web-url-follows-address`,
 * `items/item-web-url-trashed`, `items/item-web-url-frame` and
 * `mcp/item-web-url`).
 *
 * On a server of the fixture's own: the sign-in address is the instance's.
 */
let server: FreshServer;
let working: MarfaClient;

beforeAll(async () => {
  server = await bootFreshServer("item-links");
  working = new MarfaClient({
    baseUrl: server.apiUrl,
    apiKey: server.workingKey,
  });
}, FRESH_SERVER_TIMEOUT_MS);

afterAll(stopFreshServers, FRESH_SERVER_TIMEOUT_MS);

const PORT_ADDRESS = "http://marfa.example:8600";
const IDN_ADDRESS = "https://bücher.example";
const MOVED_ADDRESS = "https://moved.example";

async function setAddress(address: string | null): Promise<void> {
  // Only the private socket may skip the check. These hosts do not answer as this instance.
  const response = await controlRequest(server.controlSocket, "/config", {
    method: "PATCH",
    body: {
      sign_in_address: address,
      confirm_sign_in_address_change: true,
      skip_sign_in_address_check: true,
    },
  });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
}

async function instanceId(): Promise<string> {
  const response = await fetch(server.apiUrl, {
    headers: { Authorization: `Bearer ${server.workingKey}` },
  });
  const body = (await response.json()) as { instance_id?: string };
  expect(response.status, JSON.stringify(body)).toBe(200);
  expect(typeof body.instance_id).toBe("string");
  return body.instance_id as string;
}

function localhostOrigin(): string {
  const port = new URL(server.apiUrl).port;
  return port === "" || port === "80"
    ? "http://localhost"
    : `http://localhost:${port}`;
}

function page(origin: string, id: string): string {
  return `${origin}/i/${id}`;
}

async function note(title: string): Promise<{ id: string; version: number }> {
  const made = await working.createItem({
    type: "core.note",
    properties: { title },
  });
  expect(made.status, JSON.stringify(made.error)).toBe(201);
  return { id: made.data.item.id, version: made.data.item.version };
}

it("answers web_url from the sign-in address, including localhost, a port and an IDN host", async () => {
  await setAddress(null);
  const { id } = await note("localhost");
  const cleared = await working.getItem(id);
  expect(cleared.status, JSON.stringify(cleared.error)).toBe(200);
  expect(cleared.data.item.web_url).toBe(page(localhostOrigin(), id));

  await setAddress(PORT_ADDRESS);
  const ported = await working.getItem(id);
  expect(ported.status, JSON.stringify(ported.error)).toBe(200);
  expect(ported.data.item.web_url).toBe(page(new URL(PORT_ADDRESS).origin, id));

  await setAddress(IDN_ADDRESS);
  const named = await working.getItem(id);
  expect(named.status, JSON.stringify(named.error)).toBe(200);
  expect(named.data.item.web_url).toBe(page(new URL(IDN_ADDRESS).origin, id));
});

it("answers app_url from the instance id", async () => {
  const instance = await instanceId();
  const { id } = await note("app");
  const read = await working.getItem(id);
  expect(read.status, JSON.stringify(read.error)).toBe(200);
  expect(read.data.item.app_url).toBe(`marfa://${instance}/${id}`);

  await setAddress(MOVED_ADDRESS);
  const moved = await working.getItem(id);
  expect(moved.status, JSON.stringify(moved.error)).toBe(200);
  expect(moved.data.item.app_url).toBe(`marfa://${instance}/${id}`);
});

it("answers the new web_url on the next read after the sign-in address moves", async () => {
  await setAddress(PORT_ADDRESS);
  const { id } = await note("moves");
  const first = await working.getItem(id);
  expect(first.status, JSON.stringify(first.error)).toBe(200);
  expect(first.data.item.web_url).toBe(page(new URL(PORT_ADDRESS).origin, id));

  await setAddress(MOVED_ADDRESS);
  const second = await working.getItem(id);
  expect(second.status, JSON.stringify(second.error)).toBe(200);
  expect(second.data.item.web_url).toBe(
    page(new URL(MOVED_ADDRESS).origin, id),
  );
  expect(second.data.item.app_url).toBe(first.data.item.app_url);
});

it("answers every item in a list from the sign-in address of that read, and the next list from the address after it moves", async () => {
  await setAddress(PORT_ADDRESS);
  const made = [
    await note("list-a"),
    await note("list-b"),
    await note("list-c"),
  ];
  const ids = new Set(made.map((item) => item.id));
  const origin = new URL(PORT_ADDRESS).origin;
  const first = await working.listItems({ limit: 100 });
  expect(first.status, JSON.stringify(first.error)).toBe(200);
  const listed = first.data.data.filter((item) => ids.has(item.id));
  expect(listed).toHaveLength(3);
  for (const item of first.data.data) {
    expect(item.web_url).toBe(page(origin, item.id));
  }

  await setAddress(MOVED_ADDRESS);
  const nextOrigin = new URL(MOVED_ADDRESS).origin;
  const second = await working.listItems({ limit: 100 });
  expect(second.status, JSON.stringify(second.error)).toBe(200);
  const again = second.data.data.filter((item) => ids.has(item.id));
  expect(again).toHaveLength(3);
  for (const item of second.data.data) {
    expect(item.web_url).toBe(page(nextOrigin, item.id));
  }
});

it("answers web_url and app_url on a trashed item", async () => {
  await setAddress(PORT_ADDRESS);
  const { id } = await note("trashed");
  const trashed = await working.trashItems([id]);
  expect(trashed.status, JSON.stringify(trashed.error)).toBe(200);
  const read = await working.getItem(id, "trashed");
  expect(read.status, JSON.stringify(read.error)).toBe(200);
  expect(read.data.item.state).toBe("trashed");
  expect(read.data.item.web_url).toBe(page(new URL(PORT_ADDRESS).origin, id));
  const instance = await instanceId();
  expect(read.data.item.app_url).toBe(`marfa://${instance}/${id}`);
});

it("answers web_url and app_url on an event frame", async ({ signal }) => {
  await setAddress(PORT_ADDRESS);
  const instance = await instanceId();
  const frame = await withStreamAtCursor(
    server.apiUrl,
    server.workingKey,
    { signal },
    async (stream) => {
      const { id } = await note("frame");
      const { events } = await collectUntil(
        stream,
        (found) =>
          found.some(
            (event) =>
              event.event === "item.created" &&
              (event.data as { item?: { id?: string } }).item?.id === id,
          ),
        `item.created for ${id}`,
        signal,
      );
      return events.find(
        (event) =>
          event.event === "item.created" &&
          (event.data as { item?: { id?: string } }).item?.id === id,
      );
    },
  );
  const item = (
    frame?.data as { item: { id: string; web_url: string; app_url: string } }
  ).item;
  expect(item.web_url).toBe(page(new URL(PORT_ADDRESS).origin, item.id));
  expect(item.app_url).toBe(`marfa://${instance}/${item.id}`);
});

it("answers web_url and app_url from an MCP tool that returns an item", async () => {
  await setAddress(PORT_ADDRESS);
  const instance = await instanceId();
  const mcp = await connectMcp(server.apiUrl, server.workingKey);
  try {
    const created = toolResult(
      await callTool(mcp, "marfa_create", {
        type: "core.note",
        properties: { title: "mcp" },
      }),
    );
    const id = created.id as string;
    const origin = new URL(PORT_ADDRESS).origin;
    expect(created.web_url).toBe(page(origin, id));
    expect(created.app_url).toBe(`marfa://${instance}/${id}`);

    const got = toolResult(await callTool(mcp, "marfa_get", { ids: [id] }));
    const read = (
      got.items as { id: string; web_url: string; app_url: string }[]
    )[0];
    expect(read?.web_url).toBe(page(origin, id));
    expect(read?.app_url).toBe(`marfa://${instance}/${id}`);

    const found = toolResult(
      await callTool(mcp, "marfa_find", { type: "core.note", query: "mcp" }),
    );
    const entry = (
      found.items as { id: string; web_url: string; app_url: string }[]
    ).find((item) => item.id === id);
    expect(entry?.web_url).toBe(page(origin, id));
    expect(entry?.app_url).toBe(`marfa://${instance}/${id}`);

    const changed = toolResult(
      await callTool(mcp, "marfa_update", {
        id,
        version: created.version,
        properties: { title: "mcp renamed" },
      }),
    );
    expect(changed.web_url).toBe(page(origin, id));
    expect(changed.app_url).toBe(`marfa://${instance}/${id}`);
  } finally {
    await mcp.close();
  }
});
