import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * `API_KEY_SALT` and `MARFA_AUTH_SECRET` are the two secrets this script sets
 * whose replacement is destructive and unrecoverable. A new salt invalidates
 * every API key on the deployment; a new auth secret signs out every session.
 * Cloudflare will not read a secret back, so the previous value is gone the
 * moment it is overwritten — there is no undo and no way to reconstruct it.
 *
 * The script originally generated both unconditionally whenever the operator's
 * shell did not carry an explicit value, and only warned about it afterwards,
 * by which point the write had already happened. That turns the most ordinary
 * reason to re-run an "init secrets" script — adding one new secret to a Worker
 * that already exists — into a total credential wipe of that environment.
 *
 * These tests pin the resolution order the script now follows. They drive the
 * real script with `wrangler` stubbed out on PATH, so no network call is made
 * and no Worker is touched: the stub reports whichever secrets the case says
 * already exist, and records what a write would have been rather than
 * performing it.
 */

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, "init-server-container-secrets.sh");

let workDir: string;
let stubDir: string;
let wroteLog: string;

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), "marfa-init-secrets-"));
  stubDir = join(workDir, "bin");
  wroteLog = join(workDir, "wrote.txt");
  execFileSync("mkdir", ["-p", stubDir]);

  const stub = `#!/usr/bin/env bash
if [[ "$1" == "secret" && "$2" == "list" ]]; then
  printf '['
  first=1
  for n in \${SECRETS_PRESENT:-}; do
    [[ $first == 1 ]] || printf ','
    printf '{"name":"%s"}' "$n"
    first=0
  done
  printf ']\\n'
  exit 0
fi
if [[ "$1" == "secret" && "$2" == "put" ]]; then
  cat >/dev/null
  echo "$3" >> "$WROTE_LOG"
  exit 0
fi
exit 0
`;
  const stubPath = join(stubDir, "wrangler");
  writeFileSync(stubPath, stub);
  chmodSync(stubPath, 0o755);
});

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

/** Run the script against a Worker that already carries `present`, and return
 *  the names it attempted to write. */
function secretsWritten(options: {
  present: string[];
  rotate?: boolean;
  explicitSalt?: string;
}): string[] {
  writeFileSync(wroteLog, "");
  execFileSync("bash", [script, "staging"], {
    env: {
      ...process.env,
      PATH: `${stubDir}:${process.env.PATH ?? ""}`,
      WROTE_LOG: wroteLog,
      SECRETS_PRESENT: options.present.join(" "),
      MARFA_ROTATE_SERVER_SECRETS: options.rotate ? "1" : "",
      // Everything the script requires before it reaches the interesting part.
      NEON_DATABASE_URL_POOLED_STAGING: "postgres://pooled/db",
      NEON_DATABASE_URL_STAGING: "postgres://direct/db",
      CLOUDFLARE_API_TOKEN: "test-token",
      POSTHOG_PROJECT_KEY_STAGING: "test-posthog",
      MARFA_SERVER_AUTH_SECRET: "",
      MARFA_SERVER_API_KEY_SALT: options.explicitSalt ?? "",
    },
    stdio: "pipe",
  });
  return readFileSync(wroteLog, "utf8").split("\n").filter(Boolean);
}

describe("init-server-container-secrets.sh: stable secrets", () => {
  it("leaves an existing API_KEY_SALT alone when no explicit value is given", () => {
    const written = secretsWritten({
      present: ["DATABASE_URL", "API_KEY_SALT", "MARFA_AUTH_SECRET"],
    });
    // The whole point: re-running to add an unrelated secret must not take the
    // deployment's API keys with it.
    expect(written).not.toContain("API_KEY_SALT");
    expect(written).not.toContain("MARFA_AUTH_SECRET");
    // ...while still doing the job it was run for.
    expect(written).toContain("DATABASE_URL");
  });

  it("generates a salt on genuine first-time init", () => {
    const written = secretsWritten({ present: ["DATABASE_URL"] });
    expect(written).toContain("API_KEY_SALT");
    expect(written).toContain("MARFA_AUTH_SECRET");
  });

  it("replaces an existing salt only when rotation is asked for explicitly", () => {
    const written = secretsWritten({
      present: ["DATABASE_URL", "API_KEY_SALT", "MARFA_AUTH_SECRET"],
      rotate: true,
    });
    expect(written).toContain("API_KEY_SALT");
    expect(written).toContain("MARFA_AUTH_SECRET");
  });

  it("honors an explicitly supplied salt over the Worker's existing value", () => {
    const written = secretsWritten({
      present: ["DATABASE_URL", "API_KEY_SALT"],
      explicitSalt: "deliberate-value",
    });
    // An operator who names a value is being deliberate; that is not the
    // accidental path this guard exists to close.
    expect(written).toContain("API_KEY_SALT");
  });
});
