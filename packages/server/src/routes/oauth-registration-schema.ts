import type { ZodMediaTypeObject } from "@asteasolutions/zod-to-openapi";
import { createRoute, z } from "@hono/zod-openapi";
import type { MarfaAuth } from "../auth/instance.js";
import { makeErrorResponseSchema, REFUSAL_TEXT } from "../openapi.js";
import { CHAIN_REFUSALS } from "../openapi-finalize.js";
import { MAX_REGISTERED_REDIRECT_URIS } from "../middleware/body-cap.js";

const REQUEST_TEXT: Record<string, string> = {
  redirect_uris: `The addresses Marfa may send a person back to after authorization. Required for \`authorization_code\`. At most ${String(MAX_REGISTERED_REDIRECT_URIS)}. A \`web\` client's URIs must use \`https\` off the loopback; a \`native\` client may use \`http\` on \`localhost\`, \`127.0.0.1\` or \`[::1]\`.`,
  grant_types:
    "The grants the client uses: `authorization_code`, `refresh_token` or `urn:ietf:params:oauth:grant-type:device_code`. Defaults to `authorization_code`. Without `authorization_code`, add `refresh_token` to get a refresh token with `offline_access`.",
  response_types:
    "The response types the client uses. Defaults to `code` when `grant_types` includes `authorization_code`.",
  client_name:
    "The app's name, which Marfa shows a person asked to approve it.",
  application_type:
    "`web` or `native`, which decides the redirect URIs the client may use. Defaults to `web`.",
  scope:
    "Space-separated scopes to register the client for. `offline_access` needs `refresh_token` or `authorization_code` in `grant_types`. Leave it out to register the client for every scope the instance allows that it can use.",
  token_endpoint_auth_method:
    "`none` is public, `client_secret_basic` uses HTTP Basic and `client_secret_post` sends the secret in the body. Other methods, including `private_key_jwt`, are refused with `invalid_client_metadata`.",
  client_uri: "The app's home page URL. Leave it out if the app has none.",
  logo_uri: "The app's logo URL. Leave it out if the app has none.",
  contacts: "Contact addresses for the app. Leave it out if there are none.",
  tos_uri: "The app's terms of service URL. Leave it out if the app has none.",
  policy_uri: "The app's privacy policy URL. Leave it out if the app has none.",
  software_id: "The software's identifier. Leave it out if there is none.",
  software_version: "The software's version. Leave it out if there is none.",
  software_statement:
    "A signed software statement. Leave it out to register without one.",
  post_logout_redirect_uris:
    "Addresses the app may return to after sign-out. Leave it out if there are none.",
  jwks: "The client's public JSON Web Key Set. Leave it out if the client has none.",
  jwks_uri:
    "The URL of the client's public JSON Web Key Set. Leave it out if the client has none.",
  subject_type:
    "`public` for public subject identifiers. Leave it out to use public identifiers. `pairwise` is refused with `invalid_client_metadata`.",
  dpop_bound_access_tokens:
    "`true` to bind the client's access tokens to DPoP proofs. Leave it out for tokens without that binding.",
  resources:
    "Resource identifiers to register the client for. Leave it out for the instance's default resources.",
};
const RESPONSE_TEXT: Record<string, string> = {
  client_id: "Unique identifier for the client.",
  client_uri:
    "The app's home page URL, as registered. Absent if none was sent.",
  user_id:
    "The ID of the user who registered the client. Absent for anonymous registration.",
  client_secret:
    "The secret the client proves itself with at the token endpoint. Absent for a public client.",
  client_id_issued_at:
    "When the client was registered, in seconds since the Unix epoch.",
  scope:
    "Space-separated scopes the client is registered for: the ones you named, or every scope the instance allows, without `offline_access` for a client that can't use a refresh token.",
  redirect_uris: "The redirect URIs, as registered.",
  grant_types: "The grants, as registered.",
  response_types: "The response types, as registered.",
  token_endpoint_auth_method:
    "How the client proves itself at the token endpoint.",
  client_secret_expires_at:
    "When the secret expires, in seconds since the Unix epoch, or `0` if it doesn't.",
  client_name: "The app's name, as registered.",
  application_type: "`web` or `native`.",
  subject_type: "`public` for public subject identifiers.",
  disabled: "`true` if the client is disabled.",
  dpop_bound_access_tokens:
    "`true` if the client always uses DPoP for its token requests.",
};

