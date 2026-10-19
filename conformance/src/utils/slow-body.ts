import { request } from "node:http";

/** Where a request goes: the public listener, or the private control socket. */
export type Door = { apiUrl: string } | { socketPath: string };

export interface SlowUpload {
  /** Sends one part of the body and resolves once the socket has taken it. */
  write(part: Uint8Array): Promise<void>;
  /** Ends the body. */
  end(): void;
  /** The answer, which can arrive before the body is whole. */
  answered: Promise<{ status: number; body: string }>;
}

/**
 * A `POST` whose body the fixture sends a part at a time, however slowly, as
 * a person on a poor link does. The body has no declared length, so the
 * server cannot judge it before the last part. A connection the server cuts
 * before it answers rejects `answered`.
 */
export function slowPost(
  door: Door,
  path: string,
  headers: Record<string, string>,
): SlowUpload {
  const target =
    "socketPath" in door
      ? { socketPath: door.socketPath, path }
      : { ...urlOptions(door.apiUrl), path };
  const req = request({
    ...target,
    method: "POST",
    agent: false,
    headers: { ...headers, "transfer-encoding": "chunked" },
  });
  const answered = new Promise<{ status: number; body: string }>(
    (resolve, reject) => {
      req.on("response", (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (text: string) => (body += text));
        response.once("error", reject);
        response.once("end", () => {
          resolve({ status: response.statusCode ?? 0, body });
          req.destroy();
        });
      });
      req.on("error", reject);
    },
  );
  // A fixture that stops waiting for the answer must not leave it unhandled.
  answered.catch(() => undefined);
  return {
    write: (part) =>
      new Promise<void>((resolve, reject) => {
        req.write(part, (error) => {
          if (error) reject(error);
          else resolve();
        });
      }),
    end: () => {
      req.end();
    },
    answered,
  };
}

function urlOptions(apiUrl: string): { hostname: string; port: string } {
  const url = new URL(apiUrl);
  return { hostname: url.hostname, port: url.port };
}

/** `body` cut into `count` parts of nearly equal size. */
export function inParts(body: Uint8Array, count: number): Uint8Array[] {
  const size = Math.ceil(body.length / count);
  return Array.from({ length: count }, (_, index) =>
    body.subarray(index * size, (index + 1) * size),
  ).filter((part) => part.length > 0);
}

export function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
