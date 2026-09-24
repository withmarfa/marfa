import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, it, expect, afterEach } from "vitest";
import { BUILT_FOR, ScriptedServer } from "../../device/scripted-server.js";
import { KEY, fileOf, requireBinary } from "./harness.js";

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
async function marfa(args: string[], stdin = "") {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && !name.startsWith("MARFA_")) env[name] = value;
  }
  try {
    const pending = run(requireBinary(), args, {
      env,
      timeout: 30_000,
    });
    pending.child.stdin?.end(stdin);
    const { stdout, stderr } = await pending;
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

/**
 * What each command in the binary's own table is run with: the arguments it
 * needs to reach the server, and no more. The values are placeholders, since
 * the scripted server answers every door alike.
 */
const ID = "01JAAAAAAAAAAAAAAAAAAAAAAA";
const HASH = `sha256:${"a".repeat(64)}`;
const WHEN = "2026-01-01T00:00:00Z";
const LATER = "2026-01-02T00:00:00Z";
const invocations: Record<string, () => string[]> = {
  "items create": () => ["--type", "core.note"],
  "items list": () => [],
  "items stats": () => [],
  "items get": () => [ID],
  "items update": () => ["--version", "1", "--properties", "{}", ID],
  "items delete": () => [ID],
  "items restore": () => [ID],
  "items transition": () => ["--state", "archived", ID],
  "items versions": () => [ID],
  "metadata get": () => [ID],
  "metadata replace": () => ["--tag", "t", ID],
  "metadata merge": () => ["--tag", "t", ID],
  "items tag": () => [ID, "t"],
  "items purge": () => [ID],
  "items untag": () => [ID, "t"],
  "items bulk": () => ["--file", fileOf("items.json", '{"items":[]}')],
  "items bulk-action": () => ["tier", "--to", "feed", "--type", "core.note"],
  "items bulk-action job": () => [ID],
  "items bulk-action cancel": () => [ID],
  "items bulk-get": () => [ID],
  "extensions list": () => [ID],
  "extensions get": () => [ID, "ns"],
  "extensions write": () => ["--body", "{}", ID, "ns"],
  "extensions delete": () => [ID, "ns"],
  "items edges": () => [ID],
  "items backrefs": () => [ID],
  "edges list": () => [],
  "edges create": () => ["--source", ID, "--target", ID, "--type", "about"],
  "edges get": () => [ID],
  "edges update": () => ["--properties", "{}", "--version", "1", ID],
  "edges delete": () => [ID],
  "edges bulk": () => ["--file", fileOf("edges.json", '{"edges":[]}')],
  "edge-types register": () => ["--body", '{"id":"user.e"}'],
  "edge-types list": () => [],
  "edge-types delete": () => ["user.e"],
  "types list": () => [],
  "types register": () => ["--body", '{"id":"user.t"}'],
  "types get": () => ["core.note"],
  "types update": () => ["--body", '{"id":"user.t"}', "user.t"],
  "types delete": () => ["user.t"],
  search: () => ["q"],
  "items occurrences": () => ["--from", WHEN, "--to", LATER],
  "metadata tags": () => [],
  "blobs upload": () => [fileOf("blob.txt", "bytes")],
  "blobs download": () => [HASH],
  "blobs url": () => [HASH],
  "keys create": () => ["--label", "l", "--source", "s"],
  "keys list": () => [],
  "keys revoke": () => [ID],
  "keys update": () => ["--label", "l", ID],
  "config get": () => [],
  "config replace": () => ["--body", "{}"],
  "types drift": () => [],
  "types prune": () => ["core.note"],
  export: () => [],
  restore: () => [fileOf("archive.tar.gz", "archive")],
  "webhooks create": () => [
    "--to",
    "https://example.com/hook",
    "--event",
    "item.created",
  ],
  "webhooks list": () => [],
  "webhooks get": () => [ID],
  "webhooks update": () => ["--inactive", ID],
  "webhooks delete": () => [ID],
  "webhooks deliveries": () => [ID],
  audit: () => [],
  events: () => ["--for", "1"],
  "blobs stores": () => [],
  "blobs locations": () => [HASH],
  "blobs drop": () => ["--store", "disk", HASH],
  "blobs orphans": () => [],
  "housekeeping list": () => [],
  "housekeeping run": () => ["heartbeat"],
  "connectors register": () => ["--name", "n"],
  "connectors list": () => [],
  "connectors get": () => [ID],
  "connectors delete": () => [ID],
  "connectors heartbeat": () => [ID],
  "connectors report": () => [
    "--outcome",
    "succeeded",
    "--started-at",
    WHEN,
    "--finished-at",
    LATER,
    ID,
  ],
  "connectors runs": () => [ID],
  login: () => ["--no-browser", "--print-token"],
  "owner show": () => [],
  "owner create": () => ["--email", "owner@example.com", "--password-stdin"],
};

/** The refusal's code, or what stderr said when it is not a refusal. */
function codeOf(stderr: string): string {
  try {
    return refusal(stderr).error.code;
  } catch {
    return stderr.split("\n")[0] ?? "";
  }
}

/** The one command that reads a server on another contract: saying so is its job. */
const DESCRIBES = "status";

describe("every command holds the server to the contract", () => {
  async function table(): Promise<{ operation_id: string; command: string }[]> {
    const outcome = await marfa(["--json", "operations"]);
    expect(outcome.code, outcome.stderr).toBe(0);
    return JSON.parse(outcome.stdout) as {
      operation_id: string;
      command: string;
    }[];
  }

  /** A server that answers every door alike, on the given contract. */
  async function everyDoor(contract: string): Promise<ScriptedServer> {
    const started = await ScriptedServer.start();
    started.contract = contract;
    for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
      started.answer(method, /^\/.+/, { kind: "json", status: 200, body: {} });
    }
    return started;
  }

  it("names an invocation for every command in the table, and nothing else", async () => {
    const commands = (await table()).map((row) => row.command);
    expect(commands.length).toBeGreaterThan(0);
    expect(Object.keys(invocations).sort()).toEqual(
      commands.filter((command) => command !== DESCRIBES).sort(),
    );
    expect(commands).toContain(DESCRIBES);
  });

  it("refuses contract_mismatch from every command but status", async () => {
    const served = String(builtFor + 1);
    for (const row of await table()) {
      if (row.command === DESCRIBES) continue;
      server = await everyDoor(served);
      const argv = invocations[row.command]?.() ?? [];
      const outcome = await marfa(
        [
          "--json",
          "--url",
          server.url,
          "--key",
          KEY,
          ...row.command.split(" "),
          ...argv,
        ],
        "a password\n",
      );
      const label = `marfa ${row.command} ${argv.join(" ")}: ${outcome.stderr.slice(0, 300)}`;
      expect.soft(outcome.code, label).toBe(1);
      expect.soft(codeOf(outcome.stderr), label).toBe("contract_mismatch");
      expect.soft(outcome.stdout, label).toBe("");
      // It reached the server: a refusal made before sending anything would
      // say nothing about the answer.
      expect.soft(server.requests.length, label).toBeGreaterThan(0);
      await server.stop();
      server = undefined;
    }
  });

  it("reads every door on its own contract, so the refusal above is the contract's", async () => {
    // The witness: the same invocations against the same answers, on the
    // contract the binary was built for, are not refused for the contract.
    for (const row of await table()) {
      if (row.command === DESCRIBES) continue;
      server = await everyDoor(BUILT_FOR);
      const argv = invocations[row.command]?.() ?? [];
      const outcome = await marfa(
        [
          "--json",
          "--url",
          server.url,
          "--key",
          KEY,
          ...row.command.split(" "),
          ...argv,
        ],
        "a password\n",
      );
      const label = `marfa ${row.command} ${argv.join(" ")}: ${outcome.stderr.slice(0, 300)}`;
      if (outcome.code !== 0) {
        expect
          .soft(codeOf(outcome.stderr), label)
          .not.toBe("contract_mismatch");
      }
      expect.soft(server.requests.length, label).toBeGreaterThan(0);
      await server.stop();
      server = undefined;
    }
  });
});
