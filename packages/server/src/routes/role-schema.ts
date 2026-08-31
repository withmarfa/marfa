import { z } from "@hono/zod-openapi";

/**
 * The role a response carries.
 *
 * The current union and nothing else: a response describes what this build
 * stores, and a value it is in the middle of retiring is not something it
 * should ever answer with.
 */
export const RoleResponseSchema = z.enum([
  "instance_admin",
  "space_admin",
  "member",
]);

/**
 * The role a request may name.
 *
 * **Carries the retiring value, and comes out with the migration.** The
 * clients that mint credentials are separate deployments on their own release
 * cadence, so a request naming the old word outlives the server that renamed
 * it. Refusing it here would break every one of them at the moment the server
 * deployed, which is the failure the tolerant-first ordering exists to avoid.
 *
 * It is in the published schema deliberately rather than accepted quietly. A
 * value the API takes and does not document is one nobody can find when the
 * time comes to remove it.
 *
 * Handlers put the result through `parseMarfaRole`, so nothing downstream ever
 * sees the old spelling. The alternative — a Zod `transform` — would take the
 * normalization out of the published schema, which is where a reader looks to
 * find out what the endpoint actually accepts.
 */
export const RoleRequestSchema = z.enum([
  "instance_admin",
  "space_admin",
  "member",
  "admin",
]);
