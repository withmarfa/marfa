import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { removeTempFolder, tempFolder } from "./temp-folder.js";

/**
 * A keychain file of the run's own for the binary under test, so nothing it
 * keeps or reads is in the person's keychain; with one named in
 * `MARFA_KEYCHAIN`, the binary refuses every keychain prompt. The `device`
 * and `cli` projects make it in their global setup and remove it, with the
 * credential locks the binary keeps beside it, in its teardown. Where there
 * are no keychain files, the name is of a file that is never made.
 *
 * Named anything but `login`, because macOS adds a keychain file of that
 * name to the person's search list when it is made.
 *
 * `MARFA_AUTOSTART_ROOT` names a folder that is never made, so a `login` or
 * `keys keep` in a run finds no folder-watch agent and asks no service manager.
 */
export default function makeKeychain(): () => void {
  // A switch set in the person's shell would turn the run's own keychain off
  // under every test that names it; a test that wants it off sets it itself.
  delete process.env.MARFA_NO_KEYCHAIN;
  const folder = tempFolder("marfa-conformance-keychain-");
  const remove = () => {
    removeTempFolder(folder);
  };
  process.env[AUTOSTART] = join(folder, "no-autostart");
  if (process.platform !== "darwin") {
    process.env[PATH] = join(folder, "none");
    return remove;
  }
  const path = join(folder, "run.keychain-db");
  const password = randomUUID();
  execFileSync("security", ["create-keychain", "-p", password, path]);
  process.env[PATH] = path;
  process.env[PASSWORD] = password;
  return remove;
}

const PATH = "MARFA_CONFORMANCE_KEYCHAIN";
const PASSWORD = "MARFA_CONFORMANCE_KEYCHAIN_PASSWORD";
const AUTOSTART = "MARFA_CONFORMANCE_AUTOSTART_ROOT";

let unlockedAt = 0;

/**
 * The environment that points the binary at the run's keychain, and takes the
 * shell's own server, key and profile away (set to `undefined`, which a spawn
 * leaves out): spread it over `process.env`. A key in the environment is the
 * credential a binary uses before any kept sign-in and cannot be renewed, so a
 * run under one never meets a sign-in that ended; a fixture that wants a key,
 * a server or a profile names it after `keychainEnv()`. The file is unlocked
 * with its own password again after a minute, so it never locks itself under a
 * run: a locked keychain the binary may not ask about would fail the run
 * instead.
 */
export function keychainEnv(): NodeJS.ProcessEnv {
  const kept = keychainFiles();
  return {
    MARFA_API_KEY: undefined,
    MARFA_API_URL: undefined,
    MARFA_PROFILE: undefined,
    ...kept,
  };
}

/**
 * A keychain file that holds nothing, for a fixture whose claim is that no
 * server is named. The run's shared keychain holds the sign-in any other file
 * kept, and a command that names no server takes the server of the last
 * sign-in kept, so under it such a fixture is answered by a server another
 * file started and stopped. Removed with the file's temporary folders.
 */
export function emptyKeychain(): string {
  return ownKeychain("marfa-conformance-empty-keychain-").path;
}

/** Isolates credentials that would otherwise change the run's current sign-in. */
export function ownKeychain(prefix = "marfa-conformance-own-keychain-"): {
  path: string;
  remove: () => void;
  lock: () => void;
} {
  const folder = tempFolder(prefix);
  if (process.platform !== "darwin") {
    return {
      path: join(folder, "none"),
      remove: () => {
        removeTempFolder(folder);
      },
      lock: () => {},
    };
  }
  const path = join(folder, "credentials.keychain-db");
  const password = randomUUID();
  execFileSync("security", ["create-keychain", "-p", password, path]);
  execFileSync("security", ["unlock-keychain", "-p", password, path]);
  // Automatic locking would require a dialog the binary must refuse.
  execFileSync("security", ["set-keychain-settings", path]);
  return {
    path,
    remove: () => {
      try {
        execFileSync("security", ["delete-keychain", path]);
      } finally {
        removeTempFolder(folder);
      }
    },
    lock: () => {
      execFileSync("security", ["lock-keychain", path]);
    },
  };
}

function keychainFiles(): {
  MARFA_KEYCHAIN: string;
  MARFA_AUTOSTART_ROOT: string;
} {
  const path = process.env[PATH];
  if (path === undefined) {
    throw new Error(
      `${PATH} is unset: the project running this has no global setup making the run's keychain`,
    );
  }
  // Where there are no keychain files, a name the binary answers as no
  // keychain at all keeps it off the person's secret service.
  const MARFA_AUTOSTART_ROOT = process.env[AUTOSTART];
  if (MARFA_AUTOSTART_ROOT === undefined) {
    throw new Error(
      `${AUTOSTART} is unset: the project running this has no global setup making the run's keychain`,
    );
  }
  if (process.platform !== "darwin") {
    return { MARFA_KEYCHAIN: path, MARFA_AUTOSTART_ROOT };
  }
  const password = process.env[PASSWORD];
  if (password === undefined) {
    throw new Error(
      `${PASSWORD} is unset: the project running this has no global setup making the run's keychain`,
    );
  }
  if (Date.now() - unlockedAt > 60_000) {
    execFileSync("security", ["unlock-keychain", "-p", password, path]);
    unlockedAt = Date.now();
  }
  return { MARFA_KEYCHAIN: path, MARFA_AUTOSTART_ROOT };
}
