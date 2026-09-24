import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import {
  answers,
  headRead,
  itemEvent,
  itemsPage,
  refusal as refused,
  replay,
  typeCatalog,
  wireItem,
} from "../../device/marfa-answers.js";
import {
  BUILT_FOR,
  ScriptedServer,
  type Answer,
} from "../../device/scripted-server.js";
import {
  KEY,
  acceptUploads,
  fileOf,
  hydratedHarness,
  requireBinary,
  scriptBlob,
  scriptHydration,
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
      started.answer(
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

/**
 * Commands outside the table that reach the server, driven the same way:
 * the table lists published operations, and these reach one without being
 * its entry.
 */
const beyondTheTable: Record<string, () => string[]> = {
  "keys bootstrap": () => ["--secret", "s"],
};

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
  async function everyDoor(contract: string): Promise<ScriptedServer> {
    const started = await ScriptedServer.start();
    started.contract = contract;
    // The root's body names the contract the binary was built for, whatever
    // its header says, so a write that reads the root before it mints is
    // sent, and it is the mint's own answer that has to be refused.
    started.answer("GET", "/", answers.root(builtFor));
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
    for (const row of await driven()) {
      if (row.command === DESCRIBES) continue;
      server = await everyDoor(served);
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
        "a password\n",
      );
      const label = `marfa ${row.command} ${argv.join(" ")}: ${outcome.stderr.slice(0, 300)}`;
      expect.soft(outcome.code, label).toBe(1);
      expect.soft(codeOf(outcome.stderr), label).toBe("contract_mismatch");
      // Every command's silence has a witness but `login`'s (`SILENT_HERE`).
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
        "a password\n",
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
 * for, which is the same document's (`device.md` 42).
 */
describe("the contract the working copy was built for", () => {
  const other = String(builtFor + 1);

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
    scripted.answer(
      "GET",
      "/events",
      replay("11", [itemEvent("11", "item.created", wireItem({ id: "n2" }))]),
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
    scripted.answer(
      "GET",
      "/events",
      replay("11", [itemEvent("11", "item.created", wireItem({ id: "n2" }))]),
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
    scriptWrites(scripted, { create: [answers.created(wireItem({ id }))] });

    scripted.contract = other;
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
      create: [answers.created(wireItem({ id: queued.value.item_id ?? "" }))],
    });

    scripted.contract = other;
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

  it("hands the working copy a refusal that names no contract, as a proxy's would", async () => {
    harness = await startHarness("contract-unnamed-refusal");
    const { server: scripted, device } = harness;
    scripted.contract = null;
    scripted.answer("GET", "/events", {
      kind: "json",
      status: 502,
      body: { error: { code: "bad_gateway", message: "upstream" } },
    });
    const refused = await device.hydrate(["core.note"], "library");
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.refusal.code).toBe("server");
      expect(refused.refusal.raw).toContain("bad_gateway");
    }
  });

  it("applies nothing from a page on another contract, after a head read and a catalog on its own", async () => {
    harness = await startHarness("contract-page");
    const { server: scripted, device } = harness;
    let pageOn = other;
    scripted.answer("GET", "/events", headRead("10"));
    scripted.answer("GET", "/types", typeCatalog());
    scripted.answer("GET", "/items", () =>
      naming(itemsPage([{ item: wireItem({ id: "n1" }) }]), pageOn),
    );
    const refused = await device.hydrate(["core.note"], "library");
    expect(refused.ok, "a copy hydrated from a page on another contract").toBe(
      false,
    );
    if (!refused.ok) expect(refused.refusal.code).toBe("contract_mismatch");
    expect(sent(scripted)).toEqual(["GET /events", "GET /types", "GET /items"]);
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
    scripted.answer(
      "GET",
      "/events",
      headRead("10"),
      replay("11", [itemEvent("11", "item.created", wireItem({ id: "n2" }))]),
    );
    scripted.answer("GET", "/types", () => naming(typeCatalog(), catalogOn));
    scripted.answer("GET", "/items", itemsPage([]));
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
  const PROMPTLY_MS = 20_000;

  it("refuses a catalog on another contract on its headers, without waiting on its body", async () => {
    harness = await startHarness("contract-catalog-endless");
    const { server: scripted, device } = harness;
    scripted.answer("GET", "/events", headRead("10"));
    scripted.answer("GET", "/types", typeCatalog(), endless);
    scripted.answer("GET", "/items", itemsPage([]));
    expect((await device.hydrate(["core.note"], "library")).ok).toBe(true);

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
    scripted.answer("GET", `/blobs/${hash}/url`, endless);

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
    scripted.answer("GET", "/events", () =>
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
    if (!onItsOwn.ok) expect(onItsOwn.refusal.code).toBe("unauthorized");
  });

  it("says a read refused on another contract sent no write, naming the server and the status, with exit 1", async () => {
    harness = await startHarness("contract-read-words");
    const { server: scripted, device } = harness;
    scriptHydration(scripted, { head: "10" });
    const hash = scriptBlob(scripted, Buffer.from("bytes behind a link\n"));
    expect((await device.hydrate(["core.note"], "library")).ok).toBe(true);

    scripted.contract = other;
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
    scripted.answer("GET", "/events", headRead("10"));
    scripted.answer("GET", "/types", () => naming(typeCatalog(), catalogOn));
    scripted.answer("GET", "/items", itemsPage([]));
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
    scripted.answer("GET", `/blobs/${hash}/url`, () =>
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
      read: [naming(answers.updated(wireItem(held)), other)],
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
