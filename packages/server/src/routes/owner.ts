import { createRoute, z } from "@hono/zod-openapi";
import { getCookie, deleteCookie } from "hono/cookie";
import { MarfaError, ErrorCode } from "@withmarfa/shared";
import {
  directAuthorityOnly,
  ownerBrowserOnly,
  requireRecentOwnerAuthentication,
} from "../middleware/auth.js";
import type { AppEnv } from "../middleware/auth.js";
import {
  createOpenAPIRouter,
  makeErrorResponseSchema,
  OkResponseSchema,
} from "../openapi.js";
import type { MarfaAuth } from "../auth/instance.js";
import type { Storage } from "../storage/interface.js";
import { claimOwner } from "../auth/instance-claim.js";
import { requireOwnerOrigin } from "../auth/owner-browser.js";
import { SETUP_COOKIE } from "./setup.js";
import { setNoStore } from "./no-store.js";
import { OwnerSchema, ownerWire } from "./owner-wire.js";
import { NextCursorSchema } from "./_schemas.js";
const failure = (
  codes: Parameters<typeof makeErrorResponseSchema>[0],
  description: string,
) => ({
  content: { "application/json": { schema: makeErrorResponseSchema(codes) } },
  description,
});
const getOwnerRoute = createRoute({
  operationId: "getOwner",
  method: "get",
  path: "/",
  tags: ["Access"],
  summary: "Get the owner",
  security: [{ ownerSession: [] }],
  middleware: directAuthorityOnly,
  description:
    "Returns the owner of the claimed instance. Requires a direct owner sign-in or local process authority.",
  responses: {
    200: {
      content: { "application/json": { schema: OwnerSchema } },
      description: "The owner.",
    },
    401: failure(["unauthorized"], "Sign in as the owner."),
    403: failure(
      ["forbidden"],
      "This operation requires direct owner or local authority.",
    ),
    404: failure(["owner_not_found"], "The owner is unavailable."),
  },
});
const createOwnerRoute = createRoute({
  operationId: "createOwner",
  method: "post",
  path: "/",
  tags: ["Access"],
  summary: "Claim the instance",
  description:
    "Creates the one owner using a machine-issued setup code or setup-only browser session. The claim, consumed proof, and audit commit together. A claimed instance never reopens setup.",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            email: z
              .email()
              .max(254)
              .describe("Email address the owner uses to sign in."),
            password: z.string().describe("Password for the new owner."),
            name: z
              .string()
              .trim()
              .max(200)
              .optional()
              .describe(
                "Display name. Defaults to the part before @ in the email address when omitted or blank.",
              ),
            code: z
              .string()
              .optional()
              .describe(
                "Machine-issued setup code. Omit when using a setup-only browser session.",
              ),
          }),
        },
      },
    },
  },
  responses: {
    201: {
      content: { "application/json": { schema: OwnerSchema } },
      description: "The new owner can sign in.",
    },
    400: failure(
      ["validation_error", "missing_required_field"],
      "Owner details are invalid.",
    ),
    401: failure(
      ["unauthorized"],
      "Setup proof is invalid, expired, or replaced.",
    ),
    403: failure(
      ["forbidden"],
      "The browser origin or transport is not permitted.",
    ),
    409: failure(["owner_exists"], "The instance has already been claimed."),
    429: failure(
      ["rate_limited"],
      "The address has used its setup-code attempts.",
    ),
  },
});
const SignInSchema = z
  .object({
    id: z
      .string()
      .describe("Unique identifier for the sign-in.")
      .openapi({ example: "Q2xYvR8mKp4TnW6aBc0dEf1gHi3jKl5M" }),
    kind: z
      .enum(["browser"])
      .describe(
        "What signed in. `browser`: a browser signed in with the owner's password.",
      ),
    current: z.boolean().describe("`true` if this sign-in sent the request."),
    created_at: z
      .string()
      .describe("When the sign-in was made, in UTC.")
      .openapi({ example: "2026-10-03T09:30:00.000Z" }),
    last_used_at: z
      .string()
      .describe(
        "When the sign-in last made a request, in UTC. Marfa records a request at most once a minute.",
      )
      .openapi({ example: "2026-10-05T14:12:08.000Z" }),
    expires_at: z
      .string()
      .describe(
        "When the sign-in ends unless it makes another request, in UTC: seven days and one minute after `last_used_at`.",
      )
      .openapi({ example: "2026-10-12T14:13:08.000Z" }),
    ip_address: z
      .string()
      .nullable()
      .describe(
        "The address the sign-in was made from, or `null` when Marfa could not tell.",
      )
      .openapi({ example: "203.0.113.24" }),
    user_agent: z
      .string()
      .nullable()
      .describe(
        "The `User-Agent` the browser sent when it signed in, or `null` when it sent none.",
      ),
  })
  .describe("A sign-in is one way the owner is signed in to Marfa.")
  .openapi("SignIn");
