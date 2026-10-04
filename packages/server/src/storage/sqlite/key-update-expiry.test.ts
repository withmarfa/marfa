import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConnection } from "./connection.js";
import { SqliteKeyStore } from "./key-store.js";

const LIVE = "2030-01-01T00:00:00.000Z";
const EXPIRY = "2030-01-01T00:00:01.000Z";

afterEach(() => {
  vi.useRealTimers();
});

it.each([{ label: "too late" }, {}])(
  "refuses an update that crosses expiry during its read: %j",
  async (input) => {
    const dir = await mkdtemp(join(tmpdir(), "marfa-key-update-expiry-"));
    const connection = await createConnection(join(dir, "test.db"));
    try {
      const store = new SqliteKeyStore(connection.db);
      const key = await store.create(
        { label: "before", source: "expiry-test", is_operator: false },
        "expiry-test-hash",
      );
      await connection.raw.execute({
        sql: "UPDATE api_keys SET expires_at = ? WHERE id = ?",
        args: [EXPIRY, key.id],
      });
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(LIVE));
      expect((await store.update(key.id, { label: "live" })).label).toBe(
        "live",
      );
      expect((await store.update(key.id, {})).label).toBe("live");

      let crossed = false;
      function wrap<T extends object>(value: T): T {
        return new Proxy(value, {
          get(target, name) {
            const member: unknown = Reflect.get(target, name);
            if (typeof member !== "function") return member;
            return (...args: unknown[]) => {
              const result: unknown = Reflect.apply(member, target, args);
              if (name === "get") {
                return Promise.resolve(result).then((row: unknown) => {
                  crossed = true;
                  vi.setSystemTime(new Date(EXPIRY));
                  return row;
                });
              }
              return result !== null && typeof result === "object"
                ? wrap(result)
                : result;
            };
          },
        });
      }
      const db = new Proxy(connection.db, {
        get(target, name) {
          if (name === "select") {
            return (...args: unknown[]) =>
              wrap(
                Reflect.apply(
                  target.select.bind(target),
                  target,
                  args,
                ) as object,
              );
          }
          const member: unknown = Reflect.get(target, name);
          const bound: unknown =
            typeof member === "function" ? member.bind(target) : member;
          return bound;
        },
      });
      await expect(
        new SqliteKeyStore(db).update(key.id, input),
      ).rejects.toMatchObject({
        code: "api_key_not_found",
      });
      expect(crossed).toBe(true);
      const saved = await connection.raw.execute({
        sql: "SELECT label FROM api_keys WHERE id = ?",
        args: [key.id],
      });
      expect(saved.rows[0]?.label).toBe("live");
    } finally {
      await connection.close();
      await rm(dir, { recursive: true });
    }
  },
);
