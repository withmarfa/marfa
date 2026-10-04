import { createMiddleware } from "hono/factory";
import { ErrorCode, MarfaError } from "@withmarfa/shared";
import type { AppEnv } from "./auth.js";
import { bodyCapFor } from "./body-cap.js";
import { exceedsJsonDepth, MAX_JSON_DEPTH } from "../json-depth.js";

/**
 * Refuses a JSON body nested deeper than `MAX_JSON_DEPTH` before any door
 * reads it. It reads a clone, because a door or the sign-in handler reads
 * the request's own body and a body can be read once.
 */
export const jsonDepthLimit = createMiddleware<AppEnv>(async (c, next) => {
  const cap = bodyCapFor(c.req.path);
  if (cap === "none" || cap === "inbound") return next();
  const type = c.req.header("content-type") ?? "";
  if (/\bjson\b/i.test(type) && c.req.method !== "GET") {
    const text = await c.req.raw.clone().text();
    if (exceedsJsonDepth(text, MAX_JSON_DEPTH)) {
      throw new MarfaError(
        ErrorCode.VALIDATION_ERROR,
        `Request body nests deeper than ${String(MAX_JSON_DEPTH)} levels`,
      );
    }
  }
  return next();
});
