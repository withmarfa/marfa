import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { cleanup } from "../../utils/setup.js";
import { cliContext, once, releaseHeld } from "./harness.js";
import type { Cli, CliContext } from "./harness.js";

/**
 * A key goes to a plain `http` address on another host only after the CLI
 * has said so on standard error, and only silently where the caller said it
 * is intended or the address is this machine's.
 *
 * The addresses are listeners of this file's own, because the real server
 * is on this machine. A listener answers nothing a Marfa server would, so
 * the CLI ends in the environment's exit code once it has sent; what a
 * scenario reads is what reached the listener and what the CLI said
 * first. A listener holds each request unanswered for a moment, so the
 * command is still waiting when the scenario reads what it has said, which
 * is how "before it sends" is seen.
 */

let c: CliContext;
let dir: string;
const listeners: Listener[] = [];

beforeAll(async () => {
  c = await cliContext("cleartext");
  dir = mkdtempSync(join(tmpdir(), "marfa-cli-cleartext-"));
});

afterAll(async () => {
  releaseHeld();
  await Promise.all(listeners.splice(0).map((listener) => listener.close()));
  rmSync(dir, { recursive: true, force: true });
  await cleanup(c.ctx);
});

/**
 * An address of this machine that is not loopback, which a request to it is
 * not taken for this machine's. A machine with none fails the scenario
 * rather than skipping it, because a skipped scenario asserts nothing.
 */
function otherHost(): string {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const entry of addresses ?? []) {
      if (entry.family === "IPv4" && !entry.internal) return entry.address;
    }
  }
  throw new Error(
    "this machine has no network address but loopback, so no address can stand for another host",
  );
}

interface Arrival {
  method: string;
  path: string;
  authorization: string | undefined;
}

/** Records every request, and answers a 503 naming no contract after `holdMs`. */
class Listener {
  readonly arrivals: Arrival[] = [];
  connections = 0;
  private constructor(
    private readonly server: Server,
    readonly port: number,
  ) {}

  static async start(bind: string, holdMs: number): Promise<Listener> {
    const arrivals: Arrival[] = [];
    let counted = 0;
    const server = createServer((request, response) => {
      arrivals.push({
        method: request.method ?? "",
        path: request.url ?? "",
        authorization: request.headers.authorization,
      });
      request.resume();
      setTimeout(() => {
        response.writeHead(503, { "content-type": "application/json" });
        response.end("{}");
      }, holdMs);
    });
    server.on("connection", () => {
      counted += 1;
      listener.connections = counted;
    });
    await new Promise<void>((resolve) => server.listen(0, bind, resolve));
    const listener = new Listener(
      server,
      (server.address() as AddressInfo).port,
    );
    Object.assign(listener, { arrivals });
    listeners.push(listener);
    return listener;
  }

  origin(host: string, scheme = "http"): string {
    return `${scheme}://${host}:${String(this.port)}`;
  }

