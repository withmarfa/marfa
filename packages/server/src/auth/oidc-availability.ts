/**
 * Federated identity providers that degrade instead of taking the server
 * with them.
 *
 * The authorization library performs OIDC discovery while its plugin
 * initializes, and a provider that cannot be reached rejects there. That
 * rejection escapes into plugin init, where no caller of ours can reach
 * it, and the auth instance is constructed at boot — so an unreachable
 * discovery URL terminates the process and the server crash-loops for as
 * long as the provider blips.
 *
 * The trade this file makes is the one ruled for the platform: a
 * dependency that cannot reach the outside world degrades the feature it
 * serves, never the server. Every other sign-in method, and every request
 * that has nothing to do with signing in, keeps working. Three properties
 * make that honest rather than a way of hiding the failure:
 *
 *   - It is loud. Each failure logs at error level, the provider is
 *     reported unavailable on the health surface, and its sign-in route
 *     answers with a reason instead of claiming the provider does not
 *     exist.
 *   - It retries, on a widening delay with no ceiling on attempts. A
 *     degradation that lasted until the next restart would cost the same
 *     manual intervention that refusing to boot does.
 *   - It has no special case for the last provider standing. If a
 *     federated provider is the only configured method, degrading means
 *     nobody signs in until it returns — still better than a crash loop,
 *     because the server runs, the cause is visible, and it heals itself.
 *
 * Providers initialize one at a time rather than as a set, because the
 * library's own loop abandons the whole set on the first failure. One
 * unreachable provider must not take out the three that answered.
 */

import { genericOAuth } from "better-auth/plugins";
import type { BetterAuthPlugin } from "better-auth";
import { log } from "../middleware/logger.js";

/** A federated provider as configured on the server. */
export interface OidcProviderConfig {
  providerId: string;
  clientId: string;
  clientSecret: string;
  discoveryUrl?: string;
  scopes?: string[];
}

/** What the health surface and the sign-in route report per provider.
 *
 *  `initializing` is the honest answer during the short window between
 *  the auth instance being constructed and its plugins finishing — the
 *  library builds that context asynchronously, so there is a real moment
 *  when nothing yet knows whether a provider answers. Reporting `ok`
 *  there would be a guess, and reporting `unavailable` would flap the
 *  health surface on every ordinary boot. */
export interface OidcProviderHealth {
  provider_id: string;
  status: "ok" | "unavailable" | "initializing";
  /** Why it is unavailable. Absent while the provider is serving. */
  error?: string;
  /** When it first failed, and has been failing since. */
  unavailable_since?: string;
  /** Failed initialization attempts since it was last serving. */
  attempts?: number;
}

/**
 * Delays before retry attempts 1, 2, 3… The last entry repeats for every
 * attempt beyond it, so a provider that stays down is probed every five
 * minutes forever rather than being given up on. The early attempts are
 * close together because the common case is a provider that is briefly
 * unreachable during its own deploy.
 */
const STEADY_RETRY_DELAY_MS = 300_000;
const DEFAULT_RETRY_DELAYS_MS = [
  5_000,
  15_000,
  60_000,
  STEADY_RETRY_DELAY_MS,
] as const;

export interface ResilientOidcOptions {
  providers: readonly OidcProviderConfig[];
  /** Overridable so tests can drive the retry loop without waiting. */
  retryDelaysMs?: readonly number[];
  /** Overridable so tests can run the loop on their own clock. */
  scheduler?: (fn: () => void, delayMs: number) => { cancel: () => void };
}

/** What better-auth's plugin init hands back and consumes. Narrow on
 *  purpose: this file only reads the social-provider list and only ever
 *  appends to it. */
interface InitContextLike {
  socialProviders: unknown[];
}
interface PluginLike {
  init: (ctx: InitContextLike) => Promise<{
    context?: { socialProviders?: unknown[] };
  }>;
}

export interface ResilientOidc {
  /** Hand this to better-auth in place of `genericOAuth(...)`. */
  plugin: BetterAuthPlugin;
  /** Current state of every configured provider, in registration order. */
  snapshot: () => OidcProviderHealth[];
  /** One provider's state, or undefined when it is not configured. */
  statusOf: (providerId: string) => OidcProviderHealth | undefined;
  /** Stop the retry loop. Called on shutdown and in test teardown; a
   *  pending retry left running would outlive its server. */
  stop: () => void;
}

function defaultScheduler(
  fn: () => void,
  delayMs: number,
): { cancel: () => void } {
  const handle = setTimeout(fn, delayMs);
  // A retry must never be the reason a process stays alive.
  handle.unref();
  return {
    cancel: () => {
      clearTimeout(handle);
    },
  };
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.message;
  return typeof err === "string" ? err : "unknown error";
}

