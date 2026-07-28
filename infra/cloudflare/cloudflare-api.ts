/**
 * Thin Cloudflare REST API client used by provision.ts.
 *
 * No third-party deps — `fetch` is global (Node 20+). Each helper
 * returns the parsed `result` envelope or throws a `CloudflareApiError`
 * with the upstream `errors[]` for diagnosis.
 */
const API_BASE = "https://api.cloudflare.com/client/v4";

export interface CloudflareApiError extends Error {
  status: number;
  errors: { code: number; message: string }[];
}

interface ApiEnvelope<T> {
  success: boolean;
  result: T;
  errors: { code: number; message: string }[];
  messages: { code: number; message: string }[];
}

export interface CloudflareClientOptions {
  apiToken: string;
  accountId: string;
}

/**
 * A deployed Worker's public-hostname settings: `enabled` is the
 * `<name>.<subdomain>.workers.dev` hostname, `previews_enabled` the
 * per-version `<version>-<name>.<subdomain>.workers.dev` ones.
 */
export interface WorkerSubdomain {
  enabled: boolean;
  previews_enabled: boolean;
}

export class CloudflareClient {
  constructor(private readonly opts: CloudflareClientOptions) {}

  async request<T>(
    path: string,
    init: RequestInit = {},
  ): Promise<T | undefined> {
    const url = path.startsWith("http") ? path : `${API_BASE}${path}`;
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${this.opts.apiToken}`);
    if (init.body && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }
    const res = await fetch(url, { ...init, headers });
    const text = await res.text();
    let envelope: ApiEnvelope<T> | undefined;
    try {
      envelope = text ? (JSON.parse(text) as ApiEnvelope<T>) : undefined;
    } catch {
      // Non-JSON response — treat as failure.
    }
    if (!res.ok || (envelope && !envelope.success)) {
      const err = new Error(
        `Cloudflare API ${String(res.status)} ${res.statusText} for ${path}: ${
          envelope ? JSON.stringify(envelope.errors) : text
        }`,
      ) as CloudflareApiError;
      err.status = res.status;
      err.errors = envelope?.errors ?? [];
      throw err;
    }
    return envelope?.result;
  }

  // ---- Workers ----------------------------------------------------------
  /**
   * Whether a deployed Worker serves a `workers.dev` hostname, and
   * whether it serves per-version Preview URLs.
   *
   * These are account-side settings, not config: `wrangler deploy`
   * pushes them, so a `wrangler.toml` saying `workers_dev = false` has
   * no effect on the live Worker until the next deploy. Reading them
   * back is the only way to know a hostname is actually gone.
   *
   * Returns undefined when the script does not exist in this account,
   * which is a legitimate state (never deployed, or a name that only
   * exists in another environment). A 404 is the only thing that means
   * that: any other unreadable answer throws.
   *
   * Both flags are required rather than trusted. The caller decides a
   * Worker is closed from `enabled || previews_enabled`, so a field
   * this response stopped carrying would read as falsy and a live
   * public hostname would be reported as closed — the one wrong answer
   * a function that exists to verify a security property must not
   * give. Today's API returns both, which is exactly why an absent one
   * should be treated as "something changed, look at it" rather than
   * quietly folded into a verdict.
   */
  async getWorkerSubdomain(
    scriptName: string,
  ): Promise<WorkerSubdomain | undefined> {
    let result: unknown;
    try {
      result = await this.request<unknown>(
        `/accounts/${this.opts.accountId}/workers/scripts/${encodeURIComponent(scriptName)}/subdomain`,
      );
    } catch (err) {
      if ((err as CloudflareApiError).status === 404) return undefined;
      throw err;
    }
    const flags = result as Partial<WorkerSubdomain> | null | undefined;
    if (
      typeof flags?.enabled !== "boolean" ||
      typeof flags.previews_enabled !== "boolean"
    ) {
      throw new Error(
        `subdomain settings for ${scriptName} came back without both flags: ${JSON.stringify(result)}`,
      );
    }
    return {
      enabled: flags.enabled,
      previews_enabled: flags.previews_enabled,
    };
  }

  // ---- Queues -----------------------------------------------------------
  async listQueues(): Promise<{ queue_id: string; queue_name: string }[]> {
    const r = await this.request<{ queue_id: string; queue_name: string }[]>(
      `/accounts/${this.opts.accountId}/queues`,
    );
    return r ?? [];
  }

  async createQueue(name: string): Promise<{ queue_id: string }> {
    const r = await this.request<{ queue_id: string }>(
      `/accounts/${this.opts.accountId}/queues`,
      {
        method: "POST",
        body: JSON.stringify({ queue_name: name }),
      },
    );
    if (!r) throw new Error(`createQueue(${name}) returned no result`);
    return r;
  }

  // ---- KV ---------------------------------------------------------------
  async listKvNamespaces(): Promise<{ id: string; title: string }[]> {
    const r = await this.request<{ id: string; title: string }[]>(
      `/accounts/${this.opts.accountId}/storage/kv/namespaces?per_page=100`,
    );
    return r ?? [];
  }

  async createKvNamespace(title: string): Promise<{ id: string }> {
    const r = await this.request<{ id: string }>(
      `/accounts/${this.opts.accountId}/storage/kv/namespaces`,
      {
        method: "POST",
        body: JSON.stringify({ title }),
      },
    );
    if (!r) throw new Error(`createKvNamespace(${title}) returned no result`);
    return r;
  }

  // ---- R2 ---------------------------------------------------------------
  async listR2Buckets(): Promise<{ name: string }[]> {
    const r = await this.request<{ buckets: { name: string }[] }>(
      `/accounts/${this.opts.accountId}/r2/buckets`,
    );
    return r?.buckets ?? [];
  }

  async createR2Bucket(name: string): Promise<void> {
    await this.request(`/accounts/${this.opts.accountId}/r2/buckets`, {
      method: "POST",
      body: JSON.stringify({ name }),
    });
  }

  // ---- Queue HTTP-pull consumers ----------------------------------------
  // The runtime-control DLQ peek/replay routes use Cloudflare Queues'
  // HTTP-pull API. That requires an `http_pull` consumer registered on
  // each pull-target queue — without it the pull endpoint returns a
  // misleading "messages cannot be pulled unless http_pull mode is
  // enabled" 405 (the queue's own `type` field stays null; the consumer
  // registration is what flips the queue into pull mode).
  async listQueueHttpConsumers(
    queueId: string,
  ): Promise<{ consumer_id: string; type: string }[]> {
    const r = await this.request<{ consumer_id: string; type: string }[]>(
      `/accounts/${this.opts.accountId}/queues/${queueId}/consumers`,
    );
    return (r ?? []).filter((c) => c.type === "http_pull");
  }

  async addQueueHttpConsumer(
    queueId: string,
  ): Promise<{ consumer_id: string }> {
    // Mirrors `wrangler queues consumer http add` defaults — batch_size
    // 10, max_retries 3, visibility_timeout_ms 30000, retry_delay 0.
    // The runtime-control pull route's request defaults stay within
    // these bounds.
    const r = await this.request<{ consumer_id: string }>(
      `/accounts/${this.opts.accountId}/queues/${queueId}/consumers`,
      {
        method: "POST",
        body: JSON.stringify({
          type: "http_pull",
          settings: {
            batch_size: 10,
            max_retries: 3,
            visibility_timeout_ms: 30000,
            retry_delay: 0,
          },
        }),
      },
    );
    if (!r) {
      throw new Error(`addQueueHttpConsumer(${queueId}) returned no result`);
    }
    return r;
  }
}
