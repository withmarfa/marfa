import { expect, it, vi } from "vitest";
import type { InStatement } from "@libsql/client";
import { createUnbootstrappedTestApp, request } from "../test-utils.js";
import { ensureBootstrapSecret } from "../auth/bootstrap-secret.js";
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
          throw new Error("bootstrap commit witness");
        }
        const result = await execute(statement, ...(rest as []));
        if (target) {
          fault.fired = true;
          throw new Error("bootstrap commit witness");
        }
        return result;
      };
      return client;
    },
  };
});
it.each(["before", "after", "unknown"])(
  "keeps bootstrap key, claim and secret coherent after %s commit acknowledgment",
  async (mode) => {
    const ctx = await createUnbootstrappedTestApp();
    try {
      const secret = await ensureBootstrapSecret(ctx.storage);
      const mint = () =>
        request(ctx.app, "POST", "/keys", {
          key: secret,
          body: { label: "first", source: "first" },
        });
      if (mode === "unknown")
        vi.spyOn(ctx.storage.audit, "has").mockRejectedValue(
          new Error("audit witness unavailable"),
        );
      fault.mode = mode;
      const response = await mint();
      expect(fault.fired).toBe(true);
      expect(response.status).toBe(mode === "after" ? 201 : 500);
      const body = await response.text();
      if (mode !== "after") expect(body).not.toContain("marfa_k1_");
      else {
        const key = (JSON.parse(body) as { key: string }).key;
        expect(
          (await request(ctx.app, "GET", "/keys/current", { key })).status,
        ).toBe(200);
      }
      expect(await ctx.storage.keys.list()).toHaveLength(
        mode === "before" ? 0 : 1,
      );
      expect(await ctx.storage.settings.get("bootstrapped")).toBe(
        mode === "before" ? null : "true",
      );
      expect(await ctx.storage.settings.get("bootstrap.secret")).toBe(
        mode === "before" ? secret : null,
      );
      expect(
        (await ctx.storage.audit.list({ action: "key.bootstrap" })).data,
      ).toHaveLength(mode === "before" ? 0 : 1);
      fault.mode = "none";
      vi.restoreAllMocks();
      expect((await mint()).status).toBe(mode === "before" ? 201 : 401);
      expect(await ctx.storage.keys.list()).toHaveLength(1);
      expect(
        (await ctx.storage.audit.list({ action: "key.bootstrap" })).data,
      ).toHaveLength(1);
    } finally {
      fault.mode = "none";
      fault.fired = false;
      vi.restoreAllMocks();
      await ctx.cleanup();
    }
  },
);
it("lets concurrent bootstrap requests commit exactly one credential and audit", async () => {
  const ctx = await createUnbootstrappedTestApp();
  try {
    const secret = await ensureBootstrapSecret(ctx.storage);
    const results = await Promise.all(
      [0, 1].map((n) =>
        request(ctx.app, "POST", "/keys", {
          key: secret,
          body: { label: `key${String(n)}`, source: `source${String(n)}` },
        }),
      ),
    );
    expect(results.map((r) => r.status).sort()).toEqual([201, 401]);
    expect(await ctx.storage.keys.list()).toHaveLength(1);
    expect(
      (await ctx.storage.audit.list({ action: "key.bootstrap" })).data,
    ).toHaveLength(1);
    expect(await ctx.storage.settings.get("bootstrap.secret")).toBeNull();
  } finally {
    await ctx.cleanup();
  }
});
