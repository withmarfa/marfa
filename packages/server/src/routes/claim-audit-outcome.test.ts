import { expect, it, vi } from "vitest";
import type { InStatement } from "@libsql/client";
import { request } from "../test-utils.js";
import { createClaimTestApp } from "../auth/claim-test-app.js";
import { exchangeSetupCode, getClaimStatus } from "../auth/instance-claim.js";
const fault = vi.hoisted(() => ({ mode: "none", fired: false }));
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
        const target =
          sql === "COMMIT" && !fault.fired && fault.mode !== "none";
        if (target && fault.mode === "before") {
          fault.fired = true;
          throw new Error("claim commit witness");
        }
        const result = await execute(statement, ...(rest as []));
        if (target) {
          fault.fired = true;
          throw new Error("claim commit witness");
        }
        return result;
      };
      return client;
    },
  };
});
it.each(["before", "after", "unknown"])(
  "keeps owner, consumed proof, and claim state coherent after %s commit acknowledgment",
  async (mode) => {
    const ctx = await createClaimTestApp("http://localhost:0");
    try {
      const setup = await exchangeSetupCode(
        ctx.storage,
        ctx.setupCode,
        "127.0.0.1",
      );
      const mint = () =>
        request(ctx.app, "POST", "/owner", {
          body: {
            email: "owner@example.test",
            password: "correct horse battery",
          },
          headers: {
            origin: "http://localhost:0",
            cookie: `marfa.setup=${setup.token}`,
          },
        });
      if (mode === "unknown")
        vi.spyOn(ctx.storage.audit, "has").mockRejectedValue(
          new Error("audit witness unavailable"),
        );
      fault.mode = mode;
      const response = await mint();
      expect(fault.fired).toBe(true);
      expect(response.status).toBe(mode === "after" ? 201 : 500);
      expect((await getClaimStatus(ctx.storage)).claimed).toBe(
        mode !== "before",
      );
      expect(
        await ctx.storage.__sqliteAll("SELECT id FROM auth_user"),
      ).toHaveLength(mode === "before" ? 0 : 1);
      expect(
        (await ctx.storage.audit.list({ action: "owner.claimed" })).data,
      ).toHaveLength(mode === "before" ? 0 : 1);
      fault.mode = "none";
      vi.restoreAllMocks();
      expect((await mint()).status).toBe(mode === "before" ? 201 : 409);
      expect(
        await ctx.storage.__sqliteAll("SELECT id FROM auth_user"),
      ).toHaveLength(1);
      expect(
        (await ctx.storage.audit.list({ action: "owner.claimed" })).data,
      ).toHaveLength(1);
    } finally {
      fault.mode = "none";
      fault.fired = false;
      vi.restoreAllMocks();
      await ctx.cleanup();
    }
  },
);
it("lets concurrent setup requests commit exactly one owner and audit", async () => {
  const ctx = await createClaimTestApp("http://localhost:0");
  try {
    const results = await Promise.all(
      [0, 1].map(() =>
        request(ctx.app, "POST", "/owner", {
          body: {
            email: "owner@example.test",
            password: "correct horse battery",
            code: ctx.setupCode,
          },
        }),
      ),
    );
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(
      await ctx.storage.__sqliteAll("SELECT id FROM auth_user"),
    ).toHaveLength(1);
    expect(
      (await ctx.storage.audit.list({ action: "owner.claimed" })).data,
    ).toHaveLength(1);
    expect((await getClaimStatus(ctx.storage)).claimed).toBe(true);
  } finally {
    await ctx.cleanup();
  }
});
