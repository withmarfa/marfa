/**
 * File-backed `TokenStorage` persisting the token provider's opaque blob
 * into the per-instance config file at `~/.marfa/<instance>.json`.
 *
 * The storage protocol is key→string, but a config file holds exactly one
 * tuple (one issuer × one client_id), so the key is ignored and the value
 * lands in the file's `oauth.blob` slot. `client_id` and `issuer` are
 * recorded alongside so the next session — or another tool reading the same
 * store — can recover them without parsing the blob.
 */

import type { TokenStorage } from "../storage.js";
import {
  mergeConfigFile,
  readConfigFile,
  writeConfigFile,
  type OAuthSlot,
} from "./config-file.js";

export interface FileTokenStorageOptions {
  /** Absolute path to `~/.marfa/<instance>.json`. */
  path: string;
  clientId: string;
  issuer: string;
}

export class FileTokenStorage implements TokenStorage {
  private readonly path: string;
  private readonly clientId: string;
  private readonly issuer: string;

  constructor(opts: FileTokenStorageOptions) {
    this.path = opts.path;
    this.clientId = opts.clientId;
    this.issuer = opts.issuer;
  }

  async get(): Promise<string | null> {
    const file = await readConfigFile(this.path);
    return file?.oauth?.blob ?? null;
  }

  async set(_key: string, value: string): Promise<void> {
    // **Carry the registration fields across.** `mergeConfigFile` is a
    // shallow merge at the top level, so handing it a fresh `oauth` replaces
    // the whole slot — and the registration store keeps its record in that
    // same slot. Rebuilding it from scratch here dropped the recorded scope
    // ceiling on every sign-in, which reads as a stale registration on the
    // next one and mints an abandoned client row each time round.
    const existing = (await readConfigFile(this.path))?.oauth;
    const slot: OAuthSlot = {
      ...existing,
      client_id: this.clientId,
      issuer: this.issuer,
      blob: value,
    };
    await mergeConfigFile(this.path, { oauth: slot });
  }

  /**
   * Drop the session, and only the session.
   *
   * **The registration stays.** It used to take the whole `oauth` slot,
   * client id included, so every sign-out cost a fresh client registration on
   * the way back in and left the old row behind with nothing able to revoke
   * it. A session ending says nothing about whether the client the server
   * minted is still good.
   */
  async delete(): Promise<void> {
    const file = await readConfigFile(this.path);
    const slot = file?.oauth;
    if (!slot) return;
    const withoutSession: OAuthSlot = { ...slot };
    delete withoutSession.blob;
    await writeConfigFile(this.path, { ...file, oauth: withoutSession });
  }
}
