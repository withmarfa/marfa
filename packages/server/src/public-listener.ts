import { createServer, type RequestListener } from "node:http";
import { getRequestListener } from "@hono/node-server";
import type { AppConfig } from "./config.js";

/** Reserve the actual listener before auth derives its origin from the port. */
export async function reservePublicListener(config: AppConfig) {
  let handler: RequestListener | undefined;
  const server = createServer((request, response) => {
    if (handler) handler(request, response);
    else {
      response.writeHead(503, { Connection: "close" });
      response.end("Server is starting");
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Public listener has no TCP address");
  config.port = address.port;
  if (config.authBaseUrlFromPort)
    config.authBaseUrl = `http://localhost:${String(address.port)}`;
  return {
    server,
    activate(fetch: Parameters<typeof getRequestListener>[0]) {
      const listener = getRequestListener(fetch);
      handler = (request, response) => {
        void listener(request, response);
      };
    },
  };
}
