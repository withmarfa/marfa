/**
 * Per-instance config file at `~/.marfa/<instance>.json`.
 *
 * The single on-disk credential store every Marfa tool shares: the CLI
 * writes it on `marfa auth login`, and any headless consumer (the MCP
 * server, scripts) reads the same file rather than carrying its own copy of
 * the format. Two processes refreshing one token file must share one
 * implementation — refresh rotates the refresh token, so a second,
 * divergent writer corrupts the store for both — which is why this module
 * lives in the SDK beside the token provider that owns the blob it stores.
 *
 * Shape per file (one instance, one issuer × one client_id):
 *   - `url`   — resolved server URL
 *   - `key`   — API key (scripted / non-interactive use)
 *   - `oauth` — Device Authorization Grant slot: `client_id`, `issuer`, and
 *               the token provider's opaque persisted blob
 *
 * Files are written 0600 and `~/.marfa/` is created 0700; writes are atomic
 * (sibling tmp file, then rename) and merges are read-merge-write so
 * unrelated fields survive.
 */

import {
  mkdir,
  readFile,
  rename,
  writeFile,
  chmod,
  unlink,
} from "node:fs/promises";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { PersistedTokens } from "../token-provider.js";

const INSTANCE_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export interface ConfigFile {
  url?: string;
  key?: string;
  oauth?: OAuthSlot;
}

export interface OAuthSlot {
  client_id: string;
  issuer: string;
  /** Opaque token blob (JSON-stringified {@link PersistedTokens}), written by
   *  the token provider through `FileTokenStorage`. Present after a
   *  successful sign-in; absent in the brief window between a first-run
   *  client registration persisting the `client_id` and the device flow
   *  completing. */
  blob?: string;
}

export function resolveInstanceName(explicit?: string): string {
  const candidate = explicit ?? process.env.MARFA_INSTANCE ?? "default";
  if (!INSTANCE_RE.test(candidate)) {
    throw new Error(
      `Invalid instance name: "${candidate}". Use lowercase alphanumeric and hyphens (1-64 chars).`,
    );
  }
  return candidate;
}

export function configDir(): string {
  return join(homedir(), ".marfa");
}

export function resolveConfigPath(instance: string): string {
  return join(configDir(), `${instance}.json`);
}

export async function readConfigFile(path: string): Promise<ConfigFile | null> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  return parseConfig(path, raw);
}

/** Sync variant for synchronous credential-resolution paths. */
export function readConfigFileSync(path: string): ConfigFile | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  return parseConfig(path, raw);
}

function parseConfig(path: string, raw: string): ConfigFile {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      throw new Error("expected JSON object");
    }
    return parsed;
  } catch (err) {
    throw new Error(
      `Failed to parse config file ${path}: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
}

/**
 * Atomic full-overwrite write: create dir (mode 0700), write to a sibling
 * tmp file with 0600, rename into place. Caller controls the full object —
 * use `mergeConfigFile` to preserve unknown / unrelated fields.
 */
export async function writeConfigFile(
  path: string,
  data: ConfigFile,
): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  // Best-effort tighten in case the dir already existed with looser perms.
  try {
    await chmod(dir, 0o700);
  } catch {
    // ignore — non-critical
  }
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, path);
}

/**
 * Read the existing file (if any), shallow-merge `patch` over it, write
 * back. Use for additive updates that should preserve other fields.
 */
export async function mergeConfigFile(
  path: string,
  patch: Partial<ConfigFile>,
): Promise<void> {
  const existing = (await readConfigFile(path)) ?? {};
  await writeConfigFile(path, { ...existing, ...patch });
}

/** Remove the file entirely. No-op if it doesn't exist. */
export async function deleteConfigFile(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

/**
 * Validate a stored `oauth.blob` against the token provider's persisted
 * shape. For consumers that need fields like `access_expires_at` without
 * standing up a provider; the blob otherwise stays opaque.
 */
export function parsePersistedTokens(blob: string): PersistedTokens {
  const parsed = JSON.parse(blob) as Partial<PersistedTokens>;
  if (
    typeof parsed.access_token !== "string" ||
    typeof parsed.refresh_token !== "string" ||
    typeof parsed.access_expires_at !== "number" ||
    typeof parsed.scope !== "string"
  ) {
    throw new Error("Stored OAuth token blob is malformed");
  }
  return parsed as PersistedTokens;
}
