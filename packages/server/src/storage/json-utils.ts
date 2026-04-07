import { log } from "../middleware/logger.js";

/** Safely parse JSON from a database column, returning a fallback on corruption. */
export function safeJsonParse<T>(
  value: string,
  fallback: T,
  context: string,
): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    log("error", "Corrupted JSON in database column", {
      context,
      value: value.slice(0, 100),
    });
    return fallback;
  }
}
