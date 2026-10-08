/**
 * The scopes that carry a session rather than data: `openid` mints the
 * id_token a sign-out needs, `offline_access` the refresh token a client
 * needs to stay signed in without asking again.
 *
 * They belong in every registered ceiling because they reach no user
 * content — a consent screen shows nothing for them — while their absence
 * is unrecoverable. A client cannot amend its own registration, so a
 * ceiling minted without them refuses the client's first authorize for a
 * literal it was never told to name, and a CLI persists its `client_id`,
 * so the refusal survives every retry. The allowlist the plugin registers
 * every client against carries both (`buildAllowedScopes`).
 *
 * Also the set the authorize hook refuses to narrow away, so a request for
 * one is answered rather than silently dropped: `oauth-provider.ts`.
 *
 * A ceiling is read in two places and must mean the same thing in both.
 * Admitting the session scopes at the point of READING one is tempting,
 * because it would repair a client whose ceiling was minted without them.
 * It does not work: on the authorize path the plugin re-validates the
 * narrowed request against that same stored ceiling, so a scope this side
 * waved through is refused a moment later, and the refusal then names
 * `openid` instead of whatever the client actually over-asked for. A worse
 * error than the one it set out to prevent. So the rule lives at the mint,
 * where it is enforceable, and both readers stay a plain membership test
 * against what the row says.
 */
export const SESSION_CRITICAL_SCOPES: readonly string[] = [
  "openid",
  "offline_access",
];
