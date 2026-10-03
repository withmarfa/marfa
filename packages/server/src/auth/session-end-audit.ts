import type { BetterAuthOptions, BetterAuthPlugin } from "better-auth";
import { afterCommit } from "../storage/commit-hooks.js";
import { log } from "../middleware/logger.js";
import type { Storage } from "../storage/interface.js";
import {
  CredentialPersistencePhase,
  credentialRequest,
} from "./credential-adapter.js";

/** Prepare the provider's notification plan after its local revocation work. */
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
    if (!result || !hooks || !deletion?.before || !deletion.after)
      throw new Error("OAuth provider session lifecycle hooks are required");
    const before = deletion.before;
    const after = deletion.after;
    const databaseHooks: BetterAuthOptions["databaseHooks"] = {
      ...hooks,
      session: {
        ...hooks.session,
        delete: {
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
            return request.phase.run(true, async () => {
              const adapter = hookContext.context.adapter;
              const revoked = new Date();
              await adapter.updateMany({
                model: "oauthAccessToken",
                where: [
                  { field: "sessionId", value: session.id },
                  { field: "revoked", value: null },
                ],
                update: { revoked },
              });
              const tokens = await adapter.findMany<{
                id: string;
                scopes?: string[];
              }>({
                model: "oauthRefreshToken",
                where: [
                  { field: "sessionId", value: session.id },
                  { field: "revoked", value: null },
                ],
              });
              const ids = tokens
                .filter((token) => !token.scopes?.includes("offline_access"))
                .map((token) => token.id);
              if (ids.length)
                await adapter.updateMany({
                  model: "oauthRefreshToken",
                  where: [{ field: "id", operator: "in", value: ids }],
                  update: { revoked },
                });
              // The provider retains targets from session-linked rows, but its
              // revocation arrays are empty after these same-session writes.
              return before(session, hookContext);
            });
          },
          after: async (session, hookContext) => {
            const request = credentialRequest.getStore();
            const enqueue = () => {
              afterCommit(() => {
                credentialRequest.exit(() => {
                  const notification = Promise.resolve(
                    after(session, hookContext),
                  )
                    .then(() => undefined)
                    .catch((error: unknown) => {
                      log("error", "Session logout notification failed", {
                        error:
                          error instanceof Error
                            ? error.message
                            : String(error),
                      });
                    });
                  request?.notifications.add(notification);
                });
              });
              return Promise.resolve();
            };
            if (request?.phase) await request.phase.run(false, enqueue);
            else await enqueue();
          },
        },
      },
    };
    return { ...result, options: { ...result.options, databaseHooks } };
  };
  return { ...plugin, init };
}
