import { DrizzleQueryError } from "drizzle-orm";
import { createClient } from "@libsql/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { originalErrorMessage } from "./storage/sqlite/transaction-control.js";
import {
  errorMessage,
  errorReason,
  errorStack,
  reportableError,
  withoutQueryParameters,
} from "./error-text.js";
import {
  formatErrorSummary,
  log,
  serializeError,
} from "./middleware/logger.js";

const VALUE = "bound-value-3e9d51c0";
const STATEMENT =
  'insert into "items" ("id", "properties") values (?, jsonb(?))';

/** The wrapper the query layer raises, built by the library's own class. */
function failedQuery(
  params: unknown[] = ["an-id", `{"body":"${VALUE}"}`],
  cause: unknown = new Error("SQLITE_FULL: database or disk is full"),
): DrizzleQueryError {
  return new DrizzleQueryError(STATEMENT, params, cause as Error);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a failed query as the query layer raises it", () => {
  it("names its values in the message and in the stack, which is why a report must not copy either", () => {
    const error = failedQuery();
    expect(error.message).toContain(VALUE);
    expect(error.stack).toContain(VALUE);
  });
});

describe("errorMessage and errorStack", () => {
  it("keep the statement and drop the values", () => {
    const error = failedQuery();
    expect(errorMessage(error)).toBe(`Failed query: ${STATEMENT}`);
    const stack = errorStack(error) ?? "";
    expect(stack).not.toContain(VALUE);
    expect(stack.startsWith(`Error: Failed query: ${STATEMENT}\n    at `)).toBe(
      true,
    );
  });

  it("drop values that run over several lines, or that look like a stack frame or a parameters line", () => {
    const awkward = [
      `first\nsecond ${VALUE}`,
      `line\n    at fake (/nowhere.ts:1:1) ${VALUE}`,
      `\nparams: ${VALUE}`,
    ];
    const error = failedQuery(awkward);
    expect(errorMessage(error)).toBe(`Failed query: ${STATEMENT}`);
    expect(errorStack(error)).not.toContain(VALUE);
  });

  it("read the message of any other error as it stands", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom");
    expect(errorMessage("a thrown string")).toBe("a thrown string");
    expect(errorMessage(42)).toBe("42");
    expect(errorStack(new Error("boom"))).toContain("boom");
    expect(errorStack("not an error")).toBeUndefined();
  });

  it("cannot be made to throw by the value they are given", () => {
    const hostile = {
      get message(): string {
        throw new Error("a throwing getter");
      },
      toString(): string {
        throw new Error("a throwing toString");
      },
    };
    expect(errorMessage(hostile)).toBe("unknown error");
    const lying = Object.assign(new Error("Failed query: x"), {
      query: "x",
      params: {
        toString(): string {
          throw new Error("a throwing toString");
        },
      },
    });
    expect(() => errorMessage(lying)).not.toThrow();
  });
});

describe("withoutQueryParameters", () => {
  it("leaves text that has no parameters line exactly as it is", () => {
    const text = "Error: boom\n    at somewhere (file.ts:1:1)";
    expect(withoutQueryParameters(text)).toBe(text);
  });

  it("cuts a message at its end and a stack at its first frame", () => {
    const message = `Failed query: ${STATEMENT}\nparams: a,${VALUE}`;
    expect(withoutQueryParameters(message)).toBe(`Failed query: ${STATEMENT}`);
    expect(
      withoutQueryParameters(
        `Error: ${message}\n    at one (a.ts:1:1)\n    at two (b.ts:2:2)`,
      ),
    ).toBe(
      `Error: Failed query: ${STATEMENT}\n    at one (a.ts:1:1)\n    at two (b.ts:2:2)`,
    );
  });
});

describe("reportableError", () => {
  it("hands back an error with no failed query in its chain as it is", () => {
    const plain = new Error("boom", { cause: new Error("inner") });
    expect(reportableError(plain)).toBe(plain);
    expect(reportableError("text")).toBe("text");
  });

  it("copies one with a failed query, keeping the name, code, stack and cause and dropping the values and the library's fields", () => {
    const driver = Object.assign(new Error("SQLITE_BUSY"), {
      code: "SQLITE_BUSY",
    });
    const wrapped = new Error("transaction failed", {
      cause: failedQuery(["x", VALUE], driver),
    });
    wrapped.name = "TransactionFailure";

    const copy = reportableError(wrapped) as Error;

    expect(copy).not.toBe(wrapped);
    expect(copy).toBeInstanceOf(Error);
    expect(copy.name).toBe("TransactionFailure");
    expect(copy.message).toBe("transaction failed");
    const failed = copy.cause as Error & { query?: unknown; params?: unknown };
    expect(failed.message).toBe(`Failed query: ${STATEMENT}`);
    expect(failed.stack).not.toContain(VALUE);
    expect(failed).not.toHaveProperty("query");
    expect(failed).not.toHaveProperty("params");
    const inner = failed.cause as Error & { code?: string };
    expect(inner.message).toBe("SQLITE_BUSY");
    expect(inner.code).toBe("SQLITE_BUSY");
    expect(JSON.stringify([copy.stack, failed.stack])).not.toContain(VALUE);
  });

  it("stops at a cause chain that leads back to itself", () => {
    const a = failedQuery();
    const b = new Error("b", { cause: a });
    Object.assign(a, { cause: b });
    expect(() => reportableError(a)).not.toThrow();
  });
});

