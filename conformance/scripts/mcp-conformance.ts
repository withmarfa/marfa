/**
 * Run the MCP project's conformance tool against `/mcp` on a server that
 * `marfa:up` booted, and fail on any check that fails but those pinned in
 * `KNOWN_FAILURES`.
 *
 *   tsx scripts/mcp-conformance.ts [--state <dir>]
 *
 * The tool sends no credential, so a proxy on loopback forwards each request
 * to `/mcp` with the key from `<state>/env` as its bearer. Each pinned check
 * must still fail: one that passes, or no longer runs, fails the run too, so
 * that its pin is removed.
 */
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
} from "node:http";
import { request as httpsRequest } from "node:https";
import type { AddressInfo } from "node:net";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnvFile } from "../src/utils/target.js";

/** The scenarios every check of which must pass. */
export const REQUIRED = ["server-initialize", "ping", "tools-list"] as const;

/**
 * Checks that fail by design, by scenario and check ID, with the reason.
 * Their scenarios run too, so a pin that goes stale is seen.
 */
export const KNOWN_FAILURES: Record<string, Record<string, string>> = {
  "json-schema-2020-12": {
    "json-schema-2020-12-tool-found":
      "It looks for a tool of the SDK's reference server, which Marfa does not serve.",
  },
  "dns-rebinding-protection": {
    "localhost-host-valid-accepted":
      "It sends the proxy's address as the origin, which reads as a foreign origin, and the endpoint refuses any origin the owner did not approve.",
  },
};

export const SCENARIOS = [...REQUIRED, ...Object.keys(KNOWN_FAILURES)];

/** One entry of the tool's `checks.json`. */
export interface Check {
  id: string;
  status: string;
  errorMessage?: string;
}

const FAILED = new Set(["FAILURE", "WARNING"]);
const SCENARIO_BUDGET_MS = 60_000;

/**
 * What is wrong with a run, one line each; empty when it passes. A scenario
 * that reports no failure and no passing or pinned check did not run.
 */
export function problems(
  results: Readonly<Record<string, readonly Check[] | undefined>>,
): string[] {
  const out: string[] = [];
  for (const scenario of SCENARIOS) {
    const checks = results[scenario] ?? [];
    const pinned = KNOWN_FAILURES[scenario] ?? {};
    const failed = checks.filter(
      (check) => FAILED.has(check.status) && !(check.id in pinned),
    );
    for (const check of failed) {
      out.push(
        `${scenario}: ${check.id} ended as ${check.status}${check.errorMessage ? `: ${check.errorMessage}` : ""}`,
      );
    }
    if (
      failed.length === 0 &&
      !checks.some((check) => check.status === "SUCCESS" || check.id in pinned)
    ) {
      out.push(`${scenario}: reported no result; the tool's output says why`);
      continue;
    }
    for (const id of Object.keys(pinned)) {
      const check = checks.find((c) => c.id === id);
      if (check === undefined || !FAILED.has(check.status)) {
        out.push(
          `${scenario}: ${id} is pinned as a known failure but ${check === undefined ? "no longer runs" : `ended as ${check.status}`}; remove its pin`,
        );
      }
    }
  }
  return out;
}

const HOP_BY_HOP = ["connection", "keep-alive", "transfer-encoding"];

function forwarded(
  headers: IncomingHttpHeaders,
  extra: Record<string, string>,
): IncomingHttpHeaders {
  const out: IncomingHttpHeaders = { ...headers, ...extra };
  for (const name of HOP_BY_HOP) delete out[name];
  return out;
}

/**
 * A proxy on loopback that sends every request to `target`, keeping its
 * query, with `key` as the bearer. Responses stream through, so a server-sent
 * event reaches the tool as it is sent.
 */
