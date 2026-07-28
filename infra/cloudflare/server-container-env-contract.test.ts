import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
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
 * name the deploy tooling sets as a secret must be read somewhere in the server
 * source, declared on `Env`, and forwarded by `envVars`. It catches the next
 * secret someone adds to the script and forgets to wire.
 *
 * **Scope, stated exactly.** The server side is scraped from every
 * non-test `.ts` file under `packages/server/src`, not from `config.ts` alone.
 * Three of the eleven secrets the deploy sets — the runtime broker key and the
 * two Cloudflare Queues values — are read from route and bridge modules rather
 * than from config, so a config-only scrape silently excluded them and read as
 * coverage while covering nothing. What is still out of scope: a value the
 * server reaches by any route other than a literal `process.env.NAME` (a
 * computed key, a `destructured` read, a wrapper that takes the name as an
 * argument). Nothing does that today, and `everyDeploySetSecretIsRead` below is
 * what makes a new one fail loudly instead of quietly dropping out.
 */

const repoFile = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf-8");

const CONTAINER_WORKER_SOURCE = "./server-container/src/index.ts";
const SECRETS_SCRIPT = "./scripts/init-server-container-secrets.sh";
const SERVER_SRC = "../../packages/server/src/";

/** Env-var identifiers are SCREAMING_SNAKE_CASE across the whole surface. */
const ENV_NAME = "[A-Z][A-Z0-9_]*";

/** Every non-test TypeScript source file the server ships, concatenated. */
function serverSource(): string {
  const root = fileURLToPath(new URL(SERVER_SRC, import.meta.url));
  return readdirSync(root, { recursive: true, encoding: "utf-8" })
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
    .map((name) => readFileSync(`${root}${name}`, "utf-8"))
    .join("\n");
}

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

/**
 * Keys in a `{ … }` block whose value is a string literal — the static hosted
 * configuration, as opposed to the `cfEnv.`-sourced bindings.
 */
function blockLiterals(body: string): Map<string, string> {
  const literals = new Map<string, string>();
  for (const line of body.split("\n")) {
    const match = new RegExp(
      `^\\s*(${ENV_NAME})\\s*:\\s*"([^"]*)"\\s*,?\\s*$`,
    ).exec(line);
    if (match?.[1] !== undefined && match[2] !== undefined) {
      literals.set(match[1], match[2]);
    }
  }
  return literals;
}

function matchAll(source: string, pattern: RegExp): Set<string> {
  const found = new Set<string>();
  for (const match of source.matchAll(pattern)) {
    if (match[1]) found.add(match[1]);
  }
  return found;
}

const workerSource = repoFile(CONTAINER_WORKER_SOURCE);
const envVarsBody = braceBlock(workerSource, "envVars = definedEnv({");
const envInterfaceKeys = blockKeys(braceBlock(workerSource, "interface Env {"));
const envVarsKeys = blockKeys(envVarsBody);
const envVarsLiterals = blockLiterals(envVarsBody);

/** Every `put_secret <NAME>` the deploy tooling issues against the Worker. */
const secretsSetByDeploy = matchAll(
  repoFile(SECRETS_SCRIPT),
  new RegExp(`^\\s*put_secret\\s+(${ENV_NAME})`, "gm"),
);

/** Every `process.env.<NAME>` anywhere in the server's shipped source. */
const envReadByServer = matchAll(
  serverSource(),
  new RegExp(`process\\.env\\.(${ENV_NAME})`, "g"),
);

const deploySetSecrets = [...secretsSetByDeploy].sort();
const mustBeForwarded = deploySetSecrets.filter((name) =>
  envReadByServer.has(name),
);

describe("server-container env contract", () => {
  it("extracts a plausible env surface from all three sources", () => {
    // Guards the parsers themselves: a refactor that renames `envVars` or
    // reshapes the secrets script would otherwise turn this whole file into a
    // vacuous pass.
    expect(envInterfaceKeys.size).toBeGreaterThan(5);
    expect(envVarsKeys.size).toBeGreaterThan(5);
    expect(envVarsLiterals.size).toBeGreaterThan(5);
    expect(secretsSetByDeploy.size).toBeGreaterThan(5);
    expect(envReadByServer.size).toBeGreaterThan(5);
  });

  it("covers every secret the deploy sets, with no silent exclusions", () => {
    // The check that keeps the contract honest. Filtering the deploy's secrets
    // down to the ones the server is seen to read is what makes the forwarding
    // assertions meaningful, and it is also how a third of the subject went
    // missing: a secret read from a module the scrape did not look at simply
    // fell out, and the suite stayed green while covering nothing.
    const unread = deploySetSecrets.filter(
      (name) => !envReadByServer.has(name),
    );
    expect(unread).toEqual([]);
    expect(mustBeForwarded).toEqual(deploySetSecrets);
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

  it("declares the hosted database endpoint as a transaction-mode pooler", () => {
    // The line that arms everything else. The hosted DATABASE_URL is Neon's
    // pooled endpoint, and the server's boot guard only fires when it has been
    // told so: without this the deployment reverts to the permissive default,
    // the direct endpoint becomes optional again, and the whole enforcement
    // story is advisory. `DB_DIALECT` rides along because the guard is scoped
    // to Postgres — flipping either one disarms it.
    expect(envVarsLiterals.get("DB_DIALECT")).toBe("pg");
    expect(envVarsLiterals.get("MARFA_DB_POOL_MODE")).toBe("transaction");
  });

  it("never forwards a name the Env interface does not declare", () => {
    // `envVars` also carries static hosted values (DB_DIALECT, PORT, …) that
    // are not bindings, so only the `cfEnv.`-sourced entries are checked.
    const fromBindings = matchAll(
      envVarsBody,
      new RegExp(`cfEnv\\.(${ENV_NAME})`, "g"),
    );
    const undeclared = [...fromBindings]
      .filter((name) => !envInterfaceKeys.has(name))
      .sort();
    expect(undeclared).toEqual([]);
  });
});
