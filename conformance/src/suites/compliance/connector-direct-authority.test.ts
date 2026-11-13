import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { controlRequest } from "../../utils/control-request.js";
import { idOf, send } from "../../utils/inbound-sender.js";

let server: FreshServer;
let own: MarfaClient;
let id: string;
let itemId: string;
let deliveryId: string;
const holder = randomUUID();

beforeAll(async () => {
  server = await bootFreshServer("connector-direct-authority");
  own = new MarfaClient({ baseUrl: server.apiUrl, apiKey: server.workingKey });
  const registered = await own.registerConnector({ name: "own-key witness" });
  expect(registered.status).toBe(201);
  id = registered.data.id;
  const item = await own.createItem({
    type: "core.note",
    properties: { body: "kept" },
  });
  expect(item.status).toBe(201);
  itemId = item.data.item.id;
  expect((await own.takeConnectorHold(id, holder)).status).toBe(200);
  expect(
    (
      await own.replaceConnectorState(id, {
        process: holder,
        state: { cursor: "kept" },
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await own.writeConnectorAgreements(id, {
        process: holder,
        set: [{ item_id: itemId, waiting: true, record: { etag: "kept" } }],
      })
    ).status,
  ).toBe(200);
  const endpoint = await own.createInboundEndpoint(id);
  expect(endpoint.status).toBe(201);
  const delivery = await send(server.apiUrl, endpoint.data.path, "kept");
  expect(delivery.status).toBe(202);
  deliveryId = idOf(delivery);
}, 2 * FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  await server?.stop();
}, 2 * FRESH_SERVER_TIMEOUT_MS);

interface Door {
  method: string;
  path: string;
  body?: Record<string, unknown>;
  /** The door names no connector: the key is the connector. */
  own?: boolean;
}

function urlOf(door: Door, connectorId: string): string {
  return door.own
    ? `/connectors${door.path}`
    : `/connectors/${connectorId}${door.path}`;
}

function doors(): Door[] {
  const at = "2026-10-05T18:00:00Z";
  return [
    { method: "POST", path: "/heartbeat", own: true },
    {
      method: "POST",
      path: "/runs",
      own: true,
      body: { outcome: "succeeded", started_at: at, finished_at: at },
    },
    { method: "POST", path: "/hold", body: { process: holder } },
    { method: "GET", path: "/state" },
    {
      method: "PUT",
      path: "/state",
      body: { process: holder, state: { cursor: "changed" } },
    },
    {
      method: "POST",
      path: "/agreements",
      body: { process: holder, clear: [itemId] },
    },
    {
      method: "POST",
      path: "/agreements/lookup",
      body: { item_ids: [itemId] },
    },
    { method: "GET", path: "/agreements" },
    { method: "GET", path: "/deliveries" },
    { method: "GET", path: `/deliveries/${deliveryId}/body` },
    {
      method: "POST",
      path: "/deliveries/handled",
      body: { ids: [deliveryId], outcome: "processed" },
    },
    { method: "DELETE", path: `/hold?process=${holder}` },
  ];
}

async function refusesPrivateSocket(): Promise<void> {
  for (const door of doors()) {
    const path = urlOf(door, id);
    const response = await controlRequest(server.controlSocket, path, door);
    expect(response.status, `private socket: ${door.method} ${door.path}`).toBe(
      403,
    );
    expect(response.body).toMatchObject({ error: { code: "forbidden" } });
  }
  expect((await own.getConnectorState(id)).data.state).toEqual({
    cursor: "kept",
  });
  expect(
    (await own.lookupConnectorAgreements(id, [itemId])).data.data.map(
      (row) => row.record,
    ),
  ).toEqual([{ etag: "kept" }]);
  expect(
    (await own.listInboundDeliveries(id)).data.data.map(
      (row) => row.handled_at,
    ),
  ).toEqual([null]);
  const registration = await own.getConnector(id);
  expect(registration.data.last_heartbeat_at).toBeNull();
  expect(registration.data.last_run).toBeNull();
  expect((await own.takeConnectorHold(id, holder)).data.renewed).toBe(true);
}

describe("direct authority on own-key connector operations", () => {
  it("refuses private socket 403 on every own-key read and write", async () => {
    await refusesPrivateSocket();
  });

  it("keeps missing credentials at 401 and another key at 403", async () => {
    for (const key of [undefined, server.managementKey]) {
      for (const connectorId of [id, "01a0c000-0000-7000-8000-000000000000"]) {
        for (const door of doors()) {
          const res = await fetch(
            `${server.apiUrl}${urlOf(door, connectorId)}`,
            {
              method: door.method,
              headers: {
                ...(key === undefined
                  ? {}
                  : { Authorization: `Bearer ${key}` }),
                ...(door.body === undefined
                  ? {}
                  : { "Content-Type": "application/json" }),
              },
              body:
                door.body === undefined ? undefined : JSON.stringify(door.body),
            },
          );
          // Another key is no connector's own, so an own-key door finds it no
          // registration where a door that names one refuses it.
          const expected =
            key === undefined
              ? 401
              : connectorId === id && !door.own
                ? 403
                : 404;
          expect(
            res.status,
            `${key === undefined ? "anonymous" : "another key"}: ${door.method} ${door.path}`,
          ).toBe(expected);
          expect(await res.json()).toMatchObject({
            error: {
              code:
                expected === 401
                  ? "unauthorized"
                  : expected === 403
                    ? "forbidden"
                    : "connector_not_found",
            },
          });
        }
      }
    }
  });

  it("admits the connector's own key on the same reads and writes", async () => {
    for (const door of doors()) {
      const res = await fetch(`${server.apiUrl}${urlOf(door, id)}`, {
        method: door.method,
        headers: {
          Authorization: `Bearer ${server.workingKey}`,
          ...(door.body === undefined
            ? {}
            : { "Content-Type": "application/json" }),
        },
        body: door.body === undefined ? undefined : JSON.stringify(door.body),
      });
      expect([200, 201], `${door.method} ${door.path}`).toContain(res.status);
      await res.arrayBuffer();
    }
  });
});
