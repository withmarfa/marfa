import { createGraphQLError } from "graphql-yoga";
import { ProtocolError } from "@myme/shared";
import type { ApiKey } from "@myme/shared";
import type { Storage } from "../storage/interface.js";
import {
  checkAuth as _checkAuth,
  checkAdmin as _checkAdmin,
  checkTypeAccess as _checkTypeAccess,
  computeTypeFilter,
} from "../middleware/auth.js";

export interface GraphQLContext {
  apiKey: ApiKey | undefined;
  authType: "api_key" | "oauth" | undefined;
  storage: Storage;
}

/**
 * Wraps a function that may throw ProtocolError, converting it to
 * a GraphQLError so yoga doesn't mask the message.
 */
function wrapProtocolError<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof ProtocolError || (err instanceof Error && err.name === "ProtocolError")) {
      const pe = err as ProtocolError;
      throw createGraphQLError(pe.message, {
        extensions: { code: pe.code, status: pe.status, details: pe.details },
      });
    }
    throw err;
  }
}

/** Auth check that throws GraphQLError (not ProtocolError). */
export function gqlCheckAuth(apiKey: ApiKey | undefined): ApiKey {
  return wrapProtocolError(() => _checkAuth(apiKey));
}

/** Admin check that throws GraphQLError (not ProtocolError). */
export function gqlCheckAdmin(apiKey: ApiKey | undefined): ApiKey {
  return wrapProtocolError(() => _checkAdmin(apiKey));
}

/** Type access check that throws GraphQLError (not ProtocolError). */
export function gqlCheckTypeAccess(
  apiKey: ApiKey | undefined,
  type: string,
  level: "read" | "write",
): void {
  wrapProtocolError(() => _checkTypeAccess(apiKey, type, level));
}

// Re-export computeTypeFilter as-is (it doesn't throw)
export { computeTypeFilter };
