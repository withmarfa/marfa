/**
 * Manifest for the withmarfa.inbox email-capture integration.
 *
 * Substrate-shaped: no upstream API, no OAuth, no static token. The
 * substrate IS the upstream — Cloudflare Email Routing receives mail
 * on the connection's capture address, an Email Worker parses MIME +
 * signs the JSON envelope, and POSTs it to the server's webhook
 * receipt endpoint. The connection's subscription secret is the
 * shared HMAC key. Full per-delivery pipeline documented in
 * `email-worker/src/index.ts`.
 *
 * Space routing (v1): single capture address. Multi-space routing
 * (e.g. `capture-<space_slug>@inbox.marfa.so`) is deferred until
 * Marfa onboards a second space.
 *
 * Attachment blob upload is not yet wired; v1 captures attachment
 * metadata only.
 */
import type { IntegrationManifest } from "@withmarfa/shared";

export const WITHMARFA_INBOX_MANIFEST: IntegrationManifest = {
  name: "withmarfa.inbox",
  version: "0.2.0",
  manifest_schema_version: "1.0.0",
  publisher: "withmarfa",
  description:
    "Email-to-Marfa capture. Receives emails sent to a Marfa-managed address via Cloudflare Email Routing + Email Worker; lands each delivery as a `marfa.captured_email` item.",
  direction: "read",
  runtime_compatibility: ["local"],
  target_types: ["marfa.captured_email"],
  triggers: [{ type: "webhook" }],
  bidirectional_handling: {
    echo_ttl_seconds: 60,
    lag_window_seconds: 60,
    tombstone_mapping: "ignore",
    partial_write_mode: "accept-partial",
  },
  oauth_requirements: {},
  webhook_verification: { method: "cloudflare-email" },
  permissions: {
    extension: { "connection.runtime": "write" },
    edge: {},
  },
};

export const INTEGRATION_NAME = WITHMARFA_INBOX_MANIFEST.name;

/** Bounded idempotency ring stamped on the handler-side cursor; the
 *  server's own `connection.runtime.idempotency` map is the primary
 *  defense — this is the second wall.
 */
export const DELIVERY_RING_SIZE = 1024;

/** Header names emitted by the in-tree Email Worker. The verifier
 *  reads these; the handler reads these; tests use these. Keep in
 *  sync with `email-worker/src/index.ts`. */
export const SIGNATURE_HEADER = "X-Marfa-Signature";
export const DELIVERY_ID_HEADER = "X-Marfa-Delivery-Id";
