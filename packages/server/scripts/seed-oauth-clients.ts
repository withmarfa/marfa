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
 *   DATABASE_URL=<direct pg url> pnpm exec tsx scripts/seed-oauth-clients.ts
 *
 * Idempotent: a client that already exists is reported and skipped.
 */
import { createPgStorage } from "../src/storage/pg/index.js";
import { buildAllowedScopes } from "../src/auth/oauth-provider.js";

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
    clientId: "marfa-web",
    name: "Marfa Web",
    origins: ["https://app.marfa.so", "http://localhost:5173"],
  },
  {
    clientId: "marfa-tickets",
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

  // First-party clients can request the full Marfa scope grammar; the consent
  // screen is where the user narrows. A requested scope must fall within the
  // client's registered set, so seeding the full ceiling keeps whatever
  // default-on bundle the app asks for in range.
  const scopes = buildAllowedScopes();

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
    if (await oauth.clientExists(client.clientId)) {
      existed += 1;
      console.log(`exists     ${client.clientId}`);
      continue;
    }
    await oauth.createClient({
      clientId: client.clientId,
      name: client.name,
      isPublic: true,
      grantTypes: ["authorization_code", "refresh_token"],
      responseTypes: ["code"],
      tokenEndpointAuthMethod: "none",
      scopes,
      redirectUris: client.origins.map((o) => `${o}/auth/callback`),
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
