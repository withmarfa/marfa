/**
 * The per-account limit on password sign-in, beside Better Auth's own
 * per-address limiter.
 *
 * Better Auth's limiter holds one address to three attempts every ten
 * seconds, which still lets it try about a thousand passwords an hour for
 * as long as it likes. This holds the attempts at one account, in two
 * windows:
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
 * which dispatches to it in-process.
 */
import { APIError, createAuthMiddleware } from "better-auth/api";
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

export function buildSignInThrottlePlugin(storage: Storage) {
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

  const refuse = (resetAt: number): never => {
    const retryAfter = Math.max(1, Math.ceil((resetAt - Date.now()) / 1000));
    throw new APIError(
      "TOO_MANY_REQUESTS",
      { message: "Too many sign-in attempts. Try again later." },
      { "Retry-After": String(retryAfter) },
    );
  };

  return {
    id: "marfa-sign-in-throttle" as const,
    hooks: {
      before: [
        {
          matcher: (ctx: SignInHookCtx) => ctx.path === "/sign-in/email",
          handler: createAuthMiddleware(async (ctx: SignInHookCtx) => {
            const email = ctx.body?.email;
            if (typeof email !== "string") return;
            const account = email.trim().toLowerCase();
            const ip = ctx.headers?.get(CLIENT_ADDRESS_HEADER);
            const address = ip ? addressBucket(ip) : "unknown";
            const local = await perAddress.attempt(`${account}|${address}`);
            if (!local.allowed) refuse(local.resetAt);
            const overall = await perAccount.attempt(account);
            if (!overall.allowed) refuse(overall.resetAt);
          }),
        },
      ],
    },
  };
}
