import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";

let server: FreshServer | undefined;
const deviceGrant = "urn:ietf:params:oauth:grant-type:device_code";
const { privateKey } = generateKeyPairSync("ec", {
  namedCurve: "P-256",
});

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
      ...metadata,
    }),
  });
}

function assertion(clientId: string, audience: string) {
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const now = Math.floor((Date.now() + server!.clockOffsetMs) / 1000);
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
  it("registers a public client, the method a registration names or leaves out", async () => {
    for (const method of ["none", undefined]) {
      const response = await register({ token_endpoint_auth_method: method });
      expect(response.status).toBe(201);
      const client = (await response.json()) as Record<string, string>;
      expect(client.token_endpoint_auth_method).toBe("none");
      expect(client.client_id).toEqual(expect.any(String));
      const code = await fetch(`${server!.apiUrl}/auth/device/code`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: client.client_id!,
          scope: "core.note:read",
        }),
      });
      expect(code.status, await code.clone().text()).toBe(200);
      expect((await code.json()) as Record<string, unknown>).toHaveProperty(
        "device_code",
      );
    }
  });

  it("refuses a client that presents a credential of its own 401 invalid_client, at the device code and the token doors", async () => {
    const response = await register({ token_endpoint_auth_method: "none" });
    expect(response.status).toBe(201);
    const { client_id: clientId } = (await response.json()) as {
      client_id: string;
    };
    const asked = (
      path: string,
      extra: Record<string, string>,
      headers: Record<string, string> = {},
    ) =>
      fetch(`${server!.apiUrl}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          ...headers,
        },
        body: new URLSearchParams({
          client_id: clientId,
          ...(path.endsWith("token")
            ? { grant_type: "refresh_token", refresh_token: "unknown" }
            : { scope: "core.note:read" }),
          ...extra,
        }),
      });
    // The witness: the same request with no credential is answered on its merits.
    const code = await asked("/auth/device/code", {});
    expect(code.status).toBe(200);
    await code.body?.cancel();
    const refresh = await asked("/auth/oauth2/token", {});
    expect(refresh.status).toBe(400);
    expect(((await refresh.json()) as { error: string }).error).toBe(
      "invalid_grant",
    );
    for (const path of ["/auth/device/code", "/auth/oauth2/token"]) {
      for (const extra of [
        { client_secret: "a-secret" },
        {
          client_assertion_type:
            "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
          client_assertion: assertion(clientId, `${server!.apiUrl}${path}`),
        },
      ]) {
        const refused = await asked(path, extra);
        expect(refused.status, path).toBe(401);
        expect(((await refused.json()) as { error: string }).error, path).toBe(
          "invalid_client",
        );
      }
      const basic = await asked(
        path,
        {},
        {
          authorization: `Basic ${Buffer.from(`${clientId}:a-secret`).toString("base64")}`,
        },
      );
      expect(basic.status, path).toBe(401);
      expect(((await basic.json()) as { error: string }).error, path).toBe(
        "invalid_client",
      );
    }
  });

  it("refuses every method but none, naming the method", async () => {
    for (const method of [
      "client_secret_basic",
      "client_secret_post",
      "private_key_jwt",
      " private_key_jwt ",
    ]) {
      const response = await register({ token_endpoint_auth_method: method });
      expect(response.status, method).toBe(400);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body.error).toBe("invalid_client_metadata");
      expect(body.error_description).toEqual(
        expect.stringContaining(method.trim()),
      );
      expect(body.client_id).toBeUndefined();
    }
  });

  it("advertises only the client authentication methods it accepts", async () => {
    for (const path of [
      "/.well-known/oauth-authorization-server/auth",
      "/auth/.well-known/oauth-authorization-server",
    ]) {
      const response = await fetch(`${server!.apiUrl}${path}`);
      expect(response.status).toBe(200);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body.token_endpoint_auth_methods_supported).toEqual(["none"]);
      expect(body.revocation_endpoint_auth_methods_supported).toEqual(["none"]);
      for (const endpoint of ["token", "revocation"])
        expect(body).not.toHaveProperty(
          `${endpoint}_endpoint_auth_signing_alg_values_supported`,
        );
    }
  });
});
