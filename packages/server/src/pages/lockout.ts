/**
 * How a page says how long a refused person has to wait.
 *
 * The server redirects a refused sign-in or device code lookup with
 * `retry_after`, the whole seconds until the limit that refused it allows
 * another attempt. The pages show that wait in whole minutes, rounded up, so
 * nobody is told to try again before the limit has reset.
 */

/** The longest wait a page believes. The longest limit is an hour. */
const LONGEST_WAIT_SECONDS = 24 * 60 * 60;

/**
 * The wait a `retry_after` value names, or `undefined` for anything that is
 * not a whole number of seconds between one and a day. The value comes from
 * the address bar, so a page treats it as text a person could have typed.
 */
export function parseWaitSeconds(raw: unknown): number | undefined {
  if (typeof raw !== "string" || !/^\d{1,6}$/.test(raw)) return undefined;
  const seconds = Number(raw);
  return seconds >= 1 && seconds <= LONGEST_WAIT_SECONDS ? seconds : undefined;
}

/** "1 minute" or "12 minutes": the wait rounded up to a whole minute. */
export function waitInMinutes(seconds: number): string {
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  return minutes === 1 ? "1 minute" : `${String(minutes)} minutes`;
}
