/**
 * Fire-and-forget error webhook notifications with per-error-type debouncing.
 * Used by the error handler to send 500 alerts to a configured webhook URL.
 */

const DEBOUNCE_MS = 60_000;
const debounceMap = new Map<string, number>();

// Periodic cleanup of expired debounce entries
const cleanup = setInterval(() => {
  const now = Date.now();
  for (const [key, ts] of debounceMap) {
    if (now - ts > DEBOUNCE_MS) debounceMap.delete(key);
  }
}, 300_000);
cleanup.unref();

export interface ErrorNotification {
  timestamp: string;
  request_id: string;
  error: string;
  path: string;
  method: string;
}

export function notifyError(
  webhookUrl: string,
  notification: ErrorNotification,
): void {
  const errorKey = `${notification.error.slice(0, 100)}:${notification.path}`;
  const now = Date.now();
  const last = debounceMap.get(errorKey);
  if (last && now - last < DEBOUNCE_MS) return;
  debounceMap.set(errorKey, now);

  // Push-style URLs (e.g., Uptime Kuma) use GET with query params
  if (webhookUrl.includes("/api/push/")) {
    const msg = encodeURIComponent(
      `${notification.method} ${notification.path}: ${notification.error}`,
    );
    void fetch(`${webhookUrl}?status=down&msg=${msg}&ping=0`, {
      signal: AbortSignal.timeout(5000),
    }).catch(() => {});
  } else {
    void fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(notification),
      signal: AbortSignal.timeout(5000),
    }).catch(() => {
      // Silently swallow — webhook failures must not cascade
    });
  }
}
