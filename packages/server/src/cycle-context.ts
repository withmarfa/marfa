import { AsyncLocalStorage } from "node:async_hooks";

/**
 * T-144: request-scoped cycle metadata propagation.
 *
 * Mirrors the shape T-025 introduced for tenant context (see
 * `storage/pg/request-context.ts`): a single `AsyncLocalStorage` set by
 * `cycleMiddleware` at request entry and read by `publish` / `publishEdge`
 * in `pubsub.ts`, so route handlers don't have to spread
 * `...c.var.cycle` into every publish call.
 *
 * Lives at the top of `src/` (not under `middleware/`) because both the
 * middleware and `pubsub.ts` consume it, and `pubsub.ts` isn't
 * middleware-tier.
 *
 * The contract for cycle metadata itself — `null` originator + hop 0 is
 * the human sentinel that bypasses the budget, a connector chain head is
 * `{ <connection_id>, 0 }`, mid-chain is `{ <head>, parent + 1 }` — is
 * unchanged from T-039. The ALS just removes the manual threading.
 */
export interface CycleRequestContext {
  originatingConnectionId: string | null;
  hopCount: number;
}

export const cycleRequestContext = new AsyncLocalStorage<CycleRequestContext>();
