/**
 * The parts of booting a local Marfa server for the suite that need no
 * server: reading the one-time bootstrap secret out of the boot log, choosing
 * the key the suite runs as, rendering the env file the run sources, and
 * keeping the keys and the bootstrap secret out of a CI log.
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

/**
 * The log with every bootstrap secret replaced, for a failure message that
 * quotes it: a public CI log would otherwise carry the secret of a server
 * that never took its first mint.
 */
export function redactBootstrapSecret(log: string): string {
  return log.replace(/Bearer [0-9a-f]{64}/g, "Bearer [redacted]");
}

/**
 * Registers each value with GitHub Actions as a secret, so no later line of
 * the job shows it. The values reach `GITHUB_ENV`, and Actions prints that
 * file's variables at the head of every later step's log.
 */
export function maskInActions(...values: string[]): void {
  if (process.env.GITHUB_ACTIONS !== "true") return;
  for (const value of new Set(values)) {
    if (value.length > 0) console.log(`::add-mask::${value}`);
  }
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
 * appendable to a GitHub Actions `GITHUB_ENV` unchanged. `blobPath` is the
 * disk store the booted server keeps its bytes in, for the fixture that
 * corrupts a copy on disk to see the integrity check strike it.
 */
export function renderEnvFile(
  apiUrl: string,
  credentials: TargetCredentials,
  blobPath?: string,
  statusLogs?: string,
): string {
  return [
    `MARFA_API_URL=${apiUrl}`,
    `MARFA_API_KEY=${credentials.apiKey}`,
    `MARFA_OPERATOR_KEY=${credentials.operatorKey}`,
    ...(blobPath === undefined ? [] : [`MARFA_BLOB_PATH=${blobPath}`]),
    ...(statusLogs === undefined ? [] : [`MARFA_STATUS_LOGS=${statusLogs}`]),
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
