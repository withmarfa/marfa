import { DrizzleQueryError } from "drizzle-orm";
import { createClient, LibsqlError } from "@libsql/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { originalErrorMessage } from "./storage/sqlite/transaction-control.js";
import {
  DatabaseFailure,
  errorMessage,
  errorReason,
  errorStack,
  reportableError,
  withoutFailedQueries,
} from "./error-text.js";
import {
  formatErrorSummary,
  log,
  serializeError,
} from "./middleware/logger.js";

const VALUE = "bound-value-3e9d51c0";
const STATEMENT =
  'insert into "items" ("id", "properties") values (?, jsonb(?))';
const FIXED = "Database operation failed";

/** The wrapper the query layer raises, built by the library's own class. */
function failedQuery(
  params: unknown[] = ["an-id", `{"body":"${VALUE}"}`],
  cause: unknown = new LibsqlError(
    "database or disk is full",
    "SQLITE_FULL",
    "SQLITE_FULL",
    13,
  ),
): DrizzleQueryError {
  return new DrizzleQueryError(STATEMENT, params, cause as Error);
}

/** Every text a sink could be handed for `error`. */
function everyRendering(error: unknown): string[] {
  return [
    errorMessage(error),
    errorReason(error),
    errorStack(error) ?? "",
    formatErrorSummary(error),
    JSON.stringify(serializeError(error)),
    JSON.stringify(reportableError(error), ["name", "message", "stack"]),
    String((reportableError(error) as Error).stack),
  ];
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a failed query as the query layer raises it", () => {
  it("names its statement and values in the message and in the stack, which is why a report must not copy either", () => {
    const error = failedQuery();
    expect(error.message).toContain(VALUE);
    expect(error.message).toContain(STATEMENT);
    expect(error.stack).toContain(VALUE);
  });
});

describe("reportableError", () => {
  it("hands back an error with no database failure in its chain as it is", () => {
    const plain = new Error("boom", { cause: new Error("inner") });
    expect(reportableError(plain)).toBe(plain);
    expect(reportableError("text")).toBe("text");
    expect(reportableError(undefined)).toBeUndefined();
  });

  it("replaces one with a failed query by the fixed failure, keeping the SQLite code and the outer frames", () => {
    const error = failedQuery();
    const reported = reportableError(error) as DatabaseFailure;
    expect(reported).toBeInstanceOf(DatabaseFailure);
    expect(reported.name).toBe("DatabaseFailure");
    expect(reported.message).toBe(`${FIXED} (SQLITE_FULL)`);
    expect(reported.code).toBe("SQLITE_FULL");
    expect(reported.cause).toBeUndefined();
    expect(reported).not.toHaveProperty("query");
    expect(reported).not.toHaveProperty("params");
    const frames = error.stack!.slice(error.stack!.indexOf("\n    at "));
    expect(reported.stack).toBe(
      `DatabaseFailure: ${FIXED} (SQLITE_FULL)${frames}`,
    );
  });

  it("keeps the extended code the driver gives, and only in SQLite's own spelling", () => {
    const unique = failedQuery(
      ["x", VALUE],
      new LibsqlError(
        VALUE,
        "SQLITE_CONSTRAINT",
        "SQLITE_CONSTRAINT_UNIQUE",
        2067,
      ),
    );
    const reported = reportableError(unique) as DatabaseFailure;
    expect(reported.message).toBe(`${FIXED} (SQLITE_CONSTRAINT_UNIQUE)`);
    expect(reported.code).toBe("SQLITE_CONSTRAINT");
    expect(reported.extendedCode).toBe("SQLITE_CONSTRAINT_UNIQUE");

    for (const code of [VALUE, `SQLITE_CONSTRAINT ${VALUE}`, "SQLITE_X_y"]) {
      const odd = reportableError(new LibsqlError(VALUE, code)) as Error;
      expect(odd.message).toBe(FIXED);
      expect(JSON.stringify(serializeError(odd))).not.toContain(code);
    }
  });

  it("replaces a wrapper whose chain holds a database failure, wherever in the chain or an aggregate's branches", () => {
    const wrapped = new Error(`transaction failed: ${VALUE}`, {
      cause: failedQuery(),
    });
    const aggregate = new AggregateError(
      [new Error("ordinary"), failedQuery()],
      `several: ${VALUE}`,
    );
    const native = Object.assign(new Error(VALUE), {
      name: "SqliteError",
      code: "SQLITE_BUSY_SNAPSHOT",
    });
    for (const error of [wrapped, aggregate, native]) {
      const reported = reportableError(error) as Error;
      expect(reported).toBeInstanceOf(DatabaseFailure);
      for (const text of everyRendering(error)) {
        expect(text).toContain(FIXED);
        expect(text).not.toContain(VALUE);
        expect(text).not.toContain("Failed query");
      }
    }
    expect((reportableError(native) as Error).message).toBe(
      `${FIXED} (SQLITE_BUSY_SNAPSHOT)`,
    );
  });

  it("treats a chain too deep or too wide to read whole as a database failure, and stops at a cycle", () => {
    let deep: Error = new Error(VALUE);
    for (let i = 0; i < 20; i++) deep = new Error(VALUE, { cause: deep });
    expect(reportableError(deep)).toBeInstanceOf(DatabaseFailure);

    const wide = new AggregateError(
      Array.from({ length: 100 }, () => new Error(VALUE)),
      VALUE,
    );
    expect(reportableError(wide)).toBeInstanceOf(DatabaseFailure);

    const a = new Error("a");
    const b = new Error("b", { cause: a });
    Object.assign(a, { cause: b });
    expect(reportableError(a)).toBe(a);
    const c = failedQuery();
    Object.assign(c, { cause: new Error("d", { cause: c }) });
    expect(reportableError(c)).toBeInstanceOf(DatabaseFailure);
  });

  it("drops the frames when the stack's header cannot be told apart exactly", () => {
    const error = failedQuery();
    error.stack = `Error: something else\n    at fake (${VALUE}.ts:1:1)`;
    const reported = reportableError(error) as Error;
    expect(reported.stack).toBe(`DatabaseFailure: ${FIXED} (SQLITE_FULL)`);
  });
});

