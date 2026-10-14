import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";

let server: FreshServer | undefined;
const deviceGrant = "urn:ietf:params:oauth:grant-type:device_code";
const { publicKey, privateKey } = generateKeyPairSync("ec", {
  namedCurve: "P-256",
});
const jwks = {
  keys: [
    { ...publicKey.export({ format: "jwk" }), kid: "client-key", alg: "ES256" },
  ],
};

beforeAll(async () => {
  server = await bootFreshServer("oauth-client-auth-methods");
}, 2 * FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  await server?.stop();
}, 2 * FRESH_SERVER_TIMEOUT_MS);

function register(metadata: Record<string, unknown>) {
  return fetch(`${server!.apiUrl}/auth/oauth2/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "Client Authentication Fixture",
      application_type: "native",
      grant_types: [deviceGrant, "refresh_token"],
      response_types: [],
      jwks,
      ...metadata,
    }),
  });
}

function assertion(clientId: string, audience: string) {
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const input = `${encode({ alg: "ES256", kid: "client-key" })}.${encode({
    iss: clientId,
    sub: clientId,
    aud: audience,
    iat: now,
    exp: now + 60,
    jti: randomUUID(),
  })}`;
  return `${input}.${sign("sha256", Buffer.from(input), {
    key: privateKey,
    dsaEncoding: "ieee-p1363",
  }).toString("base64url")}`;
}

describe("OAuth client authentication methods", () => {
  it("registers none, client_secret_basic and client_secret_post, defaulting to client_secret_basic", async () => {
    for (const method of [
      "none",
      "client_secret_basic",
      "client_secret_post",
      undefined,
    ]) {
      const response = await register({ token_endpoint_auth_method: method });
      expect(response.status).toBe(201);
      const client = (await response.json()) as Record<string, string>;
      expect(client.token_endpoint_auth_method).toBe(
        method ?? "client_secret_basic",
      );
      expect(client.client_id).toEqual(expect.any(String));
      if (method === "none") expect(client.client_secret).toBeUndefined();
      else expect(client.client_secret).toEqual(expect.any(String));
      const headers: Record<string, string> = {
        "content-type": "application/x-www-form-urlencoded",
      };
      const body = new URLSearchParams({
        client_id: client.client_id!,
        scope: "core.note:read",
      });
      if (method === "client_secret_post")
        body.set("client_secret", client.client_secret!);
      else if (method !== "none")
        headers.authorization = `Basic ${Buffer.from(
          `${client.client_id!}:${client.client_secret!}`,
        ).toString("base64")}`;
      const code = await fetch(`${server!.apiUrl}/auth/device/code`, {
        method: "POST",
        headers,
        body,
      });
      expect(code.status, await code.clone().text()).toBe(200);
      expect((await code.json()) as Record<string, unknown>).toHaveProperty(
        "device_code",
      );
      for (const path of ["/auth/device/code", "/auth/oauth2/token"]) {
        const refused = await fetch(`${server!.apiUrl}${path}`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            client_id: client.client_id!,
            client_assertion_type:
              "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
            client_assertion: assertion(
              client.client_id!,
              `${server!.apiUrl}${path}`,
            ),
            ...(path.endsWith("token")
              ? { grant_type: "refresh_token", refresh_token: "unknown" }
              : {}),
          }),
        });
        expect(refused.status).toBe(400);
        expect((await refused.json()) as Record<string, unknown>).toMatchObject(
          {
            error: path.endsWith("token") ? "invalid_grant" : "invalid_client",
          },
        );
      }
    }
  });

  it("refuses private_key_jwt with inline keys, remote keys or no keys", async () => {
    // The same inline key metadata is accepted with a supported method.
    expect(
      (await register({ token_endpoint_auth_method: "none" })).status,
    ).toBe(201);
    for (const keyMetadata of [
      { jwks },
      { jwks: undefined, jwks_uri: "https://client.example.test/keys" },
      { jwks: undefined },
      { jwks, token_endpoint_auth_method: " private_key_jwt " },
    ]) {
      const response = await register({
        token_endpoint_auth_method: "private_key_jwt",
        ...keyMetadata,
      });
      expect(response.status).toBe(400);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body.error).toBe("invalid_client_metadata");
      expect(body.error_description).toEqual(
        expect.stringContaining("private_key_jwt"),
      );
      expect(body.client_id).toBeUndefined();
    }
  });

  it("advertises only the client authentication methods it accepts", async () => {
    for (const path of [
      "/.well-known/oauth-authorization-server/auth",
      "/.well-known/openid-configuration/auth",
      "/auth/.well-known/oauth-authorization-server",
      "/auth/.well-known/openid-configuration",
    ]) {
      const response = await fetch(`${server!.apiUrl}${path}`);
      expect(response.status).toBe(200);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body.token_endpoint_auth_methods_supported).toEqual([
        "none",
        "client_secret_basic",
        "client_secret_post",
      ]);
      expect(body.revocation_endpoint_auth_methods_supported).toEqual([
        "none",
        "client_secret_basic",
        "client_secret_post",
      ]);
      for (const endpoint of ["token", "revocation", "introspection"])
        expect(body).not.toHaveProperty(
          `${endpoint}_endpoint_auth_signing_alg_values_supported`,
        );
      expect(body.introspection_endpoint_auth_methods_supported).toEqual([
        "client_secret_basic",
        "client_secret_post",
      ]);
    }
  });
});
