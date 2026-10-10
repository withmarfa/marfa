import { createRoute, z } from "@hono/zod-openapi";
import { getCookie, deleteCookie } from "hono/cookie";
import { MarfaError, ErrorCode } from "@withmarfa/shared";
import {
  authorityId,
  directAuthorityOnly,
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
import { keysInReach } from "../auth/key-reach.js";
import {
  endSignIn,
  listSignIns,
  renameSignIn,
  type SignIn,
} from "../auth/sign-ins.js";
import { SIGN_IN_NAME_MAX, UNPRINTABLE } from "../auth/sign-in-names.js";
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
      .enum(["browser", "app", "key"])
      .describe(
        "What signed in. `browser`: a browser signed in with the owner's password. `app`: an app the owner approved, for every device it signs in on with that approval. `key`: an API key.",
      ),
    name: z
      .string()
      .describe(
        "A readable name: a browser's from its `user_agent`, an app's the owner's name for it or else its registered name, a key's its `label`. A name with a control or bidirectional character, or over 200 characters, gives way to the ID.",
      )
      .openapi({ example: "Safari on macOS" }),
    current: z.boolean().describe("`true` if this sign-in sent the request."),
    created_at: z
      .string()
      .describe(
        "When the sign-in was made, in UTC. For an app, when the owner last approved it.",
      )
      .openapi({ example: "2026-10-03T09:30:00.000Z" }),
    last_used_at: z
      .string()
      .nullable()
      .describe(
        "When the sign-in last made a request, in UTC, or `null` if it hasn't. Marfa records a browser's use at most once a minute and an app's or key's at most once an hour.",
      )
      .openapi({ example: "2026-10-05T14:12:08.000Z" }),
    expires_at: z
      .string()
      .nullable()
      .describe(
        "When the sign-in ends unless something changes, in UTC. A browser's is seven days and one minute after `last_used_at`. `null` for an app, and for a key that doesn't expire.",
      )
      .openapi({ example: "2026-10-12T14:13:08.000Z" }),
    ip_address: z
      .string()
      .nullable()
      .describe(
        "The address a browser signed in from, or `null` for an app, a key, or a browser whose address Marfa could not tell.",
      )
      .openapi({ example: "203.0.113.24" }),
    user_agent: z
      .string()
      .nullable()
      .describe(
        "The `User-Agent` a browser sent when it signed in, or `null` for an app, a key, or a browser that sent none.",
      ),
    minted_by: z
      .string()
      .nullable()
      .describe(
        "For a key an app minted, the ID of that app's sign-in while the app is signed in. `null` for a browser, an app, any other key, and a key whose app has ended.",
      ),
  })
  .describe("A sign-in is one way the owner's Marfa can be reached.")
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
const SIGN_IN_DOOR_REFUSAL =
  "- `forbidden`: the request carries a key or an app's token rather than the owner's browser session or the local command's authority";
const SIGN_IN_NOT_FOUND =
  "- `sign_in_not_found`: no live sign-in of the owner has this ID. It may have ended or expired.";