describe("the log line", () => {
  function written(run: () => void): string {
    const lines: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      lines.push(String(chunk));
      return true;
    });
    run();
    return lines.join("");
  }

  it("carries a failed query's statement and never its values, whichever way the caller hands the error over", () => {
    const error = failedQuery();
    const out = written(() => {
      log("error", "by itself", { error });
      log("error", "nested", { outer: { inner: [error] } });
      log("error", "its summary", { error: formatErrorSummary(error) });
      log("error", "its serialized form", { error: serializeError(error) });
      // The caller built the text itself, from the error's own message.
      log("error", "by hand", { error: error.message, stack: error.stack });
      log("error", `by hand in the message: ${error.message}`);
    });
    expect(out).toContain(`Failed query: ${STATEMENT.replaceAll('"', '\\"')}`);
    expect(out).not.toContain(VALUE);
  });

  it("keeps the driver's own error beside the statement, so an operator can still tell what failed", () => {
    const out = written(() => {
      log("error", "serialized", { error: serializeError(failedQuery()) });
      log("error", "summarized", {
        error: formatErrorSummary(failedQuery()),
      });
    });
    expect(out).toContain("SQLITE_FULL: database or disk is full");
  });
});

describe("the original message a transaction failure reports", () => {
  it("is the driver's own when the failed query has one, and the statement alone when it has none", () => {
    expect(originalErrorMessage(failedQuery())).toBe(
      "SQLITE_FULL: database or disk is full",
    );
    const orphan = new DrizzleQueryError(STATEMENT, ["x", VALUE], undefined);
    expect(orphan.message).toContain(VALUE);
    expect(originalErrorMessage(orphan)).toBe(`Failed query: ${STATEMENT}`);
  });
});

describe("the driver's reason beneath a failed query", () => {
  /** What the real driver raises for a statement, as the query layer would wrap it. */
  async function failure(
    sql: string,
    args: string[],
    setup: string[] = [],
  ): Promise<DrizzleQueryError> {
    const client = createClient({ url: ":memory:" });
    for (const statement of setup) await client.execute(statement);
    try {
      await client.execute({ sql, args });
    } catch (error) {
      return new DrizzleQueryError(sql, args, error as Error);
    }
    throw new Error("the statement was meant to fail");
  }

  it("is kept when it names the constraint or the table and not a value", async () => {
    const failed = await failure(
      "insert into i(id) values (?), (?)",
      ["bound-value-3e9d51c0", "bound-value-3e9d51c0"],
      ["create table i(id text primary key)"],
    );
    expect(failed.cause!.message).toContain("UNIQUE constraint");
    for (const text of [
      formatErrorSummary(failed),
      JSON.stringify(serializeError(failed)),
      errorReason(failed),
      JSON.stringify(reportableError(failed), ["message", "cause"]),
    ]) {
      expect(text).toContain("UNIQUE constraint failed: i.id");
      expect(text).not.toContain("bound-value-3e9d51c0");
    }
  });

  it("is withheld when the driver quotes a token of what the statement was bound to", async () => {
    const failed = await failure(
      "select * from t where t match ?",
      ["canaryzzq:term"],
      ["create virtual table t using fts5(x)"],
    );
    // The witness: the real driver does repeat the token in its message.
    expect(failed.cause!.message).toContain("canaryzzq");

    for (const text of [
      formatErrorSummary(failed),
      JSON.stringify(serializeError(failed)),
      JSON.stringify(reportableError(failed), ["message", "cause", "stack"]),
    ]) {
      expect(text).toContain("Failed query");
      expect(text).toContain("withheld");
      expect(text).not.toContain("canaryzzq");
    }
    expect(errorReason(failed)).toContain("withheld");
    expect(errorReason(failed)).not.toContain("canaryzzq");
    expect(formatErrorSummary(failed)).toContain("SQLITE_ERROR");
  });
});
