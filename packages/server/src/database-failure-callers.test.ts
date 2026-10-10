/**
 * The callers that hand a failed statement to a diagnostic sink themselves,
 * rather than through the request error handler: the Better Auth logger
 * bridge, work registered to run after a commit, and a housekeeping run,
 * whose error is also answered on its doors and stored.
 *
 * Each case drives a real statement that fails while bound to a synthetic
 * value, shows that the error the caller was given carries the value, and
 * then reads every sink that caller writes to.
 */
import { inspect } from "node:util";
import { createClient } from "@libsql/client";
import { DrizzleQueryError, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/libsql";
import { logs } from "@opentelemetry/api-logs";
import type { Logger } from "@opentelemetry/api-logs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createErrorHandler } from "./middleware/error-handler.js";
import * as logger from "./middleware/logger.js";
import { afterCommit } from "./storage/commit-hooks.js";
import { itemWrites } from "./storage/item-writes.js";
import { createTestContext, request, type TestContext } from "./test-utils.js";

vi.mock("./middleware/logger.js", async (importOriginal) => {
  const actual = await importOriginal<typeof logger>();
  return { ...actual, log: vi.fn(actual.log) };
});

const EMAIL = "sentinel-email-8d41c7@example.test";
const BODY = "sentinel-body-f2a9063e";
const PASSWORD = "sentinel password 51e0";
const REASON = "refused by the fixture";
const origin = "http://localhost:0";

let ctx: TestContext | undefined;
afterEach(async () => {
  await ctx?.cleanup();
  ctx = undefined;
});

function native(context: TestContext) {
  return context.storage as typeof context.storage & {
    __sqliteRun(query: string, params: unknown[]): Promise<unknown>;
    __sqliteAll(query: string): Promise<unknown[]>;
  };
}

/** What `log` was called with, before any rendering: the witness that a caller held the value. */
function handedToLog(): string {
  return inspect(vi.mocked(logger.log).mock.calls, { depth: 10 });
}

/** The two places a log line goes: stdout and the OpenTelemetry log mirror. */
function captureLogSinks(): { text: () => string; restore: () => void } {
  const written: string[] = [];
  const stdout = vi
    .spyOn(process.stdout, "write")
    .mockImplementation((chunk: string | Uint8Array) => {
      written.push(String(chunk));
      return true;
    });
  const records: unknown[] = [];
  const mirror = vi.spyOn(logs, "getLogger").mockReturnValue({
    emit: (record: unknown) => {
      records.push(record);
    },
  } as Logger);
  vi.mocked(logger.log).mockClear();
  return {
    text: () => written.join("") + inspect(records, { depth: 10 }),
    restore: () => {
      stdout.mockRestore();
      mirror.mockRestore();
    },
  };
}

function expectFixedFailure(
  sinks: Record<string, string>,
  values: readonly string[],
  code: string,
): void {
  for (const [name, text] of Object.entries(sinks)) {
    expect
      .soft(text, `${name} received the report`)
      .toContain("Database operation failed");
    expect.soft(text, `${name} gives the SQLite code`).toContain(code);
    expect
      .soft(text, `${name} carries the statement`)
      .not.toContain("Failed query");
    expect
      .soft(text, `${name} carries the driver's text`)
      .not.toContain(REASON);
    for (const value of values)
      expect.soft(text, `${name} carries ${value}`).not.toContain(value);
  }
}

describe("a failed statement Better Auth meets", () => {
  function signIn(context: TestContext): Promise<Response> {
    return request(context.app, "POST", "/auth/sign-in/email", {
      body: { email: EMAIL, password: PASSWORD },
      headers: { origin },
    });
  }

  /** What Better Auth's own router prints when nothing else answers a failure. */
  function captureConsole(): { text: () => string; restore: () => void } {
    const printed: unknown[][] = [];
    const error = vi
      .spyOn(console, "error")
      .mockImplementation((...args: unknown[]) => {
        printed.push(args);
      });
    const written: string[] = [];
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk: string | Uint8Array) => {
        written.push(String(chunk));
        return true;
      });
    return {
      text: () => inspect(printed, { depth: 10 }) + written.join(""),
      restore: () => {
        error.mockRestore();
        stderr.mockRestore();
      },
    };
  }

  it("answers a failed sign-in lookup through the server's error handler, with the fixed database failure on every sink", async () => {
    ctx = await createTestContext({}, { email: EMAIL, password: PASSWORD });
    const raised: unknown[] = [];
    const handler = createErrorHandler({ errorWebhookUrl: "" });
    ctx.app.onError((err, c) => {
      raised.push(err);
      return handler(err, c);
    });
    expect((await signIn(ctx)).status).toBe(200);

    const db = native(ctx);
    await db.__sqliteRun("ALTER TABLE auth_user RENAME TO auth_user_held", []);
    const sinks = captureLogSinks();
    const printed = captureConsole();
    const reported: unknown[] = [];
    const previousReporter = globalThis.__marfaReportException;
    globalThis.__marfaReportException = (error) => {
      reported.push(error);
    };
    let response: Response;
    try {
      response = await signIn(ctx);
    } finally {
      globalThis.__marfaReportException = previousReporter;
      printed.restore();
      sinks.restore();
      await db.__sqliteRun(
        "ALTER TABLE auth_user_held RENAME TO auth_user",
        [],
      );
    }
    expect(response.status).toBe(500);
    expect(response.headers.get("X-Error-Code")).toBe("internal_error");

    // The witness: the failed lookup was bound to the email.
    expect(raised).toHaveLength(1);
    expect((raised[0] as Error).message).toContain(EMAIL);

    expectFixedFailure(
      {
        "the log line and its mirror": sinks.text(),
        "the error handed to exception reporting": inspect(reported, {
          depth: 10,
        }),
      },
      [EMAIL, PASSWORD],
      "SQLITE_ERROR",
    );
    expect(printed.text()).not.toContain(EMAIL);
    expect(printed.text()).not.toContain("Failed query");
    expect((await signIn(ctx)).status).toBe(200);
  });

  it("logs a failed session delete through its logger bridge as the fixed database failure", async () => {
    ctx = await createTestContext({}, { email: EMAIL, password: PASSWORD });
    const signedIn = await signIn(ctx);
    expect(signedIn.status).toBe(200);
    const cookie = signedIn.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");
    const db = native(ctx);
    const { token } = (await signedIn.json()) as { token: string };
    expect(token).toBeTruthy();
    await db.__sqliteRun(
      `CREATE TRIGGER refuse_session_delete BEFORE DELETE ON auth_session BEGIN SELECT RAISE(ABORT, '${REASON}'); END`,
      [],
    );
    const signOut = () =>
      request(ctx!.app, "POST", "/auth/sign-out", {
        body: {},
        headers: { cookie, origin },
      });
    const sinks = captureLogSinks();
    const printed = captureConsole();
    let refused: Response;
    try {
      refused = await signOut();
    } finally {
      printed.restore();
      sinks.restore();
      await db.__sqliteRun("DROP TRIGGER refuse_session_delete", []);
    }
    expect(refused.status).toBe(500);

    // The witness: the bridge was handed the failed delete, bound to the token.
    const handed = handedToLog();
    expect(handed).toContain("Better Auth");
    expect(handed).toContain(token);

    expectFixedFailure(
      { "the bridge's log line and its mirror": sinks.text() },
      [token, EMAIL],
      "SQLITE_CONSTRAINT",
    );
    expect(printed.text()).not.toContain(token);
    expect((await signOut()).status).toBe(200);
  });
});

