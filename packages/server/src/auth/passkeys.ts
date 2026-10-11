import { credentialRequest } from "./credential-adapter.js";
import { passkey } from "@better-auth/passkey";
import { APIError, createAuthMiddleware } from "better-auth/api";
import type { Storage } from "../storage/interface.js";

export const PASSKEY_SIGN_IN_PATHS = new Set([
  "/passkey/generate-authenticate-options",
  "/passkey/verify-authentication",
]);
export const PASSKEY_OWNER_PATHS = new Set([
  "/passkey/generate-register-options",
  "/passkey/verify-registration",
  "/passkey/list-user-passkeys",
  "/passkey/delete-passkey",
]);
export const PASSKEY_VERIFY_PATHS = new Set([
  "/passkey/verify-registration",
  "/passkey/verify-authentication",
]);

/** The configured origin, not a caller's header, is the WebAuthn relying party. */
export function buildPasskeyPlugin(
  baseURL: string,
  storage: Storage,
): ReturnType<typeof passkey> &
  Pick<import("better-auth").BetterAuthPlugin, "hooks"> {
  const url = new URL(baseURL);
  const plugin = passkey({
    rpID: url.hostname,
    rpName: "Marfa",
    origin: url.origin,
    authenticatorSelection: {
      residentKey: "required",
      userVerification: "required",
    },
    registration: {
      requireSession: true,
      afterVerification: async ({ ctx, verification, user }) => {
        const registration = verification.registrationInfo;
        requireVerified(registration?.userVerified === true);
        requireVerified(
          await verifiedPhase(
            async () => (await storage.owner?.find())?.id === user.id,
          ),
        );
        const duplicate = await verifiedPhase(
          async () =>
            !!(await ctx.context.adapter.findOne({
              model: "passkey",
              where: [
                { field: "credentialID", value: registration.credential.id },
              ],
            })),
        );
        if (duplicate)
          throw new APIError("CONFLICT", {
            message: "This passkey is already registered.",
          });
      },
    },
    authentication: {
      afterVerification: async ({ ctx, verification, clientData }) => {
        requireVerified(verification.authenticationInfo.userVerified);
        requireVerified(
          await verifiedPhase(async () => {
            // The phase holds the writer from challenge consumption through
            // session creation, so removal cannot race this credential's use.
            storage.assertInWriteTransaction();
            const credential = await ctx.context.adapter.findOne<{
              userId: string;
            }>({
              model: "passkey",
              where: [{ field: "credentialID", value: clientData.id }],
            });
            return (
              !!credential &&
              (await storage.owner?.find())?.id === credential.userId
            );
          }),
        );
      },
    },
  });
  return {
    ...plugin,
    hooks: {
      before: [
        {
          matcher: (ctx) => ctx.path?.startsWith("/passkey/") === true,
          handler: createAuthMiddleware((ctx) => {
            if (credentialRequest.getStore()?.path !== ctx.path)
              throw new APIError("FORBIDDEN", {
                message: "Use the passkey browser endpoints.",
              });
            return Promise.resolve();
          }),
        },
      ],
    },
  };
}

function requireVerified(valid: boolean): asserts valid {
  if (!valid)
    throw new APIError("UNAUTHORIZED", {
      message: "Verify the owner with your passkey provider to continue.",
    });
}
function verifiedPhase(work: () => Promise<boolean>): Promise<boolean> {
  const phase = credentialRequest.getStore()?.phase;
  if (!phase)
    throw new APIError("FORBIDDEN", {
      message: "Use the passkey browser endpoints.",
    });
  return phase.run(false, work);
}
