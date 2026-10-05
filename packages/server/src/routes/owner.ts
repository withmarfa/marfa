import { maxStringLength } from "@withmarfa/shared";
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
import { operatorOnly, requireAuth } from "../middleware/auth.js";
import { createOpenAPIRouter, makeErrorResponseSchema } from "../openapi.js";
import type { CreateEmailAccountResult, MarfaAuth } from "../auth/instance.js";
import { log } from "../middleware/logger.js";
import type {
  OwnerRecord,
  SettingsStore,
  Storage,
} from "../storage/interface.js";

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
  name: maxStringLength(z.string().trim(), 200)
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
  tags: ["Access"],
  summary: "Get the owner",
  security: [{ bearerAuth: [] }],
  middleware: operatorOnly,
  description:
    "Answers the owner: the one account on this instance's sign-in surface, which is the person the OAuth consent screen asks. An instance boots with no owner, and `POST /owner` creates one. Operator key only.",
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
  tags: ["Access"],
  summary: "Create the owner",
  security: [{ bearerAuth: [] }],
  middleware: operatorOnly,
  description:
    "Creates the one account on this instance's sign-in surface, with an email address and a password. Sign-up is disabled on every instance, so this is the only way a person comes to exist behind the consent screen, and the account can sign in at `POST /auth/sign-in/email` the moment this answers. The password is judged by the sign-in surface's own length rule. Operator key only: the operator key is what proves the person running the instance, and it outlives the bootstrap secret.",
  request: {
    body: {
      content: { "application/json": { schema: CreateOwnerBodySchema } },
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
        "- `validation_error`: the body is malformed, or the password is outside the sign-in surface's length rule. For the password, the error names `password` and the bound.",
    },
    401: unauthorized,
    403: notTheOperator,
    409: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["owner_exists"]),
        },
      },
      description:
        "- `owner_exists`: this instance already has an owner, whatever the body.",
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

/** The settings row held while an owner is being created. */
const OWNER_CLAIM = "owner";

/**
 * How long a claim is honored before it is taken over. The work under it is
 * one password hash and two rows, so a claim this old belongs to a process
 * that died holding it, and nothing else could ever give it back.
 */
const CLAIM_LEASE_MS = 60_000;

/**
 * Takes the claim that serializes creation across processes on one file.
 *
 * The existence check and the account write are two steps with a password
 * hash between them, so two asks arriving together would both pass the
 * check; the claim is one atomic INSERT, so exactly one of them creates.
 * It is held for the check and the write only and given back on every
 * outcome (`give`), never kept as a marker of the owner: the row is the
 * record, and a marker outliving the row would close the door with nobody
 * behind it.
 */
async function take(settings: SettingsStore): Promise<void> {
  const now = Date.now();
  if (await settings.claim(OWNER_CLAIM, String(now))) return;
  const held = Number(await settings.get(OWNER_CLAIM));
  const stale = !Number.isFinite(held) || now - held > CLAIM_LEASE_MS;
  if (!stale) throw ownerExists();
  await settings.release(OWNER_CLAIM);
  if (!(await settings.claim(OWNER_CLAIM, String(now)))) throw ownerExists();
}

/** Gives the claim back. A failure here is logged rather than thrown,
 *  because the lease repairs it and the request's own answer matters more. */
async function give(settings: SettingsStore): Promise<void> {
  try {
    await settings.release(OWNER_CLAIM);
  } catch (error) {
    log("error", "the owner claim could not be released", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export function ownerRoutes(storage: Storage, auth: MarfaAuth) {
  const owner = storage.owner;
  if (!owner) {
    throw new Error(
      "storage wires better-auth without an owner store, so the owner door cannot be served",
    );
  }
  const router = createOpenAPIRouter<AppEnv>();

  router.openapi(getOwnerRoute, async (c) => {
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
    const operator = requireAuth(c);
    const body = c.req.valid("json");
    if (await owner.find()) throw ownerExists();
    await take(storage.settings);
    let result: CreateEmailAccountResult;
    try {
      // Asked again under the claim: the account may have landed between
      // the check above and the claim.
      if (await owner.find()) throw ownerExists();
      result = await auth.createEmailAccount(
        {
          email: body.email,
          password: body.password,
          name: body.name,
        },
        (created) => ({
          key_id: operator.id,
          action: "owner.created",
          resource_type: "owner",
          resource_id: created.authUserId,
          client_ip: c.get("clientIp") ?? null,
          details: { email: created.email },
        }),
      );
    } finally {
      await give(storage.settings);
    }
    if (!result.ok) {
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
