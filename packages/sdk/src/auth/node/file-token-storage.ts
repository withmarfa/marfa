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
    const slot: OAuthSlot = {
      client_id: this.clientId,
      issuer: this.issuer,
      blob: value,
    };
    await mergeConfigFile(this.path, { oauth: slot });
  }

  async delete(): Promise<void> {
    const file = await readConfigFile(this.path);
    if (!file?.oauth) return;
    const next = { ...file };
    delete next.oauth;
    await writeConfigFile(this.path, next);
  }
}