export function oauthRegistrationRoute(
  registration: NonNullable<MarfaAuth["registration"]>,
) {
  const excluded = new Set([
    "skip_consent",
    "backchannel_logout_uri",
    "backchannel_logout_session_required",
  ]);
  const jwks = registration.options.body.shape.jwks.unwrap();
  const publicKeys = jwks
    .safeExtend({
      keys: jwks.shape.keys.describe(
        "The client's public JSON Web Keys, including any extension members.",
      ),
    })
    .optional();
  const methods = ["none", "client_secret_basic", "client_secret_post"];
  // Marfa configures no pairwise secret; the provider refuses that subject type.
  const publicSubject = z.enum(["public"]).optional();
  const body = z
    .object(
      Object.fromEntries(
        Object.entries(registration.options.body.shape)
          .filter(([name]) => !excluded.has(name))
          .map(([name, field]) => {
            const schema =
              name === "jwks"
                ? publicKeys
                : name === "subject_type"
                  ? publicSubject
                  : field;
            const described = schema.describe(
              REQUEST_TEXT[name] ?? field.description ?? "",
            );
            return [
              name,
              name === "token_endpoint_auth_method"
                ? described.openapi({
                    enum: methods,
                    default: "client_secret_basic",
                  })
                : described,
            ];
          }),
      ),
    )
    .describe("An OAuth client: its app metadata and the grants it uses.")
    .openapi("OAuthClientRegistration");
  const nativeResponse = registration.options.metadata.openapi.responses["201"];
  const nativeSchema = nativeResponse.content["application/json"].schema;
  const publicMetadata = z.toJSONSchema(body, { target: "openapi-3.0" });
  const response = {
    ...nativeSchema,
    properties: {
      ...Object.fromEntries(
        Object.entries(publicMetadata.properties ?? {}).map(([name, field]) => [
          name,
          {
            ...(typeof field === "boolean"
              ? field
                ? {}
                : { not: {} }
              : field),
            description:
              RESPONSE_TEXT[name] ??
              `${REQUEST_TEXT[name]?.split(". Leave it out")[0] ?? name}, as registered.`,
          },
        ]),
      ),
      ...Object.fromEntries(
        Object.entries(nativeSchema.properties)
          .filter(([name]) => !excluded.has(name))
          .map(([name, field]) => [
            name,
            {
              ...field,
              description: RESPONSE_TEXT[name] ?? field.description,
              ...(name === "token_endpoint_auth_method"
                ? { enum: methods }
                : {}),
            },
          ]),
      ),
    },
  };
  const protocolRefusal = (codes: [string, ...string[]]) =>
    z.object({
      error: z.enum(codes).describe("The OAuth error code."),
      error_description: z
        .string()
        .optional()
        .describe("A description of the error for a person to read."),
    });
  return createRoute({
    method: "post",
    path: `/auth${registration.path}`,
    operationId: "registerOAuthClient",
    tags: ["Access"],
    summary: "Register an OAuth client",
    description:
      "Registers an OAuth client for an app and returns it with its `client_id`. Send no credential; a web page can call it from a browser on any origin. The `client_credentials` grant isn't available: a program that acts for no person uses an API key.",
    request: {
      body: {
        required: true,
        content: { "application/json": { schema: body } },
      },
    },
    responses: {
      201: {
        description:
          "Returns the registered client, with its `client_id` and, unless it's a public client, its `client_secret`.",
        content: {
          "application/json": {
            schema: response as ZodMediaTypeObject["schema"],
          },
        },
      },
      400: {
        description:
          "- `invalid_client_metadata`: client metadata is invalid.\n- `invalid_redirect_uri`: a redirect URI is invalid.\n- `invalid_scope`: a scope is not allowed.\n- `invalid_target`: a resource is invalid.\n- `invalid_software_statement`: a software statement is invalid.\n\nThese errors use RFC 7591. An unknown query parameter gets Marfa's `validation_error` instead.",
        content: {
          "application/json": {
            schema: z.union([
              makeErrorResponseSchema(["validation_error"]),
              protocolRefusal([
                "invalid_client_metadata",
                "invalid_redirect_uri",
                "invalid_scope",
                "invalid_target",
                "invalid_software_statement",
              ]),
            ]),
          },
        },
      },
      401: {
        description:
          "An error in the shape RFC 6750 defines:\n- `invalid_token`: the request sends a bearer token, such as an API key. Register with no credential.",
        content: {
          "application/json": { schema: protocolRefusal(["invalid_token"]) },
        },
      },
      415: {
        description:
          "An error with `message` and `code`, rather than Marfa's own shape:\n- `UNSUPPORTED_MEDIA_TYPE`: the request doesn't send its body as `application/json`.",
        content: {
          "application/json": {
            schema: z.object({
              code: z
                .enum(["UNSUPPORTED_MEDIA_TYPE"])
                .describe(REFUSAL_TEXT.code),
              message: z.string().describe(REFUSAL_TEXT.message),
            }),
          },
        },
      },
      503: CHAIN_REFUSALS.writeContention.response,
    },
  });
}
