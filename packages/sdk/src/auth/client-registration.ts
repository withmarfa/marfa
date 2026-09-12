/**
 * Dynamic client registration, and the rule for when a stored registration
 * can no longer carry a sign-in.
 *
 * **Why this is in the SDK rather than in each tool.** It was written three
 * times — once in the CLI, once in the Raycast extension, once in `sync` — and
 * the copies drifted. The CLI learned to repair a client the server had
 * forgotten; the extension never did, so a database reset on the server left
 * it presenting a dead id forever with no route back but a reinstall. The
 * copies also disagreed about the ceiling rule below, which is the same
 * question asked twice and answered differently. One implementation is the
 * only thing that stops that happening again.
 *
 * A registered client lives only in the server's database. Nothing can
 * recreate one it has lost, because the id was the server's to mint — so
 * recovery is always the client registering afresh, and the whole job of this
 * module is noticing that it must.
 */
import { isSpacePermission } from "@withmarfa/shared";
import { OAuthError, type OAuthErrorCode } from "./errors.js";
import { discoverEndpoints, type Endpoints } from "./discovery.js";

/** The device-authorization grant, spelled as the wire requires. */
export const DEVICE_CODE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

/**
 * Bumped to invalidate every stored registration in the estate at once.
 *
 * **This exists because one failure is invisible to every other check here.**
 * A stored record whose claim covers the request, against a client row the
 * server has lost, is indistinguishable from a healthy one: the record is
 * well-formed, and the only surface that would report the loss is a browser
 * redirect to an error page, which a token refresh never reaches. No predicate
 * over scopes can see it.
 *
 * Raising this number makes every record written under an older one unusable
 * regardless of content, so every install heals on its next sign-in without
 * anybody reinstalling anything. The cost is one abandoned client row per user
 * per tool, paid once, and no client can revoke one — so it is pulled for a
 * server-side loss of the client table and nothing smaller.
 *
 * 2: the hosted instance moved to an empty database on 12 September 2026 and
 * every dynamically registered client was lost with the old one.
 */
export const CLIENT_REGISTRATION_EPOCH = 2;

/**
 * A dynamically registered client, as stored.
 *
 * `claimedScope` is recorded because a ceiling is invisible from the client
 * side: the server freezes what a registration declared and never publishes it
 * back, so this is the only way to know what the stored client can carry.
 */
export interface StoredClientRegistration {
  clientId: string;
  /** Normalized issuer, so one store can hold several instances. */
  issuer: string;
  /** Space-delimited, exactly as sent. */
  claimedScope: string;
  /**
   * The epoch it was written under. A store maps a record that predates
   * epochs to 0 as it reads it, so this is always a number by the time any
   * rule here sees one.
   */
  epoch: number;
}

/**
 * Where a caller keeps its registrations.
 *
 * Issuer-keyed and typed rather than reusing `TokenStorage`, which is a flat
 * key-to-string map whose file-backed implementation ignores the key and
 * writes to one slot — it cannot hold a second value. These are different
 * contracts, not parallel ones.
 */
export interface ClientRegistrationStore {
  read(issuer: string): Promise<StoredClientRegistration | null>;
  write(record: StoredClientRegistration): Promise<void>;
  /**
   * Remove only the registration.
   *
   * **Never the tokens.** A dead client and a dead session are different
   * failures, and conflating them signs a working session out to fix a
   * registration.
   */
  clear(issuer: string): Promise<void>;
}

/** For tests, and for callers with nowhere to persist. */
export class InMemoryClientRegistrationStore implements ClientRegistrationStore {
  private readonly records = new Map<string, StoredClientRegistration>();

  read(issuer: string): Promise<StoredClientRegistration | null> {
    return Promise.resolve(this.records.get(issuer) ?? null);
  }

  write(record: StoredClientRegistration): Promise<void> {
    this.records.set(record.issuer, record);
    return Promise.resolve();
  }

