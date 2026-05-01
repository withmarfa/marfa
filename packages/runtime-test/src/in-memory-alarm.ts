/**
 * In-memory DO alarm scheduler.
 *
 * Cloudflare's `state.storage.setAlarm(when_ms)` schedules the DO's
 * `alarm()` method to fire at the wall-clock time `when_ms`. Tests
 * don't want real wall-clock waiting; this implementation captures the
 * scheduled time and exposes a `tick(now_ms)` helper so a test can
 * advance time deterministically.
 */
export interface InMemoryAlarm {
  setAlarm(when_ms: number): void;
  getAlarm(): number | null;
  cancelAlarm(): void;
  /** Test-only — invoke the registered handler if `now_ms >= scheduled`.
   *  Returns true iff the alarm fired. */
  tick(now_ms: number): Promise<boolean>;
  /** Register the handler that the DO would normally implement as
   *  `alarm()`. The runtime SDK exposes this via DurableObject. */
  setHandler(handler: () => Promise<void>): void;
}

export function createInMemoryAlarm(): InMemoryAlarm {
  let scheduled: number | null = null;
  let handler: (() => Promise<void>) | null = null;

  return {
    setAlarm(when_ms: number): void {
      scheduled = when_ms;
    },
    getAlarm(): number | null {
      return scheduled;
    },
    cancelAlarm(): void {
      scheduled = null;
    },
    setHandler(h: () => Promise<void>): void {
      handler = h;
    },
    async tick(now_ms: number): Promise<boolean> {
      if (scheduled === null || now_ms < scheduled) return false;
      scheduled = null;
      if (handler) await handler();
      return true;
    },
  };
}
