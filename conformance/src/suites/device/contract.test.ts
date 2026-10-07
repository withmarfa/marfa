import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import {
  answers,
  certifiedRead,
  copyHeadRead,
  copyItemEvent,
  itemsPage,
  refusal as refused,
  copyReplay,
  edgeTypeCatalog,
  typeCatalog,
  wireItem,
} from "../../device/marfa-answers.js";
import {
  BUILT_FOR,
  ScriptedServer,
  type Answer,
} from "../../device/scripted-server.js";
import type { HeldCommand } from "../../device/cli-adapter.js";
import { keychainEnv } from "../../utils/keychain.js";
import {
  KEY,
  acceptUploads,
  fileOf,
  hashOf,
  hydratedHarness,
  requireBinary,
  scriptBlob,
  scriptHydration,
  scriptKey,
  scriptWrites,
  startHarness,
  type Harness,
} from "./harness.js";

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

let harness: Harness | undefined;

afterEach(async () => {
  await server?.stop();
  server = undefined;
  await harness?.stop();
  harness = undefined;
});

const builtFor = Number(BUILT_FOR);

/** The binary against the scripted server, with nothing inherited. */
async function marfa(
  args: string[],
  stdin?: string,
  extra: Record<string, string> = {},
) {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && !name.startsWith("MARFA_")) env[name] = value;
  }
  Object.assign(env, keychainEnv(), extra);
  try {
    const pending = run(requireBinary(), args, {
      env,
      timeout: 30_000,
      // A docs page at the most the command reads is 10 MiB, twice over in
      // `--json`.
      maxBuffer: 64 * 1024 * 1024,
    });
    // An empty write can outlive a short-lived --help process and raise EPIPE.
    pending.child.stdin?.end(stdin || undefined);
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
  started.copyAnswer("GET", "/items", {
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

/** A JSON answer naming `contract` rather than the server's. */
function naming(answer: Answer, contract: string | string[] | null): Answer {
  if (answer.kind !== "json") {
    throw new Error("only a JSON answer names a contract of its own");
  }
  return { ...answer, contract };
}

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

  it("refuses an answer that names its contract twice, differently", async () => {
    const twice = async (contract: string[]) => {
      const started = await ScriptedServer.start();
      started.copyAnswer(
        "GET",
        "/items",
        naming(
          {
            kind: "json",
            status: 200,
            body: { data: [], next_cursor: null },
          },
          contract,
        ),
      );
      server = started;
      const outcome = await listItems(started.url);
      await started.stop();
      server = undefined;
      return outcome;
    };
    const other = String(builtFor + 1);
    for (const contract of [
      [BUILT_FOR, other],
      [other, BUILT_FOR],
    ]) {
      const outcome = await twice(contract);
      expect(
        outcome.code,
        `${contract.join(" then ")}: ${outcome.stderr}`,
      ).toBe(1);
      expect(refusal(outcome.stderr).error.code).toBe("contract_mismatch");
    }
    // The witness: the same contract named twice is one contract, and read.
    const same = await twice([BUILT_FOR, BUILT_FOR]);
    expect(same.code, same.stderr).toBe(0);
  });

  it("hands on a refusal that names no contract, as a proxy's would", async () => {
    server = await scriptItems(null, 502);
    const outcome = await listItems(server.url);
    const envelope = refusal(outcome.stderr);
    expect(envelope.error.code).not.toBe("contract_mismatch");
    expect(envelope.error.server?.status).toBe(502);
    expect([envelope.error.code, envelope.exit, outcome.code]).toEqual([
      "unnamed_answer",
      3,
      3,
    ]);
  });

  it("says a write it refused for its contract was sent and may have taken effect", async () => {
    server = await ScriptedServer.start();
    server.copyAnswer(
      "POST",
      "/items",
      naming(
        { kind: "json", status: 201, body: { item: {} } },
        String(builtFor + 1),
      ),
    );
    const outcome = await marfa([
      "--json",
      "--url",
      server.url,
      "--key",
      KEY,
      "items",
      "create",
      "--type",
      "core.note",
      "--properties",
      JSON.stringify({ title: "sent", body: "sent" }),
    ]);
    expect(outcome.code, outcome.stderr).toBe(1);
    expect(refusal(outcome.stderr).error.code).toBe("contract_mismatch");
    expect(
      outcome.stderr,
      "a write refused for its contract did not say it may have taken effect",
    ).toContain("may have taken effect");
    expect(sent(server)).toEqual(["POST /items"]);
  });

  it("refuses a redirect without following it", async () => {
    server = await ScriptedServer.start();
    server.copyAnswer("GET", "/items", {
      kind: "json",
      status: 307,
      body: {},
      headers: { location: "/elsewhere" },
    });
    const outcome = await listItems(server.url);
    expect(outcome.code, outcome.stderr).toBe(1);
    const envelope = refusal(outcome.stderr);
    expect([envelope.error.code, envelope.error.server?.status]).toEqual([
      "redirect",
      307,
    ]);
    expect(outcome.stderr).toContain("/elsewhere");
    expect(sent(server), "the redirect was followed").toEqual(["GET /items"]);
  });

  it("still says which server this is, and that its contract is another", async () => {
    server = await ScriptedServer.start();
    const served = builtFor + 1;
    server.contract = String(served);
    server.copyAnswer("GET", "/health", {
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

  it("takes the served contract from the answer's header, whatever the root's body says", async () => {
    // Every answer names its contract in the header, and that is what every
    // other door is held to; a root whose body claimed the built-for
    // contract would otherwise let `status` read on and `whoami` name the
    // server as speaking it.
    const served = builtFor + 1;
    for (const [command, header, body] of [
      ["status", served, builtFor],
      ["whoami", served, builtFor],
      // The witness: the other way about, a body naming another contract
      // under a header naming the built-for one, reports the built-for one.
      ["status", builtFor, served],
      ["whoami", builtFor, served],
    ] as const) {
      server = await ScriptedServer.start();
      server.contract = String(header);
      server.copyAnswer("GET", "/", answers.root(body));
      server.copyAnswer("GET", "/health", {
        kind: "json",
        status: 200,
        body: { status: "ok" },
      });
      server.copyAnswer("GET", "/items/stats", {
        kind: "json",
        status: 200,
        body: {},
      });
      const outcome = await marfa([
        "--json",
        "--url",
        server.url,
        "--key",
        KEY,
        command,
      ]);
      const label = `${command} under contract ${String(header)}: ${outcome.stderr}`;
      expect(outcome.code, label).toBe(0);
      const report = JSON.parse(outcome.stdout) as {
        contract: { served: number; built_for: number };
      };
      expect(report.contract, label).toEqual({
        served: header,
        built_for: builtFor,
      });
      await server.stop();
      server = undefined;
    }
  });

  it("refuses an event stream on another contract, and reads one on its own", async () => {
    const events = async (contract?: string) => {
      const started = await ScriptedServer.start();
      if (contract !== undefined) started.contract = contract;
      started.copyAnswer("GET", "/events", {
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
    server.copyAnswer("GET", "/health", {
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

  const statusWithCounts = async (stats: Answer) => {
    const started = await ScriptedServer.start();
    server = started;
    started.copyAnswer("GET", "/health", {
      kind: "json",
      status: 200,
      body: { status: "ok" },
    });
    started.copyAnswer("GET", "/items/stats", stats);
    const outcome = await marfa([
      "--json",
      "--url",
      started.url,
      "--key",
      KEY,
      "status",
    ]);
    return { started, outcome };
  };

  it("describes the server to a key that reaches no type, and says the counts need a working key", async () => {
    const { started, outcome } = await statusWithCounts(
      answers.forbidden("type_not_permitted"),
    );
    expect(outcome.code, outcome.stderr).toBe(0);
    const report = JSON.parse(outcome.stdout) as {
      health: unknown;
      stats: unknown;
      stats_refused: unknown;
    };
    expect(report.health).toEqual({ status: "ok" });
    expect(report.stats).toBeNull();
    expect(report.stats_refused).toBe("type_not_permitted");
    // The counts were asked for, so the null is the refusal's.
    expect(sent(started)).toEqual(["GET /", "GET /health", "GET /items/stats"]);
    const words = await marfa(["--url", started.url, "--key", KEY, "status"]);
    expect(words.code, words.stderr).toBe(0);
    expect(words.stdout).toContain("health ok");
    expect(words.stdout).toContain("items need a working key");
  });

  it("hands on any other refusal of the counts", async () => {
    const { outcome } = await statusWithCounts(answers.unauthorized());
    expect(outcome.code, outcome.stderr).toBe(5);
    expect(refusal(outcome.stderr).error.server?.status).toBe(401);
  });

  it("mints the operator key with a bootstrap secret read from stdin", async () => {
    const secret = "c".repeat(64);
    const bootstrap = async (stdin: string) => {
      const started = await ScriptedServer.start();
      started.answer("POST", "/keys", {
        kind: "json",
        status: 201,
        body: { key: "marfa_k1_operator", id: "k", label: "operator" },
      });
      server = started;
      const outcome = await marfa(
        ["--json", "--url", started.url, "keys", "bootstrap"],
        stdin,
      );
      const mints = started.requests.filter(
        (request) => request.method === "POST" && request.pathname === "/keys",
      );
      await started.stop();
      server = undefined;
      return { outcome, mints };
    };
    const read = await bootstrap(`${secret}\n`);
    expect(read.outcome.code, read.outcome.stderr).toBe(0);
    expect(read.outcome.stdout).toContain("marfa_k1_operator");
    expect(read.mints).toHaveLength(1);
    expect(read.mints[0]?.headers.authorization).toBe(`Bearer ${secret}`);
    // With the mint above as its witness: no secret on stdin sends none.
    const empty = await bootstrap("");
    expect(empty.outcome.code).not.toBe(0);
    expect(empty.mints).toEqual([]);
    const invalid = await bootstrap("  \n");
    expect(invalid.outcome.code).toBe(1);
    expect(refusal(invalid.outcome.stderr).error.code).toBe("invalid");
    expect(invalid.mints).toEqual([]);
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
  "metadata update": () => ["--tag", "t", ID],
  "items tag": () => [ID, "t"],
  "items purge": () => [ID],
  "items untag": () => [ID, "t"],
  "items bulk": () => ["--file", fileOf("items.json", '{"items":[]}')],
  "items bulk-action": () => ["tier", "--to", "feed", "--type", "core.note"],
  "items bulk-action job": () => [ID],
  "items bulk-action cancel": () => [ID],
  "items bulk-get": () => [ID],
  "items lookup": () => ["--type", "core.note", "--id", ID],
  "items tombstones": () => [
    "--type",
    "core.note",
    "--link",
    "v",
    "--settled-at",
    WHEN,
  ],
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
  "types replace": () => ["--body", '{"id":"user.t"}', "user.t"],
  "types delete": () => ["user.t"],
  search: () => ["q"],
  "items occurrences": () => ["--from", WHEN, "--to", LATER],
  "metadata tags": () => [],
  "blobs upload": () => [fileOf("blob.txt", "bytes")],
  "blobs download": () => [HASH],
  "blobs url": () => [HASH],
  "keys create": () => ["--label", "l", "--source", "s"],
  "keys list": () => [],
  "keys current": () => [],
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
  "webhooks redeliver": () => [ID, ID],
  audit: () => [],
  events: () => ["--for", "1"],
  "blobs stores": () => [],
  "blobs locations": () => [HASH],
  "blobs delete-location": () => ["--store", "disk", HASH],
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
  "connectors endpoints create": () => [ID],
  "connectors endpoints list": () => [ID],
  "connectors endpoints retire": () => [ID, ID],
  "connectors deliveries list": () => [ID],
  "connectors deliveries body": () => [ID, ID],
  "connectors deliveries handle": () => ["--outcome", "processed", ID, ID],
  "connectors hold": () => ["--process", "p", ID],
  "connectors release": () => ["--process", "p", ID],
  "connectors state get": () => [ID],
  "connectors state put": () => ["--process", "p", "--body", "{}", ID],
  "connectors state delete": () => [ID],
  "connectors agreements write": () => ["--process", "p", "--body", "{}", ID],
  "connectors agreements lookup": () => [ID, ID],
  "connectors agreements list": () => ["--waiting", "true", ID],
  "folders create": () => ["--title", "t"],
  "folders change": () => ["--version", "1", "--title", "t", ID],
  "folders revoke": () => [ID],
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

/**
 * Commands outside the table that reach the server, driven the same way:
 * the table lists published operations, and these reach one without being
 * its entry.
 */
const beyondTheTable: Record<string, () => string[]> = {
  "keys bootstrap": () => ["--secret", "s"],
};

const stdinFor: Record<string, string> = {
  "owner create": "a password\n",
};

/**
 * Commands beyond the table driven only to their refusal, so their silence
 * there has no witness here: `keys keep` would make its origin current in
 * the keychain every file of the project shares, and `items attach` and
 * `items add` cannot succeed against a door whose `{}` is no upload's answer.
 */
const refusedOnly: Record<string, () => string[]> = {
  "items attach": () => [ID, fileOf("attached.txt", "bytes")],
  "items add": () => [fileOf("added.txt", "bytes")],
  "keys keep": () => [],
};

/**
 * Commands the binary has that no case here drives, each with why: the
 * completeness check below holds the binary's own command tree to the
 * driven set and this list, so a command added later is driven or said to
 * need no driving.
 */
const NOT_DRIVEN: Record<string, string> = {
  status: "describes a server on another contract; held by its own case",
  whoami: "describes a server on another contract; held by its own case",
  logout: "revokes and forgets the token, printing nothing it was answered",
  "keys forget": "forgets a kept credential, sending nothing",
  operations: "prints the table, sending nothing; held by its own case",
  "docs search":
    "reads the docs site, which is not a server; held by its own case",
  "docs topics":
    "reads the docs site, which is not a server; held by its own case",
};

/**
 * Group commands whose subcommands each send the one operation the table
 * names for the group, so the group's invocation speaks for them. Named, so
 * a subcommand added under any other command is its own to drive.
 */
const GROUPS = ["items bulk-action"];

/**
 * Roots whose commands go through the core's transport rather than the
 * binary's, which the working-copy block below holds to the contract; those
 * the table names (`folders create`, `change`, `revoke`) are driven above.
 */
const THROUGH_THE_CORE = ["device", "folders"];

/** Every leaf command the binary has, read off its own help. */
async function commandTree(path: string[] = []): Promise<string[]> {
  const outcome = await marfa([...path, "--help"]);
  const section =
    (outcome.stdout.split(/^Commands:$/m)[1] ?? "").split(/^\S/m)[0] ?? "";
  // Every line that opens a command, read whole, so a name this pattern
  // does not expect fails here rather than being skipped.
  const lines = section.split("\n").filter((line) => /^ {2}\S/.test(line));
  const names = lines
    .map((line) => {
      const name = /^ {2}(\S+)/.exec(line)?.[1] ?? "";
      if (!/^[a-z][a-z0-9-]*$/.test(name)) {
        throw new Error(`\`marfa ${path.join(" ")} --help\` lists ${name}`);
      }
      return name;
    })
    .filter((name) => name !== "help");
  if (names.length === 0) return [path.join(" ")];
  const leaves: string[] = [];
  for (const name of names)
    leaves.push(...(await commandTree([...path, name])));
  return leaves;
}

/** Every command driven here, as the table names it and beyond it. */
async function driven(): Promise<{ command: string }[]> {
  const outcome = await marfa(["--json", "operations"]);
  const rows = JSON.parse(outcome.stdout) as { command: string }[];
  return [
    ...rows,
    ...Object.keys(beyondTheTable).map((command) => ({ command })),
  ];
}

/** The one command that reads a server on another contract: saying so is its job. */
const DESCRIBES = "status";

/**
 * Commands that print nothing against a door answering `{}` on their own
 * contract, so the answers here cannot witness their silence: `events`
 * reads a stream, and the stream test above reads one on its own contract;
 * `login` needs a sign-in the door cannot complete, so its refusal is held
 * by its code alone.
 */
const SILENT_HERE = ["events", "login"];

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
  async function everyDoor(
    contract: string,
    root: string | null = BUILT_FOR,
  ): Promise<ScriptedServer> {
    const started = await ScriptedServer.start();
    started.contract = contract;
    // The root answers the contract the binary was built for, header and
    // body, unless a case says otherwise, so a write that reads the root
    // before it mints is sent, and it is the mint's own answer that has to
    // be refused.
    started.copyAnswer(
      "GET",
      "/",
      Object.assign(answers.root(builtFor), { contract: root }),
    );
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

  it("sends nothing to print the table", async () => {
    server = await everyDoor(String(builtFor + 1));
    const outcome = await marfa(["--json", "--url", server.url, "operations"]);
    expect(outcome.code, outcome.stderr).toBe(0);
    // Witness: it printed the table it was asked for.
    expect(JSON.parse(outcome.stdout)).not.toHaveLength(0);
    expect(server.requests).toEqual([]);
  });

  it("reads the docs site, which names no contract and is sent no credential", async () => {
    const markdown = "# Files\n\nKeep files.\n\n";
    server = await ScriptedServer.start();
    // The site names no contract on any answer, as the real one does not.
    server.answer("GET", "/api/docs/search", {
      kind: "json",
      status: 200,
      contract: null,
      body: {
        hits: [
          {
            title: "Files",
            url: "https://docs.marfa.so/get-started/files",
            snippets: ["Keep files."],
          },
        ],
      },
    });
    server.answer("GET", "/api/docs/topics", {
      kind: "json",
      status: 200,
      contract: null,
      body: {
        pages: [
          {
            title: "Files",
            url: "https://docs.marfa.so/get-started/files",
            description: null,
            breadcrumbs: [],
          },
        ],
      },
    });
    server.answer(
      "GET",
      "/get-started/files.md",
      {
        kind: "bytes",
        status: 200,
        body: Buffer.from(markdown),
        contentType: "text/markdown; charset=utf-8",
      },
      {
        kind: "bytes",
        status: 200,
        body: Buffer.from(markdown),
        contentType: "text/markdown; charset=utf-8",
      },
    );
    server.answer("GET", "/missing/page.md", {
      kind: "bytes",
      status: 404,
      body: Buffer.from("not found"),
      contentType: "text/plain; charset=utf-8",
    });
    const site = { MARFA_DOCS_URL: server.url };
    // A server's key and address named for the commands that read a Marfa
    // server must change nothing here: the docs site is addressed only by
    // its own variable.
    const elsewhere = {
      ...site,
      MARFA_API_URL: "http://127.0.0.1:1",
      MARFA_API_KEY: KEY,
    };

    const search = await marfa(
      ["--json", "docs", "search", "keep files", "--limit", "3"],
      undefined,
      elsewhere,
    );
    expect(search.code, search.stderr).toBe(0);
    expect(JSON.parse(search.stdout).hits[0].title).toBe("Files");
    const topics = await marfa(
      ["--json", "docs", "topics"],
      undefined,
      elsewhere,
    );
    expect(topics.code, topics.stderr).toBe(0);
    expect(JSON.parse(topics.stdout).pages[0].title).toBe("Files");
    const page = await marfa(
      ["docs", "/docs/get-started/files.md"],
      undefined,
      elsewhere,
    );
    expect(page.code, page.stderr).toBe(0);
    expect(page.stdout).toBe(markdown);
    const record = await marfa(
      ["--json", "docs", "get-started/files"],
      undefined,
      elsewhere,
    );
    expect(record.code, record.stderr).toBe(0);
    expect(JSON.parse(record.stdout)).toEqual({
      path: "get-started/files",
      url: `${server.url}/get-started/files.md`,
      markdown,
    });

    expect(sent(server)).toEqual([
      "GET /api/docs/search",
      "GET /api/docs/topics",
      "GET /get-started/files.md",
      "GET /get-started/files.md",
    ]);
    expect(server.requests[0]?.query.get("q")).toBe("keep files");
    expect(server.requests[0]?.query.get("limit")).toBe("3");
    expect(server.requests[1]?.query.size).toBe(0);
    for (const request of server.requests) {
      expect(request.headers.authorization).toBeUndefined();
    }

    const missing = await marfa(
      ["--json", "docs", "missing/page"],
      undefined,
      site,
    );
    expect(missing.code, missing.stderr).toBe(1);
    expect(missing.stdout).toBe("");
    const envelope = refusal(missing.stderr);
    expect(envelope.error.code).toBe("docs_page_not_found");
    expect(envelope.exit).toBe(1);
    expect(server.unmatchedRequests).toEqual([]);

    // Nothing listens on port 1.
    const down = await marfa(["--json", "docs", "topics"], undefined, {
      MARFA_DOCS_URL: "http://127.0.0.1:1",
    });
    expect(down.code, down.stderr).toBe(3);
    expect(down.stdout).toBe("");
    expect(refusal(down.stderr).error.code).toBe("docs_unreachable");
  });

  /** A docs site's answer for a page: Markdown, as the real site serves it. */
  const markdownPage = (body: string | Buffer, status = 200): Answer => ({
    kind: "bytes",
    status,
    body: Buffer.from(body),
    contentType: "text/markdown; charset=utf-8",
  });

  /** The command against a docs site, with a Marfa server's address and key beside it. */
  const docs = (site: string, args: string[]) =>
    marfa(["--json", "docs", ...args], undefined, {
      MARFA_DOCS_URL: site,
      MARFA_API_URL: "http://127.0.0.1:1",
      MARFA_API_KEY: KEY,
    });

  it("names the page a docs site does not hold, and the site that answers with a fault", async () => {
    server = await ScriptedServer.start();
    server.answer("GET", "/missing/page.md", markdownPage("not found", 404));
    for (const status of [500, 503, 403]) {
      server.answer(
        "GET",
        `/faulty-${String(status)}.md`,
        markdownPage("no", status),
      );
    }
    const missing = await docs(server.url, ["missing/page"]);
    expect(missing.code, missing.stderr).toBe(1);
    expect(refusal(missing.stderr).error.code).toBe("docs_page_not_found");
    expect(missing.stderr).toContain("missing/page");
    for (const status of [500, 503, 403]) {
      const faulty = await docs(server.url, [`faulty-${String(status)}`]);
      expect(faulty.code, `${String(status)}: ${faulty.stderr}`).toBe(3);
      expect(faulty.stdout).toBe("");
      expect(refusal(faulty.stderr).error.code).toBe("docs_unreachable");
      expect(faulty.stderr).toContain(server.url);
    }
  });

  it("exits 3 with decoding for a docs search or topics answer that is not the JSON read, printing none of it", async () => {
    server = await ScriptedServer.start();
    // Consumed in order: a body that is not the shape read, then entries
    // without the title or the address each carries.
    server.answer(
      "GET",
      "/api/docs/search",
      {
        kind: "json",
        status: 200,
        contract: null,
        body: { hits: "catch-all" },
      },
      {
        kind: "json",
        status: 200,
        contract: null,
        body: { hits: [{ url: "https://docs.marfa.so/untitled" }] },
      },
    );
    server.answer(
      "GET",
      "/api/docs/topics",
      {
        kind: "bytes",
        status: 200,
        body: Buffer.from("<html>catch-all</html>"),
        contentType: "application/json",
      },
      {
        kind: "json",
        status: 200,
        contract: null,
        body: { pages: [{ title: "Nowhere" }] },
      },
    );
    for (const args of [
      ["search", "files"],
      ["topics"],
      ["search", "files"],
      ["topics"],
    ]) {
      const outcome = await docs(server.url, args);
      expect(outcome.code, outcome.stderr).toBe(3);
      expect(outcome.stdout).toBe("");
      expect(refusal(outcome.stderr).error.code).toBe("decoding");
      expect(outcome.stderr).not.toContain("<html>");
    }
    expect(sent(server)).toEqual([
      "GET /api/docs/search",
      "GET /api/docs/topics",
      "GET /api/docs/search",
      "GET /api/docs/topics",
    ]);
  });

  it("exits 3 with decoding for a docs page served as HTML, printing none of it", async () => {
    server = await ScriptedServer.start();
    // Consumed in order: the catch-all page first, then the Markdown.
    server.answer(
      "GET",
      "/get-started/files.md",
      {
        kind: "bytes",
        status: 200,
        body: Buffer.from("<html>catch-all</html>"),
        contentType: "text/html; charset=utf-8",
      },
      markdownPage("# Files\n"),
    );
    const outcome = await docs(server.url, ["get-started/files"]);
    expect(outcome.code, outcome.stderr).toBe(3);
    expect(outcome.stdout).toBe("");
    expect(refusal(outcome.stderr).error.code).toBe("decoding");
    expect(outcome.stderr).not.toContain("<html>");
    // The witness: the same page served as Markdown is printed.
    const served = await docs(server.url, ["get-started/files"]);
    expect(served.code, served.stderr).toBe(0);
    expect(JSON.parse(served.stdout).markdown).toBe("# Files\n");
  });

  /** `/r0.md` redirects to `/r1.md` and so on, `hops` times, then serves the page. */
  async function redirecting(hops: number): Promise<ScriptedServer> {
    const started = await ScriptedServer.start();
    started.answer("GET", /^\/r\d+\.md$/, (request) => {
      const at = Number(/\/r(\d+)\.md/.exec(request.pathname)?.[1]);
      return at < hops
        ? {
            kind: "json",
            status: 302,
            contract: null,
            body: {},
            headers: { location: `/r${String(at + 1)}.md` },
          }
        : markdownPage("# Moved\n");
    });
    return started;
  }

  it("follows up to five redirects in a row from the docs site, and exits 3 with docs_unreachable past that", async () => {
    server = await redirecting(5);
    const five = await docs(server.url, ["r0"]);
    expect(five.code, five.stderr).toBe(0);
    expect(JSON.parse(five.stdout).markdown).toBe("# Moved\n");
    expect(sent(server)).toHaveLength(6);
    await server.stop();

    server = await redirecting(6);
    const six = await docs(server.url, ["r0"]);
    expect(six.code, six.stderr).toBe(3);
    expect(six.stdout).toBe("");
    expect(refusal(six.stderr).error.code).toBe("docs_unreachable");
    expect(sent(server)).toHaveLength(6);
  });

  it("reports the address a docs page was asked for, not the one a redirect led to", async () => {
    server = await redirecting(2);
    const outcome = await docs(server.url, ["r0"]);
    expect(outcome.code, outcome.stderr).toBe(0);
    expect(JSON.parse(outcome.stdout).url).toBe(`${server.url}/r0.md`);
    expect(sent(server)).toEqual(["GET /r0.md", "GET /r1.md", "GET /r2.md"]);
  });

  it("refuses --url and --key on docs with usage, sending nothing", async () => {
    server = await ScriptedServer.start();
    for (const flags of [
      ["--url", server.url],
      ["--key", KEY],
    ]) {
      for (const command of [
        ["topics"],
        ["search", "files"],
        ["get-started/files"],
      ]) {
        const outcome = await marfa(
          [...flags, "--json", "docs", ...command],
          undefined,
          { MARFA_DOCS_URL: server.url },
        );
        expect(outcome.code, outcome.stderr).toBe(2);
        expect(outcome.stdout).toBe("");
        expect(refusal(outcome.stderr).error.code).toBe("usage");
      }
    }
    expect(server.requests).toEqual([]);
  });

  it("refuses a docs page path it does not accept with invalid, sending nothing", async () => {
    server = await ScriptedServer.start();
    for (const named of ["../outside", "a b", "a//b", "a%2fb", "/", ""]) {
      const outcome = await docs(server.url, [named]);
      expect(outcome.code, `${named}: ${outcome.stderr}`).toBe(1);
      expect(outcome.stdout).toBe("");
      expect(refusal(outcome.stderr).error.code).toBe("invalid");
    }
    expect(server.requests).toEqual([]);
  });

  it("refuses a docs address that is not http or https with invalid, sending nothing", async () => {
    server = await ScriptedServer.start();
    const host = server.url.replace("http://", "");
    for (const address of [
      "not a url",
      `ftp://${host}`,
      host,
      `${server.url}/?q=1`,
      `${server.url}#top`,
    ]) {
      const outcome = await docs(address, ["get-started/files"]);
      expect(outcome.code, `${address}: ${outcome.stderr}`).toBe(1);
      expect(outcome.stdout).toBe("");
      expect(refusal(outcome.stderr).error.code).toBe("invalid");
    }
    expect(server.requests).toEqual([]);
  });

  it("exits 3 with decoding for a docs answer larger than the command reads", async () => {
    const limit = 10 * 1024 * 1024;
    server = await ScriptedServer.start();
    server.answer("GET", "/big.md", markdownPage(Buffer.alloc(limit + 1, "a")));
    server.answer("GET", "/exact.md", markdownPage(Buffer.alloc(limit, "a")));
    const big = await docs(server.url, ["big"]);
    expect(big.code, big.stderr.slice(0, 300)).toBe(3);
    expect(big.stdout).toBe("");
    expect(refusal(big.stderr).error.code).toBe("decoding");
    // The witness: a body of exactly the limit is read.
    const exact = await docs(server.url, ["exact"]);
    expect(exact.code, exact.stderr.slice(0, 300)).toBe(0);
    expect(JSON.parse(exact.stdout).markdown).toHaveLength(limit);
  });

  it("exits 3 with decoding for a docs page that is not UTF-8", async () => {
    server = await ScriptedServer.start();
    server.answer(
      "GET",
      "/get-started/files.md",
      markdownPage(Buffer.from([0xff, 0xfe, 0xfd])),
    );
    const outcome = await docs(server.url, ["get-started/files"]);
    expect(outcome.code, outcome.stderr).toBe(3);
    expect(outcome.stdout).toBe("");
    expect(refusal(outcome.stderr).error.code).toBe("decoding");
  });

  it("reads one docs page however it is named: with a slash, under docs/, with .md, or by its address", async () => {
    server = await ScriptedServer.start();
    server.answer("GET", "/get-started/files.md", markdownPage("# Files\n"));
    for (const named of [
      "get-started/files",
      "/get-started/files",
      "get-started/files/",
      "get-started/files.md",
      "docs/get-started/files",
      "/docs/get-started/files.md",
      "get-started/files#a-heading",
      "get-started/files?from=search",
      "https://docs.marfa.so/get-started/files",
      "https://docs.marfa.so/docs/get-started/files.md",
      "http://docs.marfa.so/get-started/files",
    ]) {
      const outcome = await docs(server.url, [named]);
      expect(outcome.code, `${named}: ${outcome.stderr}`).toBe(0);
      expect(JSON.parse(outcome.stdout).path).toBe("get-started/files");
    }
    expect(new Set(sent(server))).toEqual(
      new Set(["GET /get-started/files.md"]),
    );
    expect(sent(server)).toHaveLength(11);
  });

  it("posts redelivery with encoded ids and no body", async () => {
    server = await ScriptedServer.start();
    server.answer(
      "POST",
      "/webhooks/webhook%20id/deliveries/delivery%2Fid/redeliver",
      {
        kind: "json",
        status: 202,
        body: { id: "delivery/id", status: "pending" },
      },
    );
    const outcome = await marfa([
      "--json",
      "--url",
      server.url,
      "--key",
      KEY,
      "webhooks",
      "redeliver",
      "webhook id",
      "delivery/id",
    ]);
    expect(outcome.code, outcome.stderr).toBe(0);
    expect(JSON.parse(outcome.stdout)).toMatchObject({
      id: "delivery/id",
      status: "pending",
    });
    expect(server.requests).toHaveLength(1);
    expect(server.requests[0]).toMatchObject({
      method: "POST",
      target: "/webhooks/webhook%20id/deliveries/delivery%2Fid/redeliver",
      body: "",
    });
    expect(server.requests[0]?.headers.authorization).toBe(`Bearer ${KEY}`);
  });

  it("sends no mint to a server whose root names another contract, or none", async () => {
    // The root's header decides, whatever its body says, so the only
    // request is the root's; the witness is the same mint sent on to a
    // root on the built-for contract.
    const mints: Record<string, string[]> = {
      "keys create": invocations["keys create"]?.() ?? [],
      "keys bootstrap": beyondTheTable["keys bootstrap"]?.() ?? [],
      "webhooks create": invocations["webhooks create"]?.() ?? [],
    };
    for (const [command, argv] of Object.entries(mints)) {
      for (const header of [String(builtFor + 1), null, BUILT_FOR]) {
        server = await everyDoor(BUILT_FOR, header);
        const outcome = await marfa([
          "--json",
          "--url",
          server.url,
          "--key",
          KEY,
          ...command.split(" "),
          ...argv,
        ]);
        const label = `${command} under a root naming ${String(header)}: ${outcome.stderr.slice(0, 300)}`;
        if (header === BUILT_FOR) {
          expect(sent(server).length, label).toBeGreaterThan(1);
        } else {
          expect(outcome.code, label).toBe(1);
          expect(codeOf(outcome.stderr), label).toBe("contract_mismatch");
          expect(sent(server), label).toEqual(["GET /"]);
        }
        await server.stop();
        server = undefined;
      }
    }
  });

  it("drives every command the binary has, or says why not", async () => {
    const tree = await commandTree();
    // Witness: the tree is read, and reaches below the roots.
    expect(tree).toContain("items create");
    expect(tree).toContain("keys bootstrap");
    const driven = new Set([
      ...(await table()).map((row) => row.command),
      ...Object.keys(beyondTheTable),
      ...Object.keys(refusedOnly),
      ...Object.keys(NOT_DRIVEN),
    ]);
    // A command the table names may have subcommands that each send the
    // same operation, as `items bulk-action` does, so one driven among them
    // speaks for the rest.
    const accounted = (command: string) =>
      driven.has(command) ||
      GROUPS.some((group) => command.startsWith(`${group} `));
    const unaccounted = tree.filter(
      (command) =>
        !accounted(command) &&
        !THROUGH_THE_CORE.includes(command.split(" ")[0] ?? ""),
    );
    expect(unaccounted).toEqual([]);
  });

  it("refuses contract_mismatch from every command but status", async () => {
    const served = String(builtFor + 1);
    const rows = [
      ...(await driven()),
      ...Object.keys(refusedOnly).map((command) => ({ command })),
    ];
    for (const row of rows) {
      if (row.command === DESCRIBES) continue;
      server = await everyDoor(served);
      const argv =
        (
          invocations[row.command] ??
          beyondTheTable[row.command] ??
          refusedOnly[row.command]
        )?.() ?? [];
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
        stdinFor[row.command],
      );
      const label = `marfa ${row.command} ${argv.join(" ")}: ${outcome.stderr.slice(0, 300)}`;
      expect.soft(outcome.code, label).toBe(1);
      expect.soft(codeOf(outcome.stderr), label).toBe("contract_mismatch");
      // Silence is asserted for every command; its witness is the case
      // below, which holds every table command and `keys bootstrap` but
      // `login` (`SILENT_HERE`) and the refusal-only ones to printing.
      if (row.command !== "login") {
        expect.soft(outcome.stdout, label).toBe("");
      }
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
    const printed: string[] = [];
    const rows = await driven();
    for (const row of rows) {
      if (row.command === DESCRIBES) continue;
      server = await everyDoor(BUILT_FOR);
      const argv =
        (invocations[row.command] ?? beyondTheTable[row.command])?.() ?? [];
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
        stdinFor[row.command],
      );
      const label = `marfa ${row.command} ${argv.join(" ")}: ${outcome.stderr.slice(0, 300)}`;
      if (outcome.code !== 0) {
        expect
          .soft(codeOf(outcome.stderr), label)
          .not.toBe("contract_mismatch");
      }
      expect.soft(server.requests.length, label).toBeGreaterThan(0);
      if (outcome.stdout !== "") printed.push(row.command);
      await server.stop();
      server = undefined;
    }
    // The refusal above asserts each command printed nothing, which says
    // something only of a command that prints when it is not refused.
    expect(printed.sort()).toEqual(
      rows
        .map((row) => row.command)
        .filter(
          (command) => command !== DESCRIBES && !SILENT_HERE.includes(command),
        )
        .sort(),
    );
  });
});

/**
 * The working copy holds the same server to the contract its core was built
 * for, which is the same document's (`device/contract-mismatch`).
 */
describe("the contract the working copy was built for", () => {
  const other = String(builtFor + 1);

  it.each([
    ["its own", BUILT_FOR],
    ["another", other],
    ["none", null],
  ] as const)(
    "refuses a redirect a hydration is answered with, naming %s contract, without following it",
    async (_named, contract) => {
      harness = await startHarness(`contract-redirect-${String(contract)}`);
      const { server: scripted, device } = harness;
      scripted.copyAnswer("GET", "/events", {
        kind: "json",
        status: 307,
        body: {},
        contract,
        headers: { Location: "/elsewhere" },
      });
      const refused = await device.hydrate(["core.note"], "library");
      expect(refused.ok, "a hydration followed a redirect").toBe(false);
      if (!refused.ok) {
        expect(refused.refusal.code).toBe("redirect");
        expect(refused.refusal.raw).toContain("/elsewhere");
      }
      expect(
        scripted.requests.map((request) => request.pathname),
        "the redirect was followed",
      ).toEqual(["/events"]);
      const status = await device.status();
      expect(status.ok && status.value.hydration).toBe("never");
    },
  );

  it("refuses a hydration from a server on another contract, holding nothing", async () => {
    harness = await startHarness("contract-hydrate");
    const { server: scripted, device } = harness;
    scriptHydration(scripted, {
      head: "10",
      rows: { "core.note": [{ item: { id: "n1" } }] },
    });
    scripted.contract = other;
    const refused = await device.hydrate(["core.note"], "library");
    expect(
      refused.ok,
      "a copy hydrated from a server on another contract",
    ).toBe(false);
    if (!refused.ok) {
      expect(refused.refusal.code).toBe("contract_mismatch");
      expect(refused.refusal.raw).toContain(`contract ${other}`);
      expect(refused.refusal.raw).toContain(`contract ${String(builtFor)}`);
    }
    expect(
      sent(scripted),
      "the device asked for more after an answer that named another contract",
    ).toEqual(["GET /events"]);
    const status = await device.status();
    expect(status.ok && status.value.hydration).toBe("never");

    // The witness: the same script on the core's own contract hydrates, and
    // the row is held.
    scripted.contract = String(builtFor);
    expect((await device.hydrate(["core.note"], "library")).ok).toBe(true);
    expect((await device.get("n1")).ok).toBe(true);
  });

  it("refuses a catch-up from a server on another contract", async () => {
    harness = await startHarness("contract-catch-up");
    const { server: scripted, device } = harness;
    scriptHydration(scripted, { head: "10" });
    scripted.copyAnswer(
      "GET",
      "/events",
      copyReplay("11", [
        copyItemEvent("11", "item.created", wireItem({ id: "n2" })),
      ]),
    );
    expect((await device.hydrate(["core.note"], "library")).ok).toBe(true);

    scripted.contract = other;
    const refused = await device.catchUp();
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.refusal.code).toBe("contract_mismatch");
    expect(
      (await device.get("n2")).ok,
      "an event from a stream on another contract reached the copy",
    ).toBe(false);
    const status = await device.status();
    expect(status.ok && status.value.event_cursor).toBe("10");

    // The witness: the same stream on the core's own contract is applied.
    scripted.contract = String(builtFor);
    expect((await device.catchUp()).ok).toBe(true);
    expect((await device.get("n2")).ok).toBe(true);
  });

  it("ends a held stream on another contract rather than asking again", async () => {
    harness = await startHarness("contract-follow");
    const { server: scripted, device } = harness;
    scriptHydration(scripted, { head: "10" });
    scripted.copyAnswer(
      "GET",
      "/events",
      copyReplay("11", [
        copyItemEvent("11", "item.created", wireItem({ id: "n2" })),
      ]),
    );
    expect((await device.hydrate(["core.note"], "library")).ok).toBe(true);

    const asked = scripted.requests.length;
    scripted.contract = other;
    const refused = await device.follow(10);
    expect(
      refused.ok,
      "a follow went on asking a server on another contract until its time was up",
    ).toBe(false);
    if (!refused.ok) expect(refused.refusal.code).toBe("contract_mismatch");
    expect(
      scripted.requests.length - asked,
      "the follow asked again after an answer on another contract",
    ).toBeLessThanOrEqual(2);
    expect(
      (await device.get("n2")).ok,
      "an event from a stream on another contract reached the copy",
    ).toBe(false);

    // The witness: on the core's own contract the same stream is followed,
    // and its event applied.
    scripted.contract = String(builtFor);
    const followed = await device.follow(2);
    expect(followed.ok, JSON.stringify(followed)).toBe(true);
    expect((await device.get("n2")).ok).toBe(true);
  });

  it("ends a drain on an answer from another contract, and sends the write again under its key", async () => {
    harness = await hydratedHarness("contract-drain");
    const { server: scripted, device } = harness;
    const queued = await device.create({
      type: "core.note",
      properties: { title: "sent once", body: "sent once" },
    });
    expect(queued.ok).toBe(true);
    if (!queued.ok) return;
    const id = queued.value.item_id ?? "";
    scriptWrites(scripted, {
      read: [answers.updated(wireItem({ id }))],
      create: [answers.created(wireItem({ id }))],
    });

    scripted.contract = other;
    // The root on the core's own contract, so the instance is read and the
    // answer refused is the one this case is about.
    scripted.copyAnswer("GET", "/", naming(answers.root(builtFor), BUILT_FOR));
    const refused = await device.drain();
    expect(
      refused.ok,
      "a drain read an answer from a server on another contract",
    ).toBe(false);
    if (!refused.ok) {
      expect(refused.refusal.code).toBe("contract_mismatch");
      expect(refused.refusal.raw).toContain("may have taken effect");
    }
    const queue = await device.queue();
    expect(queue.ok).toBe(true);
    if (queue.ok) {
      expect(
        queue.value.find((row) => row.id === queued.value.id)?.verdict,
        "the write took a verdict from an answer that was not read",
      ).toBeNull();
    }

    // The witness: on the core's own contract the same write is answered,
    // under the key it was sent with the first time, so the server answers
    // it from its record rather than writing it twice.
    scripted.contract = String(builtFor);
    const drained = await device.drain();
    expect(drained.ok, JSON.stringify(drained)).toBe(true);
    if (drained.ok) {
      expect(drained.value.verdicts.map((entry) => entry.verdict)).toEqual([
        "accepted",
      ]);
    }
    const keys = scripted.requests
      .filter((request) => request.method === "POST")
      .map((request) => request.headers["idempotency-key"]);
    expect(keys).toEqual([
      queued.value.idempotency_key,
      queued.value.idempotency_key,
    ]);
  });

  it("ends the pass at the first answer on another contract, sending nothing after it", async () => {
    harness = await hydratedHarness("contract-drain-ends");
    const { server: scripted, device } = harness;
    const put = await device.putBlob(
      fileOf("note.txt", Buffer.from("a note, as bytes\n")),
      "text/plain",
    );
    expect(put.ok, JSON.stringify(put)).toBe(true);
    const queued = await device.create({
      type: "core.note",
      properties: { title: "after the upload", body: "after the upload" },
    });
    expect(queued.ok).toBe(true);
    if (!put.ok || !queued.ok) return;
    acceptUploads(scripted);
    scriptWrites(scripted, {
      read: [answers.updated(wireItem({ id: queued.value.item_id ?? "" }))],
      create: [answers.created(wireItem({ id: queued.value.item_id ?? "" }))],
    });

    scripted.contract = other;
    // The root on the core's own contract, so the instance is read and the
    // answer refused is the one this case is about.
    scripted.copyAnswer("GET", "/", naming(answers.root(builtFor), BUILT_FOR));
    const ended = await device.drain();
    expect(ended.ok).toBe(false);
    if (!ended.ok) {
      expect(ended.refusal.code).toBe("contract_mismatch");
      expect(
        ended.refusal.raw,
        "the refusal of an upload's answer did not say the upload may have taken effect",
      ).toContain("may have taken effect");
    }
    const posts = () =>
      scripted.requests
        .filter((request) => request.method === "POST")
        .map((request) => request.pathname);
    expect(
      posts(),
      "the drain went on sending after an answer on another contract",
    ).toEqual(["/blobs"]);
    const queue = await device.queue();
    expect(queue.ok && queue.value.map((row) => row.verdict)).toEqual([
      null,
      null,
    ]);

    // The witness: on the core's own contract the pass sends both, and each
    // is answered.
    scripted.contract = String(builtFor);
    const drained = await device.drain();
    expect(drained.ok, JSON.stringify(drained)).toBe(true);
    if (drained.ok) {
      expect(drained.value.verdicts.map((entry) => entry.verdict)).toEqual([
        "accepted",
        "accepted",
      ]);
    }
    expect(posts()).toEqual(["/blobs", "/blobs", "/items"]);
  });

  it("keeps a row a 404 naming no contract says is gone, since a proxy's says nothing of the server's rows", async () => {
    const held = {
      id: "01a00000-0000-7000-8000-00000000000a",
      version: 3,
      properties: { title: "held", body: "held" },
    };
    harness = await hydratedHarness("contract-proxy-404", {
      rows: { "core.note": [{ item: held }] },
    });
    const { server: scripted, device } = harness;
    const notFound = (contract?: null) => ({
      ...refused(404, "item_not_found", "no such item"),
      ...(contract === null ? { contract } : {}),
    });
    // Each refused update is reconciled against the server's row: the first
    // read is answered by a proxy, the second by the server.
    scriptWrites(scripted, {
      update: [refused(400, "invalid_properties", "not a title")],
      read: [notFound(null), notFound()],
    });
    const edit = () =>
      device.update(held.id, {
        properties: { title: "edited" },
        version: held.version,
      });

    expect((await edit()).ok).toBe(true);
    const first = await device.drain();
    expect(first.ok && first.value.verdicts[0]?.verdict).toBe("refused");
    expect(
      (await device.get(held.id)).ok,
      "the copy forgot a row the server holds because a proxy answered 404",
    ).toBe(true);

    // The witness: the server's own 404 is the row's absence, and the copy
    // forgets it.
    expect((await edit()).ok).toBe(true);
    const second = await device.drain();
    expect(second.ok && second.value.verdicts[0]?.verdict).toBe("refused");
    expect((await device.get(held.id)).ok).toBe(false);
  });

  it("refuses a blob's link from a server on another contract", async () => {
    harness = await hydratedHarness("contract-blob");
    const { server: scripted, device } = harness;
    const bytes = Buffer.from("bytes behind a link\n");
    const hash = scriptBlob(scripted, bytes);

    scripted.contract = other;
    const refused = await device.blob(hash);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.refusal.code).toBe("contract_mismatch");
    expect(
      scripted.requests.some((request) =>
        request.pathname.startsWith("/links/"),
      ),
      "the device followed a link it was handed on another contract",
    ).toBe(false);

    // The witness: on the core's own contract the link is followed, and the
    // bytes it serves, which like an object store's name no contract, are
    // kept.
    scripted.contract = String(builtFor);
    const fetched = await device.blob(hash);
    expect(fetched.ok, JSON.stringify(fetched)).toBe(true);
    if (fetched.ok) expect(readFileSync(fetched.value.path)).toEqual(bytes);
  });

  it("refuses a success the working copy is given that names no contract", async () => {
    harness = await startHarness("contract-unnamed-success");
    const { server: scripted, device } = harness;
    scriptHydration(scripted, { head: "10" });
    scripted.contract = null;
    const refused = await device.hydrate(["core.note"], "library");
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.refusal.code).toBe("contract_mismatch");
      expect(refused.refusal.raw).toContain("naming no contract");
      // Where it asked and what it speaks, since nothing says the answer
      // came from a Marfa server at all.
      expect(refused.refusal.raw).toContain(scripted.url);
      expect(refused.refusal.raw).toContain(`contract ${String(builtFor)}`);
    }
  });

  it("takes a refusal that names no contract as the network's, ending the pass uncounted", async () => {
    const held = {
      id: "01a00000-0000-7000-8000-00000000000a",
      version: 3,
      properties: { title: "held", body: "held" },
    };
    harness = await hydratedHarness("contract-proxy-refusal", {
      rows: { "core.note": [{ item: held }] },
    });
    const { server: scripted, device } = harness;
    const unnamed = (status: number, code: string): Answer => ({
      kind: "json",
      status,
      body: { error: { code, message: "answered at the edge" } },
      contract: null,
    });
    scriptWrites(scripted, {
      update: [
        ...Array.from({ length: 6 }, () => unnamed(404, "not_found")),
        unnamed(401, "access_denied"),
        refused(403, "forbidden", "the key may not write this"),
      ],
      read: [answers.updated(wireItem(held))],
      create: [
        (request) =>
          answers.created(
            wireItem({ id: (JSON.parse(request.body) as { id: string }).id }),
          ),
      ],
    });
    expect(
      (
        await device.update(held.id, {
          properties: { title: "edited" },
          version: held.version,
        })
      ).ok,
    ).toBe(true);
    expect(
      (
        await device.create({
          type: "core.note",
          properties: { title: "behind", body: "held" },
        })
      ).ok,
    ).toBe(true);
    // A proxy restarting under a watch that drains each second: one past
    // the ceiling.
    for (let pass = 0; pass < 7; pass += 1) {
      const drained = await device.drain();
      expect(drained.ok, JSON.stringify(drained)).toBe(true);
      if (!drained.ok) return;
      expect(
        [
          drained.value.answered,
          drained.value.undelivered,
          drained.value.stopped,
        ],
        "an answer from in front of the server was counted as the server's, or stopped the queue as a refused credential",
      ).toEqual([0, 2, null]);
      expect(drained.value.unavailable).toMatch(/naming no contract/);
      expect(
        drained.value.verdicts.map((verdict) => [
          verdict.verdict,
          verdict.refusals,
        ]),
        "a proxy's answer was counted against a write the server never saw",
      ).toEqual([[null, 0]]);
    }
    expect(
      scripted.requests.filter((request) => request.method === "POST").length,
      "the pass went on past an answer from in front of the server",
    ).toBe(0);

    // The witness: the server's own refusal, naming its contract, refuses.
    const own = await device.drain();
    expect(own.ok && own.value.verdicts[0]?.verdict).toBe("refused");
  });

  it("takes a refusal naming no contract on any read as the network's, never as the server's word", async () => {
    harness = await hydratedHarness("contract-unnamed-reads");
    const { server: scripted, device } = harness;
    const unnamed = (status: number, code: string): Answer => ({
      kind: "json",
      status,
      body: { error: { code, message: "answered at the edge" } },
      contract: null,
    });

    // The stream a catch-up reads. The hydration's head read answers once
    // more first.
    scripted.copyAnswer("GET", "/events", unnamed(401, "access_denied"));
    expect((await device.catchUp()).ok).toBe(true);
    const stream = await device.catchUp();
    expect(stream.ok).toBe(false);
    if (!stream.ok) {
      expect(
        [
          stream.refusal.code === "unauthorized",
          stream.refusal.raw.includes('"exit":3'),
        ],
        "a gateway's 401 on the stream was read as the credential refused",
      ).toEqual([false, true]);
    }
    // The catalog it reads before the stream: the scripted catalog answers
    // once more, then the proxy does.
    scripted.copyAnswer("GET", "/types", unnamed(404, "not_found"));
    expect((await device.catchUp()).ok).toBe(false);
    const streamsBefore = scripted.requests.filter(
      (request) => request.pathname === "/events",
    ).length;
    const catalog = await device.catchUp();
    expect(catalog.ok).toBe(false);
    if (!catalog.ok) expect(catalog.refusal.code).toBe("unnamed_answer");
    expect(
      scripted.requests.filter((request) => request.pathname === "/events")
        .length,
      "the catch-up went past a catalog read refused naming no contract",
    ).toBe(streamsBefore);

    // A blob's link.
    const hash = hashOf(Buffer.from("bytes behind a gateway\n"));
    scripted.copyAnswer(
      "GET",
      `/blobs/${hash}/url`,
      unnamed(401, "access_denied"),
    );
    const blob = await device.blob(hash);
    expect(blob.ok).toBe(false);
    if (!blob.ok) {
      expect(
        blob.refusal.code,
        "a gateway's 401 on a blob's link was read as the credential refused",
      ).toBe("unnamed_answer");
    }

    // The read of the row a create landed on.
    const THEIRS = "01a00000-0000-7000-8000-0000000000ca";
    const current = {
      id: THEIRS,
      version: 1,
      properties: { title: "theirs", body: "theirs" },
      tier: "library" as const,
      occurred_at: "2026-01-01T00:00:00.000Z",
      source_id: "gated.md",
      type: "core.note",
    };
    expect(
      (
        await device.create({
          type: "core.note",
          properties: { title: "mine" },
          source: "notes",
          sourceId: "gated.md",
          version: 0,
        })
      ).ok,
    ).toBe(true);
    scriptWrites(scripted, {
      create: [answers.ancestorUnavailable(current, 0)],
      read: [unnamed(403, "forbidden")],
    });
    const drained = await device.drain();
    expect(drained.ok, JSON.stringify(drained)).toBe(true);
    if (!drained.ok) return;
    expect(drained.value.unavailable).toMatch(/naming no contract/);
    expect(
      drained.value.verdicts.map((verdict) => [
        verdict.verdict,
        verdict.refusals,
      ]),
      "a proxy's read refusal changed the original settled create verdict or counted a failure",
    ).toEqual([["refused", 0]]);
    expect((await device.drain()).ok).toBe(true);
    expect(
      scripted.requests.filter((request) => request.method === "POST"),
    ).toHaveLength(1);
  });

  it("ends the pass when the read of the row a create landed on answers on another contract", async () => {
    const THEIRS = "01a00000-0000-7000-8000-0000000000c9";
    const current = {
      id: THEIRS,
      version: 1,
      properties: { title: "theirs", body: "theirs" },
      tier: "library" as const,
      occurred_at: "2026-01-01T00:00:00.000Z",
      source_id: "landed.md",
      type: "core.note",
    };
    harness = await hydratedHarness("contract-landed-read");
    const { server: scripted, device } = harness;
    for (const [title, sourceId] of [
      ["mine", "landed.md"],
      ["behind", "behind.md"],
    ] as const) {
      expect(
        (
          await device.create({
            type: "core.note",
            properties: { title },
            source: "notes",
            sourceId,
            version: 0,
          })
        ).ok,
      ).toBe(true);
    }
    scriptWrites(scripted, {
      create: [answers.ancestorUnavailable(current, 0)],
      read: [
        naming(
          answers.updated(
            wireItem({ id: THEIRS, source: "notes", source_id: "landed.md" }),
          ),
          String(builtFor + 1),
        ),
      ],
    });
    const drained = await device.drain();
    expect(
      drained.ok,
      "a drain read a landed row on another contract and went on as though it could not read it",
    ).toBe(false);
    if (!drained.ok) expect(drained.refusal.code).toBe("contract_mismatch");
    expect(
      scripted.requests.filter((request) => request.method === "POST").length,
      "the pass went on past an answer on another contract",
    ).toBe(1);
    const queue = await device.queue();
    expect(
      queue.ok && queue.value.map((row) => [row.verdict, row.refusals]),
      "a failed read changed the original refusal or answered the unrelated create",
    ).toEqual([
      ["refused", 0],
      [null, 0],
    ]);
    const retry = await device.drain();
    expect(retry.ok ? null : retry.refusal.code).toBe("contract_mismatch");
    expect(
      scripted.requests.filter((request) => request.method === "POST"),
    ).toHaveLength(1);
  });

  it("hands the working copy a refusal that names no contract, as a proxy's would", async () => {
    harness = await startHarness("contract-unnamed-refusal");
    const { server: scripted, device } = harness;
    scripted.contract = null;
    // The root on the core's own contract, so the refusal handed on is the
    // head read's.
    scripted.copyAnswer("GET", "/", naming(answers.root(builtFor), BUILT_FOR));
    scripted.copyAnswer("GET", "/events", {
      kind: "json",
      status: 502,
      body: { error: { code: "bad_gateway", message: "upstream" } },
    });
    const refused = await device.hydrate(["core.note"], "library");
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      // Taken as from something in front of the server, whatever its
      // status, and named by it (`device/unnamed-environmental`).
      expect(refused.refusal.code).toBe("unnamed_answer");
      expect(refused.refusal.raw).toContain("502");
      expect(refused.refusal.raw).toContain('"exit":3');
    }
  });

  it("applies nothing from a page on another contract, after a head read and a catalog on its own", async () => {
    harness = await startHarness("contract-page");
    const { server: scripted, device } = harness;
    let pageOn = other;
    scripted.copyAnswer("GET", "/events", (request) =>
      request.headers["last-event-id"]
        ? copyReplay("10", [])
        : copyHeadRead("10"),
    );
    scripted.copyAnswer("GET", "/types", typeCatalog());
    scripted.copyAnswer("GET", "/edge-types", edgeTypeCatalog());
    scriptKey(scripted);
    scripted.copyAnswer("GET", "/items", () =>
      naming(itemsPage([{ item: wireItem({ id: "n1" }) }]), pageOn),
    );
    const refused = await device.hydrate(["core.note"], "library");
    expect(refused.ok, "a copy hydrated from a page on another contract").toBe(
      false,
    );
    if (!refused.ok) expect(refused.refusal.code).toBe("contract_mismatch");
    expect(sent(scripted)).toEqual([
      "GET /events",
      "GET /types",
      "GET /edge-types",
      "GET /keys/current",
      "GET /items",
    ]);
    const status = await device.status();
    expect(
      status.ok && status.value.items,
      "a row from a page on another contract reached the copy",
    ).toBe(0);

    // The witness: the same page on the core's own contract is applied.
    pageOn = String(builtFor);
    expect((await device.hydrate(["core.note"], "library")).ok).toBe(true);
    expect((await device.get("n1")).ok).toBe(true);
  });

  it("refuses a catch-up whose catalog is on another contract, before opening its stream", async () => {
    harness = await startHarness("contract-catch-up-catalog");
    const { server: scripted, device } = harness;
    let catalogOn = String(builtFor);
    scripted.copyAnswer(
      "GET",
      "/events",
      copyHeadRead("10"),
      copyReplay("10", []),
      copyReplay("11", [
        copyItemEvent("11", "item.created", wireItem({ id: "n2" })),
      ]),
    );
    scripted.copyAnswer("GET", "/types", () =>
      naming(typeCatalog(), catalogOn),
    );
    scripted.copyAnswer("GET", "/edge-types", edgeTypeCatalog());
    scriptKey(scripted);
    scripted.copyAnswer("GET", "/items", itemsPage([]));
    expect((await device.hydrate(["core.note"], "library")).ok).toBe(true);

    catalogOn = other;
    const before = scripted.requests.length;
    const refused = await device.catchUp();
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.refusal.code).toBe("contract_mismatch");
    expect(
      sent(scripted).slice(before),
      "the device opened the stream after a catalog on another contract",
    ).toEqual(["GET /types"]);

    // The witness: with the catalog on the core's own contract, the stream
    // is opened and its event applied.
    catalogOn = String(builtFor);
    expect((await device.catchUp()).ok).toBe(true);
    expect((await device.get("n2")).ok).toBe(true);
  });

  /**
   * A body that never ends: the stream answer held open with keepalives.
   * The core waits up to a minute on a body, so an answer refused on its
   * headers is refused well inside this.
   */
  const endless: Answer = { kind: "sse", frames: [], hold: true };
  const PROMPTLY_MS = 5_000;

  /**
   * The control each case below starts with: the same call on the core's
   * own contract, which reads the body, is still waiting on it once the
   * bound has passed. Without it the bound holds for a device that never
   * reads a body at all.
   */
  async function waitsOnTheBody(held: HeldCommand): Promise<void> {
    try {
      await new Promise((resolve) => setTimeout(resolve, PROMPTLY_MS));
      expect(
        held.running(),
        `the call on the core's own contract did not wait on the endless body, so the bound below measures nothing: ${held.stderr}`,
      ).toBe(true);
    } finally {
      await held.stop();
    }
  }

  it("refuses a catalog on another contract on its headers, without waiting on its body", async () => {
    harness = await startHarness("contract-catalog-endless");
    const { server: scripted, device } = harness;
    scripted.copyAnswer("GET", "/events", (request) =>
      request.headers["last-event-id"]
        ? copyReplay("10", [])
        : copyHeadRead("10"),
    );
    scripted.copyAnswer("GET", "/types", typeCatalog(), typeCatalog(), endless);
    scripted.copyAnswer("GET", "/edge-types", edgeTypeCatalog());
    scriptKey(scripted);
    scripted.copyAnswer("GET", "/items", itemsPage([]));
    expect((await device.hydrate(["core.note"], "library")).ok).toBe(true);
    await waitsOnTheBody(device.hold(["catch-up"]));

    scripted.contract = other;
    const started = Date.now();
    const refused = await device.catchUp();
    const elapsed = Date.now() - started;
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.refusal.code).toBe("contract_mismatch");
    expect(elapsed).toBeLessThan(PROMPTLY_MS);
  });

  it("refuses a write's answer on another contract on its headers, without waiting on its body", async () => {
    harness = await hydratedHarness("contract-write-endless");
    const { server: scripted, device } = harness;
    const queued = await device.create({
      type: "core.note",
      properties: { title: "endless", body: "endless" },
    });
    expect(queued.ok).toBe(true);
    scripted.answer("POST", "/items", endless);
    await waitsOnTheBody(device.hold(["drain"]));

    scripted.contract = other;
    const started = Date.now();
    const refused = await device.drain();
    const elapsed = Date.now() - started;
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.refusal.code).toBe("contract_mismatch");
    expect(elapsed).toBeLessThan(PROMPTLY_MS);
  });

  it("refuses a blob's link on another contract on its headers, without waiting on its body", async () => {
    harness = await hydratedHarness("contract-link-endless");
    const { server: scripted, device } = harness;
    const hash = `sha256:${"c".repeat(64)}`;
    scripted.copyAnswer("GET", `/blobs/${hash}/url`, endless);
    await waitsOnTheBody(device.hold(["blobs", "get", hash]));

    scripted.contract = other;
    const started = Date.now();
    const refused = await device.blob(hash);
    const elapsed = Date.now() - started;
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.refusal.code).toBe("contract_mismatch");
    expect(elapsed).toBeLessThan(PROMPTLY_MS);
  });

  it("refuses an event stream's refusal on another contract rather than reading its envelope", async () => {
    harness = await startHarness("contract-stream-refused");
    const { server: scripted, device } = harness;
    let refusalOn = other;
    scripted.copyAnswer("GET", "/events", () =>
      naming(
        refused(401, "unauthorized", "Invalid or missing credential"),
        refusalOn,
      ),
    );
    const onAnother = await device.hydrate(["core.note"], "library");
    expect(onAnother.ok).toBe(false);
    if (!onAnother.ok) {
      expect(onAnother.refusal.code).toBe("contract_mismatch");
    }

    // The witness: the same refusal on the core's own contract is read as
    // the refusal it is.
    refusalOn = String(builtFor);
    const onItsOwn = await device.hydrate(["core.note"], "library");
    expect(onItsOwn.ok).toBe(false);
    if (!onItsOwn.ok) {
      expect(onItsOwn.refusal.code).toBe("copy_expired");
      expect(onItsOwn.refusal.raw).toContain("credential_ended");
    }
  });

  it("says a read refused on another contract sent no write, naming the server and the status, with exit 1", async () => {
    harness = await startHarness("contract-read-words");
    const { server: scripted, device } = harness;
    scriptHydration(scripted, { head: "10" });
    const hash = scriptBlob(scripted, Buffer.from("bytes behind a link\n"));
    expect((await device.hydrate(["core.note"], "library")).ok).toBe(true);

    scripted.contract = other;
    // The root on the core's own contract, so the instance is read and the
    // answer refused is the one this case is about.
    scripted.copyAnswer("GET", "/", naming(answers.root(builtFor), BUILT_FOR));
    // The stream's head read, the catalog and the link door: one of each of
    // the core's ways of reading an answer.
    const reads = {
      "the head read": await device.hydrate(["core.note"], "library"),
      "the catalog": await device.catchUp(),
      "the link door": await device.blob(hash),
    };
    for (const [read, outcome] of Object.entries(reads)) {
      expect(outcome.ok, read).toBe(false);
      if (outcome.ok) continue;
      const envelope = JSON.parse(outcome.refusal.raw) as {
        error: {
          code: string;
          message: string;
          server: { status: number } | null;
        };
        exit: number;
      };
      expect(envelope.error.code, read).toBe("contract_mismatch");
      expect(envelope.error.message, read).not.toContain(
        "may have taken effect",
      );
      expect(envelope.error.message, read).toContain(scripted.url);
      expect(envelope.error.server?.status, read).toBe(200);
      expect(envelope.exit, read).toBe(1);
    }

    // The witness: a write's answer refused on the same contract says so,
    // in the same field.
    const queued = await device.create({
      type: "core.note",
      properties: { title: "sent", body: "sent" },
    });
    expect(queued.ok, JSON.stringify(queued)).toBe(true);
    if (!queued.ok) return;
    scriptWrites(scripted, {
      read: [answers.updated(wireItem({ id: queued.value.item_id ?? "" }))],
      create: [answers.created(wireItem({ id: queued.value.item_id ?? "" }))],
    });
    const drained = await device.drain();
    expect(drained.ok).toBe(false);
    if (drained.ok) return;
    const written = JSON.parse(drained.refusal.raw) as {
      error: { code: string; message: string };
    };
    expect(written.error.code).toBe("contract_mismatch");
    expect(
      written.error.message,
      "a write's answer refused on another contract did not say the write may have taken effect, so its absence above proves nothing",
    ).toContain("may have taken effect");
  });

  it("refuses a contract that only begins with the one it speaks", async () => {
    harness = await startHarness("contract-prefix");
    const { server: scripted, device } = harness;
    scriptHydration(scripted, { head: "10" });
    scripted.contract = `${BUILT_FOR}0`;
    const refused = await device.hydrate(["core.note"], "library");
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.refusal.code).toBe("contract_mismatch");

    // The witness: the contract itself is read.
    scripted.contract = BUILT_FOR;
    expect((await device.hydrate(["core.note"], "library")).ok).toBe(true);
  });

  it("refuses an answer the working copy is given that names its contract twice, differently", async () => {
    harness = await startHarness("contract-named-twice");
    const { server: scripted, device } = harness;
    const orders = [
      [BUILT_FOR, other],
      [other, BUILT_FOR],
      // The witness, last: the same contract named twice is one contract.
      [BUILT_FOR, BUILT_FOR],
    ];
    let catalogOn = orders[0] ?? [];
    scripted.copyAnswer("GET", "/events", (request) =>
      request.headers["last-event-id"]
        ? copyReplay("10", [])
        : copyHeadRead("10"),
    );
    scripted.copyAnswer("GET", "/types", () =>
      naming(certifiedRead(typeCatalog(), BUILT_FOR), catalogOn),
    );
    scripted.copyAnswer("GET", "/edge-types", edgeTypeCatalog());
    scriptKey(scripted);
    scripted.copyAnswer("GET", "/items", itemsPage([]));
    for (const order of orders.slice(0, 2)) {
      catalogOn = order;
      const refused = await device.hydrate(["core.note"], "library");
      expect(refused.ok, order.join(" then ")).toBe(false);
      if (!refused.ok) {
        expect(refused.refusal.code, order.join(" then ")).toBe(
          "contract_mismatch",
        );
      }
    }
    catalogOn = orders[2] ?? [];
    const read = await device.hydrate(["core.note"], "library");
    expect(read.ok, JSON.stringify(read)).toBe(true);
  });

  it("reads a blob as absent only on the server's own 404, never on a proxy's", async () => {
    harness = await hydratedHarness("contract-blob-404");
    const { server: scripted, device } = harness;
    const hash = `sha256:${"a".repeat(64)}`;
    let notFoundOn: string | null = null;
    scripted.copyAnswer("GET", `/blobs/${hash}/url`, () =>
      naming(refused(404, "blob_not_found", "no such blob"), notFoundOn),
    );
    const proxy = await device.blob(hash);
    expect(proxy.ok).toBe(false);
    if (!proxy.ok) {
      expect(
        proxy.refusal.code,
        "a proxy's 404 was read as the server holding no such bytes",
      ).not.toBe("bytes_absent");
    }

    // The witness: the server's own 404 is the bytes' absence.
    notFoundOn = BUILT_FOR;
    const own = await device.blob(hash);
    expect(own.ok).toBe(false);
    if (!own.ok) expect(own.refusal.code).toBe("bytes_absent");
  });

  it("ends the pass when the read a refusal is reconciled against answers on another contract", async () => {
    const held = {
      id: "01a00000-0000-7000-8000-00000000000b",
      version: 3,
      properties: { title: "held", body: "held" },
    };
    harness = await hydratedHarness("contract-reconcile", {
      rows: { "core.note": [{ item: held }] },
    });
    const { server: scripted, device } = harness;
    const edited = await device.update(held.id, {
      properties: { title: "edited" },
      version: held.version,
    });
    expect(edited.ok).toBe(true);
    const queued = await device.create({
      type: "core.note",
      properties: { title: "after the refusal", body: "after the refusal" },
    });
    expect(queued.ok).toBe(true);
    if (!edited.ok || !queued.ok) return;
    scriptWrites(scripted, {
      update: [refused(400, "invalid_properties", "not a title")],
      // The update is refused on the core's own contract, and the read it
      // is reconciled against answers on another, as a server mid-upgrade
      // would.
      read: [
        naming(answers.updated(wireItem(held)), other),
        answers.updated(wireItem(held)),
      ],
      create: [answers.created(wireItem({ id: queued.value.item_id ?? "" }))],
    });

    const ended = await device.drain();
    expect(ended.ok, "a drain went on after a read on another contract").toBe(
      false,
    );
    if (!ended.ok) expect(ended.refusal.code).toBe("contract_mismatch");
    expect(
      sent(scripted).includes("POST /items"),
      "the drain sent a write after meeting an answer on another contract",
    ).toBe(false);
    const queue = await device.queue();
    expect(
      queue.ok && queue.value.map((row) => [row.id, row.verdict]),
      "the refusal the server gave was not kept",
    ).toEqual([
      [edited.value.id, "refused"],
      [queued.value.id, null],
    ]);

    // The witness: the next pass, on the core's own contract, sends the
    // write this one held back.
    scripted.contract = String(builtFor);
    const drained = await device.drain();
    expect(drained.ok, JSON.stringify(drained)).toBe(true);
    if (drained.ok) {
      expect(drained.value.verdicts.map((entry) => entry.verdict)).toEqual([
        "accepted",
      ]);
    }
    expect(
      sent(scripted).filter((line) => line === "POST /items"),
    ).toHaveLength(1);
  });
});
