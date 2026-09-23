import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, it, expect, afterEach } from "vitest";
import { ScriptedServer } from "../../device/scripted-server.js";
import { KEY, requireBinary } from "./harness.js";

/**
 * The binary holds a server to the contract it was built for.
 *
 * Scripted rather than real, because the real server answers the contract
 * the binary was built for and cannot be asked for another. The number the
 * binary was built for is read off the document it was generated from, so
 * the fixture moves with the document rather than with a literal.
 */

const run = promisify(execFile);

let server: ScriptedServer | undefined;

afterEach(async () => {
  await server?.stop();
  server = undefined;
});

async function builtFor(): Promise<number> {
  const document = (await import("../../../../openapi.json", {
    with: { type: "json" },
  })) as { default: { info: { version: string } } };
  return Number(document.default.info.version);
}

/** The binary against the scripted server, with nothing inherited. */
async function marfa(args: string[]) {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && !name.startsWith("MARFA_")) env[name] = value;
  }
  try {
    const { stdout, stderr } = await run(requireBinary(), args, {
      env,
      timeout: 30_000,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failed = error as { code?: number; stdout?: string; stderr?: string };
    return {
      code: failed.code ?? -1,
      stdout: failed.stdout ?? "",
      stderr: failed.stderr ?? "",
    };
  }
}

function listItems(url: string) {
  return marfa(["--json", "--url", url, "--key", KEY, "items", "list"]);
}

async function scriptItems(
  contract: string | null,
  status = 200,
): Promise<ScriptedServer> {
  const started = await ScriptedServer.start();
  started.contract = contract;
  started.answer("GET", "/items", {
    kind: "json",
    status,
    body:
      status === 200
        ? { data: [], next_cursor: null }
        : { error: { code: "bad_gateway", message: "upstream" } },
  });
  return started;
}

function refusal(stderr: string): {
  error: { code: string; server: { status: number } | null };
  exit: number;
} {
  return JSON.parse(stderr) as {
    error: { code: string; server: { status: number } | null };
    exit: number;
  };
}

const sent = (scripted: ScriptedServer) =>
  scripted.requests.map((r) => `${r.method} ${r.pathname}`);

describe("the contract the binary was built for", () => {
  it("refuses an answer on another contract rather than reading it", async () => {
    server = await scriptItems(String((await builtFor()) + 1));
    const outcome = await listItems(server.url);
    expect(outcome.code, outcome.stderr).toBe(1);
    const envelope = refusal(outcome.stderr);
    expect(envelope.error.code).toBe("contract_mismatch");
    expect(envelope.exit).toBe(1);
    expect(outcome.stdout).toBe("");
    expect(sent(server)).toEqual(["GET /items"]);
  });

  it("reads an answer on its own contract, with no round trip to the root", async () => {
    // The witness: the same command, the same script, the contract it was
    // built for.
    server = await scriptItems(String(await builtFor()));
    const outcome = await listItems(server.url);
    expect(outcome.code, outcome.stderr).toBe(0);
    expect(sent(server)).toEqual(["GET /items"]);
    expect(server.requests[0]?.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(server.unmatchedRequests).toEqual([]);
  });

  it("refuses a success that names no contract", async () => {
    server = await scriptItems(null);
    const outcome = await listItems(server.url);
    expect(outcome.code, outcome.stderr).toBe(1);
    expect(refusal(outcome.stderr).error.code).toBe("contract_mismatch");
  });

  it("hands on a refusal that names no contract, as a proxy's would", async () => {
    server = await scriptItems(null, 502);
    const outcome = await listItems(server.url);
    const envelope = refusal(outcome.stderr);
    expect(envelope.error.code).not.toBe("contract_mismatch");
    expect(envelope.error.server?.status).toBe(502);
  });

  it("still says which server this is, and that its contract is another", async () => {
    server = await ScriptedServer.start();
    const served = (await builtFor()) + 1;
    server.contract = String(served);
    server.answer("GET", "/health", {
      kind: "json",
      status: 200,
      body: { status: "ok" },
    });
    const outcome = await marfa([
      "--json",
      "--url",
      server.url,
      "--key",
      KEY,
      "status",
    ]);
    expect(outcome.code, outcome.stderr).toBe(0);
    const report = JSON.parse(outcome.stdout) as {
      contract: { served: number; built_for: number };
      stats: unknown;
    };
    expect(report.contract).toEqual({
      served,
      built_for: await builtFor(),
    });
    expect(report.stats).toBeNull();
    expect(sent(server)).toEqual(["GET /", "GET /health"]);
  });
});
