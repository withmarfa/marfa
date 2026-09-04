/**
 * The offline seam, defined once.
 *
 * Every scenario that exercises the engine away from a working server goes
 * through this and names which mode it uses. Five modes cover the ways a
 * server stops being available to a client: the request never arrives, the
 * answer never comes back, the credential is refused, the server errors,
 * and — for the stream, which this part does not carry — the connection
 * closes. A scenario that does not name its seam is not reproducible, so
 * the seam is a parameter rather than something each test improvises.
 *
 * Test support. It lives beside the engine rather than in a test file
 * because more than one suite uses it, and it is not a tsup entry, so it
 * never ships. Mirrors `test-harness.ts` at the package root.
 */

export type SeamMode =
  /** Requests reach the server. */
  | "online"
  /** The request never arrives. The transport raises a network error with
   *  no HTTP status, which is not a refusal and not an attempt. */
  | "offline"
  /**
   * The request arrives and is served; the answer never comes back.
   *
   * Indistinguishable from `offline` at the client, and the opposite of it
   * at the server, which is the whole reason a write carries a key: the
   * client has to be able to repeat a request that may already have
   * landed without that repeat becoming a second write.
   */
  | "lost_response"
  /** The server answers 401. For a key-bearing client there is no refresh
   *  to spend, so this is the shape of a credential that has run out. */
  | "unauthorized"
  /** The server answers 503. Something to wait out rather than a verdict on
   *  the write. */
  | "server_error";

/** One request the engine issued, whether or not the seam let it through. */
export interface SeamRequest {
  method: string;
  path: string;
  /** The JSON body, parsed. Undefined for a request that carried none. */
  body: unknown;
  /**
   * The request headers, keyed in lower case because that is how a header
   * name compares: `Idempotency-Key` and `idempotency-key` are one header,
   * and a scenario asserting on the wrong spelling would read as a missing
   * header rather than as its own mistake.
   */
  headers: Record<string, string>;
}

export interface OfflineSeam {
  /** Pass this to `MarfaClient`. */
  fetch: typeof globalThis.fetch;
  /** How the seam answers from now on. */
  mode: SeamMode;
  /**
   * Answer the next `count` requests as `online`, then switch to `mode`.
   *
   * This is what makes "mid-drain" expressible: a credential that expires
   * between two writes rather than before the first.
   */
  after(count: number, mode: SeamMode): void;
  /** Every request the engine issued, in order. Includes the ones the seam
   *  refused, so a scenario can assert on what an offline pass tried. */
  readonly requests: SeamRequest[];
  /** The same, as `METHOD /path`, for asserting on order. */
  readonly calls: string[];
  /** Forget what has been recorded so far. */
  reset(): void;
}

function refusal(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export function createOfflineSeam(
  passthrough: typeof globalThis.fetch,
): OfflineSeam {
  const requests: SeamRequest[] = [];
  let mode: SeamMode = "online";
  /** Requests still to be answered normally before `queuedMode` takes over.
   *  Null when no switch is pending. */
  let passesLeft: number | null = null;
  let queuedMode: SeamMode | null = null;

  const seam: OfflineSeam = {
    requests,
    get calls() {
      return requests.map((request) => `${request.method} ${request.path}`);
    },
    reset() {
      requests.length = 0;
    },
    get mode() {
      return mode;
    },
    set mode(next: SeamMode) {
      mode = next;
      passesLeft = null;
      queuedMode = null;
    },
    after(count, next) {
      mode = "online";
      passesLeft = count;
      queuedMode = next;
    },
    fetch: async (input, init) => {
      const href =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      const method = init?.method ?? "GET";
      requests.push({
        method,
        path: new URL(href).pathname,
        body:
          typeof init?.body === "string"
            ? (JSON.parse(init.body) as unknown)
            : undefined,
        // Through `Headers` rather than by reading the init object, so
        // every shape `fetch` accepts is recorded the same way and the
        // keys are lower-cased for us.
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
      });

      if (passesLeft !== null && passesLeft > 0) {
        passesLeft -= 1;
        if (passesLeft === 0 && queuedMode !== null) {
          mode = queuedMode;
          queuedMode = null;
          passesLeft = null;
        }
        return passthrough(input, init);
      }

      switch (mode) {
        case "online":
          return passthrough(input, init);
        case "offline":
          // What `fetch` raises when the host cannot be reached. The
          // transport turns it into a network error carrying no status.
          throw new TypeError("fetch failed");
        case "lost_response":
          // Awaited before the throw, deliberately: the server has to have
          // finished writing by the time the client is told nothing came
          // back, or this is just a slower `offline`.
          await passthrough(input, init);
          throw new TypeError("fetch failed");
        case "unauthorized":
          return refusal(401, "unauthorized", "Access token has expired");
        case "server_error":
          return refusal(503, "internal_error", "Server is having a moment");
      }
    },
  };

  return seam;
}
