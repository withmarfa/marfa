/**
 * Asks `probe` until it answers something other than `undefined`, and
 * answers that, or throws `what` when `timeoutMs` has passed. For a state the
 * server reaches on its own clock, such as a copy its scheduler places after
 * an upload, where there is no request whose answer says it is done.
 */
export async function waitFor<T>(
  what: string,
  probe: () => Promise<T | undefined>,
  timeoutMs = 20_000,
  intervalMs = 100,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = await probe();
    if (found !== undefined) return found;
    if (Date.now() >= deadline) {
      throw new Error(`${what} did not happen within ${String(timeoutMs)}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
