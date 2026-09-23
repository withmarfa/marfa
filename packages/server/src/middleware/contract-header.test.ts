import { Hono } from "hono";
import { cors } from "hono/cors";
import { describe, expect, it } from "vitest";
import { ErrorCode, MarfaError } from "@withmarfa/shared";
import { CONTRACT_HEADER, CONTRACT_VERSION } from "../contract.js";
import { contractHeader } from "./contract-header.js";
import { createErrorHandler } from "./error-handler.js";
import type { AppEnv } from "./auth.js";

/**
 * Every kind of answer an application gives, each from the layer that gives
 * it, so a stamp that skipped a status, a thrown error or a preflight is
 * caught here by name. The app-level wire test walks the published
 * operations; this one walks the answer classes they cannot all reach.
 */
describe("the contract header", () => {
  const app = new Hono<AppEnv>();
  app.onError(createErrorHandler({ errorWebhookUrl: "" }));
  app.use("*", contractHeader());
  app.use("*", cors({ origin: "https://app.example" }));
  app.get("/ok", (c) => c.json({ ok: true }));
  app.delete("/gone", (c) => c.body(null, 204));
  app.get("/moved", (c) => c.redirect("/ok", 302));
  app.get("/limited", () => {
    throw new MarfaError(ErrorCode.RATE_LIMITED, "slow down");
  });
  app.get("/broken", () => {
    throw new Error("a fault no route meant");
  });

  const cases: [string, Request, number][] = [
    ["a success", new Request("http://h/ok"), 200],
    [
      "an empty success",
      new Request("http://h/gone", { method: "DELETE" }),
      204,
    ],
    ["a redirect", new Request("http://h/moved"), 302],
    ["an unmatched route", new Request("http://h/nowhere"), 404],
    ["a thrown refusal", new Request("http://h/limited"), 429],
    ["a thrown fault", new Request("http://h/broken"), 500],
    [
      "a CORS preflight",
      new Request("http://h/ok", {
        method: "OPTIONS",
        headers: {
          Origin: "https://app.example",
          "Access-Control-Request-Method": "GET",
        },
      }),
      204,
    ],
  ];

  for (const [label, request, status] of cases) {
    it(`names it on ${label}`, async () => {
      const response = await app.fetch(request);
      expect(response.status).toBe(status);
      expect(response.headers.get(CONTRACT_HEADER)).toBe(
        String(CONTRACT_VERSION),
      );
    });
  }
});