  clear(issuer: string): Promise<void> {
    this.records.delete(issuer);
    return Promise.resolve();
  }
}

/**
 * What a client is, as opposed to what a particular sign-in wants.
 *
 * This is the only place the callers genuinely differ: the CLI is a
 * device-flow client with no real redirect to give, the Raycast extension an
 * authorization-code client with one.
 */
export interface ClientManifest {
  clientName: string;
  grantTypes: readonly string[];
  /**
   * Omit for a device-only client. The server requires these only for the
   * authorization-code grant.
   */
  redirectUris?: readonly string[];
  /** Defaults to "none". Every Marfa-registered client is public. */
  tokenEndpointAuthMethod?: "none";
}

export interface RegisterClientOptions {
  issuer: string;
  manifest: ClientManifest;
  /**
   * The ceiling to claim.
   *
   * **Not optional, and omitting it fails quietly.** A registration naming
   * nothing takes the server's default bundle expansion as a permanent
   * ceiling, which never carries a space permission, and every later sign-in
   * is capped there with nothing on the wire saying so.
   */
  scopes: readonly string[];
  /** Pre-resolved endpoints, when the caller has already discovered. */
  endpoints?: Endpoints;
  /** An explicit endpoint, when the caller owns its own discovery. */
  registrationEndpoint?: string;
  fetch?: typeof globalThis.fetch;
}

/** Why the resolved client id is the one it is. */
export type ClientOrigin = "pinned" | "stored" | "registered";

export interface ResolvedClient {
  clientId: string;
  claimedScope: string;
  origin: ClientOrigin;
}

export interface ResolveClientOptions extends RegisterClientOptions {
  store: ClientRegistrationStore;
  /**
   * An operator-supplied id. Returned as it stands, never persisted and never
   * repaired: whoever set it owns its lifecycle.
   */
  pinnedClientId?: string;
  /**
   * False when `scopes` is the caller's own fallback list rather than the
   * instance's advertisement.
   *
   * **A scope set the client invented is evidence about nothing**, least of
   * all about a ceiling. Deciding from one would re-register on every sign-in
   * a flapping discovery endpoint produced, in both directions, each pass
   * abandoning the client the last one minted.
   */
  scopesAreAuthoritative: boolean;
}

/**
 * Which scopes of `needed` a registration claiming `claimed` does not hold.
 *
 * Exact membership, because the server compares its stored ceiling exactly —
 * its check is a plain set membership test, so treating a wildcard here as
 * covering a literal beneath it would disagree with the surface that decides.
 * Do not "improve" this to use the grant-coverage helper.
 *
 * The uncovered list rather than a yes or no, because what to do about a gap
 * depends on which scopes are in it: the server repairs some itself and
 * refuses to repair others.
 */
export function uncoveredScopes(
  claimed: string,
  needed: readonly string[],
): string[] {
  const held = new Set(claimed.split(/\s+/).filter(Boolean));
  return needed.filter((scope) => scope && !held.has(scope));
}

/**
 * Whether the stored record cannot carry this sign-in and must be replaced.
 *
 * Four things make it true, and each is a different kind of not knowing.
 *
 * **No stored record**, which needs no explanation.
 *
 * **A record from an older epoch.** See {@link CLIENT_REGISTRATION_EPOCH}.
 *
 * **No recorded claim.** A build that did not write one down left an id whose
 * ceiling could be anything, and there is no route to ask the server what it
 * is. The one guess that is never wrong registers again.
 *
 * **A space permission among the uncovered scopes.** That family is excluded
 * from the server's ceiling catch-up deliberately, since admitting it would
 * let an unauthenticated request write an administrative permission into a
 * stored registration. It is therefore the only family a client must register
 * again to obtain; a gap holding nothing else is one the next authorize closes
 * on its own, and registering for it would mint an abandoned row every time an
 * operator widens a bundle.
 */
