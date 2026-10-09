import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  startDeviceFlow,
  type FreshServer,
} from "../../utils/fresh-server.js";

/**
 * `offline_access` on a device: which clients a device approval answers a
 * refresh token, and which a registration naming no scope is registered for
 * it. Each case is approved by the owner, which an instance has one of, so
 * this file boots a server of its own, apart from `device-grant.test.ts`,
 * whose approvals would otherwise spend the per-address lookup limit.
 */
let server: FreshServer | undefined;

beforeAll(async () => {
  server = await bootFreshServer("device-offline-access");
}, 2 * FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  await server?.stop();
}, 2 * FRESH_SERVER_TIMEOUT_MS);

describe("offline_access on a device", () => {
  it("answers offline_access a refresh token, which exchanges, for a client registered for the refresh grant", async () => {
    const flow = await startDeviceFlow(server!, [
      "core.note:read",
      "offline_access",
    ]);
    await flow.approve();
    const approved = await flow.poll();
    expect(approved.status).toBe(200);
    expect(approved.body.access_token).toBeTruthy();
    expect(approved.body.refresh_token).toBeTruthy();
    const refreshed = await fetch(`${server!.apiUrl}/auth/oauth2/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: approved.body.refresh_token!,
        client_id: flow.clientId,
      }),
    });
    expect(refreshed.status).toBe(200);
    const body = (await refreshed.json()) as Record<string, unknown>;
    expect(body.access_token).toEqual(expect.any(String));
  });

  it("answers offline_access a refresh token, which exchanges, for a client registered for the code grant and not the refresh grant", async () => {
    const flow = await startDeviceFlow(
      server!,
      ["core.note:read", "offline_access"],
      {
        grantTypes: [
          "urn:ietf:params:oauth:grant-type:device_code",
          "authorization_code",
        ],
        responseTypes: ["code"],
        redirectUris: ["http://127.0.0.1:8765/callback"],
      },
    );
    await flow.approve();
    const approved = await flow.poll();
    expect(approved.status).toBe(200);
    expect(approved.body.refresh_token).toBeTruthy();
    const refreshed = await fetch(`${server!.apiUrl}/auth/oauth2/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: approved.body.refresh_token!,
        client_id: flow.clientId,
      }),
    });
    expect(refreshed.status).toBe(200);
    const body = (await refreshed.json()) as Record<string, unknown>;
    expect(body.access_token).toEqual(expect.any(String));
  });

  it("registers a client that may not refresh, naming no scope, for every scope but offline_access, and answers its device flow an access token alone", async () => {
    // The witness: a client that may refresh, naming no scope, is registered
    // for `offline_access`.
    const refreshing = await startDeviceFlow(server!, ["core.note:read"]);
    const everything = refreshing.registeredScope.split(" ");
    expect(everything).toContain("offline_access");

    const flow = await startDeviceFlow(server!, ["core.note:read"], {
      grantTypes: ["urn:ietf:params:oauth:grant-type:device_code"],
    });
    expect(flow.registeredScope.split(" ")).toEqual(
      everything.filter((scope) => scope !== "offline_access"),
    );
    await flow.approve();
    const approved = await flow.poll();
    expect(approved.status).toBe(200);
    expect(approved.body.access_token).toBeTruthy();
    expect(approved.body.scope).toBe("core.note:read");
    expect(approved.body.refresh_token).toBeUndefined();
  });
});
