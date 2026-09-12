/**
 * The fixed, first-party OAuth client the hosted browser app signs in
 * through. It is seeded rather than registered, so that a database reset does
 * not orphan every browser's cached client, and the grantless-client reaper
 * must never remove it: a dormant instance whose last web grant has been
 * retired and purged would otherwise lose sign-in itself, recoverable only by
 * re-running the seeder on the deployment host.
 *
 * There was a second, `marfa-tickets`, for a Tickets app that has since been
 * archived. It was removed rather than left in place because a client the
 * seeder re-creates on every deploy reads as live to whoever looks next.
 */
export const MARFA_WEB_CLIENT_ID = "marfa-web";
export const FIRST_PARTY_CLIENT_IDS: readonly string[] = [MARFA_WEB_CLIENT_ID];
