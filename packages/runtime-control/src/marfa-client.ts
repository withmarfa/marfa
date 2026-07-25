/**
 * Internal client for control-plane → Marfa server lookups.
 *
 * Uses `MARFA_RUNTIME_BROKER_KEY` (a long-lived `is_platform: true` API
 * key bound to the control-plane Worker as a secret). Calls the
 * server's `/system/inbound-webhook-subscriptions/:connection_id` and
 * `/system/runtime-credentials` endpoints.
 */

export interface InboundSubscription {
  id: string;
  connection_id: string;
  external_service_id?: string;
  /** Decrypted plaintext secret. */
  secret: string;
  verification_method: "hmac-sha256" | "slack" | "stripe" | "github";
  verification_adapter_id?: string;
  /**
   * Manifest name (e.g. `acme.calendar-sync`) projected from the
   * connection's integration_ref by the server's lookup endpoint.
   * The control plane stamps this on the queue message envelope so
   * the per-Integration Worker filter accepts it.
   */
  integration_name?: string;
  events: string[];
  disabled: boolean;
}

/**
 * A runtime-credential mint that failed, carrying the server's status.
 *
 * The status is the whole point: 404 (no such Connection) and 403
 * (Connection revoked or otherwise inactive) are permanent, while 5xx
 * and transport errors are worth retrying. Callers that collapse the
 * two treat a cold container the same as a deleted Connection.
 */
export class RuntimeCredentialMintError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "RuntimeCredentialMintError";
  }
}

export interface MintedRuntimeCredential {
  id: string;
  api_key: string;
  connection_id: string;
  label: string;
  source: string;
  expires_at: string;
  created_at: string;
}

export class MarfaServerClient {
  constructor(
    private readonly apiUrl: string,
    private readonly brokerKey: string,
    private readonly fetchImpl: typeof fetch = globalThis.fetch.bind(
      globalThis,
    ),
  ) {
    this.apiUrl = apiUrl.replace(/\/$/, "");
  }

  /**
   * Look up the verify-route inputs for a Connection. Forwards the
   * operator's bearer to the server, which gates on `is_platform: true`
   * and validates the connection exists, is `kind: integration`, and is
   * active. Returns 401/403/404/400 as a tagged result so the route can
   * surface the right status to the operator.
   */
  async getVerifyContext(
    connectionId: string,
    operatorBearer: string,
  ): Promise<
    | {
        ok: true;
        connection_id: string;
        integration_name: string;
        tenant_id: string | null;
      }
    | { ok: false; status: number; message: string }
  > {
    const res = await this.fetchImpl(
      `${this.apiUrl}/system/connections/${encodeURIComponent(connectionId)}/verify-context`,
      { headers: { Authorization: `Bearer ${operatorBearer}` } },
    );
    if (res.ok) {
      const body = await res.json<{
        connection_id: string;
        integration_name: string;
        tenant_id: string | null;
      }>();
      return { ok: true, ...body };
    }
    let message = `verify-context lookup failed: ${String(res.status)}`;
    try {
      const errBody = await res.json<{ error?: { message?: string } }>();
      if (typeof errBody.error?.message === "string") {
        message = errBody.error.message;
      }
    } catch {
      // not JSON — keep the status-based message
    }
    return { ok: false, status: res.status, message };
  }

  /**
   * Look up the DLQ-route inputs for a Connection. Forwards the
   * operator's bearer to the server, which gates on `is_platform: true`
   * and confirms the connection exists. Unlike `getVerifyContext`, this
   * does NOT narrow by kind or state — DLQ inspection is most relevant
   * precisely when a connection is unhealthy. Returns 401/403/404 as a
   * tagged result so the route can surface the right status to the
   * operator.
   */
  async getDlqContext(
    connectionId: string,
    operatorBearer: string,
  ): Promise<
    | {
        ok: true;
        connection_id: string;
        kind: string;
        state: string;
        integration_name: string | null;
        tenant_id: string | null;
      }
    | { ok: false; status: number; message: string }
  > {
    const res = await this.fetchImpl(
      `${this.apiUrl}/system/connections/${encodeURIComponent(connectionId)}/dlq-context`,
      { headers: { Authorization: `Bearer ${operatorBearer}` } },
    );
    if (res.ok) {
      const body = await res.json<{
        connection_id: string;
        kind: string;
        state: string;
        integration_name: string | null;
        tenant_id: string | null;
      }>();
      return { ok: true, ...body };
    }
    let message = `dlq-context lookup failed: ${String(res.status)}`;
    try {
      const errBody = await res.json<{ error?: { message?: string } }>();
      if (typeof errBody.error?.message === "string") {
        message = errBody.error.message;
      }
    } catch {
      // not JSON — keep the status-based message
    }
    return { ok: false, status: res.status, message };
  }

  /**
   * List system.activity rows tagged with a connection_id since a given
   * timestamp. Forwards the operator's bearer so the server's tenant
   * scoping applies — operators see only their tenant's rows unless
   * they're using a platform credential.
   */
  async listActivitySince(
    connectionId: string,
    sinceIso: string,
    operatorBearer: string,
  ): Promise<unknown[]> {
    const filter = `properties.connection_id eq "${connectionId.replace(/"/g, '\\"')}"`;
    const url = new URL(`${this.apiUrl}/items`);
    url.searchParams.set("type", "system.activity");
    url.searchParams.set("filter", filter);
    url.searchParams.set("since", sinceIso);
    url.searchParams.set("sort", "created_at");
    url.searchParams.set("direction", "asc");
    url.searchParams.set("limit", "100");
    const res = await this.fetchImpl(url.toString(), {
      headers: { Authorization: `Bearer ${operatorBearer}` },
    });
    if (!res.ok) {
      throw new Error(
        `Activity lookup failed: ${String(res.status)} ${res.statusText}`,
      );
    }
    const body = await res.json<{ data: unknown[] }>();
    return body.data;
  }

  async lookupInboundWebhookSubscriptions(
    connectionId: string,
  ): Promise<InboundSubscription[]> {
    const res = await this.fetchImpl(
      `${this.apiUrl}/system/inbound-webhook-subscriptions/${encodeURIComponent(connectionId)}`,
      { headers: this.headers() },
    );
    if (res.status === 404) return [];
    if (!res.ok) {
      throw new Error(
        `Inbound subscription lookup failed: ${String(res.status)} ${res.statusText}`,
      );
    }
    const body = await res.json<{ subscriptions: InboundSubscription[] }>();
    return body.subscriptions;
  }

  async mintRuntimeCredential(input: {
    connection_id: string;
    label: string;
    source: string;
    type_permissions?: Record<string, "read" | "write" | "none">;
    extension_permissions?: Record<string, "read" | "write">;
    edge_permissions?: Record<string, "read" | "write">;
    ttl_seconds?: number;
  }): Promise<MintedRuntimeCredential> {
    const headers = new Headers(this.headers());
    headers.set("Content-Type", "application/json");
    const res = await this.fetchImpl(
      `${this.apiUrl}/system/runtime-credentials`,
      {
        method: "POST",
        headers,
        body: JSON.stringify(input),
      },
    );
    if (!res.ok) {
      const text = await res.text();
      throw new RuntimeCredentialMintError(
        `Runtime credential mint failed: ${String(res.status)} ${res.statusText} ${text}`,
        res.status,
      );
    }
    return res.json<MintedRuntimeCredential>();
  }

  private headers(): HeadersInit {
    return { Authorization: `Bearer ${this.brokerKey}` };
  }
}
