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
 *
 * Code the server does not own, the sign-in library above all, reads
 * `Date` for itself. {@link installDateShim} makes the global `Date` follow
 * the same offset, and only a server started with the test hooks installs it.
 */

import { AsyncLocalStorage } from "node:async_hooks";

const realTime = new AsyncLocalStorage<boolean>();
const SystemDate = Date;
let installed = false;

/** The system clock: the live `Date` until the shim replaces it. */
function systemNow(): number {
  return installed ? SystemDate.now() : Date.now();
}

/** Wall time for protocols whose peer does not share the test clock. */
export function realNowMs(): number {
  return systemNow();
}

/** Keep a library and its asynchronous work on its external peer's clock. */
export function withRealTime<T>(run: () => T): T {
  // Startup can schedule library work before the shim is installed.
  return realTime.run(true, run);
}

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
  return systemNow() + offsetMs;
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
  if (systemNow() + offsetMs + ms > MAX_INSTANT_MS) {
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

/**
 * Makes the global `Date` read the clock: `Date.now()`, `new Date()` with no
 * argument and a call to `Date()` answer the time the server reads, and
 * everything else on `Date` is the system's. Called once at boot, before the
 * sign-in library is created, and only on a server started with the test
 * hooks, so the library's session, token and link times move with the clock.
 * `nowMs()` reads the system clock directly, so the offset is counted once.
 */
export function installDateShim(): void {
  if (installed) return;
  const shifted = (): number =>
    systemNow() + (realTime.getStore() ? 0 : offsetMs);
  const shim = new Proxy(SystemDate, {
    construct: (target, args: unknown[], newTarget): object =>
      Reflect.construct(
        target,
        args.length === 0 ? [shifted()] : args,
        newTarget,
      ) as object,
    apply: (target) => new target(shifted()).toString(),
    get: (target, property): unknown =>
      property === "now" ? shifted : Reflect.get(target, property, target),
  });
  // So that `new Date().constructor === Date` still holds.
  Object.defineProperty(SystemDate.prototype, "constructor", {
    value: shim,
    writable: true,
    configurable: true,
  });
  globalThis.Date = shim;
  installed = true;
}

/** Puts the clock back on the system clock, for a test's own isolation. */
export function resetClockForTests(): void {
  offsetMs = 0;
  if (!installed) return;
  Object.defineProperty(SystemDate.prototype, "constructor", {
    value: SystemDate,
    writable: true,
    configurable: true,
  });
  globalThis.Date = SystemDate;
  installed = false;
}
