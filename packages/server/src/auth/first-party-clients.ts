/**
 * The fixed, first-party OAuth clients the hosted browser apps sign in
 * through. They are seeded rather than registered, so that a database reset
 * does not orphan every browser's cached client, and the grantless-client
 * reaper must never remove them: a dormant instance whose last web grant has
 * been retired and purged would otherwise lose sign-in itself, recoverable
 * only by re-running the seeder on the deployment host.
 */
export const MARFA_WEB_CLIENT_ID = "marfa-web";
export const MARFA_TICKETS_CLIENT_ID = "marfa-tickets";
export const FIRST_PARTY_CLIENT_IDS: readonly string[] = [
  MARFA_WEB_CLIENT_ID,
  MARFA_TICKETS_CLIENT_ID,
];
