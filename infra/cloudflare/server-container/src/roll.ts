/**
 * Replacing the running container when it is not the build the Worker was
 * deployed to front.
 *
 * The Worker rolls atomically on `wrangler deploy`. The container does not: it
 * is replaced when it goes idle for the whole `sleepAfter` window, and any
 * request renews that window. For an additive migration the gap is harmless.
 * For a migration the old build cannot read, it is an outage that sustains
 * itself, because the failing clients' retries are what keep the old build
 * resident.
 *
 * A health-checked swap is not available to fix it. `max_instances` is 1 and
 * load-bearing rather than a capacity setting: in-process pubsub, the consent
 * mutex and the background sweeps all assume one process per database. There
 * is never a second instance to check before cutting over.
 *
 * But the replacement mechanism already exists — idling out calls `destroy()`.
 * Only its trigger is wrong. So the Worker, which does know which image it was
 * deployed to front, tells the container to stand down when the two disagree.
 * That inverts the operator trap the runbook warns about: the first
 * post-deploy request becomes the thing that causes the roll rather than the
 * thing that prevents it.
 *
 * Kept platform-free so it can be tested by passing a stand-in, for the same
 * reason `cold-start.ts` is.
 */

/** The slice of the container API a roll needs. */
export interface RollableContainer {
  destroy(): Promise<void>;
}

/** Where the instance records which image it last started under. */
export interface ImageTagStore {
  get(): Promise<string | undefined>;
  set(tag: string): Promise<void>;
}

export type RollOutcome =
  /** No expected image declared, so nothing can be judged stale. */
  | "unknown"
  /** The running instance is already the deployed build. */
  | "current"
  /** The instance was destroyed; the next start pulls the deployed build. */
  | "rolled"
  /** Stale, and the destroy did not take. Left for the next request. */
  | "failed";

/**
 * Stand the container down if it is not running the deployed image.
 *
 * Fails closed on an unset expectation. The var is rendered by the deploy
 * script and guarded there against an unresolved token, but a var that went
 * missing must not turn every request into a cold start.
 *
 * The first request after this ships finds no recorded tag and rolls once,
 * because "unrecorded" cannot be distinguished from "stale" and the safe
 * reading of an unknown build is that it is the wrong one. That costs a single
 * cold start, once per instance.
 */
export async function rollIfStale(
  container: RollableContainer,
  store: ImageTagStore,
  expectedImage: string | undefined,
): Promise<RollOutcome> {
  const expected = expectedImage?.trim();
  if (!expected) return "unknown";

  const running = await store.get();
  if (running === expected) return "current";

  try {
    await container.destroy();
  } catch {
    // Leave the recorded tag alone so the next request tries again. Failing
    // the caller's request instead would turn a stalled roll into an outage,
    // and the deploy gate is what makes a stall loud.
    return "failed";
  }

  await store.set(expected);
  return "rolled";
}
