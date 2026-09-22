/**
 * Fire-and-forget error webhook notifications with per-error-type debouncing.
 * Used by the error handler to send 500 alerts to a configured webhook URL.
 */

const DEBOUNCE_MS = 60_000;
const debounceMap = new Map<string, number>();

/** Fallback per-fetch delivery timeout (ms) when no explicit value is
 *  supplied. Production passes `AppConfig.errorWebhookTimeoutMs` (env
 *  `MARFA_ERROR_WEBHOOK_TIMEOUT_MS`) through `createErrorHandler`, so the
 *  operator-tunable value is the live one. */
const DEFAULT_WEBHOOK_TIMEOUT_MS = 5_000;

/**
 * Drops the debounce entries whose window has passed, on the write that
 * adds one. Sweeping here rather than on a timer leaves the scheduler the
 * one place a periodic task lives, and the walk rides on a path already
 * committed to sending a webhook, which dwarfs it. An entry whose window
 * has passed survives until the next send sweeps it, so the map is bounded
 * by what one window admits plus whatever the last send left behind.
 */
function forgetExpired(now: number): void {
  for (const [key, ts] of debounceMap) {
    if (now - ts > DEBOUNCE_MS) debounceMap.delete(key);
  }
}

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
  timeoutMs: number = DEFAULT_WEBHOOK_TIMEOUT_MS,
): void {
  const errorKey = `${notification.error.slice(0, 100)}:${notification.path}`;
  const now = Date.now();
  const last = debounceMap.get(errorKey);
  if (last && now - last < DEBOUNCE_MS) return;
  forgetExpired(now);
  debounceMap.set(errorKey, now);

  // Telegram sendMessage API — format as a readable text message
  if (webhookUrl.includes("api.telegram.org")) {
    const env =
      process.env.NODE_ENV === "production" ? "production" : "staging";
    const time = new Date(notification.timestamp)
      .toISOString()
      .replace("T", " ")
      .replace(/\.\d+Z$/, " UTC");
    const text = [
      `\u26a0\ufe0f *Marfa 500 Error* (${env})`,
      `\`${notification.method} ${notification.path}\` \u2014 ${time}`,
      notification.error,
      `Request: \`${notification.request_id}\``,
    ].join("\n");
    void fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, parse_mode: "Markdown" }),
      signal: AbortSignal.timeout(timeoutMs),
    }).catch(() => undefined);
  } else {
    // Generic webhook — POST JSON payload
    void fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(notification),
      signal: AbortSignal.timeout(timeoutMs),
    }).catch(() => {
      // Silently swallow — webhook failures must not cascade
    });
  }
}