export function registrationIsStale(input: {
  stored: StoredClientRegistration | null;
  scopes: readonly string[];
  scopesAreAuthoritative: boolean;
}): boolean {
  const { stored } = input;
  if (!stored?.clientId) return true;
  if (stored.epoch < CLIENT_REGISTRATION_EPOCH) return true;
  if (!input.scopesAreAuthoritative) return false;
  if (!stored.claimedScope) return true;
  return uncoveredScopes(stored.claimedScope, input.scopes).some(
    isSpacePermission,
  );
}

/**
 * Whether registering again could produce a different id at all.
 *
 * The guard on any repair, and a question about provenance rather than about
 * scopes: a pinned id belongs to whoever set it, and one minted moments ago is
 * already the freshest answer the server will give.
 */
export function repairCanHelp(origin: ClientOrigin): boolean {
  return origin === "stored";
}

interface WireError {
  error?: unknown;
  error_description?: unknown;
}

/**
 * Build an `OAuthError` from a token, registration or device response.
 *
 * Handles both shapes Marfa emits — the flat RFC 6749 `{error}` and the
 * structured `{error:{code}}` the device routes return — because the SDK
 * previously had two readers that disagreed about the second, so the code a
 * caller saw depended on which surface had refused it.
 */
export function oauthErrorFrom(status: number, body: unknown): OAuthError {
  const wire = (body ?? {}) as WireError;
  const raw = wire.error;
  const code =
    typeof raw === "string"
      ? raw
      : typeof raw === "object" && raw !== null
        ? (raw as { code?: unknown }).code
        : undefined;
  const description =
    typeof wire.error_description === "string"
      ? wire.error_description
      : typeof raw === "object" && raw !== null
        ? (raw as { message?: unknown }).message
        : undefined;
  return new OAuthError(
    (typeof code === "string" ? code : "server_error") as OAuthErrorCode,
    typeof description === "string" && description
      ? description
      : `OAuth request failed (HTTP ${String(status)})`,
    status,
  );
}

function hasCode(err: unknown, code: OAuthErrorCode): boolean {
  // **Duck-typed rather than `instanceof`, deliberately.** Two copies of the
  // SDK in one tree, a bundler emitting the error class twice, or a test
  // substituting its own all break identity while leaving the value correct —
  // and the repair that hangs off this check would then silently never fire.
  if (err instanceof OAuthError) return err.code === code;
  if (typeof err !== "object" || err === null) return false;
  const candidate = err as { name?: unknown; code?: unknown };
  return candidate.name === "OAuthError" && candidate.code === code;
}

/** The client id is gone server-side, whichever surface reported it. */
export function isDeadClientError(err: unknown): boolean {
  return hasCode(err, "invalid_client");
}

/**
 * A refusal for asking above the frozen ceiling.
 *
 * Only the device-authorization endpoint produces this: the authorize endpoint
 * narrows silently instead, which is why an authorization-code client has to
 * compare proactively rather than wait to be told.
 */
export function isStaleCeilingError(err: unknown): boolean {
  return hasCode(err, "invalid_scope");
}

interface RegistrationResponse {
  client_id?: unknown;
}

/**
 * Register a client, per RFC 7591.
 *
 * Throws `OAuthError`. `invalid_client_metadata` and `invalid_redirect_uri`
 * mean the server refused the manifest and minted nothing, so a caller holding
 * a working registration must keep it: a narrow live client beats none.
 */