/** A real write through the query layer that a trigger refuses, bound to `value`. */
async function refusedWrite(value: string): Promise<DrizzleQueryError> {
  const client = createClient({ url: ":memory:" });
  try {
    await client.execute("CREATE TABLE fixture (body TEXT)");
    await client.execute(
      `CREATE TRIGGER refuse BEFORE INSERT ON fixture BEGIN SELECT RAISE(ABORT, '${REASON}'); END`,
    );
    await drizzle(client).run(
      sql`INSERT INTO fixture (body) VALUES (${value})`,
    );
  } catch (error) {
    return error as DrizzleQueryError;
  } finally {
    client.close();
  }
  throw new Error("the write was meant to fail");
}

describe("work registered to run after a commit", () => {
  it("logs a failed statement it throws as the fixed database failure, and the work after it still runs", async () => {
    ctx = await createTestContext();
    const failure = await refusedWrite(BODY);
    // The witness: the error the callback throws carries the value.
    expect(failure).toBeInstanceOf(DrizzleQueryError);
    expect(failure.message).toContain(BODY);
    expect(failure.stack).toContain(BODY);

    const sinks = captureLogSinks();
    let later = false;
    try {
      await ctx.storage.runInTransaction(() => {
        afterCommit(() => {
          throw failure;
        });
        afterCommit(() => {
          later = true;
        });
      });
    } finally {
      sinks.restore();
    }
    expect(later).toBe(true);
    expect(sinks.text()).toContain("Work after a commit failed");
    expectFixedFailure(
      { "the log line and its mirror": sinks.text() },
      [BODY],
      "SQLITE_CONSTRAINT",
    );
  });
});

