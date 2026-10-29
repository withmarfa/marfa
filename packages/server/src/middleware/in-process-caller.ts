import { AsyncLocalStorage } from "node:async_hooks";

/**
 * The caller of a request the server sends into itself on behalf of an outer
 * one: an MCP tool call reaching the API. The inner request carries none of
 * the outer one's forwarding headers, so its own address would be the
 * proxy's, or the server's own.
 *
 * Held in async context, which only the server can set: a client cannot
 * claim it with a header.
 */
export interface InProcessCaller {
  /** The address the outer request resolved to. */
  clientIp: string | null;
  /** The door the outer request came through, recorded on each audit row. */
  via: "mcp";
}

const callers = new AsyncLocalStorage<InProcessCaller>();

export function asInProcessCaller<T>(
  caller: InProcessCaller,
  work: () => T,
): T {
  return callers.run(caller, work);
}

export function inProcessCaller(): InProcessCaller | undefined {
  return callers.getStore();
}