  async arrival(count = 1): Promise<void> {
    const started = Date.now();
    while (this.arrivals.length < count) {
      if (Date.now() - started > 15_000) {
        throw new Error("nothing reached the listener");
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  close(): Promise<void> {
    this.server.closeAllConnections();
    return new Promise((resolve) => {
      this.server.close(() => {
        resolve();
      });
    });
  }
}

/** A held child with what it has said so far. */
function watched(child: ChildProcess): {
  stderr: () => string;
  running: () => boolean;
  exit: () => Promise<number | null>;
} {
  let stderr = "";
  child.stderr!.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  return {
    stderr: () => stderr,
    running: () => child.exitCode === null && child.signalCode === null,
    exit: () => once(child, "close"),
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 250));

/** What a refusal on standard error is: the lines the command printed, the last one its envelope. */
function lines(stderr: string): string[] {
  return stderr.trim().split("\n");
}

const WARNING = /^marfa: warning: (\S+) is plain http\b/;

describe("a key sent over plain http", () => {
  it("warns before it sends a key to a plain http address on another host, and then sends it", async () => {
    const listener = await Listener.start("0.0.0.0", 1500);
    const origin = listener.origin(otherHost());
    const run = watched(c.cli.at(origin).hold(["items", "list"]));
    await listener.arrival();
    await settle();

    expect(run.running(), "the command is still waiting for the answer").toBe(
      true,
    );
    const said = lines(run.stderr());
    expect(said, run.stderr()).toHaveLength(1);
    expect(said[0]!.match(WARNING)?.[1]).toBe(origin);
    expect(listener.arrivals).toHaveLength(1);
    expect(listener.arrivals[0]!.authorization).toBe(`Bearer ${c.apiKey}`);

    expect(await run.exit()).toBe(3);
    const after = lines(run.stderr());
    expect(after).toHaveLength(2);
    expect(JSON.parse(after[1]!)).toMatchObject({ exit: 3 });
    expect(run.stderr()).not.toContain(c.apiKey);
  });

  it("warns before a working copy sends a key to a plain http address on another host", async () => {
    const listener = await Listener.start("0.0.0.0", 1500);
    const origin = listener.origin(otherHost());
    const run = watched(
      c.cli
        .at(origin)
        .hold([
          "device",
          "--db",
          join(dir, "copy.sqlite"),
          "hydrate",
          "--types",
          "core.note",
          "--tier",
          "library",
        ]),
    );
    await listener.arrival();
    await settle();

    expect(run.running()).toBe(true);
    expect(lines(run.stderr())[0]!.match(WARNING)?.[1]).toBe(origin);
    expect(listener.arrivals[0]!.authorization).toBe(`Bearer ${c.apiKey}`);
    await run.exit();
    expect(
      lines(run.stderr()).filter((line) => WARNING.test(line)),
      "a run warns of an address once",
    ).toHaveLength(1);
  });

  it("warns before a sign-in sends anything to a plain http address on another host", async () => {
    const listener = await Listener.start("0.0.0.0", 1500);
    const origin = listener.origin(otherHost());
    const run = watched(
      c.cli.as(undefined).at(origin).hold(["login", "--no-browser"]),
    );
    await listener.arrival();
    await settle();

    expect(run.running()).toBe(true);
    expect(lines(run.stderr())[0]!.match(WARNING)?.[1]).toBe(origin);
    expect(listener.arrivals[0]!.path).toContain("oauth-authorization-server");
    expect(listener.arrivals[0]!.authorization).toBeUndefined();
    await run.exit();
  });

  it("prints no warning for a plain http address on this machine, which it reaches with the key", async () => {
    const real = await c.cli.run(["--json", "items", "list"]);
    expect(real.code, real.stderr).toBe(0);
    expect(real.stderr).toBe("");

    const listener = await Listener.start("127.0.0.1", 0);
    for (const host of ["127.0.0.1", "localhost"]) {
      const before = listener.arrivals.length;
      const outcome = await c.cli
        .at(listener.origin(host))
        .run(["--json", "items", "list"]);
      expect(outcome.code, `${host}: ${outcome.stderr}`).toBe(3);
      expect(listener.arrivals, host).toHaveLength(before + 1);
      expect(listener.arrivals[before]!.authorization).toBe(
        `Bearer ${c.apiKey}`,
      );
      expect(lines(outcome.stderr), outcome.stderr).toHaveLength(1);
      expect(outcome.stderr).not.toContain("warning");
    }
  });

  it("prints no warning for an https address, which it reaches", async () => {
    const listener = await Listener.start("0.0.0.0", 0);
    const outcome = await c.cli
      .at(listener.origin(otherHost(), "https"))
      .run(["--json", "items", "list"]);
    expect(listener.connections, "the command connected").toBeGreaterThan(0);
    expect(outcome.code).not.toBe(0);
    expect(outcome.stderr).not.toContain("warning");
  });

  it("prints no warning where --allow-http states it is intended, and sends the key", async () => {
    const listener = await Listener.start("0.0.0.0", 0);
    const outcome = await c.cli
      .at(listener.origin(otherHost()))
      .run(["--json", "--allow-http", "items", "list"]);
    expect(outcome.code, outcome.stderr).toBe(3);
    expect(listener.arrivals).toHaveLength(1);
    expect(listener.arrivals[0]!.authorization).toBe(`Bearer ${c.apiKey}`);
    expect(lines(outcome.stderr), outcome.stderr).toHaveLength(1);
    expect(outcome.stderr).not.toContain("warning");
  });

  it("prints no warning where MARFA_ALLOW_HTTP states it is intended, and warns where it does not", async () => {
    const listener = await Listener.start("0.0.0.0", 0);
    const at = (cli: Cli) => cli.at(listener.origin(otherHost()));
    for (const word of ["1", "true", "yes", "on"]) {
      const before = listener.arrivals.length;
      const outcome = await at(c.cli.withEnv({ MARFA_ALLOW_HTTP: word })).run([
        "--json",
        "items",
        "list",
      ]);
      expect(listener.arrivals, word).toHaveLength(before + 1);
      expect(outcome.stderr, word).not.toContain("warning");
    }
    for (const word of ["", "0", "false", "no"]) {
      const before = listener.arrivals.length;
      const outcome = await at(c.cli.withEnv({ MARFA_ALLOW_HTTP: word })).run([
        "--json",
        "items",
        "list",
      ]);
      expect(listener.arrivals, word).toHaveLength(before + 1);
      expect(outcome.stderr, word).toMatch(/warning: .* is plain http/);
    }
  });
});