export async function registerClient(
  options: RegisterClientOptions,
): Promise<StoredClientRegistration> {
  const doFetch = options.fetch ?? globalThis.fetch;
  const endpoint =
    options.registrationEndpoint ??
    options.endpoints?.as.registration_endpoint ??
    (await discoverEndpoints(options.issuer, doFetch)).as.registration_endpoint;
  if (typeof endpoint !== "string" || !endpoint) {
    throw new OAuthError(
      "server_error",
      "This Marfa instance does not advertise a client registration endpoint.",
    );
  }

  const claimedScope = options.scopes.filter(Boolean).join(" ");
  const manifest = options.manifest;
  const body: Record<string, unknown> = {
    client_name: manifest.clientName,
    grant_types: [...manifest.grantTypes],
    token_endpoint_auth_method: manifest.tokenEndpointAuthMethod ?? "none",
    scope: claimedScope,
  };
  if (manifest.redirectUris?.length) {
    body.redirect_uris = [...manifest.redirectUris];
    body.response_types = ["code"];
  }

  let res: Response;
  try {
    res = await doFetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (cause) {
    throw new OAuthError(
      "server_error",
      `Could not reach the client registration endpoint: ${String(cause)}`,
    );
  }

  const parsed: unknown = await res.json().catch(() => ({}));
  if (!res.ok) throw oauthErrorFrom(res.status, parsed);

  const clientId = (parsed as RegistrationResponse).client_id;
  if (typeof clientId !== "string" || !clientId) {
    throw new OAuthError(
      "server_error",
      "Client registration succeeded but returned no client_id.",
      res.status,
    );
  }
  return {
    clientId,
    issuer: options.issuer,
    claimedScope,
    epoch: CLIENT_REGISTRATION_EPOCH,
  };
}

/**
 * The client id for this issuer, registering one when the stored record cannot
 * carry what this sign-in is about to ask for.
 *
 * Nothing is written until the server has answered, so a registration that
 * fails leaves a working client exactly where it was.
 */
export async function resolveClient(
  options: ResolveClientOptions,
): Promise<ResolvedClient> {
  if (options.pinnedClientId) {
    return {
      clientId: options.pinnedClientId,
      claimedScope: options.scopes.join(" "),
      origin: "pinned",
    };
  }

  const stored = await options.store.read(options.issuer);
  if (
    stored &&
    !registrationIsStale({
      stored,
      scopes: options.scopes,
      scopesAreAuthoritative: options.scopesAreAuthoritative,
    })
  ) {
    return {
      clientId: stored.clientId,
      claimedScope: stored.claimedScope,
      origin: "stored",
    };
  }

  const registered = await registerClient(options);
  await options.store.write(registered);
  return {
    clientId: registered.clientId,
    claimedScope: registered.claimedScope,
    origin: "registered",
  };
}

/**
 * Run something with a client, repairing a dead registration once.
 *
 * **Only for a flow whose whole operation is a single unattended request.**
 * The CLI's device-authorization request qualifies: it has not yet printed a
 * code or asked the person anything, so repeating it costs nothing. An
 * authorization-code flow does not, because the retry would open a second
 * browser window — those callers use {@link isDeadClientError},
 * {@link repairCanHelp} and the store directly, and repair on the next launch
 * rather than inside this one.
 *
 * The single-repair cap lives here rather than in caller discipline: a caller
 * that loops mints an abandoned client row per attempt, and nothing the client
 * can call revokes one.
 */
export async function withClientRepair<T>(
  options: ResolveClientOptions & {
    /**
     * Codes worth repairing beyond `invalid_client`. The CLI passes
     * `invalid_scope`, because the device endpoint refuses on a stale ceiling
     * where the authorize endpoint would narrow silently.
     */
    alsoRepairOn?: readonly OAuthErrorCode[];
    onRepair?: (reason: OAuthErrorCode) => void;
  },
  run: (client: ResolvedClient) => Promise<T>,
): Promise<T> {
  const repairable = new Set<OAuthErrorCode>([
    "invalid_client",
    ...(options.alsoRepairOn ?? []),
  ]);

  const client = await resolveClient(options);
  try {
    return await run(client);
  } catch (err) {
    const reason = [...repairable].find((code) => hasCode(err, code));
    if (!reason || !repairCanHelp(client.origin)) throw err;

    options.onRepair?.(reason);
    // Only the registration. The session, if there is one, is not what failed.
    await options.store.clear(options.issuer);
    const repaired = await resolveClient(options);
    return await run(repaired);
  }
}
