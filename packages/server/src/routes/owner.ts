/**
 * The owner: the one account behind an instance's sign-in surface.
 *
 * Sign-up is disabled on every instance, so without this door nothing puts
 * a person behind the consent screen that the device flow and the
 * authorization flow end at. The door is the primitive and every front that
 * claims an instance calls it; none of them holds a second way in.
 *
 * **The operator key is the gate, not the bootstrap secret.** The secret is
 * spent on the first mint and never printed again, while the operator key
 * outlives it and is the instance's recovery root, so a later reset of the
 * owner can go through the same gate. It is also the one credential that
 * already proves "the person running the instance", which is the claim
 * this door needs and the only one available before sign-in exists.
 */
import { createRoute, z } from "@hono/zod-openapi";
import { MarfaError, ErrorCode } from "@withmarfa/shared";
import type { AppEnv } from "../middleware/auth.js";
import { requireOperatorKey } from "../middleware/auth.js";
import { createOpenAPIRouter, makeErrorResponseSchema } from "../openapi.js";
import type { MarfaAuth } from "../auth/instance.js";
import { log } from "../middleware/logger.js";
import type { OwnerRecord, Storage } from "../storage/interface.js";

const OwnerSchema = z
  .object({
    id: z.string(),
    email: z.string(),
    name: z.string(),
    created_at: z.string().describe("ISO 8601 instant"),
  })
  .openapi("Owner");

const CreateOwnerBodySchema = z.object({
  email: z.email().max(254),
  // The length bound is the sign-in surface's own and is not restated
  // here; a refusal names it.
  password: z.string(),
  name: z
    .string()
    .trim()
    .max(200)
    .optional()
    .describe("Falls back to the address's local part when absent or blank."),
});

const unauthorized = {
  content: {
    "application/json": { schema: makeErrorResponseSchema(["unauthorized"]) },
  },
  description: "Unauthorized",
};

const notTheOperator = {
  content: {
    "application/json": { schema: makeErrorResponseSchema(["forbidden"]) },
  },
  description: "Caller is not the operator key",
};

const getOwnerRoute = createRoute({
  operationId: "getOwner",
  method: "get",
  path: "/",
  tags: ["Owner"],
  summary: "Who owns this instance",
  security: [{ bearerAuth: [] }],
  description:
    "Answers the owner: the one account on this instance's sign-in surface, which is the person the OAuth consent screen asks. `404 owner_not_found` on an instance that has none yet, which is the state every instance boots in; `POST /owner` is what changes it. Operator key only.",
  responses: {
    200: {
      content: { "application/json": { schema: OwnerSchema } },
      description: "The owner",
    },
    401: unauthorized,
    403: notTheOperator,
    404: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["owner_not_found"]),
        },
      },
      description: "This instance has no owner yet",
    },
  },
});

const createOwnerRoute = createRoute({
  operationId: "createOwner",
  method: "post",
  path: "/",
  tags: ["Owner"],
  summary: "Create the owner",
  security: [{ bearerAuth: [] }],
  description:
    "Creates the one account on this instance's sign-in surface, with an email address and a password. Sign-up is disabled on every instance, so this is the only way a person comes to exist behind the consent screen, and the account can sign in at `POST /auth/sign-in/email` the moment this answers. Refused `409 owner_exists` once an owner exists, for any body the schema accepts; the password is judged by the sign-in surface's own length rule and a refusal is `400 validation_error` naming `password` and the bound. Operator key only: the operator key is what proves the person running the instance, and it outlives the bootstrap secret.",
  request: {
    body: {
      content: { "application/json": { schema: CreateOwnerBodySchema } },
      required: true,
    },
  },
  responses: {
    201: {
      content: { "application/json": { schema: OwnerSchema } },
      description: "The owner, created",
    },
    400: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema([
            "validation_error",
            "missing_required_field",
          ]),
        },
      },
      description:
        "The body is malformed, or the password is outside the sign-in surface's length rule",
    },
    401: unauthorized,
    403: notTheOperator,
    409: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["owner_exists"]),
        },
      },
      description: "This instance already has an owner",
    },
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

function refusedPassword(message: string): MarfaError {
  // The shape the router's own validators answer with, so a caller reads
  // one envelope for a malformed body whichever layer refused it.
  return new MarfaError(ErrorCode.VALIDATION_ERROR, "Validation failed", {
    errors: [{ path: "password", message }],
  });
}

function ownerExists(): MarfaError {
  return new MarfaError(
    ErrorCode.OWNER_EXISTS,
    "This instance already has an owner; GET /owner says who",
  );
}

/** The settings row that says an owner is being, or has been, created. */
const OWNER_CLAIM = "owner";

export function ownerRoutes(storage: Storage, auth: MarfaAuth) {
  const owner = storage.owner;
  if (!owner) {
    throw new Error(
      "storage wires better-auth without an owner store, so the owner door cannot be served",
    );
  }
  const router = createOpenAPIRouter<AppEnv>();

  // The claim is given back only when the failure left no account behind:
  // a claim held with nobody behind it would close the door for good, and
  // one released while an account exists would let a second in.
  const releaseUnlessCreated = async () => {
    try {
      if (!(await owner.find())) await storage.settings.release(OWNER_CLAIM);
    } catch (error) {
      log("error", "the owner claim could not be released", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  router.openapi(getOwnerRoute, async (c) => {
    requireOperatorKey(c);
    const found = await owner.find();
    if (!found) {
      throw new MarfaError(
        ErrorCode.OWNER_NOT_FOUND,
        "This instance has no owner yet; POST /owner creates one",
      );
    }
    return c.json(wire(found), 200);
  });

  router.openapi(createOwnerRoute, async (c) => {
    const operator = requireOperatorKey(c);
    const body = c.req.valid("json");
    if (await owner.find()) throw ownerExists();
    // The existence check and the account write are two steps with a
    // password hash between them, so two asks arriving together, in one
    // process or in two on the same file, would both pass the check. The
    // claim is one atomic INSERT, so exactly one of them creates; the
    // address's unique index catches the same address twice besides.
    if (!(await storage.settings.claim(OWNER_CLAIM, "claimed"))) {
      throw ownerExists();
    }
    let result;
    try {
      result = await auth.createEmailAccount({
        email: body.email,
        password: body.password,
        name: body.name,
      });
    } catch (error) {
      await releaseUnlessCreated();
      throw error;
    }
    if (!result.ok) {
      await releaseUnlessCreated();
      switch (result.reason) {
        case "password_too_short":
          throw refusedPassword(
            `must be at least ${String(result.minLength)} characters`,
          );
        case "password_too_long":
          throw refusedPassword(
            `must be at most ${String(result.maxLength)} characters`,
          );
        case "email_exists":
          // Reachable only by an account written around this door, which
          // sign-up cannot do; whoever holds that address is the owner.
          throw ownerExists();
      }
    }
    // Awaited, because an owner nobody can see being created is worse
    // than the request failing.
    await storage.audit.logOrThrow({
      key_id: operator.id,
      action: "owner.created",
      resource_type: "owner",
      resource_id: result.authUserId,
      client_ip: c.get("clientIp") ?? null,
      details: { email: result.email },
    });
    return c.json(
      wire({
        id: result.authUserId,
        email: result.email,
        name: result.name,
        createdAt: result.createdAt,
      }),
      201,
    );
  });

  return router;
}