const SignInListSchema = z
  .object({
    data: z
      .array(SignInSchema)
      .describe("The owner's live sign-ins, oldest first."),
    next_cursor: NextCursorSchema.describe(
      "Always `null`: Marfa returns every sign-in in one page.",
    ),
  })
  .describe("Every live sign-in of the owner.")
  .openapi("SignInList");
const listSignInsRoute = createRoute({
  operationId: "listSignIns",
  method: "get",
  path: "/sign-ins",
  tags: ["Access"],
  summary: "List sign-ins",
  security: [{ ownerSession: [] }],
  middleware: ownerBrowserOnly,
  description:
    "Returns the browser sessions the owner is signed in with, marking the one that sent the request. Requires the owner signed in in a browser.",
  responses: {
    200: {
      content: { "application/json": { schema: SignInListSchema } },
      description: "Returns every live sign-in.",
    },
    401: failure(["unauthorized"], "Sign in as the owner."),
    403: failure(
      ["forbidden"],
      "- `forbidden`: the request carries a key, an app's token or a local command's authority rather than the owner's browser session.",
    ),
  },
});
const endSignInRoute = createRoute({
  operationId: "endSignIn",
  method: "delete",
  path: "/sign-ins/{id}",
  tags: ["Access"],
  summary: "End a sign-in",
  security: [{ ownerSession: [] }],
  middleware: ownerBrowserOnly,
  description:
    "Ends a browser session at once, so that browser must sign in again. Connected apps keep their access. Requires the owner signed in in a browser within the last five minutes.",
  request: {
    params: z.object({
      id: z.string().describe("The ID of the sign-in."),
    }),
  },
  responses: {
    200: {
      content: { "application/json": { schema: OkResponseSchema } },
      description: "Returns `ok: true`. The sign-in has ended.",
    },
    401: failure(["unauthorized"], "Sign in as the owner."),
    403: failure(
      ["forbidden"],
      "- `forbidden`: the request carries a key, an app's token or a local command's authority rather than the owner's browser session, or the browser signed in more than five minutes ago.",
    ),
    404: failure(
      ["sign_in_not_found"],
      "- `sign_in_not_found`: no live sign-in of the owner has this ID. It may have ended or expired.",
    ),
  },
});
export function ownerRoutes(storage: Storage, auth: MarfaAuth) {
  const router = createOpenAPIRouter<AppEnv>();
  router.use("*", async (c, next) => {
    setNoStore(c);
    await next();
  });
  router.openapi(getOwnerRoute, async (c) => {
    const owner = await storage.owner?.find();
    if (!owner)
      throw new MarfaError(
        ErrorCode.OWNER_NOT_FOUND,
        "The claimed owner's account is unavailable.",
      );
    return c.json(ownerWire(owner), 200);
  });
  router.openapi(listSignInsRoute, async (c) => {
    const authority = c.get("authority");
    if (authority?.kind !== "owner")
      throw new MarfaError(ErrorCode.FORBIDDEN, "Sign in in a browser.");
    const sessions = await auth.listBrowserSessions(authority.userId);
    return c.json(
      {
        data: sessions.map((session) => ({
          id: session.id,
          kind: "browser" as const,
          current: session.id === authority.sessionId,
          created_at: session.createdAt.toISOString(),
          last_used_at: session.lastUsedAt.toISOString(),
          expires_at: session.expiresAt.toISOString(),
          ip_address: session.ipAddress,
          user_agent: session.userAgent,
        })),
        next_cursor: null,
      },
      200,
    );
  });
  router.openapi(endSignInRoute, async (c) => {
    requireRecentOwnerAuthentication(c);
    const authority = c.get("authority");
    if (authority?.kind !== "owner")
      throw new MarfaError(ErrorCode.FORBIDDEN, "Sign in in a browser.");
    const { id } = c.req.valid("param");
    if (
      !(await auth.endBrowserSession(
        authority.userId,
        id,
        c.get("clientIp") ?? null,
      ))
    )
      throw new MarfaError(
        ErrorCode.SIGN_IN_NOT_FOUND,
        "No live sign-in has this ID.",
      );
    if (id === authority.sessionId)
      c.header("set-cookie", await auth.clearedSessionCookie(), {
        append: true,
      });
    return c.json({ ok: true as const }, 200);
  });
  router.openapi(createOwnerRoute, async (c) => {
    requireOwnerOrigin(auth, c.req.raw.headers, { allowNonBrowser: true });
    const body = c.req.valid("json"),
      token = getCookie(c, SETUP_COOKIE);
    const owner = await claimOwner(storage, auth, {
      ...body,
      proof:
        body.code !== undefined
          ? {
              kind: "code",
              code: body.code,
              address: c.get("clientIp") ?? null,
            }
          : { kind: "session", token: token ?? "" },
    });
    deleteCookie(c, SETUP_COOKIE, { path: "/" });
    return c.json(ownerWire(owner), 201);
  });
  return router;
}