describe("errorMessage, errorReason and errorStack", () => {
  it("give the fixed failure for a failed query, whatever its values look like", () => {
    const awkward = [
      `first\nsecond ${VALUE}`,
      `line\n    at fake (/nowhere.ts:1:1) ${VALUE}`,
      `\nparams: ${VALUE}`,
    ];
    const error = failedQuery(awkward);
    expect(errorMessage(error)).toBe(`${FIXED} (SQLITE_FULL)`);
    expect(errorReason(error)).toBe(`${FIXED} (SQLITE_FULL)`);
    expect(errorStack(error)).not.toContain(VALUE);
    expect(errorStack(error)).not.toContain("fake");
  });

  it("read any other error as it stands", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom");
    expect(errorMessage("a thrown string")).toBe("a thrown string");
    expect(errorMessage(42)).toBe("42");
    expect(errorStack(new Error("boom"))).toContain("boom");
    expect(errorStack("not an error")).toBeUndefined();
    expect(errorReason(new Error("outer", { cause: new Error("inner") }))).toBe(
      "inner",
    );
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
    const lying = Object.defineProperty(
      Object.assign(new Error("Failed query: x"), { query: "x" }),
      "cause",
      {
        get(): unknown {
          throw new Error("a throwing getter");
        },
      },
    );
    expect(() => errorMessage(lying)).not.toThrow();
    expect(errorMessage(lying)).toBe(FIXED);
  });
});

describe("withoutFailedQueries", () => {
  it("leaves text that has no failed query exactly as it is", () => {
    const text = "Error: boom\n    at somewhere (file.ts:1:1)";
    expect(withoutFailedQueries(text)).toBe(text);
  });

  it("replaces a failed query's statement and values, up to the first frame", () => {
    const message = `Failed query: ${STATEMENT}\nparams: a,${VALUE}`;
    expect(withoutFailedQueries(message)).toBe(FIXED);
    expect(
      withoutFailedQueries(
        `Error: ${message}\n    at one (a.ts:1:1)\n    at two (b.ts:2:2)`,
      ),
    ).toBe(`Error: ${FIXED}\n    at one (a.ts:1:1)\n    at two (b.ts:2:2)`);
  });

  it("keeps going through a bound value's own lines, including one that begins like a stack frame", () => {
    const frames = "\n    at one (a.ts:1:1)\n    at file:///b.ts:2:2";
    const value = `first line\n    at the end of a sentence\nlast-line-${VALUE}`;
    const message = `Failed query: ${STATEMENT}\nparams: a,${value}`;
    expect(withoutFailedQueries(message)).toBe(FIXED);
    expect(withoutFailedQueries(`Error: ${message}${frames}`)).toBe(
      `Error: ${FIXED}${frames}`,
    );
  });

  it("ends at each spelling of a genuine frame", () => {
    for (const frame of [
      "    at name (file.ts:1:1)",
      "    at async name (file:///a/b.ts:10:20)",
      "    at file:///a/b.ts:3:4",
      "    at Array.map (<anonymous>)",
      "    at process.processTicksAndRejections (node:internal/x:1:2)",
      "    at native (native)",
    ])
      expect(withoutFailedQueries(`Failed query: ${STATEMENT}\n${frame}`)).toBe(
        `${FIXED}\n${frame}`,
      );
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

  it("carries the fixed failure and never the statement or its values, whichever way the caller hands the error over", () => {
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
    expect(out).toContain(FIXED);
    expect(out).toContain("SQLITE_FULL");
    expect(out).not.toContain(VALUE);
    expect(out).not.toContain("Failed query");
    expect(out).not.toContain("database or disk is full");
  });
});

describe("the original message a transaction failure reports", () => {
  it("is the fixed failure for a failed query, with or without the driver's error beneath it", () => {
    expect(originalErrorMessage(failedQuery())).toBe(`${FIXED} (SQLITE_FULL)`);
    const orphan = new DrizzleQueryError(STATEMENT, ["x", VALUE], undefined);
    expect(orphan.message).toContain(VALUE);
    expect(originalErrorMessage(orphan)).toBe(FIXED);
  });
});

describe("the driver's own message beneath a failed query", () => {
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
    } finally {
      client.close();
    }
    throw new Error("the statement was meant to fail");
  }

  const FTS = ["create virtual table t using fts5(x)"];
  it.each([
    [
      "a full-text token",
      "canaryzzq",
      "canaryzzq:term",
      "select * from t where t match ?",
      FTS,
    ],
    ["a CJK word", "東京", "東京:x", "select * from t where t match ?", FTS],
    [
      "an accented word",
      "naïve",
      "naïve:x",
      "select * from t where t match ?",
      FTS,
    ],
    [
      "a word in a JSON path",
      "名前",
      '$."名前 x',
      "select json_extract(jsonb('{}'), ?)",
      [],
    ],
  ])(
    "is not reported when it quotes %s of what the statement was bound to",
    async (_name, word, argument, sql, setup) => {
      const failed = await failure(sql, [argument], setup);
      // The witness: the real driver repeats the word in its message.
      expect(failed.cause!.message).toContain(word);
      for (const text of everyRendering(failed)) {
        expect(text).toContain(FIXED);
        expect(text).toContain("SQLITE_ERROR");
        expect(text).not.toContain(word);
      }
    },
  );
});
