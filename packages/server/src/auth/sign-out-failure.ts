import { AsyncLocalStorage } from "node:async_hooks";

interface SignOutOutcome {
  failure?: { error: unknown };
}
const signOutOutcome = new AsyncLocalStorage<SignOutOutcome>();

/** Better Auth catches session deletion errors before clearing cookies. */
export async function requireSuccessfulSignOut(
  work: () => Promise<Response>,
): Promise<Response> {
  const outcome: SignOutOutcome = {};
  return signOutOutcome.run(outcome, async () => {
    const response = await work();
    if (outcome.failure) throw outcome.failure.error;
    return response;
  });
}

interface SessionDeleteAdapter {
  delete: (args: { model: string; where: unknown[] }) => Promise<unknown>;
}

/** Retain the deletion error until the handler can discard its success response. */
export function withSignOutFailureReporting<
  Factory extends (options: never) => unknown,
>(factory: Factory): Factory {
  return ((options: never) => {
    const adapter = factory(options) as SessionDeleteAdapter;
    return {
      ...adapter,
      delete: async (args: Parameters<SessionDeleteAdapter["delete"]>[0]) => {
        try {
          return await adapter.delete(args);
        } catch (error) {
          const outcome = signOutOutcome.getStore();
          if (args.model === "session" && outcome) outcome.failure = { error };
          throw error;
        }
      },
    };
  }) as Factory;
}
