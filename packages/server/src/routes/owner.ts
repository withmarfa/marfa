import { createRoute, z } from "@hono/zod-openapi";
import { getCookie, deleteCookie } from "hono/cookie";
import { MarfaError, ErrorCode } from "@withmarfa/shared";
import { directAuthorityOnly } from "../middleware/auth.js";
import type { AppEnv } from "../middleware/auth.js";
import { createOpenAPIRouter, makeErrorResponseSchema } from "../openapi.js";
import type { MarfaAuth } from "../auth/instance.js";
import type { OwnerRecord, Storage } from "../storage/interface.js";
import { claimOwner } from "../auth/instance-claim.js";
import { requireOwnerOrigin } from "../auth/owner-browser.js";
import { SETUP_COOKIE } from "./setup.js";
import { setNoStore } from "./no-store.js";
const OwnerSchema = z
  .object({
    id: z.string().describe("Unique identifier for the owner."),
    email: z.string().describe("Email address used to sign in."),
    name: z.string().describe("Display name of the owner."),
    created_at: z.string().describe("When the owner was created, in UTC."),
  })
  .describe("The single owner of the instance.")
  .openapi("Owner");
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
function wire(owner: OwnerRecord) {
  return {
    id: owner.id,
    email: owner.email,
    name: owner.name,
    created_at: owner.createdAt.toISOString(),
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
    return c.json(wire(owner), 200);
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
    return c.json(wire(owner), 201);
  });
  return router;
}
