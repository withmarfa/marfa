import { createHmac } from "node:crypto";
import { createServer, type Server } from "node:http";
import { expect } from "vitest";

export interface Received {
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

export interface Receiver {
  /** Base URL on the loopback interface the booted server can reach. */
  url: string;
  /** A URL of its own per subscription, so deliveries are attributable. */
  hookUrl: (label: string) => string;
  received: Received[];
  /**
   * Resolve once a delivery satisfying `matches` has arrived, or throw
   * naming what did arrive once the wait has run out. A wait with no end
   * fails as the file's own timeout, pointing at the case and saying
   * nothing about which delivery never came.
   */
  waitFor: (matches: (r: Received) => boolean) => Promise<Received>;
  close: () => Promise<void>;
}

/**
 * Half the file timeout the suites run under, so a delivery that never
 * comes is reported by this wait and not by vitest cutting the case off.
 */
const WAIT_MS = 60_000;

export async function startReceiver(): Promise<Receiver> {
  const received: Received[] = [];
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
    });
    req.on("end", () => {
      received.push({ path: req.url ?? "", headers: req.headers, body });
      res.writeHead(200);
      res.end("ok");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (typeof address !== "object" || address === null) {
    throw new Error("the receiver did not bind to a port");
  }
  const url = `http://127.0.0.1:${String(address.port)}/hook`;
  return {
    url,
    hookUrl: (label) => `${url}/${label}`,
    received,
    waitFor: async (matches) => {
      const deadline = Date.now() + WAIT_MS;
      while (Date.now() < deadline) {
        const hit = received.find(matches);
        if (hit) return hit;
        await new Promise((r) => setTimeout(r, 50));
      }
      const arrived = received
        .map((r) => `${r.path} ${r.body.slice(0, 120)}`)
        .join("\n  ");
      throw new Error(
        `no delivery matched within ${String(WAIT_MS / 1000)}s; ${String(received.length)} arrived` +
          (arrived ? `:\n  ${arrived}` : ""),
      );
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/**
 * The signature header is `t=<unix seconds>,v1=<hex sha256>`, the HMAC over
 * `<t>.<raw body>` under the subscription's secret.
 */
export function expectSignedBy(delivery: Received, secret: string): void {
  const signature = String(delivery.headers["x-marfa-signature"]);
  const match = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(signature);
  expect(match).not.toBeNull();
  const [, t, v1] = match as RegExpExecArray;
  const expected = createHmac("sha256", secret)
    .update(`${t}.${delivery.body}`)
    .digest("hex");
  expect(v1).toBe(expected);
}
