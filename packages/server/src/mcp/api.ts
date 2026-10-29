/**
 * How a tool reaches Marfa: the public API, called in process with the
 * caller's own credential. Every check a request to the API meets, from the
 * credential's grant to the rate limit and the version guard, holds for a
 * tool call too, because a tool call is such a request.
 */
import { createClient, type MarfaClient } from "@withmarfa/client";

/** A refusal from the API, as its error body named it. */
export interface ApiRefusal {
  status: number;
  code: string;
  message: string;
  details?: Record<string, unknown>;
  /** The rest of the error body, such as `current` on a version conflict. */
  body: Record<string, unknown>;
}

export type ApiAnswer<T> =
  { ok: true; status: number; data: T } | { ok: false; refusal: ApiRefusal };

export interface McpApiOptions {
  /** Where the instance is served, as its own links name it. */
  baseUrl: string;
  /** The bearer the MCP request carried. */
  credential: string;
  /** Sends a request into the app in process. */
  dispatch: (request: Request) => Promise<Response>;
}

/** Read an error body into a refusal. */
export async function refusalOf(response: Response): Promise<ApiRefusal> {
  let body: Record<string, unknown> = {};
  try {
    const parsed: unknown = await response.json();
    if (typeof parsed === "object" && parsed !== null) {
      body = parsed as Record<string, unknown>;
    }
  } catch {
    // An answer without a JSON body is named by its status alone.
  }
  return refusalFromBody(response.status, body);
}

export function refusalFromBody(status: number, body: unknown): ApiRefusal {
  const record =
    typeof body === "object" && body !== null
      ? (body as Record<string, unknown>)
      : {};
  const error =
    typeof record.error === "object" && record.error !== null
      ? (record.error as Record<string, unknown>)
      : {};
  const rest = { ...record };
  delete rest.error;
  return {
    status,
    code:
      typeof error.code === "string" ? error.code : `http_${String(status)}`,
    message:
      typeof error.message === "string"
        ? error.message
        : `The request was refused with status ${String(status)}.`,
    ...(typeof error.details === "object" && error.details !== null
      ? { details: error.details as Record<string, unknown> }
      : {}),
    body: rest,
  };
}

/** The API, for one MCP request. */
export class McpApi {
  readonly client: MarfaClient;
  private readonly base: string;

  constructor(private readonly options: McpApiOptions) {
    this.base = options.baseUrl.replace(/\/+$/, "");
    this.client = createClient({
      baseUrl: this.base,
      credential: options.credential,
      fetch: (input, init) =>
        options.dispatch(
          input instanceof Request && init === undefined
            ? input
            : new Request(input, init),
        ),
    });
  }

  /**
   * An answer from the typed client, as an `ApiAnswer`. openapi-fetch
   * hands back `data` for a success and `error` for anything else.
   */
  async answer<T>(
    call: Promise<{ data?: T; error?: unknown; response: Response }>,
  ): Promise<ApiAnswer<T>> {
    const { data, error, response } = await call;
    if (response.ok && error === undefined) {
      return { ok: true, status: response.status, data: data as T };
    }
    return { ok: false, refusal: refusalFromBody(response.status, error) };
  }

  /**
   * A call to an operation the generated client does not know yet. The
   * request is the same in-process request the client sends.
   */
  async raw<T>(
    method: "GET" | "POST" | "DELETE",
    path: string,
    query: Record<string, string | number | undefined> = {},
  ): Promise<ApiAnswer<T>> {
    const url = new URL(`${this.base}${path}`);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    const response = await this.options.dispatch(
      new Request(url, {
        method,
        headers: { Authorization: `Bearer ${this.options.credential}` },
      }),
    );
    if (!response.ok) return { ok: false, refusal: await refusalOf(response) };
    return {
      ok: true,
      status: response.status,
      data: (await response.json()) as T,
    };
  }
}
