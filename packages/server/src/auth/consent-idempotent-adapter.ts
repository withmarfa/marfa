/**
 * The @better-auth/oauth-provider plugin's consent endpoint resolves a
 * prior grant via `findOne` and only falls back to `create` when none is
 * found — but that lookup keys on `(clientId, userId, referenceId)`, and
 * the underlying drizzle `create` is an unconditional INSERT with no
 * unique constraint to back it. A consent for the same `(clientId, userId)`
 * pair with a different (or newly-resolved) `referenceId` therefore slips
 * past the plugin's dedup and inserts a second row, leaving duplicate
 * consent records for one user-client relationship.
 *
 * This wrapper makes the adapter's `create` on the `oauthConsent` model
 * idempotent on `(clientId, userId)` — the same pair the unique constraint
 * enforces. An existing row is updated in place (refreshing scopes +
 * updatedAt + referenceId, matching what the plugin would write) instead
 * of inserting a duplicate; a missing row falls through to the real
 * create. Every other model and method delegates untouched.
 *
 * The wrapper and the `auth_oauth_consent (client_id, user_id)` unique
 * constraint are load-bearing together: the constraint alone would make
 * the plugin's `create` throw on re-consent, and the idempotent write
 * alone leaves the door open to a concurrent double-insert. Both ship in
 * the same change.
 */

/** The model name Better Auth maps to `auth_oauth_consent`. Set in the
 *  schema map passed to `drizzleAdapter` in `instance.ts`. */
const OAUTH_CONSENT_MODEL = "oauthConsent";

/** Minimal structural view of the Better Auth `DBAdapter` surface this
 *  wrapper needs. The full type lives in `@better-auth/core` and drags in
 *  generic machinery we don't need here; we only intercept `create` and
 *  call through to `findOne` / `update`, delegating everything else. */
interface ConsentAdapterSurface {
  create: (data: {
    model: string;
    data: Record<string, unknown>;
    select?: string[];
    forceAllowId?: boolean;
  }) => Promise<unknown>;
  findOne: (data: {
    model: string;
    where: { field: string; value: unknown; operator?: string }[];
    select?: string[];
  }) => Promise<unknown>;
  update: (data: {
    model: string;
    where: { field: string; value: unknown; operator?: string }[];
    update: Record<string, unknown>;
  }) => Promise<unknown>;
}

/** A prior consent row, reduced to the field the update path needs. */
interface ExistingConsent {
  id: string;
}

/**
 * Wrap the factory returned by `drizzleAdapter(...)` so the adapter it
 * produces turns a `create` on the `oauthConsent` model into a
 * find-then-update-or-create on `(clientId, userId)`. The factory shape
 * (`(options) => adapter`) and the adapter's method surface are preserved
 * exactly — Better Auth never sees the wrapper.
 *
 * Typed against `Factory` (the caller passes the concrete
 * `drizzleAdapter` return type) so the wrapped factory stays
 * assignable to better-auth's `database` option without a cast at the
 * call site.
 */
export function withIdempotentConsent<
  Factory extends (options: never) => unknown,
>(factory: Factory): Factory {
  const wrapped = ((options: never) => {
    const adapter = factory(options) as ConsentAdapterSurface;

    const create: ConsentAdapterSurface["create"] = async (args) => {
      if (args.model !== OAUTH_CONSENT_MODEL) {
        return adapter.create(args);
      }

      const clientId = args.data.clientId;
      const userId = args.data.userId;

      // Defensive: if the plugin ever omits either key we can't dedup
      // safely, so fall through to the plain create rather than match
      // the wrong row.
      if (clientId == null || userId == null) {
        return adapter.create(args);
      }

      const existing = (await adapter.findOne({
        model: OAUTH_CONSENT_MODEL,
        where: [
          { field: "clientId", value: clientId },
          { field: "userId", value: userId },
        ],
        select: ["id"],
      })) as ExistingConsent | null;

      if (!existing) {
        return adapter.create(args);
      }

      // Refresh the grant in place. Mirror the fields the plugin's own
      // re-consent update writes (scopes + updatedAt) and additionally
      // re-stamp referenceId so a tenant binding resolved on this consent
      // supersedes whatever the prior row held — the row is the single
      // record for this `(clientId, userId)` pair.
      const update: Record<string, unknown> = {
        scopes: args.data.scopes,
        updatedAt: args.data.updatedAt ?? new Date(),
      };
      if ("referenceId" in args.data) {
        update.referenceId = args.data.referenceId;
      }

      await adapter.update({
        model: OAUTH_CONSENT_MODEL,
        where: [{ field: "id", value: existing.id }],
        update,
      });

      // The plugin ignores `create`'s return value on the consent path,
      // but return a consistent shape (the refreshed row's identity) so
      // the wrapper is a faithful create stand-in.
      return { ...args.data, id: existing.id };
    };

    return { ...adapter, create };
  }) as Factory;

  return wrapped;
}
