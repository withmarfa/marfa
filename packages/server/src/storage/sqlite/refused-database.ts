/**
 * The exit status of a server that will not open the database it was
 * pointed at, because another build wrote it. It is `EX_CONFIG` from
 * `sysexits.h`: the instance's configuration, a file it names, is what is
 * wrong, and starting again will not change that. `deploy/entrypoint.sh`
 * reads this number to tell such a stop from a crash.
 */
export const REFUSED_DATABASE_EXIT_CODE = 78;

/** A database this build will not open, and the file left as it was found. */
export class RefusedDatabaseError extends Error {
  override readonly name = "RefusedDatabaseError";
}
