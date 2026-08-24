/**
 * Podcast Index request signing.
 *
 * Enrichment exists for one thing RSS cannot do: some hosts publish only a
 * recent window of episodes, and nothing in a feed says it has been
 * truncated. A show with a thousand episodes behind a ten-item feed is
 * invisible to any reader of that feed. Podcast Index has the rest.
 *
 * Two deliberate limits on what is written here.
 *
 * The credential is a Worker secret rather than a per-connection one,
 * because the key identifies whoever runs this deployment rather than the
 * person using it. Every connection in every space would present the same
 * value, and asking each person to register their own turns "paste a feed
 * address" into "go and sign up for a directory API". It is also the only
 * shape a manifest can express: `token_requirements` admits only
 * "required", so declaring it at all would make a directory lookup a
 * precondition for reading a public feed.
 *
 * And there is no response mapping here, on purpose. The signing scheme is
 * fully specified and can be checked against fixed vectors without a
 * network, so it is written and tested. The response shapes cannot be
 * observed without a secret this deployment does not hold, and writing
 * interfaces from documentation is guessing with type annotations on. The
 * previous integration in this program produced a list of seven upstream
 * behaviors that contradicted the vendor's own documentation; every one
 * would have been baked in as a wrong assumption had it been written ahead
 * of contact. A stub with an honest comment carries more information than
 * plausible code that has never run.
 */

/** Base for the signed endpoints. */
export const PODCAST_INDEX_BASE = "https://api.podcastindex.org/api/1.0";

/**
 * Identifies this client upstream. Podcast Index rejects generic user
 * agents outright, and publishes no numeric rate limit — enforcement is by
 * blocking a key that misbehaves — so being identifiable is what makes a
 * conversation possible instead of a silent ban.
 */
export const PODCAST_INDEX_USER_AGENT = "MarfaPodcasts/0.1";

export interface PodcastIndexCredentials {
  key: string;
  secret: string;
}

/**
 * Both halves, or nothing. A key on its own cannot sign anything: the
 * authorization header is a digest over the key and the secret together,
 * so a lone key is a lost secret rather than a usable credential.
 */
export function readCredentials(env: {
  PODCASTINDEX_API_KEY?: string;
  PODCASTINDEX_API_SECRET?: string;
}): PodcastIndexCredentials | null {
  const key = (env.PODCASTINDEX_API_KEY ?? "").trim();
  const secret = (env.PODCASTINDEX_API_SECRET ?? "").trim();
  if (key === "" || secret === "") return null;
  return { key, secret };
}

async function sha1Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-1",
    new TextEncoder().encode(input),
  );
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * The four headers every signed request carries.
 *
 * The authorization value is `sha1(key + secret + unixSeconds)`, hex and
 * lower case, with no delimiters between the three parts, and the
 * timestamp in the header must be the identical string that went into the
 * digest. Seconds, not milliseconds: the window upstream is three minutes,
 * and a millisecond timestamp reads as a moment fifty thousand years from
 * now, which fails as an expiry rather than as a format error and so is
 * unusually hard to recognize.
 */
export async function signRequest(
  credentials: PodcastIndexCredentials,
  nowMs: number,
): Promise<Record<string, string>> {
  const stamp = String(Math.floor(nowMs / 1000));
  return {
    "User-Agent": PODCAST_INDEX_USER_AGENT,
    "X-Auth-Key": credentials.key,
    "X-Auth-Date": stamp,
    Authorization: await sha1Hex(
      `${credentials.key}${credentials.secret}${stamp}`,
    ),
  };
}

/**
 * The enrichment seam.
 *
 * Wired at the call site and inert without credentials, so the path that
 * runs when a deployment holds none is the path exercised by every test
 * and every environment so far. When the secret arrives, the mapping is
 * written here against observed responses rather than documented ones, and
 * the rule it must follow is already decided: the feed is authoritative
 * for everything the feed carries, and Podcast Index only supplies
 * episodes the feed truncated away.
 */
export function enrichmentAvailable(
  credentials: PodcastIndexCredentials | null,
): credentials is PodcastIndexCredentials {
  return credentials !== null;
}