const listSignInsRoute = createRoute({
  operationId: "listSignIns",
  method: "get",
  path: "/sign-ins",
  tags: ["Access"],
  summary: "List sign-ins",
  security: [{ ownerSession: [] }],
  middleware: directAuthorityOnly,
  description:
    "Returns every browser, app and key that can reach Marfa, marking the browser that sent the request. Requires the owner's browser session or the local command.",
  responses: {
    200: {
      content: { "application/json": { schema: SignInListSchema } },
      description: "Returns every live sign-in.",
    },
    401: failure(["unauthorized"], "Sign in as the owner."),
    403: failure(["forbidden"], `${SIGN_IN_DOOR_REFUSAL}.`),
  },
});
const renameSignInRoute = createRoute({
  operationId: "updateSignIn",
  method: "patch",
  path: "/sign-ins/{id}",
  tags: ["Access"],
  summary: "Update a sign-in",
  security: [{ ownerSession: [] }],
  middleware: directAuthorityOnly,
  description:
    "Gives an app or a key a new name and returns the sign-in. A key's name is its `label`. Requires the owner's browser session, signed in within the last five minutes, or the local command.",
  request: {
    params: z.object({
      id: z.string().describe("The ID of the sign-in."),
    }),
    body: {
      required: true,
      content: {
        "application/json": {
          schema: z.strictObject({
            name: z
              .string()
              .trim()
              .min(1)
              .max(SIGN_IN_NAME_MAX)
              .refine((name) => !UNPRINTABLE.test(name), {
                message:
                  "name can't hold a control or bidirectional formatting character",
              })
              .describe(
                "The sign-in's new name. Marfa trims spaces from each end.",
              )
              .openapi({ example: "Marfa app on the studio laptop" }),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      content: { "application/json": { schema: SignInSchema } },
      description: "Returns the renamed sign-in.",
    },
    400: failure(
      ["missing_required_field", "validation_error"],
      "- `missing_required_field`: `name` is missing.\n- `validation_error`: `name` is empty, too long or holds a control or bidirectional formatting character, the body has another field, or the ID names a browser, whose name comes from the browser.",
    ),
    401: failure(["unauthorized"], "Sign in as the owner."),
    403: failure(
      ["forbidden"],
      `${SIGN_IN_DOOR_REFUSAL}, or the browser signed in more than five minutes ago.`,
    ),
    404: failure(["sign_in_not_found"], SIGN_IN_NOT_FOUND),
  },
});
const endSignInRoute = createRoute({
  operationId: "endSignIn",
  method: "delete",
  path: "/sign-ins/{id}",
  tags: ["Access"],
  summary: "End a sign-in",
  security: [{ ownerSession: [] }],
  middleware: directAuthorityOnly,
  description:
    "Ends a sign-in at once: it can't make another request, and an app can't refresh its tokens. The keys an app minted stay unless `revoke_keys` is `true`. Requires the owner's browser session, signed in within five minutes, or the local command.",
  request: {
    params: z.object({
      id: z.string().describe("The ID of the sign-in."),
    }),
    query: z.object({
      revoke_keys: z
        .enum(["true", "false"])
        .optional()
        .describe(
          "For an app, also revoke every key it minted, as its `minted_by` rows show. Only an app takes it.",
        ),
    }),
  },
  responses: {
    200: {
      content: { "application/json": { schema: OkResponseSchema } },
      description: "Returns `ok: true`. The sign-in has ended.",
    },
    400: failure(
      ["validation_error"],
      "- `validation_error`: `revoke_keys` is `true` and the ID names a browser or a key.",
    ),
    401: failure(["unauthorized"], "Sign in as the owner."),
    403: failure(
      ["forbidden"],
      `${SIGN_IN_DOOR_REFUSAL}, or the browser signed in more than five minutes ago.`,
    ),
    404: failure(["sign_in_not_found"], SIGN_IN_NOT_FOUND),
  },
});
/** The wire form of a sign-in, `current` when it is the browser that asks. */
function signInWire(signIn: SignIn, currentSessionId: string | undefined) {
  return {
    id: signIn.id,
    kind: signIn.kind,
    name: signIn.name,
    current: signIn.kind === "browser" && signIn.id === currentSessionId,
    created_at: signIn.createdAt,
    last_used_at: signIn.lastUsedAt,
    expires_at: signIn.expiresAt,
    ip_address: signIn.ipAddress,
    user_agent: signIn.userAgent,
    minted_by: signIn.mintedBy,
  };
}
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
    const owner = await storage.owner?.find();
    const signIns = await listSignIns(
      storage,
      auth,
      keysInReach(storage, c),
      owner?.id ?? null,
    );
    const current =
      authority?.kind === "owner" ? authority.sessionId : undefined;
    return c.json(
      {
        data: signIns.map((signIn) => signInWire(signIn, current)),
        next_cursor: null,
      },
      200,
    );
  });
  router.openapi(renameSignInRoute, async (c) => {
    requireRecentOwnerAuthentication(c);
    const { id } = c.req.valid("param");
    const { name } = c.req.valid("json");
    const owner = await storage.owner?.find();
    const renamed = await renameSignIn(
      storage,
      auth,
      keysInReach(storage, c),
      owner?.id ?? null,
      id,
      name,
      { keyId: authorityId(c), clientIp: c.get("clientIp") ?? null },
    );
    if (renamed === "browser")
      throw new MarfaError(
        ErrorCode.VALIDATION_ERROR,
        "A browser's name comes from the browser, so it can't be renamed.",
      );
    if (renamed === null)
      throw new MarfaError(
        ErrorCode.SIGN_IN_NOT_FOUND,
        "No live sign-in has this ID.",
      );
    return c.json(signInWire(renamed, undefined), 200);
  });
  router.openapi(endSignInRoute, async (c) => {
    requireRecentOwnerAuthentication(c);
    const authority = c.get("authority");
    const { id } = c.req.valid("param");
    const { revoke_keys } = c.req.valid("query");
    const owner = await storage.owner?.find();
    const ended = await endSignIn(
      storage,
      auth,
      keysInReach(storage, c),
      owner?.id ?? null,
      id,
      {
        keyId: authorityId(c),
        clientIp: c.get("clientIp") ?? null,
      },
      { revokeKeys: revoke_keys === "true" },
    );
    if (ended === "not_app")
      throw new MarfaError(
        ErrorCode.VALIDATION_ERROR,
        "revoke_keys applies only to an app; this ID names a browser or a key.",
      );
    if (ended === null)
      throw new MarfaError(
        ErrorCode.SIGN_IN_NOT_FOUND,
        "No live sign-in has this ID.",
      );
    if (
      ended === "browser" &&
      authority?.kind === "owner" &&
      id === authority.sessionId
    )
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
