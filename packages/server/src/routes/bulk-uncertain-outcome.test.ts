import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { InStatement } from "@libsql/client";
import { generateId } from "@withmarfa/shared";
import { createTestContext, request, type TestContext } from "../test-utils.js";
import { initEventLog, __resetEventLogForTests } from "../pubsub.js";

const fault = vi.hoisted(() => ({ armed: false, fired: false, mode: "after" }));
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
        const sql = typeof statement === "string" ? statement : statement.sql;
        const targeted = sql === "COMMIT" && fault.armed;
        if (targeted) {
          fault.armed = false;
          fault.fired = true;
          if (fault.mode === "before")
            throw new Error("lost commit acknowledgement");
        }
        const result = await execute(statement, ...(rest as []));
        if (targeted) throw new Error("lost commit acknowledgement");
        return result;
      };
      return client;
    },
  };
});

let ctx: TestContext;
beforeEach(async () => {
  ctx = await createTestContext();
  initEventLog(ctx.storage.eventLog);
});
afterEach(async () => {
  fault.armed = false;
  fault.fired = false;
  vi.restoreAllMocks();
  __resetEventLogForTests();
  await ctx.cleanup();
});

type Family = "items" | "edges";
interface BulkAnswer {
  counts: {
    created: number;
    updated: number;
    skipped: number;
    errored: number;
  };
  results: {
    index: number;
    outcome: string;
    error?: {
      code: string;
      message: string;
      details?: { write_outcome?: string };
    };
  }[];
}
async function inputs(family: Family) {
  return Promise.all(
    Array.from({ length: 3 }, async (_, index) => {
      const id = generateId();
      if (family === "items")
        return {
          id,
          type: "core.note",
          properties: { body: `entry ${String(index)}` },
        };
      const ends: string[] = [];
      for (let i = 0; i < 2; i++) {
        const response = await request(ctx.app, "POST", "/items", {
          key: ctx.workingKey,
          body: { type: "core.note", properties: { body: "endpoint" } },
        });
        expect(response.status).toBe(201);
        ends.push(
          ((await response.json()) as { item: { id: string } }).item.id,
        );
      }
      return {
        id,
        source_id: ends[0],
        target_id: ends[1],
        edge_type: "about",
        properties: {},
      };
    }),
  );
}

