import { createServer, type ServerResponse } from "node:http";
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HeartbeatPinger } from "../heartbeat.js";
const controls = vi.hoisted(() => ({ failCancel: false, canceled: 0 }));
vi.mock("undici", async (importOriginal) => {
  const original = await importOriginal<typeof import("undici")>();
  return {
    ...original,
    fetch: async (...args: Parameters<typeof original.fetch>) => {
      const response = await original.fetch(...args);
      const body = response.body;
      if (body) {
        const cancel = body.cancel.bind(body);
        body.cancel = async () => {
          controls.canceled++;
          if (controls.failCancel) throw new Error("fixture cleanup error");
          await cancel();
        };
      }
      return response;
    },
  };
});
import { createWebhookHttpClient } from "./outbound-http.js";
afterEach(() => {
  controls.failCancel = false;
  controls.canceled = 0;
});
async function receiver(streaming: boolean, status: number) {
  let closed!: () => void;
  const released = new Promise<void>((resolve) => {
    closed = resolve;
  });
  let peerClosed!: () => void;
  const peerReleased = new Promise<void>((resolve) => {
    peerClosed = resolve;
  });
  const server = createServer((req, res: ServerResponse) => {
    req.socket.on("close", peerClosed);
    res.writeHead(status, { "Content-Type": "text/plain" });
    res.on("close", closed);
    if (streaming) {
      res.write("ordinary streaming body");
      const interval = setInterval(() => res.write("more body"), 10);
      res.on("close", () => {
        clearInterval(interval);
      });
    } else res.end("ordinary finite body");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("receiver address missing");
  return {
    url: `http://127.0.0.1:${String(address.port)}/response`,
    released,
    peerReleased,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) =>
        server.close(() => {
          resolve();
        }),
      );
    },
  };
}
describe("owned response release", () => {
  for (const status of [200, 503])
    for (const kind of ["webhook", "heartbeat"] as const)
      for (const streaming of [false, true])
        for (const fallback of [false, true]) {
          it(`${kind} ${String(status)} releases ${streaming ? "streaming" : "finite"} response with ${fallback ? "abort fallback" : "body cancellation"}`, async () => {
            const own = await receiver(streaming, status);
            try {
              controls.failCancel = fallback;
              if (kind === "webhook") {
                const outcome = await createWebhookHttpClient({
                  allowPrivateAddresses: true,
                }).post({
                  url: own.url,
                  headers: {},
                  body: "ordinary request",
                  timeoutMs: 2000,
                });
                expect(outcome).toMatchObject({ kind: "answered", status });
                expect(controls.canceled).toBe(1);
              } else {
                let canceled = 0;
                const injected: typeof fetch = async (...args) => {
                  const response = await fetch(...args);
                  const body = response.body;
                  if (body) {
                    const cancel = body.cancel.bind(body);
                    body.cancel = async () => {
                      canceled++;
                      if (fallback) throw new Error("fixture cleanup error");
                      await cancel();
                    };
                  }
                  return response;
                };
                expect(
                  await new HeartbeatPinger(own.url, injected).runOnce(),
                ).toEqual({ ok: status >= 200 && status < 300, status });
                expect(canceled).toBe(1);
              }
              await Promise.race([
                streaming ? own.peerReleased : own.released,
                new Promise<never>((_resolve, reject) =>
                  setTimeout(() => {
                    reject(new Error("owned response remained alive"));
                  }, 1500),
                ),
              ]);
            } finally {
              await own.close();
            }
          });
        }
});
