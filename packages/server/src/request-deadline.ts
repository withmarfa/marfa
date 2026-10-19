import type { IncomingMessage, Server } from "node:http";

/** How long a request on the public listener has to arrive whole. */
export const PUBLIC_REQUEST_DEADLINE_MS = 300_000;

/** How long a request on the private control socket has to arrive whole. */
export const CONTROL_REQUEST_DEADLINE_MS = 30_000;

const REQUEST_TIMEOUT_RESPONSE =
  "HTTP/1.1 408 Request Timeout\r\nConnection: close\r\n\r\n";

const lifts = new WeakMap<IncomingMessage, () => void>();

/**
 * Give every request `ms` from the moment its headers are in to arrive whole,
 * and cut the connection of one that does not, as Node's own `requestTimeout`
 * does; the headers have the `headersTimeout` Node keeps. Node's request
 * timeout is switched off because it cannot be lifted for one request: a
 * restore or a blob upload lifts this one (`liftRequestDeadline`) once the
 * caller is admitted, and every other request keeps it.
 */
export function enforceRequestDeadline(server: Server, ms: number): void {
  server.requestTimeout = 0;
  server.prependListener("request", (request, response) => {
    if (request.complete) return;
    const socket = request.socket;
    const timer = setTimeout(() => {
      if (request.complete) return;
      if (!response.headersSent && socket.writable)
        socket.write(REQUEST_TIMEOUT_RESPONSE);
      socket.destroySoon();
    }, ms);
    timer.unref();
    // A door that answers before the body is whole leaves the request with
    // no `end` and, once Node drops it from its list, no `close`; the
    // connection's own close is what releases the timer and what it holds.
    const stop = () => {
      clearTimeout(timer);
      socket.off("close", stop);
    };
    lifts.set(request, stop);
    request.once("end", stop);
    socket.once("close", stop);
    response.once("close", () => {
      if (request.complete) stop();
    });
  });
}

/**
 * End the fixed deadline of a request whose door reads its body under a limit
 * of its own. A request that reaches here has been admitted by its door, so an
 * unauthenticated caller never holds a connection past the deadline.
 */
export function liftRequestDeadline(request: IncomingMessage): void {
  lifts.get(request)?.();
}
