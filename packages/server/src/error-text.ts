/**
 * The form an error takes when it leaves the process: in a log line, an
 * exported telemetry record, an error-tracking event, an alert, a stored
 * failure or an answer that reports one.
 *
 * **A database failure leaves only as a fixed error.** The query layer's
 * message is the statement followed by every value it was bound to, and the
 * stack repeats it. The driver's own message can quote a bound value too, and
 * the statement's text is not guaranteed to hold only placeholders. For a
 * write those values are the content written. So an error with a database
 * failure anywhere in its chain is replaced, at every sink, by a
 * {@link DatabaseFailure} that keeps the SQLite code and the outer error's
 * stack frames, and nothing the database was given or said.
 *
 * Classification reads the original: a typed refusal, write contention or a
 * full disk is decided before any of this runs.
 *
 * Nothing in this module throws: it runs on the path that reports a failure,
 * and a report that throws hides the failure it was reporting.
 */

const FIXED_MESSAGE = "Database operation failed";
const STATEMENT_PREFIX = "Failed query: ";
const MAX_CHAIN_DEPTH = 8;
const MAX_CHAIN_NODES = 64;

/** SQLite's primary result codes that report a failure. */
const PRIMARY_CODES = new Set([
  "SQLITE_ERROR",
  "SQLITE_INTERNAL",
  "SQLITE_PERM",
  "SQLITE_ABORT",
  "SQLITE_BUSY",
  "SQLITE_LOCKED",
  "SQLITE_NOMEM",
  "SQLITE_READONLY",
  "SQLITE_INTERRUPT",
  "SQLITE_IOERR",
  "SQLITE_CORRUPT",
  "SQLITE_NOTFOUND",
  "SQLITE_FULL",
  "SQLITE_CANTOPEN",
  "SQLITE_PROTOCOL",
  "SQLITE_EMPTY",
  "SQLITE_SCHEMA",
  "SQLITE_TOOBIG",
  "SQLITE_CONSTRAINT",
  "SQLITE_MISMATCH",
  "SQLITE_MISUSE",
  "SQLITE_NOLFS",
  "SQLITE_AUTH",
  "SQLITE_FORMAT",
  "SQLITE_RANGE",
  "SQLITE_NOTADB",
  "SQLITE_NOTICE",
  "SQLITE_WARNING",
]);

/** An extended code is its primary code and a suffix of capitals. */
const EXTENDED_SUFFIX = /^_[A-Z]+(?:_[A-Z]+)*$/;

interface FailureCodes {
  code?: string;
  extendedCode?: string;
}

/** What a sink receives in place of an error with a database failure in its chain. */
export class DatabaseFailure extends Error {
  readonly code?: string;
  readonly extendedCode?: string;

  constructor(codes: FailureCodes, frames: string) {
    const shown = codes.extendedCode ?? codes.code;
    const message =
      shown === undefined ? FIXED_MESSAGE : `${FIXED_MESSAGE} (${shown})`;
    super(message);
    this.name = "DatabaseFailure";
    if (codes.code !== undefined) this.code = codes.code;
    if (codes.extendedCode !== undefined)
      this.extendedCode = codes.extendedCode;
    this.stack = `${this.name}: ${message}${frames}`;
  }
}

