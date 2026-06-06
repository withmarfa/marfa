import { createMiddleware } from "hono/factory";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import type { AppEnv } from "./auth.js";

/**
 * Stamps request context onto the active OpenTelemetry server span so
 * traces join the existing JSON request logs by `request_id`, and so
 * the error-aware sampler's error gate fires on 5xx.
 *
 * API-only (`@opentelemetry/api`) — when OpenTelemetry is disabled there is
 * no active span and this is a pure pass-through (`trace.getActiveSpan()`
 * returns undefined). The HTTP instrumentation owns the span itself; this
 * middleware never creates one.
 *
 * Mounted AFTER `loggerMiddleware` (so `requestId` is set) but the
 * credential-derived attributes are stamped after `next()` resolves, since
 * auth runs later in the chain. Only `key_id` / `tenant_id` are recorded —
 * never the credential secret.
 */
export function otelCorrelationMiddleware() {
  return createMiddleware<AppEnv>(async (c, next) => {
    const span = trace.getActiveSpan();
    if (!span) {
      await next();
      return;
    }

    const requestId = c.get("requestId");
    if (requestId) span.setAttribute("marfa.request_id", requestId);

    await next();

    const apiKey = c.get("apiKey");
    if (apiKey) {
      span.setAttribute("marfa.key_id", apiKey.id);
      if (apiKey.tenant_id)
        span.setAttribute("marfa.tenant_id", apiKey.tenant_id);
    }

    if (c.res.status >= 500) {
      span.setStatus({ code: SpanStatusCode.ERROR });
      const code = c.res.headers.get("X-Error-Code");
      if (code) span.setAttribute("error.code", code);
    }
  });
}
