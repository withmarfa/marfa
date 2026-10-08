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

export const TEST_OWNER = {
  email: "owner@example.test",
  password: "conformance owner password",
};

export function redactSetupProof(log: string): string {
  return log.replace(/setup code: [A-Z2-7-]+/g, "setup code: [redacted]");
}

export interface TargetCredentials {
  apiKey: string;
  managementKey: string;
  controlSocket: string;
  ownerCookie: string;
  ownerSessionFile?: string;
  authSecret?: string;
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
    `MARFA_MANAGEMENT_KEY=${credentials.managementKey}`,
    `MARFA_CONTROL_SOCKET=${credentials.controlSocket}`,
    `MARFA_OWNER_COOKIE=${credentials.ownerCookie}`,
    ...(credentials.ownerSessionFile === undefined
      ? []
      : [`MARFA_OWNER_SESSION_FILE=${credentials.ownerSessionFile}`]),
    ...(credentials.authSecret === undefined
      ? []
      : [`MARFA_FIXTURE_AUTH_SECRET=${credentials.authSecret}`]),
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
