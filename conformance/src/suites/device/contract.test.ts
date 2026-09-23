import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, it, expect, afterEach } from "vitest";
import { newStore } from "../../device/cli-adapter.js";
import { answers } from "../../device/marfa-answers.js";
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

function scriptRoot(contract: unknown): void {
  server?.answer("GET", "/", answers.root(contract));
  server?.answer("GET", "/items", {
    kind: "json",
    status: 200,
    body: { data: [], next_cursor: null },
  });
}

describe("the contract the binary was built for", () => {
  it("refuses a server whose root answers another contract, and sends it nothing that carries the credential", async () => {
    server = await ScriptedServer.start();
    scriptRoot((await builtFor()) + 1);
    const outcome = await listItems(server.url);
    expect(outcome.code, outcome.stderr).toBe(1);
    const envelope = JSON.parse(outcome.stderr) as {
      error: { code: string };
      exit: number;
    };
    expect(envelope.error.code).toBe("contract_mismatch");
    expect(envelope.exit).toBe(1);
    expect(server.requests.map((r) => `${r.method} ${r.pathname}`)).toEqual([
      "GET /",
    ]);
    expect(server.requests[0]?.headers.authorization).toBeUndefined();
  });

  it("sends the call to a server on its contract, after reading the root without the credential", async () => {
    // The witness: the same command, the same script, the contract it was
    // built for.
    server = await ScriptedServer.start();
    scriptRoot(await builtFor());
    const outcome = await listItems(server.url);
    expect(outcome.code, outcome.stderr).toBe(0);
    expect(server.requests.map((r) => `${r.method} ${r.pathname}`)).toEqual([
      "GET /",
      "GET /items",
    ]);
    expect(server.requests[0]?.headers.authorization).toBeUndefined();
    expect(server.requests[1]?.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(server.unmatchedRequests).toEqual([]);
  });

  it("refuses a server whose root names no contract", async () => {
    server = await ScriptedServer.start();
    scriptRoot(undefined);
    const outcome = await listItems(server.url);
    expect(outcome.code, outcome.stderr).toBe(1);
    expect(
      (JSON.parse(outcome.stderr) as { error: { code: string } }).error.code,
    ).toBe("contract_mismatch");
    expect(server.requests.map((r) => `${r.method} ${r.pathname}`)).toEqual([
      "GET /",
    ]);
    expect(server.requests[0]?.headers.authorization).toBeUndefined();
  });

  it("holds the working copy to it before the key is handed over", async () => {
    server = await ScriptedServer.start();
    scriptRoot((await builtFor()) + 1);
    const outcome = await marfa([
      "--json",
      "device",
      "--db",
      newStore("contract"),
      "hydrate",
      "--url",
      server.url,
      "--key",
      KEY,
      "--types",
      "core.note",
      "--tier",
      "library",
    ]);
    expect(outcome.code, outcome.stderr).toBe(1);
    expect(
      (JSON.parse(outcome.stderr) as { error: { code: string } }).error.code,
    ).toBe("contract_mismatch");
    expect(server.requests.map((r) => `${r.method} ${r.pathname}`)).toEqual([
      "GET /",
    ]);
  });

  it("still says which server this is, and that its contract is another", async () => {
    server = await ScriptedServer.start();
    const served = (await builtFor()) + 1;
    scriptRoot(served);
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
    expect(
      server.requests.every((r) => r.headers.authorization === undefined),
    ).toBe(true);
  });
});
