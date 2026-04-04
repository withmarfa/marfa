import { createGraphQLError } from "graphql-yoga";
import { MymeError } from "@mymehq/shared";
import type { ApiKey } from "@mymehq/shared";
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
 * Wraps a function that may throw MymeError, converting it to
 * a GraphQLError so yoga doesn't mask the message.
 */
function wrapMymeError<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (
      err instanceof MymeError ||
      (err instanceof Error && err.name === "MymeError")
    ) {
      const pe = err as MymeError;
      throw createGraphQLError(pe.message, {
        extensions: { code: pe.code, status: pe.status, details: pe.details },
      });
    }
    throw err;
  }
}

/** Auth check that throws GraphQLError (not MymeError). */
export function gqlCheckAuth(apiKey: ApiKey | undefined): ApiKey {
  return wrapMymeError(() => _checkAuth(apiKey));
}

/** Admin check that throws GraphQLError (not MymeError). */
export function gqlCheckAdmin(apiKey: ApiKey | undefined): ApiKey {
  return wrapMymeError(() => _checkAdmin(apiKey));
}

/** Type access check that throws GraphQLError (not MymeError). */
export function gqlCheckTypeAccess(
  apiKey: ApiKey | undefined,
  type: string,
  level: "read" | "write",
): void {
  wrapMymeError(() => {
    _checkTypeAccess(apiKey, type, level);
  });
}

// Re-export computeTypeFilter as-is (it doesn't throw)
export { computeTypeFilter };