export async function startProxy(
  target: URL,
  key: string,
): Promise<{ url: URL; close: () => Promise<void> }> {
  const send = target.protocol === "https:" ? httpsRequest : httpRequest;
  const server = createServer((req, res) => {
    const url = new URL(target);
    url.search = new URL(req.url ?? "/", "http://proxy").search;
    const upstream = send(
      url,
      {
        method: req.method,
        headers: forwarded(req.headers, {
          host: target.host,
          authorization: `Bearer ${key}`,
        }),
      },
      (reply) => {
        res.writeHead(reply.statusCode ?? 502, forwarded(reply.headers, {}));
        reply.pipe(res);
      },
    );
    upstream.on("error", (error) => {
      if (!res.headersSent) res.writeHead(502);
      res.end(`proxy: ${error.message}`);
    });
    res.on("close", () => upstream.destroy());
    req.pipe(upstream);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as AddressInfo;
  return {
    url: new URL(`http://127.0.0.1:${String(port)}/mcp`),
    close: () =>
      new Promise((done) => {
        server.closeAllConnections();
        server.close(() => done());
      }),
  };
}

function toolEntry(): string {
  const require = createRequire(import.meta.url);
  const manifest =
    require.resolve("@modelcontextprotocol/conformance/package.json");
  const { bin } = JSON.parse(readFileSync(manifest, "utf8")) as {
    bin: { conformance: string };
  };
  return join(dirname(manifest), bin.conformance);
}

/**
 * Runs one scenario and reads its `checks.json`. The tool's exit status is
 * not the verdict, since it fails a scenario for a pinned check too.
 */
async function runScenario(
  entry: string,
  url: URL,
  scenario: string,
  output: string,
): Promise<Check[] | undefined> {
  const dir = join(output, scenario);
  console.log(`\n=== ${scenario} ===`);
  const child = spawn(
    process.execPath,
    [entry, "server", "--url", url.href, "--scenario", scenario, "-o", dir],
    { stdio: "inherit" },
  );
  const timer = setTimeout(() => child.kill("SIGKILL"), SCENARIO_BUDGET_MS);
  await new Promise((done) => child.on("close", done));
  clearTimeout(timer);
  if (!existsSync(dir)) return undefined;
  const [run] = readdirSync(dir);
  const file = run === undefined ? undefined : join(dir, run, "checks.json");
  if (file === undefined || !existsSync(file)) return undefined;
  return JSON.parse(readFileSync(file, "utf8")) as Check[];
}

function stateArg(argv: string[]): string {
  let state = resolve(".marfa-state");
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--state") state = resolve(argv[++i] ?? "");
    else throw new Error(`unexpected argument: ${argv[i] ?? ""}`);
  }
  return state;
}

async function main(): Promise<void> {
  const env = parseEnvFile(
    readFileSync(resolve(stateArg(process.argv.slice(2)), "env"), "utf8"),
  );
  const { MARFA_API_URL: base, MARFA_API_KEY: key } = env;
  if (!base || !key)
    throw new Error("the env file has no MARFA_API_URL or MARFA_API_KEY");
  const proxy = await startProxy(new URL("/mcp", base), key);
  const output = mkdtempSync(join(tmpdir(), "mcp-conformance-"));
  const results: Record<string, Check[] | undefined> = {};
  try {
    const entry = toolEntry();
    for (const scenario of SCENARIOS) {
      results[scenario] = await runScenario(entry, proxy.url, scenario, output);
    }
  } finally {
    await proxy.close();
    rmSync(output, { recursive: true, force: true });
  }
  console.log("\n=== Verdict ===");
  for (const [scenario, pins] of Object.entries(KNOWN_FAILURES)) {
    for (const [id, reason] of Object.entries(pins)) {
      console.log(`known failure ${scenario}: ${id}. ${reason}`);
    }
  }
  const found = problems(results);
  for (const line of found) console.log(`::error::${line}`);
  if (found.length > 0) process.exit(1);
  console.log(`Every check of ${REQUIRED.join(", ")} passed.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
