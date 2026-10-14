import { generateKeyPairSync } from "node:crypto";
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
  const { publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
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
    jwks: { keys: [{ ...publicKey.export({ format: "jwk" }), alg: "ES256" }] },
    subject_type: "public",
    dpop_bound_access_tokens: true,
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

it("describes the resource and software-statement validation refusals", async () => {
  const documentResponse = await fetch(`${server!.apiUrl}/openapi.json`);
  expect(documentResponse.status).toBe(200);
  const document = (await documentResponse.json()) as OpenApiDocument;
  const schema =
    document.paths["/auth/oauth2/register"]?.post.responses?.["400"]?.content?.[
      "application/json"
    ]?.schema;
  expect(schema).toBeDefined();
  const validate = validatorFor(schema, document);
  for (const [field, value, code] of [
    ["resources", ["not-a-uri"], "invalid_target"],
    ["software_statement", 42, "invalid_software_statement"],
  ] as const) {
    const response = await fetch(`${server!.apiUrl}/auth/oauth2/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "Validation Fixture",
        application_type: "native",
        grant_types: ["urn:ietf:params:oauth:grant-type:device_code"],
        response_types: [],
        token_endpoint_auth_method: "none",
        [field]: value,
      }),
    });
    const body = await response.json();
    expect(response.status).toBe(400);
    expect(body).toMatchObject({ error: code });
    expect(validate(body), JSON.stringify(validate.errors)).toBe(true);
  }
});

it("publishes only the subject type the configured provider accepts", async () => {
  const documentResponse = await fetch(`${server!.apiUrl}/openapi.json`);
  expect(documentResponse.status).toBe(200);
  const document = (await documentResponse.json()) as OpenApiDocument;
  const operation = document.paths["/auth/oauth2/register"]?.post;
  expect(operation).toBeDefined();
  const requestSchema =
    operation!.requestBody?.content?.["application/json"]?.schema;
  const successSchema =
    operation!.responses?.["201"]?.content?.["application/json"]?.schema;
  const refusalSchema =
    operation!.responses?.["400"]?.content?.["application/json"]?.schema;
  expect(requestSchema).toBeDefined();
  expect(successSchema).toBeDefined();
  expect(refusalSchema).toBeDefined();
  const metadata = {
    client_name: "Subject Fixture",
    application_type: "native",
    grant_types: ["urn:ietf:params:oauth:grant-type:device_code"],
    response_types: [],
    token_endpoint_auth_method: "none",
    subject_type: "public",
  };
  const register = (body: typeof metadata) =>
    fetch(`${server!.apiUrl}/auth/oauth2/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  const publicResponse = await register(metadata);
  const publicBody = await publicResponse.json();
  expect(publicResponse.status).toBe(201);
  expect(publicBody).toMatchObject({ subject_type: "public" });
  const pairwiseMetadata = { ...metadata, subject_type: "pairwise" };
  const pairwiseResponse = await register(pairwiseMetadata);
  const pairwiseBody = await pairwiseResponse.json();
  expect(pairwiseResponse.status).toBe(400);
  expect(pairwiseBody).toMatchObject({
    error: "invalid_client_metadata",
    error_description:
      "pairwise subject_type requires server pairwiseSecret configuration",
  });
  const validateRefusal = validatorFor(refusalSchema, document);
  expect(
    validateRefusal(pairwiseBody),
    JSON.stringify(validateRefusal.errors),
  ).toBe(true);
  const validateRequest = validatorFor(requestSchema, document);
  expect(
    validateRequest(metadata),
    JSON.stringify(validateRequest.errors),
  ).toBe(true);
  expect(validateRequest(pairwiseMetadata)).toBe(false);
  const validateSuccess = validatorFor(successSchema, document);
  expect(
    validateSuccess(publicBody),
    JSON.stringify(validateSuccess.errors),
  ).toBe(true);
  expect(validateSuccess({ ...publicBody, subject_type: "pairwise" })).toBe(
    false,
  );
});
