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
  /** Resolve once a delivery satisfying `matches` has arrived. */
  waitFor: (matches: (r: Received) => boolean) => Promise<Received>;
  close: () => Promise<void>;
}

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
      for (;;) {
        const hit = received.find(matches);
        if (hit) return hit;
        await new Promise((r) => setTimeout(r, 50));
      }
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
