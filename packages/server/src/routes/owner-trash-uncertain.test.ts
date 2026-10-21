import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { InStatement } from "@libsql/client";
import { createTestContext, request, type TestContext } from "../test-utils.js";
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
        const targeted =
          sql === "COMMIT" && fault.mode !== "none" && !fault.fired;
        if (targeted && fault.mode === "before") {
          fault.fired = true;
          throw new Error("commit acknowledgment witness");
        }
        const result = await execute(statement, ...(rest as []));
        if (targeted && fault.mode === "after") {
          fault.fired = true;
          throw new Error("commit acknowledgment witness");
        }
        return result;
      };
      return client;
    },
  };
});
let ctx: TestContext;
beforeEach(async () => {
  ctx = await createTestContext();
});
afterEach(async () => {
  fault.mode = "none";
  fault.fired = false;
  vi.restoreAllMocks();
  await ctx.cleanup();
});

async function made() {
  const response = await request(ctx.app, "POST", "/items", {
    key: ctx.workingKey,
    body: { type: "core.note", properties: { body: "private-body-witness" } },
  });
  return ((await response.json()) as { item: { id: string } }).item.id;
}
async function act(id: string, action: string) {
  return ctx.ownerRequest(`/items/summaries/${id}/${action}?version=1`, {
    method: "POST",
  });
}
function loseAcknowledgement(action: string, witnessReadable = false) {
  const log = ctx.storage.audit.log.bind(ctx.storage.audit);
  vi.spyOn(ctx.storage.audit, "log").mockImplementation(async (entry, id) => {
    await log(entry, id);
    if (entry.action === action) fault.mode = "after";
  });
  if (!witnessReadable)
    vi.spyOn(ctx.storage.audit, "has").mockRejectedValue(
      new Error("private-body-witness unavailable"),
    );
}
it("reports a committed but unconfirmed purge explicitly and stops the batch", async () => {
  const first = await made();
  const second = await made();
  for (const id of [first, second])
    expect((await act(id, "trash")).status).toBe(200);
  const selected = (
    (await (await ctx.ownerRequest("/trash")).json()) as {
      data: { id: string }[];
    }
  ).data;
  loseAcknowledgement("item.purge");
  const response = await ctx.ownerRequest("/trash/empty", { method: "POST" });
  const answer = await response.json();
  expect(fault.fired).toBe(true);
  expect(
    await ctx.storage.items.getIncludingTrashed(selected[0]!.id),
  ).toBeNull();
  expect(
    await ctx.storage.items.getIncludingTrashed(selected[1]!.id),
  ).not.toBeNull();
  expect(response.status).toBe(200);
  expect(answer).toMatchObject({
    purged: 0,
    next_cursor: null,
    failures: [
      {
        id: selected[0]!.id,
        code: "internal_error",
        details: { write_outcome: "unknown" },
      },
    ],
  });
  expect(JSON.stringify(answer)).not.toContain("private-body-witness");
});
it.each(["trash", "restore", "purge"])(
  "keeps an uncertain %s visible through the single-item response",
  async (action) => {
    const id = await made();
    if (action !== "trash") await act(id, "trash");
    loseAcknowledgement(action === "trash" ? "item.delete" : `item.${action}`);
    const response = await act(id, action);
    expect(fault.fired).toBe(true);
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body).toMatchObject({
      error: { code: "internal_error", details: { write_outcome: "unknown" } },
    });
    expect(JSON.stringify(body)).not.toContain("private-body-witness");
    const row = await ctx.storage.items.getIncludingTrashed(id);
    if (action === "purge") expect(row).toBeNull();
    else expect(row?.state).toBe(action === "trash" ? "trashed" : "active");
  },
);
it("reports success when the durable audit witness confirms a lost acknowledgement", async () => {
  const id = await made();
  await act(id, "trash");
  loseAcknowledgement("item.purge", true);
  const response = await act(id, "purge");
  expect(fault.fired).toBe(true);
  expect(response.status).toBe(200);
  expect(await ctx.storage.items.getIncludingTrashed(id)).toBeNull();
});
