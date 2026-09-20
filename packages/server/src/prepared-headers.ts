/**
 * Carry the headers the middleware chain prepared onto a response built by
 * hand, which Hono would otherwise drop.
 *
 * Hono keeps a header set by `c.header(...)` in a prepared bag and does not
 * materialize the context response to hold it. When a handler returns a
 * fresh `Response`, the assignment in Hono's `set res` copies that bag over
 * the returned response — but only if the context response already exists.
 * On a handler that builds its own `Response` and nothing has read `c.res`,
 * it does not, the copy is skipped, and every header set outside the route
 * is silently lost: `X-Request-ID`, the `X-RateLimit-*` trio, and on a
 * replay the idempotency marker.
 *
 * Reading `c.res` here is what makes the copy happen at all, so this
 * function is load-bearing twice over: it merges, and it materializes.
 *
 * **The gap is invisible on some deployments, which is why it survived.**
 * Hono's `cors` middleware reads `c.res` before `next()`, materializing the
 * response for the whole chain behind it — so where `CORS_ORIGINS` is set,
 * every handler here already kept its prepared headers. `CORS_ORIGINS` is
 * empty by default, and the test harness leaves it empty, so the routes
 * below lost them on a default deployment and in every test that did not
 * look.
 *
 * **Precedence, stated as it actually is rather than as it reads.** The
 * merge below lets `response` win, but Hono then re-applies the prepared
 * bag over the result and skips only `content-type` while doing it — so for
 * any name in both, the *prepared* value is what ships. That is invisible
 * today because the prepared bag only ever holds `X-Request-ID`, the
 * `X-RateLimit-*` trio and `Retry-After`, and no caller here sets any of
 * those. It stops being invisible the moment one does. Do not read the
 * merge as a guarantee that a hand-built response can override a header the
 * chain prepared: it cannot, and the fix would have to be to clear the name
 * from `c.res` first.
 */
/**
 * **Which responses this covers, enumerated rather than assumed.** The list
 * below is every `withPreparedHeaders` call site, and it is kept by reading
 * them rather than by remembering them: an earlier version of this comment
 * named three surfaces that no longer exist, which is worse than naming none.
 *
 * Wrapped, because they are the API surface a client calls: the SSE stream
 * (`routes/events.ts`), both export shapes (`routes/export.ts`), the blob
 * bytes on both of their doors and on `HEAD` (`routes/blobs.ts`, one
 * function serving the bearer door and the link door), and a replayed answer
 * served from the idempotency store (`middleware/idempotency.ts`). The last
 * is the one a reader is most likely to miss, because it is served from the
 * middleware rather than from a route: a replay is still an answer to an API
 * request, and a caller correlating it with a log line needs the same id as
 * on any other.
 *
 * Deliberately not wrapped: the browser and protocol surfaces. The auth HTML
 * pages and their redirects (`routes/auth-pages.ts`, `routes/auth-consent.ts`),
 * the OAuth discovery documents (`app.ts`), and the error pages and bodies
 * (`middleware/error-handler.ts`). These are not the typed API and declare
 * none of these headers, so there is nothing to make honest.
 */
export function withPreparedHeaders(
  c: { res: Response },
  response: Response,
): Response {
  const headers = new Headers(c.res.headers);
  for (const [name, value] of response.headers) headers.set(name, value);
  return new Response(response.body, { status: response.status, headers });
}
