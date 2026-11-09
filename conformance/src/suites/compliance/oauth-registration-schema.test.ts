import { afterAll, beforeAll, expect, it } from "vitest";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { validatorFor, type OpenApiDocument } from "../../utils/openapi.js";

let server: FreshServer | undefined;

beforeAll(async () => {
  server = await bootFreshServer("oauth-registration-schema");
}, 2 * FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  await server?.stop();
}, 2 * FRESH_SERVER_TIMEOUT_MS);

it("describes the public metadata registration accepts and echoes", async () => {
  const metadata = {
    client_name: "Metadata Fixture",
    client_uri: "https://app.example.test/",
    contacts: ["support@example.test"],
    software_id: "metadata-fixture",
    software_version: "1",
    application_type: "native",
    grant_types: [
      "urn:ietf:params:oauth:grant-type:device_code",
      "refresh_token",
    ],
    response_types: [],
    token_endpoint_auth_method: "none",
  };
  const documentResponse = await fetch(`${server!.apiUrl}/openapi.json`);
  expect(documentResponse.status).toBe(200);
  const document = (await documentResponse.json()) as OpenApiDocument;
  const operation = document.paths["/auth/oauth2/register"]?.post;
  expect(operation).toBeDefined();
  const response = await fetch(`${server!.apiUrl}/auth/oauth2/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(metadata),
  });
  const body = (await response.json()) as Record<string, unknown>;
  expect(response.status, JSON.stringify(body)).toBe(201);
  expect(body).toMatchObject(metadata);
  const schema =
    operation!.responses?.["201"]?.content?.["application/json"]?.schema;
  expect(schema).toBeDefined();
  const validate = validatorFor(schema, document);
  expect(validate(body), JSON.stringify(validate.errors)).toBe(true);
});

it("registers a client whose metadata the server does not support, and leaves that metadata out of its answer", async () => {
  const unsupported = {
    dpop_bound_access_tokens: true,
    subject_type: "pairwise",
    software_statement: "eyJhbGciOiJub25lIn0.eyJpc3MiOiJ4In0.",
    resources: ["https://resource.example.test/"],
  };
  const response = await fetch(`${server!.apiUrl}/auth/oauth2/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "Unsupported Metadata Fixture",
      application_type: "native",
      grant_types: ["urn:ietf:params:oauth:grant-type:device_code"],
      response_types: [],
      token_endpoint_auth_method: "none",
      ...unsupported,
    }),
  });
  const body = (await response.json()) as Record<string, unknown>;
  expect(response.status, JSON.stringify(body)).toBe(201);
  expect(body.client_id).toEqual(expect.any(String));
  for (const field of Object.keys(unsupported))
    expect(body, field).not.toHaveProperty(field);
});

it("describes the refusal of a resource that is not an absolute URI", async () => {
  const documentResponse = await fetch(`${server!.apiUrl}/openapi.json`);
  expect(documentResponse.status).toBe(200);
  const document = (await documentResponse.json()) as OpenApiDocument;
  const schema =
    document.paths["/auth/oauth2/register"]?.post.responses?.["400"]?.content?.[
      "application/json"
    ]?.schema;
  expect(schema).toBeDefined();
  const validate = validatorFor(schema, document);
  for (const resource of [
    "not-a-uri",
    "/relative",
    "https://a.example.test/#part",
  ]) {
    const response = await fetch(`${server!.apiUrl}/auth/oauth2/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "Validation Fixture",
        application_type: "native",
        grant_types: ["urn:ietf:params:oauth:grant-type:device_code"],
        response_types: [],
        token_endpoint_auth_method: "none",
        resources: ["https://a.example.test/", resource],
      }),
    });
    const body = (await response.json()) as Record<string, unknown>;
    expect(response.status, resource).toBe(400);
    expect(body, resource).toMatchObject({ error: "invalid_target" });
    expect(validate(body), JSON.stringify(validate.errors)).toBe(true);
  }
});
