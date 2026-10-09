/**
 * Durable password sign-in attempts, limited by account and address.
 * This replaces the provider's process-local password limiter so recovery
 * can clear the account's complete sign-in lock in the same transaction.
 *
 * - **Per account and address**, so one visitor guessing at the owner's
 *   account is stopped, and the owner signing in from anywhere else is not.
 *   An IPv6 address counts as its /64 (`addressBucket`).
 * - **Per account across every address**, so guessing spread over many
 *   addresses is bounded too. An attempt the first window refused is not
 *   counted here, so one address alone cannot reach this cap; ten can, and
 *   so can one IPv6 /56, which holds 256 /64s.
 *
 * Every attempt counts, the right password included, because the answer has
 * to be given before the password is checked: a limit that only counted
 * failures would still tell a guesser when it had found the password.
 *
 * Mounted as a Better Auth hook rather than on a Marfa route so that it holds
 * for `/auth/sign-in/email` reached directly and for Marfa's sign-in form,
 * which dispatches to it in-process. A password change counts its check of
 * the current password against the same windows (`passwordAttempts`).
 */
import { APIError, createAuthMiddleware } from "better-auth/api";
import { ErrorCode, MarfaError } from "@withmarfa/shared";
import type { Storage } from "../storage/interface.js";
import {
  CLIENT_ADDRESS_HEADER,
  addressBucket,
} from "../middleware/client-ip.js";
import { KeyedThrottle } from "./keyed-throttle.js";

/** Attempts one address may make at one account per window. */
export const SIGN_IN_ADDRESS_LIMIT = 10;
const SIGN_IN_ADDRESS_WINDOW_MS = 15 * 60 * 1000;

/** Attempts at one account from every address together per window. */
export const SIGN_IN_ACCOUNT_LIMIT = 100;
const SIGN_IN_ACCOUNT_WINDOW_MS = 60 * 60 * 1000;

interface SignInHookCtx {
  path?: string;
  body?: Record<string, unknown>;
  headers?: Headers | null;
}

/**
 * The two windows a password check is counted against, shared by sign-in and
 * by every other operation that checks the owner's password, so a guess
 * counts the same wherever it is made. Answers when the caller may try again
 * if the attempt is refused.
 */
export function passwordAttempts(storage: Storage) {
  const perAddress = new KeyedThrottle(storage, {
    family: "sign-in-account-address",
    limit: SIGN_IN_ADDRESS_LIMIT,
    windowMs: SIGN_IN_ADDRESS_WINDOW_MS,
  });
  const perAccount = new KeyedThrottle(storage, {
    family: "sign-in-account",
    limit: SIGN_IN_ACCOUNT_LIMIT,
    windowMs: SIGN_IN_ACCOUNT_WINDOW_MS,
  });
  return async (
    email: string,
    ip: string | null | undefined,
  ): Promise<{ allowed: true } | { allowed: false; retryAfter: number }> => {
    const account = email.trim().toLowerCase();
    const address = ip ? addressBucket(ip) : "unknown";
    const local = await perAddress.attempt(`${account}|${address}`);
    const refused = local.allowed ? await perAccount.attempt(account) : local;
    if (refused.allowed) return { allowed: true };
    return {
      allowed: false,
      retryAfter: Math.max(1, Math.ceil((refused.resetAt - Date.now()) / 1000)),
    };
  };
}

/** A password check refused by `passwordAttempts`, answered with
 *  `Retry-After` by the error handler. */
export class PasswordAttemptsSpent extends MarfaError {
  constructor(readonly retryAfterSeconds: number) {
    super(
      ErrorCode.RATE_LIMITED,
      `Too many password attempts. Try again in ${String(retryAfterSeconds)} seconds.`,
    );
  }
}

export function buildSignInThrottlePlugin(storage: Storage) {
  const attempt = passwordAttempts(storage);
  return {
    id: "marfa-sign-in-throttle" as const,
    hooks: {
      before: [
        {
          matcher: (ctx: SignInHookCtx) => ctx.path === "/sign-in/email",
          handler: createAuthMiddleware(async (ctx: SignInHookCtx) => {
            const email = ctx.body?.email;
            if (typeof email !== "string") return;
            const admitted = await attempt(
              email,
              ctx.headers?.get(CLIENT_ADDRESS_HEADER),
            );
            if (admitted.allowed) return;
            throw new APIError(
              "TOO_MANY_REQUESTS",
              { message: "Too many sign-in attempts. Try again later." },
              { "Retry-After": String(admitted.retryAfter) },
            );
          }),
        },
      ],
    },
  };
}
