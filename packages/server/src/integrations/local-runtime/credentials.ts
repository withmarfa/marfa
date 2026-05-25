/**
 * `mintCredential` short-circuit for the local runtime. The Cloudflare
 * substrate goes through the runtime-control lease broker → POST
 * `/system/runtime-credentials` → cached on the per-Connection Durable
 * Object. The local substrate skips the HTTP round-trip and calls
 * `storage.keys.createRuntimeCredential` directly.
 *
 * The permission shape mirrors the route's: write on `connection.runtime`
 * is granted automatically so the credential can hydrate its own state
 * subtree; everything else falls out of the manifest at install time
 * and stays on the connection's `system.integration` reference.
 *
 * The credential is short-TTL by design — the SDK refreshes via the
 * same callback on every dispatch, so a 10-minute window is fine even
 * if the integration runs every minute.
 */
import { randomBytes } from "node:crypto";
import type { RuntimeCredential } from "@withmarfa/runtime-sdk";
import { hashApiKey } from "../../middleware/auth.js";
import type { Storage } from "../../storage/interface.js";

const KEY_PREFIX = "myme_k1_";
const DEFAULT_TTL_MS = 600 * 1000;

interface ConnectionProperties {
  kind?: string;
  integration_ref?: string;
  status?: string;
}

interface IntegrationProperties {
  manifest?: { permissions?: { extension?: Record<string, "read" | "write"> } };
}

/**
 * Mint a fresh runtime credential for a Connection. Returns the wire
 * `RuntimeCredential` shape the SDK consumes — `{ api_key, expires_at,
 * connection_id }`.
 *
 * Throws when:
 *   - the Connection doesn't exist
 *   - the Connection isn't of kind `integration`
 *   - the Connection's `state` isn't `"active"` (T-175 — symmetric with
 *     the HTTP-side mint gate; a revoked Connection cannot mint and
 *     therefore cannot run handlers)
 */
export async function mintLocalRuntimeCredential(
  storage: Storage,
  salt: string,
  connectionId: string,
  ttlMs = DEFAULT_TTL_MS,
): Promise<RuntimeCredential> {
  const connection = await storage.items.get(connectionId);
  if (connection?.type !== "system.connection") {
    throw new Error(`Connection ${connectionId} not found`);
  }
  if (connection.state !== "active") {
    throw new Error(
      `Connection ${connectionId} is ${connection.state}; cannot mint runtime credential`,
    );
  }
  const props = connection.properties as ConnectionProperties;
  if (props.kind !== "integration") {
    throw new Error(
      `Connection ${connectionId} is not of kind integration (got ${props.kind ?? "undefined"})`,
    );
  }

  // Carry manifest-declared extension grants alongside the always-on
  // `connection.runtime: write`. The CF path does this in
  // `install-pipeline.ts` for each per-Worker mint; we do it inline
  // because the local substrate doesn't have a long-lived credential
  // record.
  const extension_permissions: Record<string, "read" | "write"> = {
    "connection.runtime": "write",
  };
  if (props.integration_ref) {
    const integration = await storage.items.get(props.integration_ref);
    if (integration?.type === "system.integration") {
      const intProps = integration.properties as IntegrationProperties;
      const manifestGrants = intProps.manifest?.permissions?.extension ?? {};
      for (const [ns, level] of Object.entries(manifestGrants)) {
        extension_permissions[ns] = level;
      }
    }
  }

  const rawKey = KEY_PREFIX + randomBytes(32).toString("hex");
  const keyHash = hashApiKey(rawKey, salt);
  const expiresAt = new Date(Date.now() + ttlMs).toISOString();
  // `source` is uniqueness-checked per tenant by `createRuntimeCredential`
  // so concurrent / sequential mints for the same Connection can't
  // collide. The suffix (8 hex chars) is plenty to avoid clashes within
  // the credential's short TTL window.
  const suffix = randomBytes(4).toString("hex");

  await storage.keys.createRuntimeCredential(
    {
      label: `local-runtime ${connectionId}`,
      source: `local-runtime:${connectionId}:${suffix}`,
      role: "member",
      type_permissions: { "*": "write" },
      extension_permissions,
      edge_permissions: { "*": "write" },
      connection_id: connectionId,
    },
    keyHash,
    connection.tenant_id ?? undefined,
  );

  return {
    api_key: rawKey,
    expires_at: expiresAt,
    connection_id: connectionId,
  };
}
