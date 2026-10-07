import type { BetterAuthOptions, BetterAuthPlugin } from "better-auth";
import type { Storage } from "../storage/interface.js";
import {
  CredentialPersistencePhase,
  credentialRequest,
} from "./credential-adapter.js";

/** Run the provider's session-deletion hooks inside the credential phase, so a session's end and its audit commit together. */
export function withSessionEndAudit<T extends BetterAuthPlugin>(
  plugin: T,
  storage: Storage,
): T {
  const initialize = plugin.init;
  if (!initialize) throw new Error("OAuth provider initialization is required");
  const init: NonNullable<BetterAuthPlugin["init"]> = async (context) => {
    const result = await initialize(context);
    const hooks = result?.options?.databaseHooks;
    const deletion = hooks?.session?.delete;
    if (!result || !hooks || !deletion?.before)
      throw new Error("OAuth provider session lifecycle hooks are required");
    const before = deletion.before;
    const databaseHooks: BetterAuthOptions["databaseHooks"] = {
      ...hooks,
      session: {
        ...hooks.session,
        delete: {
          ...deletion,
          before: async (session, hookContext) => {
            if (!hookContext) return before(session, hookContext);
            const request = credentialRequest.getStore();
            if (!request?.active)
              throw new Error(
                "Session deletion requires an active credential scope",
              );
            request.phase ??= new CredentialPersistencePhase(
              storage,
              "auth.session.ended",
            );
            return request.phase.run(true, () => before(session, hookContext));
          },
        },
      },
    };
    return { ...result, options: { ...result.options, databaseHooks } };
  };
  return { ...plugin, init };
}
