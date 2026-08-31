/**
 * Projects a role read back from storage onto the role union.
 *
 * Four row projections need this, the user store and the key store, in
 * each dialect, and they used to reach it with a cast. A cast asserts
 * rather than checks, so a value the build does not recognize arrived
 * intact and then failed every comparison downstream, silently and in two
 * different directions depending on whether the gate compared literals or
 * looked the role up in `ROLE_RANK`.
 *
 * `isMarfaRole` in `@withmarfa/shared` is the definition of a valid role
 * and stays free of any logging concern, because it ships to npm and the
 * SDK consumes it. What belongs here is the policy for meeting a bad one:
 * fall back to the least authority available, and say so. A store read is
 * the wrong place to throw, one mis-migrated row would take out every
 * list query that touches it, but it is exactly the right place to
 * notice, since nothing further down the call chain can tell a fallback
 * from a genuine `member`.
 */
import { isMarfaRole, type MarfaRole } from "@withmarfa/shared";
import { log } from "../middleware/logger.js";

/**
 * Narrows a stored role, logging when the stored value was not one this
 * build knows.
 *
 * `table` and `id` are carried so the log line names the row to go and
 * look at. A warning that says only "bad role" costs the reader the same
 * investigation every time.
 */
export function storedRole(
  value: unknown,
  source: { table: "users" | "api_keys"; id: string },
): MarfaRole {
  if (isMarfaRole(value)) return value;
  // `error` for a user, `warn` for a credential. No route writes
  // `users.role`, so a value outside the union there can only come from a
  // migration that did not run or a restore of an older shape, and the
  // symptom it produces is the one that already went a whole rename cycle
  // unnoticed. A credential is minted from validated input, so the same
  // value there is worth seeing without claiming the database is broken.
  log(
    source.table === "users" ? "error" : "warn",
    "stored role is not a role this build recognizes",
    {
      table: source.table,
      row_id: source.id,
      stored_role: typeof value === "string" ? value : typeof value,
      projected_as: "member",
    },
  );
  return "member";
}
