import {
  captureCommittedRegistryView,
  createRegistryReadView,
} from "@withmarfa/shared";
import type { Client, InArgs, InStatement, Transaction } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import * as schema from "./schema.js";
import { registryContext, assertRegistryReady } from "./registry-context.js";
import {
  sqliteRequestContext,
  type SqliteReadScope,
} from "./request-context.js";
import { transactionControl } from "./transaction-control.js";
import { ReadLifetime, ReadSnapshotUnavailable } from "./read-lifetime.js";
import {
  STRUCTURAL_GENERATION_KEY,
  structuralGeneration,
} from "./structural-generation.js";
import { INSTANCE_ID_KEY } from "../instance-id.js";
import type { createConnection } from "./connection.js";

type CaptureRead = Awaited<ReturnType<typeof createConnection>>["captureRead"];

export function readSnapshotRunner(captureRead: CaptureRead) {
  return async function runInReadSnapshot<T>(
    fn: (
      pin: Readonly<{ instanceId: string; structuralGeneration: string }>,
    ) => T | Promise<T>,
    options?: { deadlineAt?: number; signal?: AbortSignal },
  ): Promise<T> {
    const parent = sqliteRequestContext.getStore();
    if (
      parent?.mode === "write" ||
      (transactionControl.getStore()?.begun && !parent)
    )
      throw new Error("A writer transaction cannot acquire a read snapshot");
    if (parent?.mode === "read") {
      parent.assertActive();
      parent.lifetime.shorten(options);
      parent.assertActive();
      const unwatch = parent.lifetime.watch(options?.signal);
      try {
        const value = await parent.lifetime.wait(
          Promise.resolve().then(() => {
            parent.assertActive();
            return fn(parent.pin);
          }),
        );
        parent.assertActive();
        return value;
      } finally {
        unwatch();
      }
    }
    const lifetime = new ReadLifetime(options);
    let reader: Transaction | undefined;
    let scope: SqliteReadScope | undefined;
    let tail: Promise<unknown> = Promise.resolve();
    let cleanup: Promise<void> | undefined;
    try {
      const captured = await captureRead(async (native) => {
        const rows = (
          await native.execute({
            sql: "SELECT key, value FROM settings WHERE key IN (?, ?)",
            args: [INSTANCE_ID_KEY, STRUCTURAL_GENERATION_KEY],
          })
        ).rows;
        lifetime.assertAlive();
        assertRegistryReady();
        const view = captureCommittedRegistryView();
        const id = rows.find((row) => row.key === INSTANCE_ID_KEY)?.value;
        if (typeof id !== "string" || id.length === 0)
          throw new Error("Stored instance identity is unavailable");
        const generation = structuralGeneration(
          rows.find((row) => row.key === STRUCTURAL_GENERATION_KEY)?.value,
        );
        return {
          view,
          pin: Object.freeze({
            instanceId: id,
            structuralGeneration: generation,
          }),
        };
      }, lifetime);
      const native = captured.reader;
      reader = native;
      const assertActive = () => {
        try {
          lifetime.assertAlive();
          if (!scope?.active || native.closed)
            throw new ReadSnapshotUnavailable();
          assertRegistryReady();
        } catch (error) {
          lifetime.abandon();
          throw error;
        }
      };
      const execute: Client["execute"] = (
        statement: InStatement | string,
        args?: InArgs,
      ) => {
        const operation = tail.then(async () => {
          assertActive();
          const query =
            typeof statement === "string" ? statement : statement.sql;
          // Control SQL could end the read transaction before its next query.
          if (!/^\s*(SELECT|WITH|EXPLAIN)\b/i.test(query))
            throw new Error("A read snapshot only executes queries");
          const result =
            typeof statement === "string"
              ? await native.execute({ sql: statement, args: args ?? [] })
              : await native.execute(statement);
          assertActive();
          return result;
        });
        tail = operation.catch(() => undefined);
        return operation;
      };
      const refuse = (): never => {
        assertActive();
        throw new Error("A read snapshot cannot control its native connection");
      };
      const facade: Client = {
        get closed() {
          return !scope?.active || native.closed;
        },
        protocol: "file",
        execute,
        async batch(statements) {
          const results = [];
          for (const statement of statements)
            results.push(
              await (Array.isArray(statement)
                ? execute(statement[0], statement[1])
                : execute(statement)),
            );
          return results;
        },
        transaction: refuse,
        executeMultiple: refuse,
        migrate: refuse,
        sync: refuse,
        reconnect: refuse,
        close: refuse,
      };
      scope = {
        mode: "read",
        active: true,
        lifetime,
        pin: captured.captured.pin,
        tx: drizzle(facade, { schema }),
        assertActive,
        view: createRegistryReadView(captured.captured.view, assertActive),
      };
      const activeScope = scope;
      const value = await lifetime.wait(
        registryContext.run(activeScope, () =>
          sqliteRequestContext.run(activeScope, () =>
            Promise.resolve().then(() => fn(activeScope.pin)),
          ),
        ),
      );
      assertActive();
      scope.active = false;
      cleanup = tail.then(() => native.rollback());
      await lifetime.wait(cleanup);
      lifetime.assertAlive();
      assertRegistryReady();
      return value;
    } finally {
      if (scope) scope.active = false;
      if (reader) {
        const closingReader = reader;
        cleanup ??= tail.then(() => closingReader.rollback());
        void cleanup.catch(() => undefined);
        if (!lifetime.abandoned) {
          try {
            await lifetime.wait(cleanup);
          } finally {
            lifetime.dispose();
          }
        }
      }
      lifetime.dispose();
    }
  };
}