for (const family of ["items", "edges"] as const) {
  for (const index of [0, 1]) {
    it.each(["available", "missing", "unavailable"])(
      `${family} entry ${String(index)} keeps a lost COMMIT with %s witness truthful and continues`,
      async (witness) => {
        const rows = await inputs(family);
        const insert = ctx.storage.audit.logOrThrow.bind(ctx.storage.audit);
        const attempts: number[] = [];
        vi.spyOn(ctx.storage.audit, "logOrThrow").mockImplementation(
          async (entry, id) => {
            await insert(entry, id);
            if (entry.action === `${family}.bulk`) {
              attempts.push(entry.details!.index as number);
              if (entry.details?.index === index) fault.armed = true;
            }
          },
        );
        fault.mode = "after";
        if (witness === "missing")
          vi.spyOn(ctx.storage.audit, "has").mockResolvedValue(false);
        if (witness === "unavailable")
          vi.spyOn(ctx.storage.audit, "has").mockRejectedValue(
            new Error("witness unavailable"),
          );
        const response = await request(ctx.app, "POST", `/${family}/bulk`, {
          key: ctx.workingKey,
          body: { atomic: false, [family]: rows },
        });
        expect(fault.fired).toBe(true);
        expect(response.status).toBe(200);
        const body = (await response.json()) as BulkAnswer;
        expect(attempts).toEqual([0, 1, 2]);
        expect(
          (
            await Promise.all(
              rows.map((row) => ctx.storage[family].get(row.id)),
            )
          ).every(Boolean),
        ).toBe(true);
        expect(
          (await ctx.storage.audit.list({ action: `${family}.bulk` })).data,
        ).toHaveLength(3);
        expect(body.counts).toEqual({
          created: witness === "available" ? 3 : 2,
          updated: 0,
          skipped: 0,
          errored: witness === "available" ? 0 : 1,
        });
        if (witness === "available") {
          expect(body.results.map((result) => result.outcome)).toEqual([
            "created",
            "created",
            "created",
          ]);
        } else {
          expect(body.results[index]).toMatchObject({
            index,
            outcome: "errored",
            error: {
              code: "internal_error",
              details: { write_outcome: "unknown" },
            },
          });
          expect(body.results[index]!.error!.message).toContain(
            "may have been written",
          );
          expect(
            body.results
              .filter((result) => result.index !== index)
              .map((result) => result.outcome),
          ).toEqual(["created", "created"]);
        }
      },
    );

    it.each(["commit", "audit"])(
      `${family} entry ${String(index)} preserves a definite %s rollback and its retry boundary`,
      async (failure) => {
        const rows = await inputs(family);
        if (failure === "audit") {
          const raw = ctx.storage as typeof ctx.storage & {
            __sqliteRun(sql: string, args: unknown[]): Promise<unknown>;
          };
          await raw.__sqliteRun(
            `CREATE TRIGGER refuse_bulk_audit BEFORE INSERT ON audit_log WHEN NEW.action = '${family}.bulk' AND json_extract(NEW.details, '$.index') = ${String(index)} BEGIN SELECT RAISE(ABORT, 'audit refused'); END`,
            [],
          );
        } else {
          fault.mode = "before";
          const insert = ctx.storage.audit.logOrThrow.bind(ctx.storage.audit);
          vi.spyOn(ctx.storage.audit, "logOrThrow").mockImplementation(
            async (entry, id) => {
              await insert(entry, id);
              if (
                entry.action === `${family}.bulk` &&
                entry.details?.index === index
              )
                fault.armed = true;
            },
          );
        }
        const response = await request(ctx.app, "POST", `/${family}/bulk`, {
          key: ctx.workingKey,
          body: { atomic: false, [family]: rows },
        });
        if (failure === "commit") expect(fault.fired).toBe(true);
        expect(response.status).toBe(index === 0 ? 500 : 200);
        const present = await Promise.all(
          rows.map(async (row) =>
            Boolean(await ctx.storage[family].get(row.id)),
          ),
        );
        expect(present).toEqual(
          index === 0 ? [false, false, false] : [true, false, true],
        );
        expect(
          (await ctx.storage.audit.list({ action: `${family}.bulk` })).data,
        ).toHaveLength(index === 0 ? 0 : 2);
        if (index !== 0) {
          const body = (await response.json()) as BulkAnswer;
          expect(body.counts).toEqual({
            created: 2,
            updated: 0,
            skipped: 0,
            errored: 1,
          });
          expect(
            body.results[index]!.error?.details?.write_outcome,
          ).toBeUndefined();
          expect(body.results[index]!.error?.message).toContain(
            "nothing of it was",
          );
        }
      },
    );
  }
}

it.each(["items", "edges"] as const)(
  "%s retains the partial answer when an unknown first commit is followed by a definite refusal",
  async (family) => {
    const rows = await inputs(family);
    const raw = ctx.storage as typeof ctx.storage & {
      __sqliteRun(sql: string, args: unknown[]): Promise<unknown>;
    };
    await raw.__sqliteRun(
      `CREATE TRIGGER refuse_second_audit BEFORE INSERT ON audit_log WHEN NEW.action = '${family}.bulk' AND json_extract(NEW.details, '$.index') = 1 BEGIN SELECT RAISE(ABORT, 'audit refused'); END`,
      [],
    );
    const insert = ctx.storage.audit.logOrThrow.bind(ctx.storage.audit);
    vi.spyOn(ctx.storage.audit, "logOrThrow").mockImplementation(
      async (entry, id) => {
        await insert(entry, id);
        if (entry.action === `${family}.bulk` && entry.details?.index === 0)
          fault.armed = true;
      },
    );
    fault.mode = "after";
    vi.spyOn(ctx.storage.audit, "has").mockRejectedValue(
      new Error("witness unavailable"),
    );
    const response = await request(ctx.app, "POST", `/${family}/bulk`, {
      key: ctx.workingKey,
      body: { atomic: false, [family]: rows },
    });
    expect(fault.fired).toBe(true);
    expect(response.status).toBe(200);
    const body = (await response.json()) as BulkAnswer;
    expect(body.counts).toEqual({
      created: 1,
      updated: 0,
      skipped: 0,
      errored: 2,
    });
    expect(body.results[0]!.error?.details?.write_outcome).toBe("unknown");
    expect(body.results[1]!.error?.details?.write_outcome).toBeUndefined();
    expect(body.results[1]!.error?.message).toContain("nothing of it was");
    expect(body.results[2]!.outcome).toBe("created");
    expect(
      await Promise.all(
        rows.map(async (row) => Boolean(await ctx.storage[family].get(row.id))),
      ),
    ).toEqual([true, false, true]);
    expect(
      (await ctx.storage.audit.list({ action: `${family}.bulk` })).data
        .map((entry) => entry.details.index)
        .sort(),
    ).toEqual([0, 2]);
  },
);
