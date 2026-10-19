import type { IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import { ErrorCode, MarfaError } from "@withmarfa/shared";
import type { Context } from "hono";
import type { AppEnv } from "./middleware/auth.js";
import { liftRequestDeadline } from "./request-deadline.js";

export const DEFAULT_UPLOAD_IDLE_TIMEOUT_MS = 60_000;

/**
 * The body of a restore or a blob upload, which streams to disk and takes no
 * size cap. It has no total deadline: the request's fixed one is lifted, and
 * the body ends instead when no bytes arrive for `idleTimeoutMs`, with
 * `408 request_timeout`. The wait counts only while the server is waiting for
 * the sender, so a slow disk never ends an upload.
 *
 * Call it once the caller is admitted, because it lifts the deadline.
 */
export function uploadBody(
  c: Context<AppEnv>,
  idleTimeoutMs: number,
): Readable | null {
  const body = c.req.raw.body;
  if (!body) return null;
  const env = c.env as { incoming?: IncomingMessage } | undefined;
  if (env?.incoming) liftRequestDeadline(env.incoming);
  return Readable.from(arriving(body.getReader(), idleTimeoutMs), {
    objectMode: false,
  });
}

async function* arriving(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  idleTimeoutMs: number,
): AsyncGenerator<Uint8Array> {
  try {
    for (;;) {
      let timer: NodeJS.Timeout | undefined;
      const stalled = new Promise<"stalled">((resolve) => {
        timer = setTimeout(resolve, idleTimeoutMs, "stalled");
      });
      const read = reader.read();
      read.catch(() => undefined);
      const next = await Promise.race([read, stalled]).finally(() => {
        clearTimeout(timer);
      });
      if (next === "stalled") {
        throw new MarfaError(
          ErrorCode.REQUEST_TIMEOUT,
          `No bytes arrived for ${String(idleTimeoutMs / 1000)} seconds`,
        );
      }
      if (next.done) return;
      yield next.value;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}
