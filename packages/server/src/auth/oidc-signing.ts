// T-090: OIDC ID Token signing.
//
// Generates and persists a single RS256 keypair the first time the server
// boots against a given storage; subsequent boots re-import the persisted
// JWK pair. The public half is served from /.well-known/jwks.json so
// strict OIDC relying parties can verify `id_token` claims against the
// platform JWKS without needing a shared secret.
//
// The private JWK lives in the `settings` table (key
// `oidc.signing.keypair`) — same KV the bootstrap-admin sentinel uses.
// Persisting in DB rather than env keeps single-host self-hosts working
// out of the box, and lets multi-instance deployments rotate keys by
// updating one row.

import { generateKeyPair, exportJWK, importJWK, SignJWT } from "jose";
import type { JWK, CryptoKey, KeyObject } from "jose";

type SigningKey = CryptoKey | KeyObject | Uint8Array;
import { randomUUID } from "node:crypto";
import type { Storage } from "../storage/interface.js";

const SIGNING_KEY_SETTINGS_KEY = "oidc.signing.keypair";
const SIGNING_ALG = "RS256";
const ID_TOKEN_TTL_SECONDS = 3600;

interface PersistedKeypair {
  kid: string;
  alg: typeof SIGNING_ALG;
  privateJwk: JWK;
  publicJwk: JWK;
}

/** Subset of OIDC Core claims we issue today. */
export interface IdTokenClaims {
  iss: string;
  sub: string;
  aud: string;
  // Profile-scoped, optional.
  name?: string | null;
  preferred_username?: string | null;
  picture?: string | null;
  given_name?: string | null;
  family_name?: string | null;
  // Email-scoped, optional.
  email?: string | null;
  email_verified?: boolean;
}

export class OidcSigner {
  private constructor(
    private readonly kp: PersistedKeypair,
    private readonly privateKey: SigningKey,
  ) {}

  /** Loads the persisted keypair, generating + persisting one on first
   *  boot. Idempotent across restarts. Multi-instance deployments race
   *  on first boot but the KV row is upserted so the last writer wins
   *  and all instances converge once the row exists. */
  static async init(storage: Storage): Promise<OidcSigner> {
    const existing = await storage.settings.get(SIGNING_KEY_SETTINGS_KEY);
    if (existing) {
      const kp = JSON.parse(existing) as PersistedKeypair;
      const privateKey = (await importJWK(kp.privateJwk, kp.alg)) as SigningKey;
      return new OidcSigner(kp, privateKey);
    }

    const { privateKey, publicKey } = await generateKeyPair(SIGNING_ALG, {
      modulusLength: 2048,
      extractable: true,
    });
    const privateJwk = await exportJWK(privateKey);
    const publicJwk = await exportJWK(publicKey);
    const kid = randomUUID();
    privateJwk.kid = kid;
    privateJwk.alg = SIGNING_ALG;
    privateJwk.use = "sig";
    publicJwk.kid = kid;
    publicJwk.alg = SIGNING_ALG;
    publicJwk.use = "sig";

    const kp: PersistedKeypair = {
      kid,
      alg: SIGNING_ALG,
      privateJwk,
      publicJwk,
    };
    await storage.settings.set(SIGNING_KEY_SETTINGS_KEY, JSON.stringify(kp));
    return new OidcSigner(kp, privateKey);
  }

  /** Mints a signed JWT for the given claims. `iat` and `exp` are stamped
   *  by this method — callers pass scope-derived claims only. */
  async signIdToken(claims: IdTokenClaims): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT(claims as unknown as Record<string, unknown>)
      .setProtectedHeader({ alg: this.kp.alg, kid: this.kp.kid, typ: "JWT" })
      .setIssuedAt(now)
      .setExpirationTime(now + ID_TOKEN_TTL_SECONDS)
      .sign(this.privateKey);
  }

  /** Returns the public half as a JWKS document (single-key set today;
   *  multi-key sets land on key rotation). */
  jwks(): { keys: JWK[] } {
    return { keys: [this.kp.publicJwk] };
  }

  /** OIDC discovery doc surface. */
  get algorithm(): string {
    return this.kp.alg;
  }
}
