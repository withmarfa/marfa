/**
 * The registration store for tools that keep their credentials in
 * `~/.marfa/<instance>.json`.
 *
 * **It shares one slot with the token store and must not disturb it.** The
 * registration and the session live side by side in `oauth`, and they fail
 * independently: a client the server has forgotten is not an expired session,
 * and clearing one to repair the other signs a working session out. The CLI
 * used to delete the whole slot on a registration repair, which is where that
 * lesson comes from, and it is why `clear()` below names its fields rather
 * than dropping the object.
 */
import type {
  ClientRegistrationStore,
  StoredClientRegistration,
} from "../client-registration.js";
import { mergeConfigFile, readConfigFile } from "./config-file.js";

export class FileClientRegistrationStore implements ClientRegistrationStore {
  private readonly path: string;

  constructor(options: { path: string }) {
    this.path = options.path;
  }

  async read(issuer: string): Promise<StoredClientRegistration | null> {
    const file = await readConfigFile(this.path);
    const slot = file?.oauth;
    if (!slot?.client_id) return null;
    // A record naming a different instance is not this one's to reuse.
    if (slot.issuer !== issuer) return null;
    return {
      clientId: slot.client_id,
      issuer: slot.issuer,
      claimedScope: slot.client_scope ?? "",
      epoch: slot.registration_epoch ?? 0,
    };
  }

  async write(record: StoredClientRegistration): Promise<void> {
    const file = await readConfigFile(this.path);
    await mergeConfigFile(this.path, {
      oauth: {
        ...file?.oauth,
        client_id: record.clientId,
        issuer: record.issuer,
        client_scope: record.claimedScope,
        registration_epoch: record.epoch,
      },
    });
  }

  /**
   * Retire the registration without touching the session beside it.
   *
   * **It drops the ceiling record rather than the id.** `client_id` and
   * `issuer` are required fields of the slot, so blanking them would write a
   * file the other readers of it treat as valid and it is not. Removing the
   * claim is enough and is exact: a record with no recorded claim is stale by
   * definition, so the next resolve registers afresh and overwrites the id
   * then — while a reader that only wants the token blob still finds a
   * well-formed slot in the meantime.
   *
   * `mergeConfigFile` is a shallow merge at the top level, so handing it a
   * whole `oauth` object replaces the slot rather than merging into it, which
   * is what removing a key requires.
   */
  async clear(issuer: string): Promise<void> {
    const file = await readConfigFile(this.path);
    const slot = file?.oauth;
    if (slot?.issuer !== issuer) return;
    await mergeConfigFile(this.path, {
      oauth: {
        client_id: slot.client_id,
        issuer: slot.issuer,
        ...(slot.blob ? { blob: slot.blob } : {}),
      },
    });
  }
}
