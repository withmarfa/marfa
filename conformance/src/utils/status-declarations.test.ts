/**
 * The status checker's own witness.
 *
 * A gate that reads a log and a document has to be shown both answers: a
 * log naming a status the document does not declare, which it must catch,
 * and the same log with the declaration in place, which it must pass. Held
 * here rather than against a live server, because a live server cannot be
 * asked to answer a status it has no code path for.
 */
import { describe, it, expect } from "vitest";
import {
  declaredStatuses,
  formatObserved,
  formatUndeclared,
  parseRequestLines,
  reportStatuses,
} from "./status-declarations.js";

/** A document declaring one door, the way the server's does. */
function documentDeclaring(statuses: number[]) {
  return {
    paths: {
      "/items/{id}": {
        get: {
          responses: Object.fromEntries(
            statuses.map((status) => [String(status), { description: "" }]),
          ),
        },
        parameters: [{ name: "id", in: "path" }],
      },
    },
  };
}

function logLine(fields: Record<string, unknown>): string {
  return JSON.stringify({
    timestamp: "2026-09-22T00:00:00.000Z",
    request_id: "019d1234-5678-7abc-8def-1234567890ab",
    duration_ms: 1,
    ...fields,
  });
}

const OBSERVED_403 = logLine({
  method: "GET",
  path: "/items/019d1234-5678-7abc-8def-1234567890ab",
  route: "/items/{id}",
  status: 403,
  error_code: "type_not_permitted",
});

const OBSERVED_200 = logLine({
  method: "GET",
  path: "/items/019d1234-5678-7abc-8def-1234567890ab",
  route: "/items/{id}",
  status: 200,
});

describe("the status checker", () => {
  it("catches a status the door answered and its document does not declare", () => {
    const report = reportStatuses(
      parseRequestLines([OBSERVED_200, OBSERVED_403].join("\n")),
      documentDeclaring([200, 401, 404, 429]),
    );

    expect(report.undeclared).toEqual([
      {
        operation: "GET /items/{id}",
        status: 403,
        codes: ["type_not_permitted"],
        declared: [200, 401, 404, 429],
      },
    ]);
    expect(formatUndeclared(report)).toContain("type_not_permitted");
  });

  it("passes the same log once the door declares it", () => {
    const report = reportStatuses(
      parseRequestLines([OBSERVED_200, OBSERVED_403].join("\n")),
      documentDeclaring([200, 401, 403, 404, 429]),
    );

    expect(report.undeclared).toEqual([]);
    expect(report.lines).toBe(2);
  });

  it("keeps every code seen on a status, which is what the declaration needs", () => {
    const report = reportStatuses(
      parseRequestLines(
        [
          OBSERVED_403,
          logLine({
            method: "GET",
            path: "/items/x",
            route: "/items/{id}",
            status: 403,
            error_code: "forbidden",
          }),
        ].join("\n"),
      ),
      documentDeclaring([200]),
    );

    expect(report.undeclared[0]?.codes).toEqual([
      "forbidden",
      "type_not_permitted",
    ]);
  });

  it("counts a served route the document does not publish rather than refusing it", () => {
    const report = reportStatuses(
      parseRequestLines(
        logLine({
          method: "GET",
          path: "/health",
          route: "/health",
          status: 200,
        }),
      ),
      documentDeclaring([200]),
    );

    expect(report.undeclared).toEqual([]);
    expect([...report.unpublished.keys()]).toEqual(["GET /health"]);
  });

  it("reads the request lines out of a log that carries everything else too", () => {
    const lines = parseRequestLines(
      [
        "Listening on http://127.0.0.1:0",
        JSON.stringify({ level: "info", message: "bootstrap secret" }),
        "{ not json",
        "",
        OBSERVED_200,
      ].join("\n"),
    );

    expect(lines).toEqual([
      {
        method: "GET",
        route: "/items/{id}",
        path: "/items/019d1234-5678-7abc-8def-1234567890ab",
        status: 200,
        code: undefined,
      },
    ]);
  });

  // A request that matched no route carries no `route`, so there is no
  // operation to hold it to and it is not one.
  it("skips a line with no route", () => {
    expect(
      parseRequestLines(
        logLine({ method: "GET", path: "/nothing-here", status: 404 }),
      ),
    ).toEqual([]);
  });

  it("resolves a catch-all mount to the operation its path names", () => {
    const report = reportStatuses(
      parseRequestLines(
        logLine({
          method: "POST",
          path: "/auth/oauth2/register",
          route: "/auth/*",
          status: 400,
        }),
      ),
      {
        paths: {
          "/auth/oauth2/register": {
            post: { responses: { "201": { description: "" } } },
          },
        },
      },
    );

    expect(report.undeclared).toEqual([
      {
        operation: "POST /auth/oauth2/register",
        status: 400,
        codes: [],
        declared: [201],
      },
    ]);
  });

  it("reads the declared statuses off the document's operations only", () => {
    const declared = declaredStatuses(documentDeclaring([200, 404]));
    expect([...declared.keys()]).toEqual(["GET /items/{id}"]);
    expect([...(declared.get("GET /items/{id}") ?? [])]).toEqual([200, 404]);
  });

  it("prints the observed table with the codes beside each status", () => {
    const report = reportStatuses(
      parseRequestLines([OBSERVED_200, OBSERVED_403].join("\n")),
      documentDeclaring([200, 403]),
    );

    expect(formatObserved(report)).toBe(
      "GET /items/{id}  ->  200  403 (type_not_permitted)",
    );
  });
});
