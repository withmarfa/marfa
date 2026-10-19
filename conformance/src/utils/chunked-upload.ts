import { request } from "node:http";

/** Sends an unknown-length body, including when the server refuses it early. */
export async function chunkedUpload(
  apiUrl: string,
  key: string,
  send: (
    write: (part: Uint8Array) => Promise<void>,
    signal: AbortSignal,
  ) => Promise<void>,
  timeoutMs = 20_000,
): Promise<{ status: number; body: string }> {
  const abort = new AbortController();
  const req = request(new URL("/blobs", apiUrl), {
    method: "POST",
    signal: abort.signal,
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/octet-stream",
      "Transfer-Encoding": "chunked",
    },
  });
  let phase = "sending the request body";
  let queued = 0;
  let flushed = 0;
  let status: number | undefined;
  const answered = new Promise<{ status: number; body: string }>(
    (resolve, reject) => {
      req.on("response", (response) => {
        status = response.statusCode;
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (text: string) => (body += text));
        response.once("error", reject);
        response.once("end", () => resolve({ status: status!, body }));
      });
      req.on("error", (error) => {
        // An early response can close the request's still-pending writes.
        // Once headers arrive, the response's end/error decides the result.
        if (status === undefined) reject(error);
      });
    },
  );
  const write = async (part: Uint8Array): Promise<void> => {
    abort.signal.throwIfAborted();
    queued += part.byteLength;
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => reject(abort.signal.reason);
      abort.signal.addEventListener("abort", onAbort, { once: true });
      req.write(part, (error) => {
        abort.signal.removeEventListener("abort", onAbort);
        if (error) reject(error);
        else {
          flushed += part.byteLength;
          resolve();
        }
      });
    });
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(
        new Error(
          `Chunked upload stalled while ${phase} after ${String(timeoutMs)}ms ` +
            `(${String(queued)} bytes queued, ${String(flushed)} flushed, ` +
            `response status ${String(status ?? "not received")})`,
        ),
      );
    }, timeoutMs);
  });
  const sending = Promise.resolve()
    .then(async () => {
      await send(write, abort.signal);
      abort.signal.throwIfAborted();
      phase = "waiting for the response";
      req.end();
      return answered;
    })
    .catch((error: unknown) => {
      if (status !== undefined) return answered;
      throw error;
    });
  try {
    // A response must not wait for a write callback on a refused body.
    return await Promise.race([answered, sending, deadline]);
  } finally {
    clearTimeout(timer);
    abort.abort();
    req.destroy();
  }
}
