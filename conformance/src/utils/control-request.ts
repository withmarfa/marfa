import { request } from "node:http";

/** Uses the server's production local listener, without an HTTP credential. */
export function controlRequest(
  socketPath: string,
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const body =
      init.body === undefined ? undefined : JSON.stringify(init.body);
    const req = request(
      {
        socketPath,
        path,
        method: init.method ?? "GET",
        headers:
          body === undefined
            ? {}
            : {
                "content-type": "application/json",
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
