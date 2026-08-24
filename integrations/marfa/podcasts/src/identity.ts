/**
 * Stable identities for shows and episodes.
 *
 * Kept apart from the parser because everything here needs a digest, and so
 * is asynchronous; the parser stays synchronous and its tests stay free of
 * a runtime.
 *
 * The problem this solves is that a feed address is not an identity. Shows
 * move between hosts, and if the address were the key every episode would
 * be rewritten as a new row the day a publisher switched provider.
 */
import type { ParsedEpisode } from "./feed-parser.js";

/**
 * The namespace the Podcasting 2.0 specification defines for feed
 * identifiers. Fixed by that spec, not chosen here.
 */
const PODCAST_NAMESPACE_UUID = "ead4c236-bf58-58c6-a2c6-a6b28d128cb6";

/* ------------------------------------------------------------------ */
/* UUIDv5                                                              */
/* ------------------------------------------------------------------ */

function uuidToBytes(uuid: string): Uint8Array {
  const hex = uuid.replace(/-/g, "");
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i += 1) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToUuid(bytes: Uint8Array): string {
  const hex: string[] = [];
  for (const b of bytes) hex.push(b.toString(16).padStart(2, "0"));
  const s = hex.join("");
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20, 32)}`;
}

/**
 * Name-based UUID, version 5. SHA-1 over the namespace bytes followed by
 * the name, with the version and variant bits overwritten as RFC 4122
 * requires.
 *
 * SHA-1 is the algorithm the UUID version specifies. It is not being used
 * for anything that depends on collision resistance.
 */
export async function uuidV5(name: string, namespace: string): Promise<string> {
  const ns = uuidToBytes(namespace);
  const nameBytes = new TextEncoder().encode(name);
  const input = new Uint8Array(ns.length + nameBytes.length);
  input.set(ns, 0);
  input.set(nameBytes, ns.length);

  const digest = new Uint8Array(await crypto.subtle.digest("SHA-1", input));
  const out = digest.slice(0, 16);
  out[6] = ((out[6] ?? 0) & 0x0f) | 0x50; // version 5
  out[8] = ((out[8] ?? 0) & 0x3f) | 0x80; // RFC 4122 variant
  return bytesToUuid(out);
}

/**
 * The feed address in the form the specification hashes: scheme removed,
 * trailing slashes removed. Both `https://example.com/feed/` and
 * `example.com/feed` therefore reach the same identifier, which is what
 * lets a feed that later declares a conformant `podcast:guid` land on the
 * value already stored rather than forking every episode.
 */
export function canonicalFeedName(feedUrl: string): string {
  return feedUrl
    .trim()
    .replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, "")
    .replace(/\/+$/, "");
}

/**
 * A show's identity. A declared `podcast:guid` wins; otherwise the same
 * value is computed from the address.
 *
 * Most feeds declare nothing — of the mainstream hosts sampled, none did —
 * so the computed path is the ordinary one and the declared path is the
 * upgrade.
 */
export async function showScopeKey(
  feedUrl: string,
  declaredGuid: string | null,
): Promise<string> {
  const declared = (declaredGuid ?? "").trim().toLowerCase();
  if (declared !== "") return declared;
  return uuidV5(canonicalFeedName(feedUrl), PODCAST_NAMESPACE_UUID);
}

/* ------------------------------------------------------------------ */
/* Episode identity                                                    */
/* ------------------------------------------------------------------ */

/**
 * The enclosure address without its query string.
 *
 * Prefix analytics services rewrite these on every request, so the query is
 * the one part guaranteed to differ between two reads of the same episode.
 * Keeping it would mint a fresh identity every poll.
 */
export function stableEnclosureUrl(url: string): string {
  const cut = url.search(/[?#]/);
  const base = cut === -1 ? url : url.slice(0, cut);
  return base.trim();
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  );
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * An episode's identity within its show, in order of preference.
 *
 * 1. The item's own `guid`. Optional in RSS and required by Apple, so it is
 *    usually there. `isPermaLink` is deliberately ignored: it says whether
 *    the value can be fetched, which has no bearing on whether it is
 *    stable, and it defaults to true when absent, so acting on it would
 *    reject perfectly good identifiers.
 * 2. The enclosure address with its query removed. Feeds without guids
 *    exist and still have media.
 * 3. A digest of title, publication date and episode number. Title alone is
 *    not enough, because a serialized audiobook names its parts almost
 *    identically.
 *
 * Returns null when an item offers none of these, which is the one case
 * where an episode cannot be tracked across polls and is skipped instead.
 */
export async function episodeLocalId(
  episode: ParsedEpisode,
): Promise<string | null> {
  const guid = (episode.guid ?? "").trim();
  if (guid !== "") return `g:${guid}`;

  const enclosure = episode.enclosure?.url ?? "";
  if (enclosure.trim() !== "") return `e:${stableEnclosureUrl(enclosure)}`;

  const title = (episode.title ?? "").trim();
  if (title === "") return null;
  const material = [
    title,
    episode.pub_date ?? "",
    episode.episode_number === null ? "" : String(episode.episode_number),
  ].join(" ");
  return `h:${(await sha256Hex(material)).slice(0, 32)}`;
}

/**
 * Provenance keys written as `source_id`.
 *
 * Both are scoped by the show. `source` is one value for the whole
 * integration, so without the scope two feeds emitting the same bare guid,
 * and values as plain as "1" do occur, would resolve to the same natural
 * key and silently overwrite each other's episodes.
 *
 * The scope is the show's identity rather than its address, and it is read
 * from stored state rather than recomputed, so that re-pointing a
 * subscription cannot re-key a catalog that is already stored.
 */
export function showSourceId(scopeKey: string): string {
  return `show:${scopeKey}`;
}

export function episodeSourceId(scopeKey: string, localId: string): string {
  return `ep:${scopeKey}:${localId}`;
}
