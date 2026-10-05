import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { ApiKeyResponse } from "../../client/types.js";
import {
  approvedApp,
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";

/**
 * Which keys say an app made them. An app's key is minted with the app's
 * access token, which needs a person's approval, and an instance has one
 * owner, which the run's shared server does not have, so this file boots a
 * server of its own and creates the owner there.
 */
let server: FreshServer | undefined;
let operator: MarfaClient;
let appClientId: string;
let appMade: ApiKeyResponse;

function asKey(key: ApiKeyResponse): MarfaClient {
  return new MarfaClient({ baseUrl: server!.apiUrl, apiKey: key.key });
}

/** The key as the listing, the key's own read and an update each answer it. */
async function answers(key: ApiKeyResponse) {
  const listed = await operator.listKeys();
  expect(listed.status).toBe(200);
  const current = await asKey(key).getCurrentKey();
  expect(current.status).toBe(200);
  const updated = await operator.updateKey(key.id, { label: `${key.label}-2` });
  expect(updated.status).toBe(200);
  return {
    mint: key,
    listing: listed.data.data.find((k) => k.id === key.id)!,
    current: current.data,
    update: updated.data,
  };
}

beforeAll(async () => {
  server = await bootFreshServer("key-oauth-client");
  operator = new MarfaClient({
    baseUrl: server.apiUrl,
    apiKey: server.operatorKey,
  });
  const app = await approvedApp(server);
  appClientId = app.clientId;
  const minted = await new MarfaClient({
    baseUrl: server.apiUrl,
    apiKey: app.token,
  }).createKey({ label: "app-made", source: "app-made" });
  expect(minted.status, JSON.stringify(minted.error)).toBe(201);
  appMade = minted.data;
}, 2 * FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  await server?.stop();
}, 2 * FRESH_SERVER_TIMEOUT_MS);

describe("oauth_client_id on a key answer", () => {
  it("names the client an app minted the key through, on every door that answers a key", async () => {
    const seen = await answers(appMade);
    expect(appClientId).toBeTruthy();
    for (const [door, key] of Object.entries(seen)) {
      expect(key.oauth_client_id, `the ${door} answer`).toBe(appClientId);
    }
  });

  it("is absent from a key no app minted, on every door that answers a key", async () => {
    // The witness: the same server gave an app's key the field above, so its
    // absence here is the server leaving it out and not a server that never
    // sends it.
    expect(appMade.oauth_client_id).toBe(appClientId);

    const byOperator = await operator.createKey({
      label: "by-operator",
      source: "by-operator",
    });
    expect(byOperator.status, JSON.stringify(byOperator.error)).toBe(201);
    // A key an app made mints a key too, and that one was not minted through
    // OAuth: the field marks the key an app's token minted, not every key
    // downstream of an app.
    const byAppKey = await asKey(appMade).createKey({
      label: "by-app-key",
      source: "by-app-key",
      type_permissions: { "core.note": "read" },
    });
    expect(byAppKey.status, JSON.stringify(byAppKey.error)).toBe(201);

    for (const key of [byOperator.data, byAppKey.data]) {
      const seen = await answers(key);
      for (const [door, answered] of Object.entries(seen)) {
        expect(
          answered,
          `the ${door} answer for ${key.label}`,
        ).not.toHaveProperty("oauth_client_id");
      }
    }
  });
});
