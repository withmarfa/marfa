import { type ChildProcess, spawn } from "node:child_process";
import {
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { createServer } from "node:net";
import { request } from "node:http";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createClient } from "@libsql/client";

/**
 * The server process with a real client on a real event stream, stopped the
 * way a container runtime stops it: `SIGTERM`, and `SIGKILL` after its grace.
 * What the client sees is the closing frame and the end of the body, and what
 * the supervisor sees is exit status 0, well inside ten seconds.
 */

const SERVER_ROOT = fileURLToPath(new URL("..", import.meta.url));
const GRACE_MS = 10_000;
const dirs: string[] = [];
const servers: ChildProcess[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.kill("SIGKILL");
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => {
        resolvePort(port);
      });
    });
  });
}

interface Running {
  dir: string;
  url: string;
  socketPath: string;
  output: () => string;
  stop: () => Promise<{ code: number | null; ms: number }>;
}

async function boot(built = false, hooks = false): Promise<Running> {
  const dir = mkdtempSync(join(realpathSync("/tmp"), "marfa-shutdown-"));
  dirs.push(dir);
  const port = await freePort();
  const socketPath = join(dir, "control", "marfa.sock");
  const child = spawn(
    process.execPath,
    built ? ["dist/index.js"] : ["--import", "tsx", "src/index.ts"],
    {
      cwd: SERVER_ROOT,
      env: {
        ...process.env,
        NODE_ENV: "test",
        MARFA_TEST_HOOKS: String(hooks),
        PORT: String(port),
        SQLITE_PATH: join(dir, "marfa.db"),
        BLOB_PATH: join(dir, "blobs"),
        MARFA_CONTROL_SOCKET: socketPath,
        MARFA_CONTROL_ONLY: "false",
        MARFA_AUTH_BASE_URL: `http://127.0.0.1:${String(port)}`,
        MARFA_AUTH_SECRET: "test-secret-for-local-runs-0123456789abcdef",
        RATE_LIMIT_ENABLED: "false",
        MARFA_ENRICHMENT_ENABLED: "false",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  servers.push(child);
  let output = "";
  child.stdout.setEncoding("utf8").on("data", (c: string) => (output += c));
  child.stderr.setEncoding("utf8").on("data", (c: string) => (output += c));
  const exited = new Promise<number | null>((resolve) => {
    child.once("close", (code) => {
      resolve(code);
    });
  });
  const url = `http://127.0.0.1:${String(port)}`;
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (Date.now() > deadline) throw new Error(`no answer:\n${output}`);
    try {
      if ((await fetch(`${url}/health`)).ok) break;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return {
    dir,
    url,
    socketPath,
    output: () => output,
    stop: async () => {
      const started = Date.now();
      child.kill("SIGTERM");
      const code = await Promise.race([
        exited,
        new Promise<null>((resolve) =>
          setTimeout(() => {
            resolve(null);
          }, GRACE_MS),
        ),
      ]);
      return { code, ms: Date.now() - started };
    },
  };
}

async function localPost(
  socketPath: string,
  path: string,
  body: unknown,
  method = "POST",
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? "" : JSON.stringify(body);
    const req = request(
      {
        socketPath,
        path,
        method,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        let output = "";
        res.setEncoding("utf8");
        res.on("data", (part: string) => {
          output += part;
        });
        res.on("end", () => {
          try {
            expect(res.statusCode, output).toBe(method === "POST" ? 201 : 200);
            resolve(JSON.parse(output) as Record<string, unknown>);
          } catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        });
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end(payload);
  });
}

describe("stopping the server process with an event stream open", () => {
  it("sends the stream its closing frame and ends it, and exits 0 within the grace", async () => {
    const server = await boot();
    await localPost(server.socketPath, "/_control/setup/claim", {
      email: "owner@example.com",
      password: "shutdown-test-password",
    });
    const minted = await localPost(server.socketPath, "/keys", {
      label: "stream-reader",
      source: "stream-reader",
      type_permissions: { "*": "read" },
    });
    const working = minted.key;
    expect(typeof working).toBe("string");

    const stream = await fetch(`${server.url}/events`, {
      headers: { Authorization: `Bearer ${String(working)}` },
    });
    expect(stream.status).toBe(200);
    const reader = (stream.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let text = "";
    while (!text.includes("stream_live")) {
      const chunk = await reader.read();
      expect(chunk.done).toBe(false);
      text += decoder.decode(chunk.value, { stream: true });
    }

    const stopping = server.stop();
    // The body ending is what leaves this loop.
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      text += decoder.decode(chunk.value, { stream: true });
    }
    const stopped = await stopping;

    expect(text).toContain("event: stream_incomplete");
    expect(text).toContain('"reason":"server_stopping"');
    expect(stopped.code, server.output()).toBe(0);
    expect(stopped.ms).toBeLessThan(GRACE_MS - 2_000);
    expect(server.output()).not.toContain("HTTP server close did not complete");
  }, 120_000);

  // The witness for the exit status: with nothing open the same stop is the
  // same clean one, so the status above is the stream's doing and not the
  // server's.
  it("exits 0 at once with no stream open", async () => {
    const server = await boot();

    const stopped = await server.stop();

    expect(stopped.code, server.output()).toBe(0);
    expect(stopped.ms).toBeLessThan(2_000);
  }, 120_000);
});

it.each(["spooling", "validation", "streaming"])(
  "cancels built-server archive %s, removes its files, and exits 0 on SIGTERM",
  async (phase) => {
    const server = await boot(true, phase === "validation");
    if (phase === "validation")
      await localPost(
        server.socketPath,
        "/_control/test/faults",
        { name: "hold:export-validation" },
        "PUT",
      );
    await localPost(server.socketPath, "/_control/setup/claim", {
      email: "owner@example.com",
      password: "shutdown-test-password",
    });
    const minted = await localPost(server.socketPath, "/keys", {
      label: "archive-reader",
      source: "archive-reader",
      type_permissions: { "*": "read" },
    });
    const database = createClient({
      url: pathToFileURL(join(server.dir, "marfa.db")).href,
    });
    try {
      await database.execute({
        sql: `WITH RECURSIVE n(v) AS (VALUES(1) UNION ALL SELECT v + 1 FROM n WHERE v < 2000)
        INSERT INTO items (id, type, properties, created_at, updated_at, occurred_at)
        SELECT printf('01912345-0000-7000-8000-%012x', v), 'core.note',
          jsonb(json_object('body', CASE WHEN ? THEN hex(randomblob(16000)) ELSE ? END)),
          '2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z',
          '2024-01-01T00:00:00.000Z' FROM n`,
        args: [phase === "streaming" ? 1 : 0, "x".repeat(32_000)],
      });
    } finally {
      database.close();
    }
    const spoolDir = join(server.dir, "blobs", "tmp");
    const state = { answered: false };
    let streaming: Response | undefined;
    const response = fetch(`${server.url}/export?format=archive`, {
      headers: { Authorization: `Bearer ${String(minted.key)}` },
    })
      .then(
        async (answer) => {
          state.answered = true;
          if (phase === "streaming") streaming = answer;
          else await answer.arrayBuffer();
        },
        () => {
          state.answered = true;
        },
      )
      .catch(() => undefined);
    const deadline = Date.now() + 60_000;
    while (phase !== "streaming") {
      const files = readdirSync(spoolDir);
      const large = files.filter(
        (name) => statSync(join(spoolDir, name)).size > 1_000_000,
      ).length;
      // Selection uses five files, one of which grows past the threshold.
      if (phase === "spooling" && files.length === 5 && large === 1) break;
      if (phase === "validation") {
        const { faults } = (await localPost(
          server.socketPath,
          "/_control/test/faults",
          undefined,
          "GET",
        )) as { faults: { name: string; waiting: number }[] };
        if (
          faults.some(
            (fault) =>
              fault.name === "hold:export-validation" && fault.waiting === 1,
          )
        )
          break;
      }
      if (state.answered || Date.now() > deadline)
        throw new Error(`Archive ${phase} did not start:\n${server.output()}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    if (phase === "streaming") {
      await response;
      expect(streaming?.status, server.output()).toBe(200);
      expect(readdirSync(spoolDir).length).toBeGreaterThan(0);
    } else expect(state.answered).toBe(false);
    const stopped = await server.stop();
    await response;
    await streaming?.body?.cancel().catch(() => undefined);
    expect.soft(readdirSync(spoolDir)).toEqual([]);
    expect.soft(stopped.code, server.output()).toBe(0);
    expect(stopped.ms).toBeLessThan(GRACE_MS - 2_000);
    expect(server.output()).not.toContain("HTTP server close did not complete");
  },
  120_000,
);
