import type { IncomingMessage, Server } from "node:http";
import type { Socket } from "node:net";

/** How long a request on the public listener has to arrive whole. */
export const PUBLIC_REQUEST_DEADLINE_MS = 300_000;

/** How long a request on the private control socket has to arrive whole. */
export const CONTROL_REQUEST_DEADLINE_MS = 30_000;

const REQUEST_TIMEOUT_RESPONSE =
  "HTTP/1.1 408 Request Timeout\r\nConnection: close\r\n\r\n";

const lifts = new WeakMap<IncomingMessage, () => void>();

/**
 * The status the server ended a connection with, set before it ends it. The
 * request stream of a connection the server cut ends with the same `aborted`
 * error as one the client closed, and this is what tells the two apart.
 */
const severed = new WeakMap<Socket, number>();

/** The requests of a server whose body has not yet arrived whole. */
const unfinished = new WeakMap<Server, Set<IncomingMessage>>();

/** The status the server ended this request's connection with, if it did. */
export function severedStatus(request: IncomingMessage): number | undefined {
  return severed.get(request.socket);
}

/**
 * End every connection of `server` at once, as the start-up clean-up does. A
 * request still arriving is marked as cut by the server (`503`) before its
 * connection goes.
 */
export function severAllConnections(server: Server): void {
  for (const request of unfinished.get(server) ?? [])
    severed.set(request.socket, 503);
  server.closeAllConnections();
}

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
  const arriving = new Set<IncomingMessage>();
  unfinished.set(server, arriving);
  server.prependListener("request", (request, response) => {
    if (request.complete) return;
    const socket = request.socket;
    const timer = setTimeout(() => {
      if (request.complete) return;
      severed.set(socket, 408);
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
    // Still arriving after the deadline is lifted, because the connection can
    // be cut for another reason until the body is whole.
    arriving.add(request);
    const arrived = () => arriving.delete(request);
    request.once("end", arrived);
    socket.once("close", arrived);
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
