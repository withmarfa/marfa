import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createTestContext,
  mintWorkingKey,
  request,
  seedOauthBearer,
  type TestContext,
} from "../test-utils.js";
import type { Connector } from "../storage/interface.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.cleanup();
});

const READS = [
  "GET /connectors",
  "GET /connectors/:id",
  "GET /connectors/:id/runs",
];

const OWN_RULES = {
  "GET /connectors/:id/endpoints": "the own key or operator reads endpoints",
  "GET /connectors/:id/deliveries": "the own key reads deliveries",
  "GET /connectors/:id/deliveries/:delivery_id/body":
    "the own key reads delivery bodies",
  "GET /connectors/:id/state": "the own key reads state",
  "GET /connectors/:id/agreements": "the own key reads agreements",
};

describe("connector read doors", () => {
  it("classifies every registered connector read door", () => {
    const doors = [
      ...new Set(
        ctx.app.routes
          .filter(
            (route) =>
              route.method === "GET" &&
              (route.path === "/connectors" ||
                route.path.startsWith("/connectors/")),
          )
          .map((route) => `${route.method} ${route.path}`),
      ),
    ].sort();
    expect(doors).toEqual([...READS, ...Object.keys(OWN_RULES)].sort());
  });

  it("shows registrations and their runs only to the own key or operator", async () => {
    const registered = await request(ctx.app, "POST", "/connectors", {
      key: ctx.workingKey,
      body: { name: "reader", description: "connector details" },
    });
    expect(registered.status).toBe(201);
    const connector = (await registered.json()) as Connector;
    const at = new Date().toISOString();
    const reported = await request(
      ctx.app,
      "POST",
      `/connectors/${connector.id}/runs`,
      {
        key: ctx.workingKey,
        body: {
          outcome: "failed",
          started_at: at,
          finished_at: at,
          summary: "vendor details",
          error: "vendor failure",
        },
      },
    );
    expect(reported.status).toBe(201);
    const other = await mintWorkingKey(ctx);
    const { token } = await seedOauthBearer(ctx.storage, ["openid"]);

    for (const door of READS) {
      const path = door.slice(4).replace(":id", connector.id);
      for (const key of [ctx.workingKey, ctx.operatorKey]) {
        const witness = await request(ctx.app, "GET", path, { key });
        expect(witness.status, path).toBe(200);
        expect(await witness.text(), path).toContain("vendor details");
      }
      for (const key of [other, token]) {
        const hidden = await request(ctx.app, "GET", path, { key });
        if (path === "/connectors") {
          expect(hidden.status).toBe(200);
          expect(await hidden.json()).toEqual({ data: [], next_cursor: null });
        } else {
          expect(hidden.status, path).toBe(404);
          const absent = await request(
            ctx.app,
            "GET",
            path.replace(connector.id, "01a0c000-0000-7000-8000-000000000000"),
            { key },
          );
          expect(absent.status).toBe(404);
          expect(((await hidden.json()) as { error: unknown }).error).toEqual(
            ((await absent.json()) as { error: unknown }).error,
          );
        }
      }
    }
  });
});
