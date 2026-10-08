import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import type { Client, InStatement } from "@libsql/client";
import { createClient, LibsqlError } from "@libsql/client";
import { createConnection, type DrizzleDb } from "./connection.js";
import { wrapDbWithRequestContext } from "./request-context.js";
import {
  assertTransactionUsable,
  TransactionFailure,
} from "./transaction-control.js";

function causeMessages(error: unknown): string[] {
  const messages: string[] = [];
  for (let step = error, i = 0; step instanceof Error && i < 8; i++) {
    messages.push(step.message);
    step = step.cause;
  }
  return messages;
}

const injection = vi.hoisted(() => ({
  before: undefined as ((sql: string) => void) | undefined,
  after: undefined as ((sql: string) => void) | undefined,
}));
vi.mock("@libsql/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@libsql/client")>();
  return {
    ...actual,
    createClient: (...args: Parameters<typeof actual.createClient>) => {
      const client = actual.createClient(...args);
      const execute = client.execute.bind(client);
      client.execute = async (
        statement: InStatement | string,
        ...rest: unknown[]
      ) => {
        const text = typeof statement === "string" ? statement : statement.sql;
        injection.before?.(text);
        const result = await execute(statement, ...(rest as []));
        injection.after?.(text);
        return result;
      };
      return client;
    },
  };
});

let directory: string;
let db: DrizzleDb;
let raw: Client;
let close: () => Promise<void>;
beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "marfa-tx-failures-"));
  const connection = await createConnection(join(directory, "test.db"));
  db = wrapDbWithRequestContext(connection.db);
  raw = connection.raw;
  close = connection.close;
  await raw.execute("CREATE TABLE fixture (n INTEGER PRIMARY KEY)");
});
afterEach(async () => {
  injection.before = undefined;
  injection.after = undefined;
  await close();
  rmSync(directory, { recursive: true, force: true });
});
const insert = (n: number) =>
  db.run(sql`INSERT INTO fixture (n) VALUES (${n})`);
const values = async () =>
  (await raw.execute("SELECT n FROM fixture ORDER BY n")).rows.map(
    (row) => row.n,
  );

it("distinguishes the pinned native already-active refusal from a generic SQL error", async () => {
  const native = createClient({ url: ":memory:" });
  try {
    await native.execute("BEGIN IMMEDIATE");
    await expect(native.execute("BEGIN DEFERRED")).rejects.toMatchObject({
      code: "SQLITE_ERROR",
      rawCode: 1,
      message: "SQLITE_ERROR: cannot start a transaction within a transaction",
    });
    await expect(
      native.execute("SELECT absent FROM missing"),
    ).rejects.toMatchObject({ code: "SQLITE_ERROR", rawCode: 1 });
    await native.execute("ROLLBACK");
    await native.execute("CREATE TABLE control (n INTEGER)");
    await native.execute("INSERT INTO control VALUES (1)");
    expect((await native.execute("SELECT n FROM control")).rows[0]?.n).toBe(1);
  } finally {
    native.close();
  }
});

describe("savepoint failures poison the root even when the callback catches them", () => {
  it.each(["SAVEPOINT", "RELEASE SAVEPOINT", "ROLLBACK TO SAVEPOINT"])(
    "refuses a later write after %s fails and gives the next transaction a usable connection",
    async (operation) => {
      let fired = 0;
      injection.before = (text) => {
        if (text.toUpperCase().startsWith(operation) && fired++ === 0)
          throw new Error("savepoint cleanup witness");
      };
      let attemptedAfter = false;
      let thrown: unknown;
      try {
        await db.transaction(async () => {
          await insert(1);
          try {
            await db.transaction(async () => {
              await insert(2);
              if (operation === "ROLLBACK TO SAVEPOINT")
                throw new Error("original row refusal");
            });
          } catch {
            /* The root guard must detect a swallowed failed savepoint. */
          }
          try {
            assertTransactionUsable();
            attemptedAfter = true;
            await insert(3);
          } catch {
            /* Commit must still refuse. */
          }
        });
      } catch (error) {
        thrown = error;
      }
      injection.before = undefined;
      expect(fired).toBeGreaterThan(0);
      expect(thrown).toBeInstanceOf(TransactionFailure);
      expect(causeMessages(thrown).join("\n")).toContain(
        operation === "ROLLBACK TO SAVEPOINT"
          ? "original row refusal"
          : "savepoint cleanup witness",
      );
      expect(attemptedAfter).toBe(false);
      expect(await values()).toEqual([]);
      await db.transaction(() => insert(4));
      expect(await values()).toEqual([4]);
    },
  );
});

it.each(["probe", "probe rollback"])(
  "preserves the statement cause and discards an uncertain %s connection",
  async (failure) => {
    await raw.execute(
      "CREATE TRIGGER ends_fixture BEFORE INSERT ON fixture WHEN NEW.n = 2 BEGIN SELECT RAISE(ROLLBACK, 'native transaction-ending witness'); END",
    );
    let armed = false;
    let fired = false;
    injection.before = (text) => {
      if (
        armed &&
        !fired &&
        text === (failure === "probe" ? "BEGIN DEFERRED" : "ROLLBACK")
      ) {
        fired = true;
        throw new LibsqlError(
          "uncertain probe witness",
          "SQLITE_ERROR",
          "SQLITE_ERROR",
        );
      }
    };
    let thrown: unknown;
    try {
      await db.transaction(async () => {
        await insert(1);
        armed = true;
        await insert(2);
      });
    } catch (error) {
      thrown = error;
    }
    injection.before = undefined;
    expect(fired).toBe(true);
    expect(thrown).toBeInstanceOf(TransactionFailure);
    expect(causeMessages(thrown).join("\n")).toContain(
      "native transaction-ending witness",
    );
    expect(await values()).toEqual([]);
    await db.transaction(() => insert(4));
    expect(await values()).toEqual([4]);
  },
);

it("preserves the callback cause when root rollback fails and discards its connection", async () => {
  let fired = false;
  injection.before = (text) => {
    if (!fired && text === "ROLLBACK") {
      fired = true;
      throw new Error("root rollback witness");
    }
  };
  let thrown: unknown;
  try {
    await db.transaction(async () => {
      await insert(1);
      throw new Error("original callback witness");
    });
  } catch (error) {
    thrown = error;
  }
  injection.before = undefined;
  expect(fired).toBe(true);
  expect((thrown as Error).message).toBe("original callback witness");
  expect(await values()).toEqual([]);
  await db.transaction(() => insert(4));
  expect(await values()).toEqual([4]);
});
