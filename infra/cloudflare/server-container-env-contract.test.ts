import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * The container Worker is the only path config takes from Cloudflare into the
 * server process: `wrangler secret put` writes a secret onto the Worker, and
 * the Worker's `envVars` map is what the container actually receives at launch.
 * A secret that the deploy tooling sets but `envVars` never forwards is
 * invisible from every side — `wrangler secret list` shows it present, the
 * container's `process.env` never sees it, and the server silently takes its
 * "unset" branch.
 *
 * That is not hypothetical: `MARFA_DATABASE_URL_DIRECT` was set on both Workers
 * and absent from `envVars` for the life of the feature it was added for, so
 * the streaming-RLS direct-endpoint escape hatch never engaged.
 *
 * This test asserts the general contract rather than any single variable: every
 * name that BOTH the deploy tooling sets as a secret AND the server reads from
 * `process.env` must be declared on `Env` and forwarded by `envVars`. It
 * catches the next secret someone adds to the script and forgets to wire.
 */

const repoFile = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf-8");

const CONTAINER_WORKER_SOURCE = "./server-container/src/index.ts";
const SECRETS_SCRIPT = "./scripts/init-server-container-secrets.sh";
const SERVER_CONFIG = "../../packages/server/src/config.ts";

/** Env-var identifiers are SCREAMING_SNAKE_CASE across the whole surface. */
const ENV_NAME = "[A-Z][A-Z0-9_]*";

/**
 * Slice the body of a brace-delimited block starting at `opener`. Regex alone
 * cannot find the matching close brace of a nested object literal, and the
 * `envVars` map contains none today but is one edit away from doing so.
 */
function braceBlock(source: string, opener: string): string {
  const start = source.indexOf(opener);
  if (start === -1) throw new Error(`missing block opener: ${opener}`);
  let depth = 0;
  for (let i = start + opener.length - 1; i < source.length; i += 1) {
    const char = source[i];
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start + opener.length, i);
    }
  }
  throw new Error(`unbalanced braces after: ${opener}`);
}

/** Keys declared at the top level of a `{ … }` block, one per line. */
function blockKeys(body: string): Set<string> {
  const keys = new Set<string>();
  for (const line of body.split("\n")) {
    const match = new RegExp(`^\\s*(${ENV_NAME})\\??\\s*:`).exec(line);
    if (match?.[1]) keys.add(match[1]);
  }
  return keys;
}

function matchAll(source: string, pattern: RegExp): Set<string> {
  const found = new Set<string>();
  for (const match of source.matchAll(pattern)) {
    if (match[1]) found.add(match[1]);
  }
  return found;
}

const workerSource = repoFile(CONTAINER_WORKER_SOURCE);
const envInterfaceKeys = blockKeys(braceBlock(workerSource, "interface Env {"));
const envVarsKeys = blockKeys(
  braceBlock(workerSource, "envVars = definedEnv({"),
);

/** Every `put_secret <NAME>` the deploy tooling issues against the Worker. */
const secretsSetByDeploy = matchAll(
  repoFile(SECRETS_SCRIPT),
  new RegExp(`^\\s*put_secret\\s+(${ENV_NAME})`, "gm"),
);

/** Every `process.env.<NAME>` the server reads when it builds its config. */
const envReadByServer = matchAll(
  repoFile(SERVER_CONFIG),
  new RegExp(`process\\.env\\.(${ENV_NAME})`, "g"),
);

const mustBeForwarded = [...secretsSetByDeploy]
  .filter((name) => envReadByServer.has(name))
  .sort();

describe("server-container env contract", () => {
  it("extracts a plausible env surface from all three files", () => {
    // Guards the parsers themselves: a refactor that renames `envVars` or
    // reshapes the secrets script would otherwise turn this whole file into a
    // vacuous pass.
    expect(envInterfaceKeys.size).toBeGreaterThan(5);
    expect(envVarsKeys.size).toBeGreaterThan(5);
    expect(secretsSetByDeploy.size).toBeGreaterThan(5);
    expect(envReadByServer.size).toBeGreaterThan(5);
    expect(mustBeForwarded.length).toBeGreaterThan(3);
  });

  it("declares every deploy-set secret the server reads on the Env interface", () => {
    const missing = mustBeForwarded.filter(
      (name) => !envInterfaceKeys.has(name),
    );
    expect(missing).toEqual([]);
  });

  it("forwards every deploy-set secret the server reads through envVars", () => {
    const missing = mustBeForwarded.filter((name) => !envVarsKeys.has(name));
    expect(missing).toEqual([]);
  });

  it("forwards MARFA_DATABASE_URL_DIRECT so streaming RLS can reach the direct endpoint", () => {
    // Called out explicitly as well as covered by the general rule above: this
    // is the variable whose silent absence let a session-level SET ROLE run on
    // the transaction-mode pooled endpoint.
    expect(envInterfaceKeys).toContain("MARFA_DATABASE_URL_DIRECT");
    expect(envVarsKeys).toContain("MARFA_DATABASE_URL_DIRECT");
  });

  it("never forwards a name the Env interface does not declare", () => {
    // `envVars` also carries static hosted values (DB_DIALECT, PORT, …) that
    // are not bindings, so only the `cfEnv.`-sourced entries are checked.
    const fromBindings = matchAll(
      braceBlock(workerSource, "envVars = definedEnv({"),
      new RegExp(`cfEnv\\.(${ENV_NAME})`, "g"),
    );
    const undeclared = [...fromBindings]
      .filter((name) => !envInterfaceKeys.has(name))
      .sort();
    expect(undeclared).toEqual([]);
  });
});
