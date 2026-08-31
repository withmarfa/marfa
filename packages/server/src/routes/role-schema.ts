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
 * Identical to the response schema today, and kept separate anyway. The two
 * answer different questions, and a rename needs them to diverge for exactly
 * one release: the request side carries the retiring word while the clients
 * that mint credentials catch up on their own cadence, and the response side
 * never does. Collapsing them into one constant is how that release ends up
 * having to reintroduce the split under time pressure.
 *
 * A transitional value belongs in the published schema rather than accepted
 * quietly, so it can be found when the time comes to remove it, and handlers
 * put the result through `parseMarfaRole` so nothing downstream sees an old
 * spelling.
 */
export const RoleRequestSchema = z.enum([
  "instance_admin",
  "space_admin",
  "member",
]);
