/**
 * The one place the server reads the time. Every other module takes the
 * time from here, and the lint rule `no-restricted-syntax` in
 * `eslint.config.js` refuses `Date.now()` and a bare `new Date()` anywhere
 * else in `src`.
 *
 * The clock is the system clock plus an offset, which is zero unless the
 * server was started with `MARFA_TEST_HOOKS` and the test hooks move it.
 * It only moves forward: ids, versions and cursors assume time does not go
 * back. Timers and `monotonicMs()` stay on real time.
 */

/** The latest instant a `Date` can hold, in milliseconds since the epoch. */
const MAX_INSTANT_MS = 8_640_000_000_000_000;

/**
 * The furthest ahead the clock may be: a hundred years. It is also the largest
 * `MARFA_TEST_CLOCK_OFFSET_MS`, so a server that moved the clock can always
 * be restarted with the offset it reached.
 */
export const MAX_CLOCK_OFFSET_MS = 3_153_600_000_000;

let offsetMs = 0;

/** The current time in milliseconds since the epoch. */
export function nowMs(): number {
  return Date.now() + offsetMs;
}

/** The current time as a `Date`. */
export function now(): Date {
  return new Date(nowMs());
}

/**
 * Milliseconds on a monotonic scale that the test hooks never move. Measure
 * every elapsed span with it (a budget, a stall, a lifetime, an uptime): a
 * span that followed `nowMs()` would end the moment a test moved the clock.
 */
export function monotonicMs(): number {
  return performance.now();
}

/** How far the clock is ahead of the system clock, in milliseconds. */
export function clockOffsetMs(): number {
  return offsetMs;
}

/**
 * Moves the clock forward by `ms` and returns the new offset. A step that is
 * negative, not a whole number or would carry the offset past
 * `MAX_CLOCK_OFFSET_MS` (or the clock past the last instant a `Date` can
 * hold) is refused, and the clock stays where it was.
 */
export function advanceClock(ms: number): number {
  if (!Number.isSafeInteger(ms) || ms < 0) {
    throw new RangeError("the clock moves forward by a whole number of ms");
  }
  if (offsetMs + ms > MAX_CLOCK_OFFSET_MS) {
    throw new RangeError(
      `the clock cannot be more than ${String(MAX_CLOCK_OFFSET_MS)} ms ahead`,
    );
  }
  if (Date.now() + offsetMs + ms > MAX_INSTANT_MS) {
    throw new RangeError("the clock cannot move past the last instant");
  }
  offsetMs += ms;
  return offsetMs;
}

/**
 * Sets the offset a restarted server inherits. Called once at boot, before
 * anything reads the time, and only from a setting that is refused unless the
 * test hooks are on.
 */
export function setClockOffset(ms: number): void {
  offsetMs = 0;
  advanceClock(ms);
}

/** Puts the clock back on the system clock, for a test's own isolation. */
export function resetClockForTests(): void {
  offsetMs = 0;
}
