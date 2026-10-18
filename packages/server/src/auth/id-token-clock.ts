import { createAuthMiddleware } from "better-auth/api";
import { signJWT } from "better-auth/plugins";
import * as clock from "../clock.js";

/**
 * The provider stamps ID tokens before calling its custom-claims hook and
 * reserves the time claims. Re-sign only those external credentials when the
 * test clock moves; sessions and opaque tokens keep the provider's clock.
 */
export function realTimeIdTokens() {
  return {
    id: "marfa-id-token-clock" as const,
    hooks: {
      after: [
        {
          matcher: (ctx: { path?: string }) =>
            ctx.path === "/oauth2/token" &&
            clock.dateShimInstalled() &&
            clock.clockOffsetMs() !== 0,
          handler: createAuthMiddleware(async (ctx) => {
            const answer = ctx.context.returned as
              Record<string, unknown> | undefined;
            if (!answer || typeof answer.id_token !== "string") return;
            const encoded = answer.id_token.split(".")[1];
            if (!encoded)
              throw new Error("The provider issued an invalid ID token");
            const payload = JSON.parse(
              Buffer.from(encoded, "base64url").toString(),
            ) as Parameters<typeof signJWT>[1]["payload"];
            // NumericDate claims use seconds; rounding toward earlier expiry
            // never extends a credential's lifetime for a fractional offset.
            const difference = Math.ceil(clock.clockOffsetMs() / 1000);
            for (const field of ["iat", "exp", "nbf", "auth_time"]) {
              if (typeof payload[field] === "number")
                payload[field] -= difference;
            }
            const idToken = await clock.withRealTime(() =>
              signJWT(ctx, { payload }),
            );
            return { ...answer, id_token: idToken };
          }),
        },
      ],
    },
  };
}
