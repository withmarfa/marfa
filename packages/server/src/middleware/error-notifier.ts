import { DEPLOYMENT_ENVIRONMENT } from "../deployment-environment.js";
import { withoutQueryParameters } from "../error-text.js";

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

/**
 * How many entries the debounce is holding.
 *
 * Exported for the case that pins the sweep. Dropping an entry changes
 * nothing a caller can see — an entry past its window and an absent one
 * both let the next error through — so a test with no way to read this
 * number can assert that the sweep is called and never that it clears
 * anything.
 */
export function debounceEntryCount(): number {
  return debounceMap.size;
}

export interface ErrorNotification {
  timestamp: string;
  request_id: string;
  error: string;
  path: string;
  method: string;
  /** The host the instance is reached at. */
  instance?: string;
}

/** The host itself, not a URL that merely mentions it in a path, query or longer hostname. */
function isTelegramUrl(webhookUrl: string): boolean {
  try {
    return new URL(webhookUrl).hostname === "api.telegram.org";
  } catch {
    return false;
  }
}

export function notifyError(
  webhookUrl: string,
  reported: ErrorNotification,
  timeoutMs: number = DEFAULT_WEBHOOK_TIMEOUT_MS,
): void {
  // The channel is read by more people than the instance holds data for, so
  // the text it is sent never carries a failed query's values, whoever built it.
  const notification = {
    ...reported,
    error: withoutQueryParameters(reported.error),
    environment: DEPLOYMENT_ENVIRONMENT,
  };
  const errorKey = `${notification.error.slice(0, 100)}:${notification.path}`;
  const now = Date.now();
  const last = debounceMap.get(errorKey);
  if (last && now - last < DEBOUNCE_MS) return;
  forgetExpired(now);
  debounceMap.set(errorKey, now);

  // Telegram sendMessage API — format as a readable text message
  if (isTelegramUrl(webhookUrl)) {
    const time = new Date(notification.timestamp)
      .toISOString()
      .replace("T", " ")
      .replace(/\.\d+Z$/, " UTC");
    const where = notification.instance
      ? `${notification.instance}, ${notification.environment}`
      : notification.environment;
    const text = [
      `\u26a0\ufe0f *Marfa 500 Error* (${where})`,
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
