import type { Storage } from "../storage/interface.js";

/**
 * **Which space a grant belongs to, asked in one place.**
 *
 * With a `users` store, hosted mode, it is the space on the consenting
 * person's row. Without one, keys mode, it is the instance's only space.
 * `undefined` means no space could be resolved: a person with no space yet,
 * or a keys-mode instance holding anything other than exactly one.
 *
 * Every surface that decides a grant's space calls this, because the token's
 * `reference_id` and the `system.connection` projection have to name the same
 * bucket. `findGrantItemId` looks in exactly one, so a second copy of the
 * question that answered differently would leave a revoke finding nothing to
 * revoke and reporting success. They agreed by accident until keys mode got a
 * space: hosted read the person's row on both sides, and keys mode had
 * nothing on either.
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
  authUserId: string,
): Promise<string | undefined> {
  if (storage.users) {
    const user = await storage.users.getByAuthUserId(authUserId);
    return user?.space_id ?? undefined;
  }
  // **No user store is keys mode, and keys mode has one space.** This used to
  // answer `undefined` there, on the reasoning that a self-host bound nothing
  // to a space so a token binding to none was the only shape available. That
  // stopped being true when keys mode got a space: a token with no space
  // becomes a principal the storage layer applies no space predicate to,
  // which is the reach of the operator key handed to whatever app the person
  // consented to.
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
 * Both ways of reaching it are named, because from inside the flow they are
 * indistinguishable and neither is the reader's fault: an account that has no
 * space of its own, and a self-hosted instance holding more than one, which
 * leaves nothing that is unambiguously *the* space to grant in. The old copy
 * said onboarding was incomplete, which is true of the first and simply wrong
 * about the second, and it sent a self-hoster looking for a step that does not
 * exist.
 */
export const NO_GRANT_SPACE_MESSAGE =
  "There is no space to grant this app access in. An account is given a space when it is created, and a self-hosted server grants in the one space it holds, so an account without a space, or a server holding more than one, has nothing to attach the grant to.";
