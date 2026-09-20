/**
 * The pure parts of booting a local Marfa server for the suite: reading the
 * one-time bootstrap secret out of the boot log, choosing the key the suite
 * runs as, and rendering the env file the run sources.
 *
 * Kept apart from the process handling in `scripts/marfa-server.ts` so they
 * can be tested without a server.
 */

const BOOTSTRAP_SECRET = /Authorization: Bearer ([0-9a-f]{64})/;

/**
 * The bootstrap secret, if the log holds one.
 *
 * The server prints it in a single warn line at every boot until the first
 * key is minted. A log from a server that was already bootstrapped has no such
 * line, and that is the signal to reuse the env file from the earlier mint.
 */
export function readBootstrapSecret(log: string): string | undefined {
  return BOOTSTRAP_SECRET.exec(log)?.[1];
}

export interface MintedKey {
  key: string;
  [field: string]: unknown;
}

export interface TargetCredentials {
  /** The key the per-file keys are minted through. */
  apiKey: string;
  /** The same key, which the operator-only fixtures run as. */
  operatorKey: string;
}

/**
 * Which key the suite runs as.
 *
 * The bootstrap mint answers with one key, the operator key. It holds no
 * content permissions of its own, and it still provisions the run, because a
 * key it mints naming no permission maps carries the whole dataset.
 */
export function chooseCredentials(response: MintedKey): TargetCredentials {
  if (typeof response.key !== "string" || response.key.length === 0) {
    throw new Error(
      `bootstrap mint returned no usable key: ${JSON.stringify(response)}`,
    );
  }
  return { apiKey: response.key, operatorKey: response.key };
}

/**
 * The env file, one `KEY=value` per line, readable by a shell `source` and
 * appendable to a GitHub Actions `GITHUB_ENV` unchanged.
 */
export function renderEnvFile(
  apiUrl: string,
  credentials: TargetCredentials,
): string {
  return [
    `MARFA_API_URL=${apiUrl}`,
    `MARFA_API_KEY=${credentials.apiKey}`,
    `MARFA_OPERATOR_KEY=${credentials.operatorKey}`,
    "",
  ].join("\n");
}

/** Parse the env file back, for a `status` call or a second `up`. */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    out[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return out;
}
