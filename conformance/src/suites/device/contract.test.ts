import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, it, expect, afterEach } from "vitest";
import { BUILT_FOR, ScriptedServer } from "../../device/scripted-server.js";
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

const builtFor = Number(BUILT_FOR);

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

/**
 * `/items` scripted, on the given contract, or on the server's default one
 * when left out, which is the binary's.
 */
async function scriptItems(
  contract?: string | null,
  status = 200,
): Promise<ScriptedServer> {
  const started = await ScriptedServer.start();
  if (contract !== undefined) started.contract = contract;
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
    server = await scriptItems(String(builtFor + 1));
    const outcome = await listItems(server.url);
    expect(outcome.code, outcome.stderr).toBe(1);
    const envelope = refusal(outcome.stderr);
    expect(envelope.error.code).toBe("contract_mismatch");
    expect(envelope.exit).toBe(1);
    expect(outcome.stdout).toBe("");
    expect(sent(server)).toEqual(["GET /items"]);
  });

  it("reads an answer on its own contract, sending only the call", async () => {
    // The witness: the same command, the same script, the contract it was
    // built for.
    server = await scriptItems();
    const outcome = await listItems(server.url);
    expect(outcome.code, outcome.stderr).toBe(0);
    expect(JSON.parse(outcome.stdout)).toEqual({ data: [], next_cursor: null });
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
    const served = builtFor + 1;
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
      built_for: builtFor,
    });
    expect(report.stats).toBeNull();
    expect(sent(server)).toEqual(["GET /", "GET /health"]);
  });

  it("refuses an event stream on another contract, and reads one on its own", async () => {
    const events = async (contract?: string) => {
      const started = await ScriptedServer.start();
      if (contract !== undefined) started.contract = contract;
      started.answer("GET", "/events", {
        kind: "sse",
        frames: [{ id: "1", event: "item.created", data: { id: "i" } }],
      });
      server = started;
      return marfa([
        "--json",
        "--url",
        started.url,
        "--key",
        KEY,
        "events",
        "--for",
        "1",
      ]);
    };
    const refused = await events(String(builtFor + 1));
    expect(refused.code, refused.stderr).toBe(1);
    expect(refusal(refused.stderr).error.code).toBe("contract_mismatch");
    await server?.stop();
    // The witness: the same stream on the server's default contract, which
    // is the binary's, is read.
    const read = await events();
    expect(read.code, read.stderr).toBe(0);
    expect(read.stdout).toContain("item.created");
  });

  it("says in words that the server speaks another contract", async () => {
    server = await ScriptedServer.start();
    server.contract = String(builtFor + 1);
    server.answer("GET", "/health", {
      kind: "json",
      status: 200,
      body: { status: "ok" },
    });
    const outcome = await marfa(["--url", server.url, "status"]);
    expect(outcome.code, outcome.stderr).toBe(0);
    expect(outcome.stdout).toContain(
      `contract ${String(builtFor + 1)}; this marfa was built for contract ${String(builtFor)}`,
    );
  });
});
