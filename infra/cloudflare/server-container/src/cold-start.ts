/**
 * Serving a request through a container that may be asleep.
 *
 * Kept in its own module, importing nothing from the platform, so it can be
 * tested by passing a stand-in. The Worker entry cannot: it reaches for
 * `cloudflare:workers` and the containers library at import time, neither of
 * which resolves outside the Workers runtime, and this package carries its own
 * `node_modules` so a specifier mock from the parent package resolves to a
 * different physical copy and misses.
 */

/** The port the server image listens on, matching `PORT` in `envVars`. */
export const SERVER_PORT = 8600;

/**
 * How long to wait for a cold container to start listening.
 *
 * A measured wake is 11 to 15 seconds, so this is roughly twice the observed
 * worst case: long enough that a genuine wake is never cut short, short enough
 * that a container which is not coming up at all fails in front of the caller
 * rather than holding the connection open.
 *
 * The bound matters because one symptom covers two causes. A server that cannot
 * reach its database never listens either, and no amount of waiting changes
 * that — production sat in exactly that state for hours with its Postgres
 * compute exhausted. Unbounded, that becomes a hung request; bounded, it
 * becomes a retryable answer.
 */
export const PORT_READY_TIMEOUT_MS = 30_000;

/** The slice of the containers API this needs, so a test can supply it. */
export interface WakeableContainer {
  startAndWaitForPorts(args: {
    ports: number;
    cancellationOptions: { portReadyTimeoutMS: number };
  }): Promise<void>;
  fetch(request: Request): Promise<Response>;
}

/**
 * Wait for the container to be listening, then proxy the request to it.
 *
 * A bare passthrough answered the request that triggers a wake with the proxy
 * layer's own failure: `500` carrying
 * `Error proxying request to container: The container is not running, consider
 * calling start()`. Measured from cold, attempt one 500 in 0.4s, attempt two
 * 200 in 12.6s. The wake itself is the accepted cost of scaling to zero;
 * answering the request that caused it with an error was not, and it is the
 * first thing a person sees.
 *
 * **The wait comes before the proxy rather than a retry after it.** A retry
 * would have to replay the request, replaying means buffering the body, and a
 * blob upload runs to 50 MB inside a Worker. Waiting first sends the body
 * exactly once and holds nothing.
 */
export async function serveThroughContainer(
  request: Request,
  container: WakeableContainer,
): Promise<Response> {
  try {
    await container.startAndWaitForPorts({
      ports: SERVER_PORT,
      cancellationOptions: { portReadyTimeoutMS: PORT_READY_TIMEOUT_MS },
    });
  } catch {
    // Not listening, and it did not begin to within the budget. Answer in
    // Marfa's own error shape: the proxy layer's raw string carries no code, so
    // a client cannot tell a cold start from a dead instance, and anything
    // treating a 500 as fatal shows a broken app to a visitor arriving fresh.
    //
    // 503 with `Retry-After`, because retrying is the right move for both
    // causes — a wake still in progress, and an instance that needs an
    // operator. The caller's correct behaviour does not differ between them.
    return Response.json(
      {
        error: {
          code: "service_unavailable",
          message:
            "The server is starting up and did not become ready in time. Retry shortly.",
        },
      },
      {
        status: 503,
        headers: {
          "Retry-After": "5",
          // The next request may well succeed, so nothing should cache this.
          "Cache-Control": "no-store",
        },
      },
    );
  }

  return container.fetch(request);
}
