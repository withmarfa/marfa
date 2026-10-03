/**
 * The inbound webhook door: a sender posts to an endpoint's address, and the
 * server stores what arrived and answers `202` with the delivery's id at
 * once. It never reads, verifies or acts on a delivery; the connector that
 * owns the endpoint does. The address is the credential, and one no live
 * endpoint holds answers as a path the server does not serve. A plain
 * handler, like the event stream: no Marfa client calls it, so it stays out
 * of the document (`conformance/spec/inbound-webhooks.md` states it).
 */
import type { IncomingMessage } from "node:http";
import type { ReadableStreamReadResult } from "node:stream/web";
import { Hono } from "hono";
import type { Context } from "hono";
import { MarfaError, ErrorCode } from "@withmarfa/shared";
import type { AppEnv } from "../middleware/auth.js";
import type { Storage } from "../storage/interface.js";
import type { AppConfig } from "../config.js";
import { DEFAULT_INBOUND_LIMITS } from "../config.js";
import { shapedError } from "../middleware/error-handler.js";
import { hashInboundToken } from "../inbound/address.js";

/** Long enough for a backlog to drain or a burst to pass. */
const RETRY_AFTER_SECONDS = 60;

/** The headers as they arrived: the order, the case and every repeat, where
 *  the Fetch `Headers` the router hands over folds all three. */
function receivedHeaders(c: Context<AppEnv>): [string, string][] {
  const raw = (c.env as { incoming?: Partial<IncomingMessage> } | undefined)
    ?.incoming?.rawHeaders;
  if (raw !== undefined) {
    const pairs: [string, string][] = [];
    let name: string | undefined;
    for (const part of raw) {
      if (name === undefined) {
        name = part;
      } else {
        pairs.push([name, part]);
        name = undefined;
      }
    }
    return pairs;
  }
  return [...c.req.raw.headers.entries()];
}

function rawQuery(url: string): string {
  const at = url.indexOf("?");
  return at === -1 ? "" : url.slice(at + 1);
}

function unavailable(c: Context<AppEnv>, message: string): MarfaError {
  c.header("Retry-After", String(RETRY_AFTER_SECONDS));
  return new MarfaError(ErrorCode.INBOUND_UNAVAILABLE, message);
}

export function inboundRoutes(storage: Storage, config: AppConfig) {
  const router = new Hono<AppEnv>();
  const limits = config.inbound ?? DEFAULT_INBOUND_LIMITS;
  let inFlight = 0;

  router.post("/:token", async (c) => {
    const target = await storage.inbound.target(
      hashInboundToken(c.req.param("token")),
    );
    if (target === null) {
      throw new MarfaError(ErrorCode.NOT_FOUND, "Not found");
    }

    if (config.rateLimitEnabled) {
      const key = `endpoint:${target.endpoint_id}`;
      const now = Date.now();
      const windows = await storage.rateLimits.incrementWindows(
        "inbound",
        [key],
        config.rateLimitWindowMs,
        new Date(now).toISOString(),
      );
      const window = windows.get(key);
      if (window !== undefined && window.count > limits.requestsPerWindow) {
        const retryAfter = Math.ceil(
          (new Date(window.expires_at).getTime() - now) / 1000,
        );
        c.header("Retry-After", String(retryAfter));
        throw new MarfaError(
          ErrorCode.RATE_LIMITED,
          `This endpoint's rate limit is spent. Try again in ${String(retryAfter)} seconds`,
        );
      }
    }

    const backlog = await storage.inbound.backlog(target.connector_id);
    if (backlog.count >= limits.backlogDeliveries) {
      throw unavailable(c, "The connector's backlog is full");
    }

    const declared = Number(c.req.header("content-length") ?? "0");
    if (declared > limits.maxBytes) {
      throw new MarfaError(
        ErrorCode.REQUEST_TOO_LARGE,
        "Request body too large",
      );
    }

    const chunks: Buffer[] = [];
    let held = 0;
    try {
      const reader = c.req.raw.body?.getReader();
      if (reader !== undefined) {
        let timer: NodeJS.Timeout | undefined;
        const deadline = new Promise<"late">((resolve) => {
          timer = setTimeout(() => {
            resolve("late");
          }, limits.readTimeoutMs);
        });
        try {
          for (;;) {
            let read: ReadableStreamReadResult<Uint8Array> | "late";
            try {
              read = await Promise.race([
                reader.read() as Promise<ReadableStreamReadResult<Uint8Array>>,
                deadline,
              ]);
            } catch {
              // The sender went away mid-body: a refusal of what arrived,
              // not a fault of the server's.
              throw new MarfaError(
                ErrorCode.VALIDATION_ERROR,
                "The body did not arrive whole",
              );
            }
            if (read === "late") {
              await reader.cancel().catch(() => undefined);
              throw new MarfaError(
                ErrorCode.REQUEST_TIMEOUT,
                "The body did not arrive in time",
              );
            }
            if (read.done) break;
            const chunk = read.value;
            if (held + chunk.byteLength > limits.maxBytes) {
              await reader.cancel();
              throw new MarfaError(
                ErrorCode.REQUEST_TOO_LARGE,
                "Request body too large",
              );
            }
            if (inFlight + chunk.byteLength > limits.inFlightBytes) {
              await reader.cancel();
              throw unavailable(c, "The instance is holding all it will");
            }
            inFlight += chunk.byteLength;
            held += chunk.byteLength;
            chunks.push(
              Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength),
            );
          }
        } finally {
          clearTimeout(timer);
        }
      }
      const headers = receivedHeaders(c);
      let received: Awaited<ReturnType<Storage["inbound"]["receive"]>>;
      try {
        received = await storage.inbound.receive(
          {
            tokenHash: hashInboundToken(c.req.param("token")),
            method: c.req.method,
            query: rawQuery(c.req.url),
            headers,
            body: Buffer.concat(chunks, held),
          },
          limits,
        );
      } catch (error) {
        if (shapedError(error) !== undefined) throw error;
        // eslint-disable-next-line preserve-caught-error -- Receipt SQL parameters must not reach error sinks.
        throw new Error("Inbound receipt storage failed");
      }
      if (received.kind === "not_found") {
        throw new MarfaError(ErrorCode.NOT_FOUND, "Not found");
      }
      if (received.kind === "capacity") {
        throw unavailable(c, "The registration's inbound capacity is full");
      }
      return c.json({ id: received.id }, 202);
    } finally {
      inFlight -= held;
    }
  });

  return router;
}
