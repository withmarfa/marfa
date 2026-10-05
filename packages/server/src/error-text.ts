/**
 * The words an error leaves the process in, with the values of a failed query
 * taken out.
 *
 * **Why the values are in the message at all.** The query layer wraps every
 * failed statement in an error whose message is the SQL followed by
 * `params: ` and every value the statement was bound to, and whose stack
 * starts with the same message. For a write those values are the item: its
 * properties, tags and hashes. A message that reaches a log, an exported
 * telemetry attribute, an error-tracking event or an alert channel therefore
 * hands item content to whoever reads that sink.
 *
 * **What stays.** The statement, which carries only placeholders, and the
 * wrapped driver error beside it, which says what went wrong. An operator
 * can still find the failing statement and the reason.
 *
 * Nothing in this module throws: it runs on the path that reports a failure,
 * and a report that throws hides the failure it was reporting.
 */

const STATEMENT_PREFIX = "Failed query: ";
const PARAMETERS_MARKER = "\nparams: ";
const MAX_CAUSE_DEPTH = 8;

/** The query layer's wrapper, recognized by its shape rather than its class, which a second copy of the library would not share. */
interface QueryFailure extends Error {
  query: string;
  params: unknown;
}

function isQueryFailure(value: unknown): value is QueryFailure {
  try {
    return (
      value instanceof Error &&
      typeof (value as { query?: unknown }).query === "string" &&
      "params" in value &&
      value.message.startsWith(STATEMENT_PREFIX)
    );
  } catch {
    return false;
  }
}

/** The failed statement's own text, which carries placeholders and no values. */
function statementOf(failure: QueryFailure): string {
  return `${STATEMENT_PREFIX}${failure.query}`;
}

/**
 * The text of a failed query's message as the library composes it, so that
 * exactly those characters can be found again in the message and in the
 * stack, which repeats it.
 */
function composedMessage(failure: QueryFailure): string {
  return `${statementOf(failure)}${PARAMETERS_MARKER}${String(failure.params)}`;
}

/**
 * Takes the values out of any failed query's message found in a string.
 *
 * **A net, not the mechanism.** A string has lost the error that made it, so
 * where the values end can only be guessed: at the first stack frame if one
 * follows, else at the end of the text. A value written to look like a stack
 * frame would end the guess early. Callers that hold the error use
 * {@link errorMessage} and {@link errorStack}, which remove exactly what the
 * library wrote; this is for the sink that only ever sees text.
 */
export function withoutQueryParameters(text: string): string {
  if (!text.includes(PARAMETERS_MARKER)) return text;
  return text.replace(
    /(Failed query: [^]*?)\nparams: [^]*?(?=\n {4}at |$)/g,
    (_whole, statement: string) => statement,
  );
}

const WORD = /[A-Za-z0-9_]{3,}/g;

/** The words of the values each failed query was bound to, held for the driver errors beneath it. */
const boundWords = new WeakMap<object, ReadonlySet<string>>();

function wordsOf(value: unknown, into: Set<string>, depth = 0): void {
  if (typeof value === "string") {
    for (const word of value.match(WORD) ?? []) into.add(word);
  } else if (typeof value === "number" || typeof value === "bigint") {
    wordsOf(String(value), into, depth);
  } else if (Array.isArray(value) && depth < 3) {
    for (const item of value) wordsOf(item, into, depth + 1);
  }
}

/**
 * Notes, for each error beneath a failed query, the words of what the query
 * was bound to. The driver's own message is kept in a report because it says
 * what failed, but the driver sometimes quotes a token of the text it was
 * given: a malformed full-text search says `near "token"`, and a filter on a
 * column that is not there names it. A message that does is withheld.
 */
function rememberBound(failure: QueryFailure): void {
  const words = new Set<string>();
  wordsOf(failure.params, words);
  let step: unknown = (failure as { cause?: unknown }).cause;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth++) {
    if (step === null || typeof step !== "object") return;
    boundWords.set(step, words);
    step = (step as { cause?: unknown }).cause;
  }
}

