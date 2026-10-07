import { request, type IncomingHttpHeaders } from "node:http";

/**
 * What a request answers that declares a body larger than the cap, with no
 * body behind the declaration.
 *
 * A request whose whole body is sent races the answer: the server refuses on
 * the declared length, closes the connection, and the client, still writing,
 * is reset more often than not before it reads the status. Declaring the
 * length and sending nothing leaves the server to answer on the header alone.
 */
export function declareOversizeBody(
  url: string,
  options: {
    method: string;
    headers: Record<string, string>;
    bytes: number;
  },
): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        method: options.method,
        headers: {
          ...options.headers,
          "content-length": String(options.bytes),
          connection: "close",
        },
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8").on("data", (chunk: string) => {
          body += chunk;
        });
        res.once("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body,
          });
        });
        res.once("error", reject);
      },
    );
    req.once("error", reject);
    req.flushHeaders();
  });
}
