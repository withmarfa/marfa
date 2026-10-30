import type { MiddlewareHandler } from "hono";
import { compress } from "hono/compress";
import { isJsonContentType } from "./json-content-type.js";

const gzip = compress({
  encoding: "gzip",
  contentTypeFilter: isJsonContentType,
});

/**
 * Sends a JSON answer gzip-compressed to a `GET` request that carries
 * `Authorization` and accepts gzip. A hydration's pages are mostly item
 * bodies, which compress several times over, and over a slow link their
 * bytes are what a person waits for.
 *
 * A request without `Authorization`, such as a browser's with a session
 * cookie, is answered as it is: a page on another site can make the browser
 * send such a request with text of its choosing, and the size of a
 * compressed answer that holds that text beside a secret can give the secret
 * away (BREACH). A browser attaches no `Authorization` header to a request
 * another site makes, since Marfa uses no HTTP authentication a browser would remember.
 *
 * A request with a body is answered as it is too. When a handler refuses one
 * before reading its body, as a `413` does, `@hono/node-server` drains that
 * body so the connection can carry the next request; a compressed answer left
 * it undrained, and the next request on the connection failed.
 */
export function compressJson(): MiddlewareHandler {
  return (c, next) =>
    c.req.method !== "GET" || c.req.header("authorization") === undefined
      ? next()
      : gzip(c, next);
}
