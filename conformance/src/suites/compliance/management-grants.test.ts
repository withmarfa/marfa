import { afterAll, beforeAll, expect, it } from "vitest";
import { MarfaClient } from "../../client/api.js";
import {
  approvedAppToken,
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";

let server: FreshServer;
let owner: MarfaClient;
let working: MarfaClient;
beforeAll(async () => {
  server = await bootFreshServer("management-grants", { S3_BUCKET: "" });
  owner = new MarfaClient({
    baseUrl: server.apiUrl,
    ownerCookie: server.ownerCookie,
  });
  working = new MarfaClient({
    baseUrl: server.apiUrl,
    apiKey: server.workingKey,
  });
}, FRESH_SERVER_TIMEOUT_MS);
afterAll(async () => {
  await server?.stop();
}, FRESH_SERVER_TIMEOUT_MS);

async function callers(permission: string): Promise<MarfaClient[]> {
  const minted = await owner.createKey({
    label: permission,
    source: `management-${permission}`,
    permissions: [permission],
    type_permissions: {},
    extension_permissions: {},
    edge_permissions: {},
    metadata_permissions: {},
    profile_permissions: {},
  });
  expect(minted.status, JSON.stringify(minted.error)).toBe(201);
  const token = await approvedAppToken(server, [permission]);
  return [minted.data.key, token].map(
    (apiKey) => new MarfaClient({ baseUrl: server.apiUrl, apiKey }),
  );
}

it("instance.read grants reports to keys and apps without granting maintenance", async () => {
  for (const reader of await callers("instance.read")) {
    expect((await reader.listHousekeeping()).status).toBe(200);
    expect((await reader.listBlobStores()).status).toBe(200);
    expect((await reader.listBlobOrphans()).status).toBe(200);
    expect((await reader.runHousekeeping("rate-limit-cleanup")).status).toBe(
      403,
    );
  }
  expect((await working.listHousekeeping()).status).toBe(403);
});

it("instance.maintain grants maintenance to keys and apps without granting reports", async () => {
  for (const maintainer of await callers("instance.maintain")) {
    expect(
      (await maintainer.runHousekeeping("rate-limit-cleanup")).status,
    ).toBe(200);
    expect((await maintainer.listHousekeeping()).status).toBe(403);
    expect((await maintainer.listBlobStores()).status).toBe(403);
  }
  expect((await working.runHousekeeping("rate-limit-cleanup")).status).toBe(
    403,
  );
});

it("connectors.manage grants administration to keys and apps without connector identity", async () => {
  const registered = await working.registerConnector({
    name: "management witness",
  });
  expect(registered.status).toBe(201);
  let id = registered.data.id;
  expect((await working.heartbeatConnector(id)).status).toBe(200);
  for (const manager of await callers("connectors.manage")) {
    expect((await manager.getConnector(id)).status).toBe(200);
    expect((await manager.listConnectorRuns(id)).status).toBe(200);
    const endpoint = await manager.createInboundEndpoint(id);
    expect(endpoint.status).toBe(201);
    expect(
      (await manager.retireInboundEndpoint(id, endpoint.data.id)).status,
    ).toBe(200);
    expect((await manager.deleteConnectorState(id)).status).toBe(200);
    expect((await manager.heartbeatConnector(id)).status).toBe(403);
    expect(
      (await manager.rawRequest(`/connectors/${id}/deliveries`)).status,
    ).toBe(403);
    expect((await manager.holdConnector(id, crypto.randomUUID())).status).toBe(
      403,
    );
    expect((await manager.deleteConnector(id)).status).toBe(200);
    const renewed = await working.registerConnector({
      name: "management witness",
    });
    expect(renewed.status).toBe(201);
    id = renewed.data.id;
  }
});

it("blobs.manage grants unreferenced bytes to keys and apps while preserving copy and restore boundaries", async () => {
  const managers = await callers("blobs.manage");
  const uploaded = await managers[0]!.uploadBlob(
    new TextEncoder().encode("unreferenced management proof"),
    "text/plain",
  );
  expect(uploaded.status).toBe(201);
  for (const manager of managers) {
    expect(
      (
        await manager.uploadBlob(
          new TextEncoder().encode("second management proof"),
          "text/plain",
        )
      ).status,
    ).toBe(201);
    expect((await manager.downloadBlob(uploaded.data.hash)).status).toBe(200);
    const locations = await manager.listBlobLocations(uploaded.data.hash);
    expect(locations.status).toBe(200);
    const dropped = await manager.deleteBlobLocation(
      uploaded.data.hash,
      locations.data.data[0]!.store_id,
    );
    expect(dropped.status).toBe(409);
    expect(dropped.error?.error.code).toBe("copies_below_minimum");
    expect((await manager.listBlobStores()).status).toBe(403);
    expect(
      (await manager.rawRequest("/restore", { method: "POST", body: {} }))
        .status,
    ).toBe(403);
  }
  expect((await working.downloadBlob(uploaded.data.hash)).status).toBe(404);
});
