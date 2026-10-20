/**
 * The rows that list API keys, read from storage for the API keys list and
 * for an app's page, which lists the keys the app made in the same rows.
 */
import { endsSoon, endsWords, usedWords } from "../pages/key-time.js";
import type { Storage, StoredApiKey } from "../storage/interface.js";
import { describeHeld } from "./access-model.js";
import { readAccessWords, scopesOfKey } from "./access-view.js";
import type { KeyListRow } from "./key-pages.js";

export const timeOf = (text: string | null | undefined): number | null => {
  if (!text) return null;
  const at = Date.parse(text);
  return Number.isNaN(at) ? null : at;
};

/** The names of the apps that made keys, by registered client. */
export async function appNames(
  storage: Storage,
  keys: readonly StoredApiKey[],
): Promise<Map<string, string | null>> {
  const ids = [
    ...new Set(
      keys.flatMap((key) =>
        key.oauth_client_id === undefined ? [] : [key.oauth_client_id],
      ),
    ),
  ];
  const names = new Map<string, string | null>();
  await Promise.all(
    ids.map(async (id) => {
      const client = await storage.oauthProvider?.getClient(id);
      names.set(id, client?.name ?? null);
    }),
  );
  return names;
}

/** The scopes a key holds with the read each write brings, so Read only is offered under Read and edit. */
export function withReads(scopes: readonly string[]): string[] {
  const all = new Set(scopes);
  for (const literal of scopes)
    if (literal.endsWith(":write")) all.add(`${literal.slice(0, -6)}:read`);
  return [...all];
}

/** "Made by X. ", or nothing for a key the owner made. */
function makerLine(
  key: StoredApiKey,
  names: ReadonlyMap<string, string | null>,
): string {
  if (key.oauth_client_id === undefined) return "";
  const name = names.get(key.oauth_client_id);
  return `Made by ${name ?? "an app"}. `;
}

/**
 * The rows for `keys`, in the order given. `maker: false` leaves out who made
 * each key, for a page that already says so.
 */
export async function keyListRows(
  storage: Storage,
  keys: readonly StoredApiKey[],
  now: number,
  options: { maker: boolean } = { maker: true },
): Promise<KeyListRow[]> {
  const names = options.maker
    ? await appNames(storage, keys)
    : new Map<string, string | null>();
  const heldBy = new Map(keys.map((key) => [key.id, scopesOfKey(key)]));
  const words = await readAccessWords(
    storage,
    withReads([...heldBy.values()].flatMap((held) => held.scopes)),
  );
  return keys.map((key) => {
    const held = heldBy.get(key.id) ?? scopesOfKey(key);
    const summary =
      held.scopes.length === 0
        ? "No access"
        : describeHeld(held.scopes, words, held).summary;
    const ends = timeOf(key.expires_at);
    return {
      id: key.id,
      label: key.label,
      description: `${options.maker ? makerLine(key, names) : ""}${summary}. ${endsWords(ends, now)}.`,
      endsSoon: endsSoon(ends, now),
      value: usedWords(timeOf(key.last_used_at), now),
    };
  });
}
