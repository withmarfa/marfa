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

/**
 * Requests that change nothing a person would lose by sending them again:
 * reads sent as POST, and a blob, which is stored by its hash.
 */
const SAFE_TO_REPEAT = new Set([
  "/items/bulk-get",
  "/items/trash-preview",
  "/blobs",
]);

/** The API, for one MCP request. */
export class McpApi {
  readonly client: MarfaClient;
  /** Whether a call so far changed something, so it is not safe to repeat. */
  wrote = false;

  constructor(options: McpApiOptions) {
    const base = options.baseUrl.replace(/\/+$/, "");
    const basePath = new URL(base).pathname.replace(/\/+$/, "");
    this.client = createClient({
      baseUrl: base,
      credential: options.credential,
      fetch: async (input, init) => {
        const request =
          input instanceof Request && init === undefined
            ? input
            : new Request(input, init);
        const response = await options.dispatch(request);
        if (
          response.ok &&
          request.method !== "GET" &&
          !SAFE_TO_REPEAT.has(
            new URL(request.url).pathname.slice(basePath.length),
          )
        ) {
          this.wrote = true;
        }
        return response;
      },
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
}
