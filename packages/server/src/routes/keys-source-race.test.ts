/**
 * Mints racing for one `source` answer one `201` and `409 conflict` for the
 * rest. The unique index on an unrevoked key's own source is what decides,
 * so the loser is told what the contract says rather than `500`.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestContext, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("concurrent mints naming one source", () => {
  it("answer one 201 and 409 conflict naming the source for the rest", async () => {
    for (let round = 0; round < 3; round++) {
      const source = `race-${String(round)}-${Math.random().toString(36).slice(2, 8)}`;
      const answers = await Promise.all(
        Array.from({ length: 4 }, (_, i) =>
          request(ctx.app, "POST", "/keys", {
            key: ctx.workingKey,
            body: { label: `racer ${String(i)}`, source },
          }),
        ),
      );
      const statuses = answers.map((r) => r.status).sort();
      expect(statuses).toEqual([201, 409, 409, 409]);
      for (const answer of answers.filter((r) => r.status === 409)) {
        const body = (await answer.json()) as {
          error: { code: string; details?: { source?: string } };
        };
        expect(body.error.code).toBe("conflict");
        expect(body.error.details?.source).toBe(source);
      }
    }
  });
});
