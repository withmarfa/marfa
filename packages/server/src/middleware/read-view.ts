import { createMiddleware } from "hono/factory";
import type { Context } from "hono";
import { ErrorCode, MarfaError } from "@withmarfa/shared";
import type { AppEnv } from "./auth.js";
import { requireAuth } from "./auth.js";
import { shapedError } from "./error-handler.js";
import type { Storage } from "../storage/interface.js";
import {
  READ_VIEW_HEADER,
  READ_VIEW_PATTERN,
  readViewAuthority,
} from "../storage/read-view.js";

export const CONDITIONAL_READ_OPERATIONS = new Set([
  "listItems",
  "getItem",
  "listItemEdges",
  "listEdges",
  "getEdge",
  "listTypes",
  "listEdgeTypes",
  "getCurrentKey",
]);
const ATTRIBUTED_REFUSALS = new Set<string>([
  ErrorCode.ITEM_NOT_FOUND,
  ErrorCode.EDGE_NOT_FOUND,
  ErrorCode.TYPE_NOT_PERMITTED,
  ErrorCode.EDGE_PERMISSION_DENIED,
]);
export function invalidReadViewRequest(message: string): MarfaError {
  return new MarfaError(ErrorCode.VALIDATION_ERROR, message);
}
export function requestReadView(c: Context<AppEnv>): string | undefined {
  const raw = c.req.header(READ_VIEW_HEADER);
  if (raw !== undefined && !READ_VIEW_PATTERN.test(raw))
    throw invalidReadViewRequest(
      "X-Marfa-Read-View must be exactly one 64-character lowercase hexadecimal value",
    );
  return raw;
}

/** Installed on declared doors ahead of their standing rules and validators. */
export const conditionalReadBoundary = createMiddleware<AppEnv>(
  async (c, next) => {
    if (c.req.method !== "GET" || c.req.header(READ_VIEW_HEADER) === undefined)
      return next();
    return c.get("copyReadBoundary")(c, next);
  },
);

export function copyReadBoundary(
  storage: Storage,
  instanceId: string,
  signingKey: Buffer,
) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const expected = requestReadView(c);
    if (expected === undefined) return next();
    if (
      c.req.path.replace(/\/$/, "") === "/items" &&
      !(c.req.query("include") ?? "")
        .split(",")
        .map((part) => part.trim())
        .includes("metadata")
    ) {
      throw invalidReadViewRequest(
        "Conditional item pages require include=metadata",
      );
    }
    requireAuth(c);
    const bound = c.get("boundCredential");
    if (!bound)
      throw new MarfaError(ErrorCode.UNAUTHORIZED, "Authentication required");
    const result = await storage.runInReadSnapshot(
      async (pin) => {
        const authority = await readViewAuthority(
          storage,
          bound,
          pin,
          instanceId,
          signingKey,
          expected,
        );
        c.set("apiKey", authority.key);
        c.set("authType", bound.kind);
        c.set(
          "oauthGrant",
          bound.kind === "oauth"
            ? {
                scopes: authority.permissions,
                clientId: bound.clientId,
                authUserId: bound.authUserId,
              }
            : undefined,
        );
        c.set("readViewAuthority", authority);
        await next();
        const error = shapedError(c.error);
        const attributed =
          error !== undefined &&
          (ATTRIBUTED_REFUSALS.has(error.code) ||
            (c.req.path === "/keys/current" && error.code === "forbidden"));
        return {
          readView: authority.readView,
          response: c.res,
          certify: (c.res.status >= 200 && c.res.status < 300) || attributed,
        };
      },
      { signal: c.req.raw.signal },
    );
    if (result.certify) {
      result.response.headers.set(READ_VIEW_HEADER, result.readView);
      result.response.headers.set("Cache-Control", "no-store");
      c.res = result.response;
    }
  });
}
