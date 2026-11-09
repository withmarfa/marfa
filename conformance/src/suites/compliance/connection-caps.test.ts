import { connect, type Socket } from "node:net";
import { afterAll, describe, expect, it } from "vitest";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  stopFreshServers,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { waitFor } from "../../utils/wait.js";

/**
 * How many connections the public listener holds open, and what a caller
 * over a bound meets.
 *
 * **A server of its own per case, because the claim is about settings.** Each
 * case asks for a number no default names and counts to it. A connection is
 * held open with a request answered on it, so the fixture sees that the
 * server took it and not only that a socket connected.
 *
 * **Places other than the fixture's may be taken for a moment.** The harness
 * reached the server through pooled connections that close on their own, so
 * a case first waits until it can hold the whole number it means to.
 */
afterAll(stopFreshServers, 2 * FRESH_SERVER_TIMEOUT_MS);

interface Answered {
  status: number;
  head: string;
  body: string;
  socket: Socket;
}

const ASK = "GET /health HTTP/1.1\r\nHost: connection-caps\r\n\r\n";

/** Opens a connection, asks `GET /health` on it, and reads the whole answer. */
function ask(port: number, host = "127.0.0.1"): Promise<Answered> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host, port });
    let received = Buffer.alloc(0);
    const settle = (): void => {
      const split = received.indexOf("\r\n\r\n");
      if (split < 0) return;
      const head = received.subarray(0, split).toString("latin1");
      const length = /content-length: (\d+)/i.exec(head)?.[1];
      const body = received.subarray(split + 4);
      if (length !== undefined && body.length < Number(length)) return;
      socket.off("data", onData);
      resolve({
        status: Number(/^HTTP\/1\.1 (\d{3})/.exec(head)?.[1]),
        head,
        body: body.toString("utf8"),
        socket,
      });
    };
    const onData = (chunk: Buffer): void => {
      received = Buffer.concat([received, chunk]);
      settle();
    };
    socket.on("data", onData);
    socket.on("error", reject);
    socket.once("connect", () => socket.write(ASK));
    socket.once("close", () => {
      if (received.length === 0) reject(new Error("closed with no answer"));
    });
  });
}

function portOf(server: FreshServer): number {
  return Number(new URL(server.apiUrl).port);
}

/** Holds `count` connections the server has answered, once it can. */
async function holding(
  port: number,
  count: number,
  host?: string,
): Promise<Socket[]> {
  return waitFor(
    `${String(count)} connections held`,
    async () => {
      const held: Answered[] = [];
      for (let made = 0; made < count; made++) {
        const answered = await ask(port, host).catch(() => undefined);
        if (answered === undefined || answered.status !== 200) {
          answered?.socket.destroy();
          for (const earlier of held) earlier.socket.destroy();
          return undefined;
        }
        held.push(answered);
      }
      return held.map((answered) => answered.socket);
    },
    30_000,
    300,
  );
}

function expectTurnedAway(answer: Answered): void {
  expect(answer.status).toBe(503);
  expect(answer.head).toMatch(/retry-after: 5\r\n/i);
  expect(answer.head).toMatch(/x-error-code: too_many_connections\r\n/i);
  expect(JSON.parse(answer.body).error.code).toBe("too_many_connections");
}

async function servedAgain(port: number, host?: string): Promise<void> {
  const answered = await waitFor(
    "a new connection served",
    async () => {
      const answer = await ask(port, host).catch(() => undefined);
      if (answer?.status === 200) return answer;
      answer?.socket.destroy();
      return undefined;
    },
    10_000,
    200,
  );
  answered.socket.destroy();
}

describe("the public listener's open connections", () => {
  it("turns a connection away past the listener's cap and serves again once one closes", async () => {
    const server = await bootFreshServer("connection-caps-listener", {
      MARFA_MAX_CONNECTIONS: "3",
      MARFA_MAX_CONNECTIONS_PER_ADDRESS: "1000",
    });
    const port = portOf(server);
    const held = await holding(port, 3);
    try {
      const over = await ask(port);
      expectTurnedAway(over);
      over.socket.destroy();

      held.pop()!.destroy();
      await servedAgain(port);
    } finally {
      for (const socket of held) socket.destroy();
    }
  }, 4 * FRESH_SERVER_TIMEOUT_MS);

  it("turns an address away past its share and serves the same address again once one closes", async () => {
    // The listener binds both families, so a second address exists on every
    // machine: the IPv6 loopback beside the IPv4 one.
    const server = await bootFreshServer("connection-caps-address", {
      MARFA_LISTEN_HOST: "::",
      MARFA_MAX_CONNECTIONS: "100",
      MARFA_MAX_CONNECTIONS_PER_ADDRESS: "2",
    });
    const port = portOf(server);
    const held = await holding(port, 2);
    try {
      const over = await ask(port);
      expectTurnedAway(over);
      over.socket.destroy();

      // The witness: another address is served while this one is held.
      const other = await ask(port, "::1");
      expect(other.status).toBe(200);
      other.socket.destroy();

      held.pop()!.destroy();
      await servedAgain(port);
    } finally {
      for (const socket of held) socket.destroy();
    }
  }, 4 * FRESH_SERVER_TIMEOUT_MS);

  it("counts a believed proxy's connections in the listener's cap alone", async () => {
    const server = await bootFreshServer("connection-caps-proxy", {
      MARFA_MAX_CONNECTIONS: "100",
      MARFA_MAX_CONNECTIONS_PER_ADDRESS: "1",
      MARFA_TRUSTED_PROXY_CIDRS: "127.0.0.0/8",
    });
    // Three connections from one address, where a share of one would hold
    // back the second if the address counted.
    const held = await holding(portOf(server), 3);
    for (const socket of held) socket.destroy();
  }, 4 * FRESH_SERVER_TIMEOUT_MS);
});
