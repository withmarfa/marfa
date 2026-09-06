/**
 * Seed the fixed, first-party OAuth clients (`marfa-web`, `marfa-tickets`)
 * directly into `auth_oauth_client`.
 *
 * The hosted browser apps use a STABLE `client_id` rather than per-browser
 * dynamic client registration (DCR). A DCR client lives only in the database,
 * so a DB reset orphans every browser's cached client and sign-in then fails
 * with `invalid_client`. A fixed, pre-seeded client survives resets. The
 * @better-auth/oauth-provider plugin has no declarative trusted-client config,
 * so the supported path is to insert the rows — idempotently, so re-running
 * (after a future reset, or as a post-migrate deploy step) is safe.
 *
 * Usage (from packages/server, with the env's DIRECT Postgres URL — the same
 * one the migrator uses; the pooled URL can't run the bootstrap reads):
 *   DATABASE_URL=<direct pg url> pnpm exec tsx src/scripts/seed-oauth-clients.ts
 *
 * It also builds to `dist/seed-oauth-clients.js`, the same way the migrator
 * does, because a managed database only accepts connections from inside its
 * own network: the deployment host is the only place this can run, and there
 * it has an image rather than a checkout.
 *
 * Idempotent: a client that already exists is reported and skipped.
 */
import { createPgStorage } from "../storage/pg/index.js";
import {
  MARFA_TICKETS_CLIENT_ID,
  MARFA_WEB_CLIENT_ID,
} from "../auth/first-party-clients.js";

interface SeedClient {
  clientId: string;
  name: string;
  origins: string[];
}

// Redirect URIs are `${origin}/auth/callback` — the path every Marfa browser
// app posts back to. Each app's production origin plus the shared local dev
// origin (Vite on :5173) so the same fixed client works in development too.
const CLIENTS: SeedClient[] = [
  {
    clientId: MARFA_WEB_CLIENT_ID,
    name: "Marfa Web",
    origins: ["https://app.marfa.so", "http://localhost:5173"],
  },
  {
    clientId: MARFA_TICKETS_CLIENT_ID,
    name: "Marfa Tickets",
    origins: ["https://tickets.marfa.so", "http://localhost:5173"],
  },
];

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL is required (the env's direct Postgres URL).");
    process.exit(1);
  }

  const storage = await createPgStorage(databaseUrl, {
    authMode: "hosted",
    skipBootstrap: true,
  });
  const oauth = storage.oauthProvider;
  if (!oauth) {
    console.error("OAuth provider store unavailable (auth not configured).");
    process.exit(1);
  }

  let created = 0;
  let existed = 0;
  for (const client of CLIENTS) {
    // Both spellings. The plugin compares `post_logout_redirect_uri` against
    // this list with an exact string match, and the SDK sends the browser's
    // own `location.origin`, which never carries a trailing slash. Registering
    // only the slashed form meant every logout missed, fell off the end of the
    // plugin's handler, and returned an empty 200 that renders as a blank page
    // with the session already gone.
    const postLogoutRedirectUris = client.origins.flatMap((origin) => [
      origin,
      `${origin}/`,
    ]);
    if (await oauth.clientExists(client.clientId)) {
      await oauth.updateClientLogoutConfig(
        client.clientId,
        postLogoutRedirectUris,
      );
      existed += 1;
      console.log(`updated    ${client.clientId}`);
      continue;
    }
    await oauth.createClient({
      clientId: client.clientId,
      name: client.name,
      isPublic: true,
      grantTypes: ["authorization_code", "refresh_token"],
      responseTypes: ["code"],
      tokenEndpointAuthMethod: "none",
      // No ceiling. A first-party client is meant to be able to request the
      // whole Marfa scope grammar, and the consent screen is where the user
      // narrows. Writing the grammar out as an array expressed that intent
      // but did not achieve it: the array is a snapshot, the grammar is
      // rebuilt from the type registry on every boot, and nothing refreshes
      // the row — the idempotent branch below updates logout config only. A
      // stale snapshot then rejects scopes the platform advertises, which
      // took hosted sign-in down entirely. `null` is the same intent
      // expressed so that it stays true.
      scopes: null,
      redirectUris: client.origins.map((o) => `${o}/auth/callback`),
      postLogoutRedirectUris,
      referenceId: null,
    });
    created += 1;
    console.log(`created    ${client.clientId}`);
  }

  console.log(
    `\nDone: ${String(created)} created, ${String(existed)} already present.`,
  );
  process.exit(0);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
