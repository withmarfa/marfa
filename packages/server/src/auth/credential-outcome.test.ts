import { afterEach, expect, it, vi } from "vitest";
import type { InStatement } from "@libsql/client";
import { createTestContext, request, type TestContext } from "../test-utils.js";

const fault = vi.hoisted(() => ({
  mode: "none",
  action: "",
  armed: false,
  fired: false,
  inserts: 0,
}));
vi.mock("@libsql/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@libsql/client")>();
  return {
    ...actual,
    createClient: (...args: Parameters<typeof actual.createClient>) => {
      const client = actual.createClient(...args),
        execute = client.execute.bind(client);
      client.execute = async (
        statement: InStatement | string,
        ...rest: unknown[]
      ) => {
        const sql = typeof statement === "string" ? statement : statement.sql;
        const values =
          typeof statement === "string"
            ? []
            : Object.values(statement.args ?? {});
        const audit =
          fault.mode !== "none" &&
          sql.startsWith('insert into "audit_log"') &&
          values.includes(fault.action);
        const target = sql === "COMMIT" && fault.armed && !fault.fired;
        if (target && fault.mode === "before") {
          fault.fired = true;
          throw new Error("credential commit acknowledgment");
        }
        const result = await execute(statement, ...(rest as []));
        if (audit) {
          fault.armed = true;
          fault.inserts++;
        }
        if (target) {
          fault.fired = true;
          throw new Error("credential commit acknowledgment");
        }
        return result;
      };
      return client;
    },
  };
});
let ctx: TestContext | undefined;
afterEach(async () => {
  Object.assign(fault, {
    mode: "none",
    action: "",
    armed: false,
    fired: false,
    inserts: 0,
  });
  vi.restoreAllMocks();
  await ctx?.cleanup();
  ctx = undefined;
});
const body = { email: "owner@example.test", password: "correct horse battery" };
for (const door of ["owner", "session"] as const) {
  it.each(["before", "after", "unknown"])(
    `withholds an unconfirmed ${door} response after %s commit acknowledgment`,
    async (mode) => {
      ctx = await createTestContext();
      const owner = () =>
        request(ctx!.app, "POST", "/owner", { key: ctx!.operatorKey, body });
      if (door === "session") expect((await owner()).status).toBe(201);
      const submit =
        door === "owner"
          ? owner
          : () =>
              request(ctx!.app, "POST", "/auth/sign-in/email", {
                body,
                headers: { origin: "http://localhost:0" },
              });
      if (mode === "unknown")
        vi.spyOn(ctx.storage.audit, "has").mockRejectedValue(
          new Error("witness unavailable"),
        );
      fault.mode = mode;
      fault.action =
        door === "owner" ? "owner.created" : "auth.sign_in.success";
      const response = await submit();
      expect(fault.fired).toBe(true);
      expect(fault.inserts).toBe(1);
      expect(response.status).toBe(
        mode === "after" ? (door === "owner" ? 201 : 200) : 500,
      );
      if (mode !== "after") expect(response.headers.getSetCookie()).toEqual([]);
      else if (door === "session") {
        const cookie = response.headers
          .getSetCookie()
          .map((value) => value.split(";")[0])
          .join("; ");
        expect(
          await (
            await request(ctx.app, "GET", "/auth/get-session", {
              headers: { cookie },
            })
          ).json(),
        ).not.toBeNull();
      }
      const db = ctx.storage as typeof ctx.storage & {
        __sqliteAll(sql: string): Promise<unknown[]>;
      };
      expect(
        await db.__sqliteAll(
          `SELECT id FROM auth_${door === "owner" ? "user" : "session"}`,
        ),
      ).toHaveLength(mode === "before" ? 0 : 1);
      expect(
        (await ctx.storage.audit.list({ action: fault.action })).data,
      ).toHaveLength(mode === "before" ? 0 : 1);
      fault.mode = "none";
      vi.restoreAllMocks();
      if (door === "owner")
        expect((await owner()).status).toBe(mode === "before" ? 201 : 409);
      else if (mode === "before") expect((await submit()).status).toBe(200);
    },
  );
}
