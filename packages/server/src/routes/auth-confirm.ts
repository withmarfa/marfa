import { Hono } from "hono";
import { z } from "zod";
import { ErrorCode, MarfaError } from "@withmarfa/shared";
import type { AppEnv } from "../middleware/auth.js";
import type { MarfaAuth } from "../auth/instance.js";
import { CONFIRM_REFUSALS } from "../pages/recent-sign-in.js";
import { PasswordAttemptsSpent } from "../auth/sign-in-throttle.js";
import type { Storage } from "../storage/interface.js";
import { setNoStore } from "./no-store.js";

/**
 * What a confirmation carries: the password, or a passkey assertion, and
 * nothing else. The account is the signed-in session's owner, so a body that
 * names an email, or both proofs, is refused rather than ignored.
 */
const ConfirmBody = z.union([
  z.object({ password: z.string().min(1).max(1024) }).strict(),
  z.object({ passkey: z.record(z.string(), z.unknown()) }).strict(),
]);

/**
 * `POST /auth/confirm`, the one door that renews a stale browser session. A
 * page opens its dialog when a change is refused for a sign-in older than five
 * minutes, posts the proof here, and sends the change again under the new
 * session this sets.
 */
export function confirmRoutes(storage: Storage, auth: MarfaAuth) {
  const router = new Hono<AppEnv>();
  router.post("/confirm", async (c) => {
    setNoStore(c);
    const authority = c.get("authority");
    const owner = await storage.owner?.find();
    if (authority?.kind !== "owner" || owner?.id !== authority.userId)
      throw new MarfaError(ErrorCode.UNAUTHORIZED, CONFIRM_REFUSALS.noSession);
    const parsed = ConfirmBody.safeParse(
      await c.req.json().catch(() => undefined),
    );
    if (!parsed.success)
      throw new MarfaError(
        ErrorCode.VALIDATION_ERROR,
        "Send either the owner's password or a passkey assertion.",
      );
    const outcome = await auth.confirmSession({
      headers: c.req.raw.headers,
      clientAddress: c.var.clientIp ?? null,
      current: {
        userId: authority.userId,
        sessionId: authority.sessionId,
        email: owner.email,
      },
      proof:
        "password" in parsed.data
          ? { kind: "password", password: parsed.data.password }
          : { kind: "passkey", response: parsed.data.passkey },
    });
    if (!outcome.ok) {
      if (outcome.reason === "too_many_attempts")
        throw new PasswordAttemptsSpent(outcome.retryAfterSeconds);
      throw new MarfaError(
        ErrorCode.UNAUTHORIZED,
        outcome.reason === "wrong_password"
          ? CONFIRM_REFUSALS.password
          : outcome.reason === "passkey_refused"
            ? CONFIRM_REFUSALS.passkey
            : CONFIRM_REFUSALS.noSession,
      );
    }
    for (const cookie of outcome.cookies)
      c.header("set-cookie", cookie, { append: true });
    return c.json({ ok: true as const });
  });
  return router;
}