export function resilientGenericOAuth(
  options: ResilientOidcOptions,
): ResilientOidc {
  const configs = [...options.providers];
  const retryDelays =
    options.retryDelaysMs && options.retryDelaysMs.length > 0
      ? [...options.retryDelaysMs]
      : [...DEFAULT_RETRY_DELAYS_MS];
  const schedule = options.scheduler ?? defaultScheduler;

  const health = new Map<string, OidcProviderHealth>(
    configs.map((c) => [
      c.providerId,
      { provider_id: c.providerId, status: "initializing" },
    ]),
  );
  const pending = new Set<{ cancel: () => void }>();
  let stopped = false;

  /** The array better-auth holds as its live provider list. A provider
   *  that recovers is unshifted into this exact reference, which is what
   *  makes recovery visible to a request already in flight without
   *  rebuilding the auth instance. */
  let live: unknown[] | null = null;

  /**
   * Initialize one provider in isolation. The context handed to the
   * library delegates every read to the real one but shadows the
   * social-provider list with an empty array, so whatever comes back is
   * exactly this provider and nothing else.
   */
  async function initOne(
    config: OidcProviderConfig,
    ctx: InitContextLike,
  ): Promise<unknown> {
    const plugin = genericOAuth({
      config: [
        {
          providerId: config.providerId,
          clientId: config.clientId,
          clientSecret: config.clientSecret,
          discoveryUrl: config.discoveryUrl,
          scopes: config.scopes ?? ["openid", "email", "profile"],
        },
      ],
    }) as unknown as PluginLike;

    const isolated = Object.create(ctx, {
      socialProviders: { value: [], enumerable: true },
    }) as InitContextLike;

    const result = await plugin.init(isolated);
    const produced = result.context?.socialProviders ?? [];
    return produced[0] ?? null;
  }

  function scheduleRetry(config: OidcProviderConfig, ctx: InitContextLike) {
    if (stopped) return;
    const state = health.get(config.providerId);
    const attempts = state?.attempts ?? 1;
    const delay =
      retryDelays[Math.min(attempts - 1, retryDelays.length - 1)] ??
      STEADY_RETRY_DELAY_MS;

    const timer = schedule(() => {
      pending.delete(timer);
      void attempt(config, ctx);
    }, delay);
    pending.add(timer);
  }

  async function attempt(config: OidcProviderConfig, ctx: InitContextLike) {
    if (stopped) return;
    try {
      const provider = await initOne(config, ctx);
      if (!provider)
        throw new Error("provider initialization produced nothing");
      health.set(config.providerId, {
        provider_id: config.providerId,
        status: "ok",
      });
      // Ahead of the built-in providers, matching the order the library
      // itself builds when every provider answers.
      live?.unshift(provider);
      log("info", "identity provider recovered", {
        provider_id: config.providerId,
      });
    } catch (err) {
      const previous = health.get(config.providerId);
      const attempts = (previous?.attempts ?? 0) + 1;
      health.set(config.providerId, {
        provider_id: config.providerId,
        status: "unavailable",
        error: describe(err),
        unavailable_since:
          previous?.unavailable_since ?? new Date().toISOString(),
        attempts,
      });
      log(
        "error",
        "identity provider unavailable, sign-in via it is degraded",
        {
          provider_id: config.providerId,
          error: describe(err),
          attempts,
          note: "the server keeps running and retries; other sign-in methods are unaffected",
        },
      );
      scheduleRetry(config, ctx);
    }
  }

  const plugin = {
    id: "generic-oauth",
    init: async (ctx: InitContextLike) => {
      const ready: unknown[] = [];
      for (const config of configs) {
        try {
          const provider = await initOne(config, ctx);
          if (!provider) {
            throw new Error("provider initialization produced nothing");
          }
          ready.push(provider);
          health.set(config.providerId, {
            provider_id: config.providerId,
            status: "ok",
          });
        } catch (err) {
          const attempts = 1;
          health.set(config.providerId, {
            provider_id: config.providerId,
            status: "unavailable",
            error: describe(err),
            unavailable_since: new Date().toISOString(),
            attempts,
          });
          log(
            "error",
            "identity provider unavailable, sign-in via it is degraded",
            {
              provider_id: config.providerId,
              error: describe(err),
              attempts,
              note: "the server keeps running and retries; other sign-in methods are unaffected",
            },
          );
          scheduleRetry(config, ctx);
        }
      }
      live = [...ready, ...ctx.socialProviders];
      return { context: { socialProviders: live } };
    },
  };

  return {
    // The library types `init`'s context against its full auth context;
    // this plugin only reads the social-provider list off it, so the
    // narrow shape above is deliberate and the cast is the seam.
    plugin: plugin as unknown as BetterAuthPlugin,
    snapshot: () =>
      configs.map(
        (c) =>
          health.get(c.providerId) ?? {
            provider_id: c.providerId,
            status: "initializing" as const,
          },
      ),
    statusOf: (providerId: string) => health.get(providerId),
    stop: () => {
      stopped = true;
      for (const timer of pending) timer.cancel();
      pending.clear();
    },
  };
}