function read(value: object, key: string): unknown {
  try {
    return (value as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

/** The code the driver writes at the start of its message, as in `SQLITE_FULL: database or disk is full`. */
const MESSAGE_CODE = /^(SQLITE_[A-Z_]+):/;

/**
 * The query layer's wrapper, the driver's error and the native binding's
 * error, recognized by name, code and the start of the message rather than
 * by class, which a second copy of a library would not share.
 */
function isDatabaseError(value: object): boolean {
  const name = read(value, "name");
  if (
    name === "LibsqlError" ||
    name === "LibsqlBatchError" ||
    name === "SqliteError" ||
    name === "DrizzleQueryError"
  )
    return true;
  const code = read(value, "code");
  if (typeof code === "string" && code.startsWith("SQLITE_")) return true;
  const message = read(value, "message");
  return (
    typeof message === "string" &&
    (message.startsWith(STATEMENT_PREFIX) || MESSAGE_CODE.test(message))
  );
}

/** The codes a database error carries, kept only in SQLite's own spelling. */
function codesOf(value: object): FailureCodes {
  const codes: FailureCodes = {};
  const message = read(value, "message");
  const written =
    typeof message === "string" ? MESSAGE_CODE.exec(message)?.[1] : undefined;
  for (const candidate of [
    read(value, "code"),
    read(value, "extendedCode"),
    written,
  ]) {
    if (typeof candidate !== "string") continue;
    const primary = [...PRIMARY_CODES].find(
      (code) =>
        candidate === code ||
        (candidate.startsWith(code) &&
          EXTENDED_SUFFIX.test(candidate.slice(code.length))),
    );
    if (primary === undefined) continue;
    codes.code ??= primary;
    if (candidate !== primary) codes.extendedCode ??= candidate;
  }
  return codes;
}

/**
 * Whether a database failure sits anywhere in the error's cause chain or in
 * an aggregate's branches, with the first codes found. A chain too deep or too
 * wide to read whole counts as one, since what was not read could be.
 */
function databaseFailureIn(error: unknown): FailureCodes | undefined {
  const walk: { found?: FailureCodes; nodes: number; complete: boolean } = {
    nodes: 0,
    complete: true,
  };
  const seen = new Set<object>();
  const visit = (value: unknown, depth: number): void => {
    if (value === null || typeof value !== "object" || seen.has(value)) return;
    if (depth > MAX_CHAIN_DEPTH || ++walk.nodes > MAX_CHAIN_NODES) {
      walk.complete = false;
      return;
    }
    seen.add(value);
    if (isDatabaseError(value)) {
      const codes = codesOf(value);
      walk.found =
        walk.found?.code === undefined
          ? { ...codes, ...walk.found }
          : walk.found;
    }
    visit(read(value, "cause"), depth + 1);
    const errors = read(value, "errors");
    if (Array.isArray(errors))
      for (const branch of errors as unknown[]) visit(branch, depth + 1);
  };
  visit(error, 0);
  return walk.found ?? (walk.complete ? undefined : {});
}

/**
 * The stack frames of `error`, without the header that repeats its message,
 * or nothing when the header cannot be told apart exactly.
 */
function framesOf(error: unknown): string {
  if (error === null || typeof error !== "object") return "";
  const stack = read(error, "stack");
  const message = read(error, "message");
  if (typeof stack !== "string" || typeof message !== "string") return "";
  const at = message === "" ? stack.indexOf("\n") : stack.indexOf(message);
  if (at < 0 || stack.slice(0, at).includes("\n")) return "";
  const rest = stack.slice(at + message.length);
  return /^\n {4}at /.test(rest) ? rest : "";
}

/**
 * The value to hand any diagnostic sink in place of `error`: the error
 * itself when no database failure is in its chain, and a
 * {@link DatabaseFailure} otherwise.
 */
export function reportableError(error: unknown): unknown {
  try {
    if (error instanceof DatabaseFailure) return error;
    const codes = databaseFailureIn(error);
    return codes === undefined
      ? error
      : new DatabaseFailure(codes, framesOf(error));
  } catch {
    return new DatabaseFailure({}, "");
  }
}

/**
 * Takes the text of a failed query out of a string, from its statement to its
 * first stack frame or the end.
 *
 * **A net, not the mechanism.** A string has lost the error that made it, so
 * only the query layer's own spelling can be found in it. Callers that hold
 * the error use {@link reportableError} and the functions below; this is for
 * the sink that only ever sees text.
 */
export function withoutFailedQueries(text: string): string {
  if (!text.includes(STATEMENT_PREFIX)) return text;
  return text.replace(/Failed query: [^]*?(?=\n {4}at |$)/g, FIXED_MESSAGE);
}

/**
 * Why a failure happened, for a report that has room for one line: the
 * error an error wrapped when it wrapped one, and the error itself otherwise.
 */
export function errorReason(error: unknown): string {
  try {
    const reported = reportableError(error);
    if (reported !== error) return errorMessage(reported);
    const cause = error instanceof Error ? error.cause : undefined;
    return errorMessage(cause instanceof Error ? cause : error);
  } catch {
    return "unknown error";
  }
}

/**
 * What to put in a report for a caught value: its message, as the first line
 * of `err instanceof Error ? err.message : String(err)` would, with a
 * database failure in its fixed form.
 */
export function errorMessage(error: unknown): string {
  try {
    const reported = reportableError(error);
    return withoutFailedQueries(
      reported instanceof Error ? reported.message : String(reported),
    );
  } catch {
    return "unknown error";
  }
}

/** An error's stack, with a database failure in its fixed form. */
export function errorStack(error: unknown): string | undefined {
  try {
    const reported = reportableError(error);
    if (!(reported instanceof Error) || typeof reported.stack !== "string") {
      return undefined;
    }
    return withoutFailedQueries(reported.stack);
  } catch {
    return undefined;
  }
}
