import { createMiddleware } from "hono/factory";
import { ErrorCode, findLoneSurrogate, MarfaError } from "@withmarfa/shared";
import type { AppEnv } from "./auth.js";
import { bodyCapFor } from "./body-cap.js";
import { exceedsJsonDepth, MAX_JSON_DEPTH } from "../json-depth.js";

/** A JSON escape of a surrogate code unit, U+D800 to U+DFFF. */
const SURROGATE_ESCAPE = /\\u[dD][89a-fA-F]/;

/**
 * Refuses a JSON body that nests deeper than `MAX_JSON_DEPTH`, or that holds
 * text that is not well-formed UTF-16, before any door reads it. It reads a
 * clone, because a door or the sign-in handler reads the request's own body
 * and a body can be read once.
 *
 * Only an escape can carry a lone surrogate: UTF-8 has no byte sequence for
 * one, and the decoder turns a malformed sequence into U+FFFD. So the body is
 * parsed and walked only when its text holds an escape of a surrogate, and
 * only after the depth check has bounded the parse.
 */
export const jsonBodyGuard = createMiddleware<AppEnv>(async (c, next) => {
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
    if (SURROGATE_ESCAPE.test(text)) {
      const path = findLoneSurrogate(parseOrNull(text));
      if (path !== null) {
        throw new MarfaError(ErrorCode.VALIDATION_ERROR, "Validation failed", {
          errors: [
            {
              path,
              message:
                "Must not contain a lone surrogate, which is not well-formed UTF-16",
            },
          ],
        });
      }
    }
  }
  return next();
});

/** The parsed body, or null when it is not JSON, which its door refuses itself. */
function parseOrNull(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
