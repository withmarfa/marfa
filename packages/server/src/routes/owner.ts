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
import {
  createOpenAPIRouter,
  makeErrorResponseSchema,
  OPERATOR_ONLY_RESPONSE,
} from "../openapi.js";
import type { CreateEmailAccountResult, MarfaAuth } from "../auth/instance.js";
import { log } from "../middleware/logger.js";
import type {
  OwnerRecord,
  SettingsStore,
  Storage,
} from "../storage/interface.js";
import { errorMessage } from "../error-text.js";

const OwnerSchema = z
  .object({
    id: z.string().describe("Unique identifier for the owner's account."),
    email: z.string().describe("The owner's email address, in lowercase."),
    name: z.string().describe("The owner's name."),
    created_at: z.string().describe("When the owner was created, in UTC."),
  })
  .describe("The owner is the one person who can sign in to the instance.")
  .openapi("Owner");

const CreateOwnerBodySchema = z.object({
  email: z
    .email()
    .max(254)
    .describe(
      "The owner's email address, which they sign in with. Marfa stores it in lowercase.",
    ),
  // The length bound is the sign-in surface's own and is not restated
  // here; a refusal names it.
  password: z.string().describe("The password the owner signs in with."),
  name: maxStringLength(z.string().trim(), 200)
    .optional()
    .describe(
      "The owner's name. Leave it out or blank to use the part of `email` before the `@`.",
    ),
});

const unauthorized = {
  content: {
    "application/json": { schema: makeErrorResponseSchema(["unauthorized"]) },
  },
  description: "Unauthorized",
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
    "Returns the owner: the one account that can sign in to the instance and approve apps. A new instance has no owner until `POST /owner` creates one. Requires the operator key.",
  responses: {
    200: {
      content: { "application/json": { schema: OwnerSchema } },
      description: "Returns the owner.",
    },
    401: unauthorized,
    403: OPERATOR_ONLY_RESPONSE,
    404: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["owner_not_found"]),
        },
      },
      description: "- `owner_not_found`: the instance has no owner yet.",
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
    "Creates the owner, the one account that can sign in to the instance, and returns it. The owner can sign in at once with the email address and password. No other route creates an account. Requires the operator key.",
  request: {
    body: {
      content: { "application/json": { schema: CreateOwnerBodySchema } },
    },
  },
  responses: {
    201: {
      content: { "application/json": { schema: OwnerSchema } },
      description: "Returns the new owner.",
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
        "- `missing_required_field`: `email` or `password` is missing.\n- `validation_error`: a field is invalid, such as an `email` that isn't an email address or a `password` shorter or longer than sign-in allows. For `password`, the message names the limit.",
    },
    401: unauthorized,
    403: OPERATOR_ONLY_RESPONSE,
    409: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["owner_exists"]),
        },
      },
      description: "- `owner_exists`: the instance already has an owner.",
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
      error: errorMessage(error),
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
        "This instance has no owner yet; `marfa owner create` or POST /owner creates one",
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
