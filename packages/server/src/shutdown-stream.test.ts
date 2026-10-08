import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { request } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

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
  url: string;
  socketPath: string;
  output: () => string;
  stop: () => Promise<{ code: number | null; ms: number }>;
}

async function boot(): Promise<Running> {
  const dir = mkdtempSync(join(realpathSync("/tmp"), "marfa-shutdown-"));
  dirs.push(dir);
  const port = await freePort();
  const socketPath = join(dir, "control", "marfa.sock");
  const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
    cwd: SERVER_ROOT,
    env: {
      ...process.env,
      NODE_ENV: "test",
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
  });
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
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = request(
      {
        socketPath,
        path,
        method: "POST",
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
            expect(res.statusCode, output).toBe(201);
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
