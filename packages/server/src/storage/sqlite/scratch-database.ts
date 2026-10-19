import { statSync } from "node:fs";
import { createClient, type Client } from "@libsql/client";
import { ErrorCode, MarfaError } from "@withmarfa/shared";
import type { ScratchBudget } from "../disk-space.js";

/**
 * A disposable database has one disk file: journals and temp tables stay in
 * memory. Nothing in it outlives the process, so a commit does not wait for
 * the disk.
 */
export class ScratchDatabase {
  constructor(
    private readonly path: string,
    private readonly budget: () => ScratchBudget,
  ) {}

  client(url: string): Client {
    const raw = createClient({ url });
    const initialize = async () => {
      await raw.execute("PRAGMA journal_mode = MEMORY");
      await raw.execute("PRAGMA temp_store = MEMORY");
      await raw.execute("PRAGMA synchronous = OFF");
    };
    const ready = initialize();
    let line = Promise.resolve();
    const path = this.path;
    const budget = this.budget();
    let closed = false;
    const isClosed = () => closed;
    const close = () => {
      closed = true;
      try {
        raw.close();
      } finally {
        budget.close();
      }
    };
    const requireOpen = () => {
      if (isClosed()) throw new Error("Scratch database is closed");
    };
    const allocated = () => {
      const file = statSync(path);
      // Cache spills can extend the file past dirty pages that are still only in memory.
      return Math.min(file.size, file.blocks * 512);
    };
    const settle = async (page: number) => {
      try {
        const pages = Number(
          (await raw.execute("PRAGMA page_count")).rows[0]?.page_count,
        );
        budget.settle(Math.max(0, pages * page - allocated()));
      } catch (error) {
        close();
        throw error;
      }
    };
    return new Proxy(raw, {
      get(target, key) {
        if (key === "close") return close;
        if (
          key === "execute" ||
          key === "executeMultiple" ||
          key === "batch" ||
          key === "migrate"
        ) {
          return (...args: unknown[]) => {
            const initialized = ready;
            const turn = line.then(async () => {
              requireOpen();
              await initialized;
              requireOpen();
              const page = Number(
                (await raw.execute("PRAGMA page_size")).rows[0]?.page_size,
              );
              const sql = typeof args[0] === "string" ? args[0] : "";
              const rollback = /^(?:ROLLBACK|RELEASE)\b/i.test(sql);
              const room = await budget.acquire();
              try {
                const pages = Number(
                  (await raw.execute("PRAGMA page_count")).rows[0]?.page_count,
                );
                const ceiling = Math.floor((allocated() + room) / page);
                if (!rollback && (room === 0 || ceiling < pages))
                  throw new MarfaError(
                    ErrorCode.INSUFFICIENT_STORAGE,
                    "The disk has no room for archive validation and the configured reserve.",
                  );
                // SQLite refuses growth within the native statement, including index and FTS pages.
                await raw.execute(
                  `PRAGMA max_page_count = ${String(Math.min(Math.max(1, ceiling), 4294967294))}`,
                );
                return await Reflect.apply(
                  Reflect.get(target, key) as (...args: unknown[]) => unknown,
                  target,
                  args,
                );
              } finally {
                await settle(page);
              }
            });
            line = turn.then(
              () => undefined,
              () => undefined,
            );
            return turn;
          };
        }
        const value: unknown = Reflect.get(target, key);
        return typeof value === "function"
          ? (value.bind(target) as unknown)
          : value;
      },
    });
  }
}
