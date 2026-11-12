import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import { connect } from "node:net";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { serverProgram } from "../../../scripts/marfa-server.js";
import { controlRequest } from "../../utils/control-request.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/**
 * Opens a request on the private socket whose body is only partly sent, so
 * the server holds it in flight, and answers a way to send the rest.
 */
async function holdRequest(socketPath: string): Promise<() => Promise<number>> {
  const body = '{"setup_code":"held"}';
  const socket = connect(socketPath);
  await once(socket, "connect");
  let reply = "";
  socket.setEncoding("utf8");
  socket.on("data", (part: string) => {
    reply += part;
  });
  socket.write(
    "POST /_control/setup/claim HTTP/1.1\r\nhost: marfa\r\n" +
      `content-type: application/json\r\ncontent-length: ${String(body.length)}\r\n\r\n` +
      body.slice(0, 5),
  );
  cleanups.push(async () => {
    socket.destroy();
  });
  return async () => {
    const closed = once(socket, "close");
    socket.write(body.slice(5));
    await closed;
    return Number(/^HTTP\/1\.1 (\d{3})/.exec(reply)?.[1]);
  };
}

async function fixture() {
  const found = serverProgram();
  if (!found) throw new Error("MARFA_SERVER_BIN names no server");
  const program: string = found;
  const root = await mkdtemp(join(await realpath(tmpdir()), "marfa-restart-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const socket = join(root, "control.sock");
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    MARFA_AUTH_SECRET: randomBytes(32).toString("hex"),
    MARFA_CONTROL_ONLY: "true",
    MARFA_CONTROL_SOCKET: socket,
    MARFA_DATABASE_PATH: join(root, "marfa.db"),
    MARFA_BLOB_PATH: join(root, "blobs"),
    MARFA_ENRICHMENT_ENABLED: "false",
    MARFA_ENRICHMENT_OCR_ENABLED: "false",
  };
  function start() {
    const child = spawn(program, [], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    const exited = once(child, "exit");
    cleanups.push(async () => {
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
      await exited;
    });
    return {
      child,
      exited,
      output: () => output,
      async ready() {
        const deadline = Date.now() + 30_000;
        while (Date.now() < deadline) {
          if (child.exitCode !== null || child.signalCode !== null)
            throw new Error(output);
          try {
            if ((await controlRequest(socket, "/health")).status === 200)
              return;
          } catch {
            /* The process has not bound its socket yet. */
          }
          await new Promise((done) => setTimeout(done, 25));
        }
        throw new Error(`Server did not start: ${output}`);
      },
    };
  }
  return { socket, start };
}

it("refuses startup until a closing listener has finished its socket cleanup", async () => {
  const { socket, start } = await fixture();
  const first = start();
  await first.ready();
  const finish = await holdRequest(socket);
  // Answered after the held connection, so the server has taken that one in.
  expect((await controlRequest(socket, "/health")).status).toBe(200);
  first.child.kill("SIGTERM");
  await expect
    .poll(
      async () =>
        controlRequest(socket, "/health").then(
          () => "listening",
          (error: NodeJS.ErrnoException) => error.code,
        ),
      { timeout: 30_000 },
    )
    .toBe("ECONNREFUSED");
  const second = start();
  expect(await second.exited).toEqual([1, null]);
  expect(second.output()).toContain(
    `Control socket path is already in use: ${socket}`,
  );
  expect(first.child.exitCode).toBeNull();
  expect(await finish()).toBe(400);
  expect(await first.exited).toEqual([0, null]);
  const third = start();
  await third.ready();
  expect((await controlRequest(socket, "/health")).status).toBe(200);
}, 60_000);
