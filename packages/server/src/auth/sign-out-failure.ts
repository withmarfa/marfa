import { AsyncLocalStorage } from "node:async_hooks";

interface SignOutOutcome {
  active: boolean;
  failure?: { error: unknown };
}
const signOutOutcome = new AsyncLocalStorage<SignOutOutcome>();

/** Better Auth catches session lookup and deletion errors before clearing cookies. */
export async function requireSuccessfulSignOut(
  work: () => Promise<Response>,
): Promise<Response> {
  const outcome: SignOutOutcome = { active: true };
  return signOutOutcome.run(outcome, async () => {
    try {
      const response = await work();
      if (outcome.failure) throw outcome.failure.error;
      return response;
    } catch (error) {
      throw outcome.failure ? outcome.failure.error : error;
    } finally {
      outcome.active = false;
    }
  });
}

type SessionOperation = (args: {
  model: string;
  where: unknown[];
}) => Promise<unknown>;
type SessionAdapter = Record<
  "delete" | "findOne" | "findMany",
  SessionOperation
>;

/** Retain the first failure even if the provider continues with later operations. */
export function withSignOutFailureReporting<
  Factory extends (options: never) => unknown,
>(factory: Factory): Factory {
  return ((options: never) => {
    const adapter = factory(options) as SessionAdapter;
    const wrapped = { ...adapter };
    for (const operation of ["findOne", "findMany", "delete"] as const) {
      wrapped[operation] = async (args) => {
        const outcome = signOutOutcome.getStore();
        try {
          return await adapter[operation](args);
        } catch (error) {
          if (args.model === "session" && outcome?.active)
            outcome.failure ??= { error };
          throw error;
        }
      };
    }
    return wrapped;
  }) as Factory;
}
