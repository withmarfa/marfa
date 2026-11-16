import { createServer } from "node:http";
import { waitFor } from "./wait.js";

/** A heartbeat receiver on loopback that counts the requests it answers. */
export interface BeatReceiver {
  /** The value to give `heartbeat_url`. */
  url: string;
  count(): number;
  /** Waits until `more` beats beyond the count now have arrived. */
  more(more: number, what: string, timeoutMs?: number): Promise<void>;
  close(): Promise<void>;
}

export async function beatReceiver(): Promise<BeatReceiver> {
  let received = 0;
  const server = createServer((_request, response) => {
    received += 1;
    response.writeHead(204).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (typeof address !== "object" || address === null) {
    throw new Error("the heartbeat receiver did not bind to a port");
  }
  return {
    url: `http://127.0.0.1:${String(address.port)}/beat`,
    count: () => received,
    async more(more, what, timeoutMs = 30_000) {
      const target = received + more;
      await waitFor(
        what,
        async () => (received >= target ? true : undefined),
        timeoutMs,
      );
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
