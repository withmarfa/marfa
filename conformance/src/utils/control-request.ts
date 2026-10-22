import { request } from "node:http";

/**
 * Uses the server's production local listener, without an HTTP credential.
 * A `Uint8Array` body is sent as it is, as `application/octet-stream`; any
 * other body is sent as JSON.
 */
export function controlRequest(
  socketPath: string,
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const raw = init.body instanceof Uint8Array;
    const body: string | Uint8Array | undefined =
      init.body === undefined
        ? undefined
        : init.body instanceof Uint8Array
          ? init.body
          : JSON.stringify(init.body);
    const req = request(
      {
        socketPath,
        path,
        method: init.method ?? "GET",
        headers:
          body === undefined
            ? {}
            : {
                "content-type": raw
                  ? "application/octet-stream"
                  : "application/json",
                "content-length": Buffer.byteLength(body),
              },
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (part: string) => {
          text += part;
        });
        res.on("end", () => {
          try {
            resolve({
              status: res.statusCode ?? 0,
              body: JSON.parse(text) as Record<string, unknown>,
            });
          } catch {
            reject(
              new Error(
                `Local control answered invalid JSON (${res.statusCode})`,
              ),
            );
          }
        });
        res.on("error", reject);
      },
    );
    req.setTimeout(30_000, () =>
      req.destroy(new Error("Local control request timed out")),
    );
    req.on("error", reject);
    req.end(body);
  });
}
