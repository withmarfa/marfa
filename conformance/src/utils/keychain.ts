import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A keychain file of the run's own for the binary under test, so nothing it
 * keeps or reads is in the person's keychain; with one named in
 * `MARFA_KEYCHAIN`, the binary refuses every keychain prompt. The `device`
 * and `cli` projects make it in their global setup and remove it in its
 * teardown. Nothing is made where there are no keychain files.
 *
 * Named anything but `login`, because macOS adds a keychain file of that
 * name to the person's search list when it is made.
 */
export default function makeKeychain(): () => void {
  if (process.platform !== "darwin") return () => undefined;
  const folder = mkdtempSync(join(tmpdir(), "marfa-conformance-keychain-"));
  const path = join(folder, "run.keychain-db");
  const password = randomUUID();
  execFileSync("security", ["create-keychain", "-p", password, path]);
  process.env[PATH] = path;
  process.env[PASSWORD] = password;
  return () => {
    rmSync(folder, { recursive: true, force: true });
  };
}

const PATH = "MARFA_CONFORMANCE_KEYCHAIN";
const PASSWORD = "MARFA_CONFORMANCE_KEYCHAIN_PASSWORD";

let unlockedAt = 0;

/**
 * The environment that points the binary at the run's keychain. The file is
 * unlocked with its own password again after a minute, so it never locks
 * itself under a run: a locked keychain the binary may not ask about would
 * fail the run instead.
 */
export function keychainEnv(): Record<string, string> {
  // Where there are no keychain files, a name the binary answers as no
  // keychain at all keeps it off the person's secret service.
  if (process.platform !== "darwin")
    return { MARFA_KEYCHAIN: join(tmpdir(), "marfa-no-keychain") };
  const path = process.env[PATH];
  const password = process.env[PASSWORD];
  if (path === undefined || password === undefined) {
    throw new Error(
      `${PATH} is unset: the project running this has no global setup making the run's keychain`,
    );
  }
  if (Date.now() - unlockedAt > 60_000) {
    execFileSync("security", ["unlock-keychain", "-p", password, path]);
    unlockedAt = Date.now();
  }
  return { MARFA_KEYCHAIN: path };
}
