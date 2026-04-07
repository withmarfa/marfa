import { createMiddleware } from "hono/factory";
import { generateId } from "@mymehq/shared";
import type { AppEnv } from "./auth.js";

// ---------------------------------------------------------------------------
// Structured log entry
// ---------------------------------------------------------------------------

interface LogEntry {
  timestamp: string;
  request_id: string;
  method: string;
  path: string;
  status: number;
  duration_ms: number;
  key_id?: string;
  error_code?: string;
}

// ---------------------------------------------------------------------------
// Standalone logger for non-request contexts (startup, shutdown, background)
// ---------------------------------------------------------------------------

type LogLevel = "info" | "warn" | "error";

export function log(
  level: LogLevel,
  message: string,
  data?: Record<string, unknown>,
): void {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    message,
    ...data,
  };
  process.stdout.write(JSON.stringify(entry) + "\n");
}

// ---------------------------------------------------------------------------
// Hono middleware — logs every request as JSON to stdout at completion
// ---------------------------------------------------------------------------

export function loggerMiddleware() {
  return createMiddleware<AppEnv>(async (c, next) => {
    const requestId = generateId();
    c.set("requestId", requestId);
    c.header("X-Request-ID", requestId);

    const start = performance.now();
    await next();
    const duration = performance.now() - start;

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      request_id: requestId,
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      duration_ms: Math.round(duration * 100) / 100,
    };

    const apiKey = c.get("apiKey");
    if (apiKey) entry.key_id = apiKey.id;

    // Extract error code from response body if it's an error status
    if (c.res.status >= 400) {
      const errorCode = c.res.headers.get("X-Error-Code");
      if (errorCode) entry.error_code = errorCode;
    }

    process.stdout.write(JSON.stringify(entry) + "\n");
  });
}