describe("a housekeeping run whose write fails", () => {
  it("answers, lists, stores and logs the fixed database failure, and the next run succeeds", async () => {
    ctx = await createTestContext();
    const context = ctx;
    const db = native(context);
    let thrown: unknown;
    context.housekeeping.register({
      name: "fixture-write",
      intervalMs: 3_600_000,
      firstRunDelayMs: 3_600_000,
      run: async () => {
        try {
          await itemWrites(context.storage).create({
            writer: null,
            type: "core.note",
            tier: "library",
            state: "active",
            properties: { body: BODY },
            source: "test/database-failure-callers",
          });
        } catch (error) {
          thrown = error;
          throw error;
        }
        return null;
      },
    });
    await context.housekeeping.start();
    try {
      await db.__sqliteRun(
        `CREATE TRIGGER refuse_inserts BEFORE INSERT ON items BEGIN SELECT RAISE(ABORT, '${REASON}'); END`,
        [],
      );
      const sinks = captureLogSinks();
      let ran: Response;
      let listed: Response;
      try {
        ran = await request(
          context.app,
          "POST",
          "/housekeeping/fixture-write/run",
          { key: context.managementKey },
        );
        listed = await request(context.app, "GET", "/housekeeping", {
          key: context.managementKey,
        });
      } finally {
        sinks.restore();
      }

      // The witness: the run failed on a statement bound to the value.
      expect((thrown as Error).message).toContain(BODY);

      expect(ran.status).toBe(200);
      const run = (await ran.json()) as { outcome: string; error: string };
      expect(run.outcome).toBe("error");
      expect(listed.status).toBe(200);
      const row = (
        (await listed.json()) as {
          data: { name: string; last_error: string | null }[];
        }
      ).data.find((entry) => entry.name === "fixture-write");
      const stored = await db.__sqliteAll(
        "SELECT last_error FROM housekeeping WHERE name = 'fixture-write'",
      );
      expectFixedFailure(
        {
          "the run's answer": run.error,
          "the list's last_error": String(row?.last_error),
          "the stored last_error": JSON.stringify(stored),
          "the log line and its mirror": sinks.text(),
        },
        [BODY],
        "SQLITE_CONSTRAINT",
      );

      await db.__sqliteRun("DROP TRIGGER refuse_inserts", []);
      const again = await request(
        context.app,
        "POST",
        "/housekeeping/fixture-write/run",
        { key: context.managementKey },
      );
      expect(((await again.json()) as { outcome: string }).outcome).toBe("ok");
    } finally {
      await context.housekeeping.stop();
    }
  });
});
