import type { Storage } from "../storage/interface.js";

/**
 * **Which space a grant belongs to, asked in one place.**
 *
 * It is the instance's only space. `undefined` means no space could be
 * resolved: an instance holding anything other than exactly one.
 *
 * Every surface that decides a grant's space calls this, because the token's
 * `reference_id` and the `system.connection` projection have to name the same
 * bucket. `findGrantItemId` looks in exactly one, so a second copy of the
 * question that answered differently would leave a revoke finding nothing to
 * revoke and reporting success.
 *
 * **A module of its own because of who asks.** Five callers reach it, and one
 * of them is `auth/grant-lifecycle.ts`, which the provider imports in turn.
 * Living beside the provider made that pair a cycle: resolvable at runtime by
 * hoisting and by the order the two modules happen to initialize in, and
 * exactly the kind of edge that turns into an undefined import the day
 * somebody adds a top-level constant. A leaf with no imports of its own
 * cannot be one end of a cycle.
 *
 * Used by:
 *   - `clientReference`, at client registration, and the Marfa-owned DCR's
 *     own binding in `routes/oauth-register.ts`
 *   - `postLogin.consentReferenceId`, at token issuance
 *   - the two consents that write the projection: `projectGrantOnConsent`
 *     in `routes/auth-consent.ts` and `createUserAppGrant` in
 *     `routes/auth-pages.ts`, and the guard in front of each that refuses a
 *     grant with no space rather than writing one
 *   - `auditGrantReused` in `auth/grant-lifecycle.ts`, which looks the
 *     projection up
 *   - the security page's grant list and its form revoke, in
 *     `routes/auth-pages.ts`
 */
export async function resolveSpaceIdForAuthUser(
  storage: Storage,
): Promise<string | undefined> {
  // **The instance has one space.** A token with no space would be a
  // principal the storage layer applies no space predicate to, which is the
  // reach of the operator key handed to whatever app the person consented
  // to, so a grant binds to the one space or to nothing.
  //
  // Exactly one, or nothing. Two spaces is a state nothing here can choose
  // between, and issuing against a guess would bind the token to whichever
  // the store happened to return first. `soleSpaceId` is the bounded read of
  // that question; enumerating every space to answer it would put an
  // unbounded scan on a request path.
  return (await storage.spaces?.soleSpaceId()) ?? undefined;
}

/**
 * What a person is told when no space can be resolved for their grant.
 *
 * The one way of reaching it is named: an instance holding more than one
 * space, which leaves nothing that is unambiguously *the* space to grant in.
 */
export const NO_GRANT_SPACE_MESSAGE =
  "There is no space to grant this app access in. A server grants in the one space it holds, so a server holding more than one has nothing to attach the grant to.";
