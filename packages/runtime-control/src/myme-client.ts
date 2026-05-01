/**
 * Internal client for control-plane → Myme server lookups.
 *
 * Uses `MYME_RUNTIME_BROKER_KEY` (a long-lived `is_platform: true` API
 * key bound to the control-plane Worker as a secret). Calls the
 * server's `/system/inbound-webhook-subscriptions/:connection_id` and
 * `/system/runtime-credentials` endpoints — both PR 4 server-side
 * additions.
 */

export interface InboundSubscription {
  id: string;
  connection_id: string;
  external_service_id?: string;
  /** Decrypted plaintext secret. */
  secret: string;
  verification_method: "hmac-sha256" | "slack" | "stripe" | "github" | "custom";
  verification_adapter_id?: string;
  events: string[];
  disabled: boolean;
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

export class MymeServerClient {
  constructor(
    private readonly apiUrl: string,
    private readonly brokerKey: string,
    private readonly fetchImpl: typeof fetch = globalThis.fetch.bind(
      globalThis,
    ),
  ) {
    this.apiUrl = apiUrl.replace(/\/$/, "");
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
      throw new Error(
        `Runtime credential mint failed: ${String(res.status)} ${res.statusText} ${text}`,
      );
    }
    return res.json<MintedRuntimeCredential>();
  }

  private headers(): HeadersInit {
    return { Authorization: `Bearer ${this.brokerKey}` };
  }
}