const WITHHELD =
  "[withheld: it repeats a value the failed statement was bound to]";

function echoesBoundValue(error: unknown, text: string): boolean {
  if (error === null || typeof error !== "object") return false;
  const words = boundWords.get(error);
  if (words === undefined) return false;
  return (text.match(WORD) ?? []).some((word) => words.has(word));
}

/**
 * `text`, which came from `error`'s message or stack, with a failed query's
 * values removed: exactly where `error` is the failed query, by the net
 * otherwise, and withheld where `error` is a driver error beneath a failed
 * query and repeats one of its values.
 *
 * Callers walk a cause chain from the top, so a failed query has been seen
 * before the errors beneath it are read.
 */
export function withoutParametersOf(error: unknown, text: string): string {
  try {
    if (isQueryFailure(error)) rememberBound(error);
    else if (echoesBoundValue(error, text)) return WITHHELD;
    const exact = isQueryFailure(error)
      ? text.split(composedMessage(error)).join(statementOf(error))
      : text;
    return withoutQueryParameters(exact);
  } catch {
    return withoutQueryParameters(text);
  }
}

/**
 * Why a failure happened, for a report that has room for one line: the
 * error an error wrapped when it wrapped one, since the query layer's own
 * message is the statement, and the error itself otherwise.
 */
export function errorReason(error: unknown): string {
  try {
    const cause = error instanceof Error ? error.cause : undefined;
    if (cause instanceof Error) {
      if (isQueryFailure(error)) rememberBound(error);
      return errorMessage(cause);
    }
    return errorMessage(error);
  } catch {
    return "unknown error";
  }
}

/**
 * What to put in a report for a caught value: its message, as the first line
 * of `err instanceof Error ? err.message : String(err)` would, without the
 * values of a failed query.
 */
export function errorMessage(error: unknown): string {
  try {
    return withoutParametersOf(
      error,
      error instanceof Error ? error.message : String(error),
    );
  } catch {
    return "unknown error";
  }
}

/** An error's stack without the values of a failed query, which the stack's first line repeats. */
export function errorStack(error: unknown): string | undefined {
  try {
    if (!(error instanceof Error) || typeof error.stack !== "string") {
      return undefined;
    }
    return withoutParametersOf(error, error.stack);
  } catch {
    return undefined;
  }
}

/** Whether a failed query sits anywhere in the error's cause chain. */
function chainHasQueryFailure(error: unknown): boolean {
  let step: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth++) {
    if (isQueryFailure(step)) return true;
    if (step === null || typeof step !== "object") return false;
    step = (step as { cause?: unknown }).cause;
  }
  return false;
}

function cleanCopy(error: unknown, depth: number): unknown {
  if (!(error instanceof Error)) {
    return typeof error === "string" ? withoutQueryParameters(error) : error;
  }
  const copy = new Error(errorMessage(error));
  copy.name = error.name;
  const stack = errorStack(error);
  if (stack !== undefined) copy.stack = stack;
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string" || typeof code === "number") {
    (copy as { code?: unknown }).code = code;
  }
  const cause = (error as { cause?: unknown }).cause;
  if (cause !== undefined && cause !== null && depth < MAX_CAUSE_DEPTH) {
    copy.cause = cleanCopy(cause, depth + 1);
  }
  return copy;
}

/**
 * The value to hand a sink that reads an error's own fields, such as an
 * error-tracking client or a span's exception event.
 *
 * An error with no failed query in its chain is returned as it is, so what
 * the sink records of every other failure does not change. One with a failed
 * query comes back as a copy: the same name, message, stack, code and cause
 * chain, with the values taken out and the library's `query` and `params`
 * fields not carried over.
 */
export function reportableError(error: unknown): unknown {
  try {
    return chainHasQueryFailure(error) ? cleanCopy(error, 0) : error;
  } catch {
    return new Error("unreportable error");
  }
}
