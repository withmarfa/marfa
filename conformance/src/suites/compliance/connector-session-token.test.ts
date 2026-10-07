import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import {
  approvedAppToken,
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { createNote } from "../../generators/items.js";
import { idOf, send } from "../../utils/inbound-sender.js";
import { expectMatchesSchema } from "../../utils/openapi.js";

/**
 * An app's session token is not a connector's key: a registration keyed to
 * one would be orphaned by its next refresh. A fixture holds one through the
 * device flow, which needs an owner, so the file's server is its own.
 */

let server: FreshServer;
let token: string;
let own: MarfaClient;
let registrationId: string;
let rowId: string;
let endpointId: string;
let deliveryId: string;
const holder = randomUUID();

beforeAll(async () => {
  server = await bootFreshServer("connector-session-token");
  token = await approvedAppToken(server);
  const minter = new MarfaClient({
    baseUrl: server.apiUrl,
    apiKey: server.workingKey,
  });
  const minted = await minter.createKey({
    label: "session-token-connector",
    source: "session-token-connector",
    default_tier: "library",
  });
  expect(minted.status).toBe(201);
  own = new MarfaClient({ baseUrl: server.apiUrl, apiKey: minted.data.key });
  const registered = await own.registerConnector({ name: "session token" });
  expect(registered.status).toBe(201);
  registrationId = registered.data.id;

  // What the connector holds, so that a refusal leaves something to compare.
  const row = await minter.createItem(createNote());
  expect(row.ok, JSON.stringify(row.error)).toBe(true);
  rowId = row.data.item.id;
  expect((await own.holdConnector(registrationId, holder)).status).toBe(200);
  expect(
    (
      await own.replaceConnectorState(registrationId, {
        process: holder,
        state: { cursor: "kept" },
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await own.writeConnectorAgreements(registrationId, {
        process: holder,
        set: [{ item_id: rowId, waiting: true, record: { etag: "kept" } }],
      })
    ).status,
  ).toBe(200);
  const endpoint = await own.createInboundEndpoint(registrationId);
  expect(endpoint.status).toBe(201);
  endpointId = endpoint.data.id;
  deliveryId = idOf(await send(server.apiUrl, endpoint.data.path, "kept"));
}, 2 * FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  await server.stop();
}, 2 * FRESH_SERVER_TIMEOUT_MS);

/** The session token's request, and nothing else a fixture's client adds. */
async function asApp(
  method: string,
  path: string,
  body?: Record<string, unknown>,
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${server.apiUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

describe("an app's session token on the connector doors", () => {
  it("refuses an app's session token 403 on every door that admits the connector's key", async () => {
    const id = registrationId;
    const startedAt = "2026-10-05T18:00:00Z";
    const doors: {
      label: string;
      method: string;
      path: string;
      template: string;
      body?: Record<string, unknown>;
    }[] = [
      {
        label: "heartbeat",
        method: "POST",
        path: `/connectors/${id}/heartbeat`,
        template: "/connectors/{id}/heartbeat",
      },
      {
        label: "runs",
        method: "POST",
        path: `/connectors/${id}/runs`,
        template: "/connectors/{id}/runs",
        body: {
          outcome: "succeeded",
          started_at: startedAt,
          finished_at: startedAt,
        },
      },
      {
        label: "hold",
        method: "POST",
        path: `/connectors/${id}/hold`,
        template: "/connectors/{id}/hold",
        body: { process: "app" },
      },
      {
        label: "release",
        method: "DELETE",
        path: `/connectors/${id}/hold?process=${holder}`,
        template: "/connectors/{id}/hold",
      },
      {
        label: "read state",
        method: "GET",
        path: `/connectors/${id}/state`,
        template: "/connectors/{id}/state",
      },
      {
        label: "replace state",
        method: "PUT",
        path: `/connectors/${id}/state`,
        template: "/connectors/{id}/state",
        body: { process: holder, state: { cursor: "app" } },
      },
      {
        label: "clear state",
        method: "DELETE",
        path: `/connectors/${id}/state`,
        template: "/connectors/{id}/state",
      },
      {
        label: "write agreements",
        method: "POST",
        path: `/connectors/${id}/agreements`,
        template: "/connectors/{id}/agreements",
        body: { process: holder, clear: [rowId] },
      },
      {
        label: "find agreements",
        method: "POST",
        path: `/connectors/${id}/agreements/lookup`,
        template: "/connectors/{id}/agreements/lookup",
        body: { item_ids: [rowId] },
      },
      {
        label: "list agreements",
        method: "GET",
        path: `/connectors/${id}/agreements`,
        template: "/connectors/{id}/agreements",
      },
      {
        label: "make an endpoint",
        method: "POST",
        path: `/connectors/${id}/endpoints`,
        template: "/connectors/{id}/endpoints",
        body: {},
      },
      {
        label: "list endpoints",
        method: "GET",
        path: `/connectors/${id}/endpoints`,
        template: "/connectors/{id}/endpoints",
      },
      {
        label: "retire an endpoint",
        method: "DELETE",
        path: `/connectors/${id}/endpoints/${endpointId}`,
        template: "/connectors/{id}/endpoints/{endpoint_id}",
      },
      {
        label: "list deliveries",
        method: "GET",
        path: `/connectors/${id}/deliveries`,
        template: "/connectors/{id}/deliveries",
      },
      {
        label: "read a body",
        method: "GET",
        path: `/connectors/${id}/deliveries/${deliveryId}/body`,
        template: "/connectors/{id}/deliveries/{delivery_id}/body",
      },
      {
        label: "mark handled",
        method: "POST",
        path: `/connectors/${id}/deliveries/handled`,
        template: "/connectors/{id}/deliveries/handled",
        body: { ids: [deliveryId], outcome: "processed" },
      },
      {
        label: "remove the registration",
        method: "DELETE",
        path: `/connectors/${id}`,
        template: "/connectors/{id}",
      },
    ];

    // The witness: the token is a credential the connector doors read, so
    // the refusals below are about what it is.
    const listed = await asApp("GET", "/connectors");
    expect(listed.status).toBe(200);

    for (const door of doors) {
      const refused = await asApp(door.method, door.path, door.body);
      expect(refused.status, door.label).toBe(403);
      expect(
        (refused.body as { error?: { code?: string } }).error?.code,
        door.label,
      ).toBe("forbidden");
      await expectMatchesSchema(
        door.method.toUpperCase(),
        door.template,
        403,
        refused.body,
      );
    }

    // Nothing the refusals asked for happened. The connector's own key reads
    // the registration, its hold, its state, its agreement, its endpoint and
    // its delivery as it left them.
    const read = await own.getConnector(registrationId);
    expect(read.status).toBe(200);
    expect(read.data.last_heartbeat_at).toBeNull();
    expect(read.data.last_run).toBeNull();
    expect(read.data.hold_expires_at).not.toBeNull();
    expect((await own.getConnectorState(registrationId)).data.state).toEqual({
      cursor: "kept",
    });
    const agreements = await own.lookupConnectorAgreements(registrationId, [
      rowId,
    ]);
    expect(agreements.data.data.map((row) => row.record)).toEqual([
      { etag: "kept" },
    ]);
    const endpoints = await own.listInboundEndpoints(registrationId);
    expect(endpoints.data.data.map((row) => [row.id, row.retired_at])).toEqual([
      [endpointId, null],
    ]);
    const deliveries = await own.listInboundDeliveries(registrationId);
    expect(deliveries.data.data.map((row) => [row.id, row.handled_at])).toEqual(
      [[deliveryId, null]],
    );
    expect((await own.listConnectorRuns(registrationId)).data.data).toEqual([]);
    // The witness for the refused hold and release: the holder still renews.
    expect((await own.holdConnector(registrationId, holder)).data.renewed).toBe(
      true,
    );
  });

  it("lists nothing to an app's session token, and hides a registration from it", async () => {
    // The witness: the registration is there for its own key and the
    // operator's.
    expect((await own.listConnectors()).data.data.map((row) => row.id)).toEqual(
      [registrationId],
    );
    const operator = new MarfaClient({
      baseUrl: server.apiUrl,
      apiKey: server.operatorKey,
    });
    expect(
      (await operator.listConnectors()).data.data.map((row) => row.id),
    ).toEqual([registrationId]);

    const listed = await asApp("GET", "/connectors");
    expect(listed.status).toBe(200);
    expect(listed.body).toEqual({ data: [], next_cursor: null });
    for (const suffix of ["", "/runs"]) {
      const hidden = await asApp(
        "GET",
        `/connectors/${registrationId}${suffix}`,
      );
      const absent = await asApp(
        "GET",
        `/connectors/01a0c000-0000-7000-8000-000000000000${suffix}`,
      );
      expect(hidden.status, suffix).toBe(404);
      expect(
        (hidden.body as { error?: { code?: string } }).error?.code,
        suffix,
      ).toBe("connector_not_found");
      expect(hidden.body).toEqual(absent.body);
    }
  });

  it("refuses an app's session token 403 on registration, leaving nothing registered", async () => {
    const refused = await asApp("POST", "/connectors", { name: "session" });
    expect(refused.status).toBe(403);
    expect((refused.body as { error?: { code?: string } }).error?.code).toBe(
      "forbidden",
    );
    const operator = new MarfaClient({
      baseUrl: server.apiUrl,
      apiKey: server.operatorKey,
    });
    const rows = (await operator.listConnectors()).data.data;
    expect(rows.map((row) => row.name)).toEqual(["session token"]);
  });
});
