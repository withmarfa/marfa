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
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  declaredStatuses,
  formatObserved,
  formatUndeclared,
  parseRequestLines,
  reportStatuses,
  SIGN_IN_ROUTE_STATUSES,
  UNPUBLISHED_ROUTES,
  unreachedDebt,
} from "./status-declarations.js";
import { FRESH_SERVER_LOGS } from "./fresh-server.js";

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

/** The same door, each status declaring the refusal codes given. */
function documentRefusing(byStatus: Record<number, string[]>) {
  return {
    paths: {
      "/items/{id}": {
        get: {
          responses: Object.fromEntries(
            Object.entries(byStatus).map(([status, codes]) => [
              status,
              codes.length === 0
                ? { description: "" }
                : {
                    description: "",
                    content: {
                      "application/json": {
                        schema: {
                          type: "object",
                          properties: {
                            error: {
                              type: "object",
                              properties: {
                                code: { type: "string", enum: codes },
                              },
                            },
                          },
                        },
                      },
                    },
                  },
            ]),
          ),
        },
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

  it("catches a code a declared status answered and does not list, and passes once it lists it", () => {
    const log = parseRequestLines([OBSERVED_200, OBSERVED_403].join("\n"));
    const missing = reportStatuses(
      log,
      documentRefusing({ 200: [], 403: ["forbidden"] }),
    );
    expect(missing.undeclared).toEqual([]);
    expect(missing.undeclaredCodes).toEqual([
      "GET /items/{id} 403 type_not_permitted",
    ]);

    const listed = reportStatuses(
      log,
      documentRefusing({ 200: [], 403: ["forbidden", "type_not_permitted"] }),
    );
    expect(listed.undeclaredCodes).toEqual([]);
  });

  it("reads a refusal code from an error described beside its schema", () => {
    const log = parseRequestLines(OBSERVED_403);
    const document = {
      components: {
        schemas: {
          ForbiddenError: {
            type: "object",
            properties: {
              code: { type: "string", enum: ["type_not_permitted"] },
            },
          },
        },
      },
      paths: {
        "/items/{id}": {
          get: {
            responses: {
              "403": {
                description: "",
                content: {
                  "application/json": {
                    schema: {
                      anyOf: [
                        {
                          type: "object",
                          properties: {
                            error: {
                              allOf: [
                                { $ref: "#/components/schemas/ForbiddenError" },
                                { description: "What went wrong." },
                              ],
                            },
                          },
                        },
                        {
                          type: "object",
                          properties: {
                            error: {
                              type: "object",
                              properties: {
                                code: { type: "string", enum: ["forbidden"] },
                              },
                            },
                          },
                        },
                      ],
                    },
                  },
                },
              },
            },
          },
        },
      },
    };
    expect(reportStatuses(log, document).undeclaredCodes).toEqual([]);
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

  it("counts a served route the document does not publish, and reports one with no reason", () => {
    const report = reportStatuses(
      parseRequestLines(
        [
          logLine({
            method: "GET",
            path: "/health",
            route: "/health",
            status: 200,
          }),
          logLine({
            method: "GET",
            path: "/unlisted",
            route: "/unlisted",
            status: 200,
          }),
        ].join("\n"),
      ),
      documentDeclaring([200]),
    );

    expect(report.undeclared).toEqual([]);
    expect([...report.unpublished.keys()].sort()).toEqual([
      "GET /health",
      "GET /unlisted",
    ]);
    expect(report.unexplained).toEqual(["GET /unlisted"]);
  });

  it("counts a published owner refusal reached through local authority", () => {
    const report = reportStatuses(
      parseRequestLines(
        logLine({
          method: "GET",
          path: "/owner",
          route: "/owner",
          status: 404,
          transport: "local_socket",
          error_code: "owner_not_found",
        }),
      ),
      {
        paths: {
          "/owner": {
            get: { responses: { "404": { description: "Owner not found" } } },
          },
        },
      },
    );
    expect(report.observed.get("GET /owner")?.get(404)).toEqual(
      new Set(["owner_not_found"]),
    );
    expect(report.unanswered).not.toContain("GET /owner 404");
    expect(report.local.size).toBe(0);
  });

  it("validates local published statuses and refusal codes against their declarations", () => {
    const lines = parseRequestLines(
      [
        logLine({
          method: "GET",
          path: "/items/x",
          route: "/items/{id}",
          status: 403,
          error_code: "unexpected_refusal",
          transport: "local_socket",
        }),
        logLine({
          method: "GET",
          path: "/items/x",
          route: "/items/{id}",
          status: 418,
          transport: "local_socket",
        }),
      ].join("\n"),
    );
    const report = reportStatuses(
      lines,
      documentRefusing({ 403: ["type_not_permitted"] }),
    );
    expect(report.undeclared).toEqual([
      { operation: "GET /items/{id}", status: 418, codes: [], declared: [403] },
    ]);
    expect(report.undeclaredCodes).toEqual([
      "GET /items/{id} 403 unexpected_refusal",
    ]);
  });

  it("does not exempt an unexplained local route outside the private control namespace", () => {
    const report = reportStatuses(
      parseRequestLines(
        logLine({
          method: "GET",
          path: "/unlisted",
          route: "/unlisted",
          status: 200,
          transport: "local_socket",
        }),
      ),
      documentDeclaring([200]),
    );
    expect(report.unexplained).toEqual(["GET /unlisted"]);
  });

  it("separates real startup socket log shapes from public HTTP operations", () => {
    const local = [
      logLine({
        method: "GET",
        path: "/_control/setup/status",
        route: "/_control/setup/status",
        status: 200,
        transport: "local_socket",
      }),
      logLine({
        method: "POST",
        path: "/_control/setup/claim",
        route: "/_control/setup/claim",
        status: 201,
        transport: "local_socket",
      }),
      logLine({
        method: "POST",
        path: "/keys",
        route: "/keys",
        status: 201,
        transport: "local_socket",
      }),
      logLine({
        method: "POST",
        path: "/_control/setup/claim",
        route: "/_control/setup/claim",
        status: 409,
        error_code: "owner_exists",
        transport: "local_socket",
      }),
    ];
    const report = reportStatuses(
      parseRequestLines([...local, OBSERVED_200].join("\n")),
      {
        paths: {
          ...documentDeclaring([200]).paths,
          "/keys": {
            post: { responses: { "201": { description: "Key created" } } },
          },
        },
      },
    );
    expect(
      [...report.local].map(([operation, statuses]) => [
        operation,
        [...statuses],
      ]),
    ).toEqual([
      ["GET /_control/setup/status", [200]],
      ["POST /_control/setup/claim", [201, 409]],
    ]);
    expect([...report.observed.keys()]).toEqual([
      "POST /keys",
      "GET /items/{id}",
    ]);
    expect(report.unpublished.size).toBe(0);
    expect(report.unexplained).toEqual([]);
    expect(report.lines).toBe(5);
  });

  it.each([undefined, "http", "unrecognized"])(
    "does not exempt control paths without explicit local transport (%s)",
    (transport) => {
      const report = reportStatuses(
        parseRequestLines(
          logLine({
            method: "POST",
            path: "/_control/setup/claim",
            route: "/_control/setup/claim",
            status: 201,
            transport,
          }),
        ),
        documentDeclaring([200]),
      );
      expect(report.local.size).toBe(0);
      expect(report.unexplained).toEqual(["POST /_control/setup/claim"]);
    },
  );

  it("does not exempt an arbitrary unknown path or a published operation's 404", () => {
    const report = reportStatuses(
      parseRequestLines(
        [
          logLine({
            method: "GET",
            path: "/unlisted",
            route: "/unlisted",
            status: 404,
          }),
          logLine({
            method: "GET",
            path: "/items/x",
            route: "/items/{id}",
            status: 404,
          }),
        ].join("\n"),
      ),
      documentDeclaring([200]),
    );
    expect(report.local.size).toBe(0);
    expect(report.unexplained).toEqual(["GET /unlisted"]);
    expect(report.undeclared).toMatchObject([
      { operation: "GET /items/{id}", status: 404 },
    ]);
  });

  it("holds a HEAD answer to its GET operation's declarations", () => {
    const report = reportStatuses(
      parseRequestLines(
        logLine({
          method: "HEAD",
          path: "/items/x",
          route: "/items/{id}",
          status: 418,
        }),
      ),
      documentDeclaring([200, 404]),
    );

    expect(report.unpublished.size).toBe(0);
    expect(report.undeclared).toEqual([
      {
        operation: "GET /items/{id}",
        status: 418,
        codes: [],
        declared: [200, 404],
      },
    ]);
  });

  it("reports a declared status no request drew, less the harness's own codes", () => {
    const document = documentRefusing({
      200: [],
      404: ["item_not_found"],
      413: ["request_too_large"],
      429: ["rate_limited"],
      503: ["write_contention", "stream_capacity_exhausted"],
    });
    const report = reportStatuses(parseRequestLines(OBSERVED_200), document);

    // The 503 also declares a door's own code, so it is not the harness's.
    expect(report.unanswered).toEqual([
      "GET /items/{id} 404",
      "GET /items/{id} 503",
    ]);
    expect(unreachedDebt(report, {}).unlisted).toEqual(report.unanswered);
    expect(
      unreachedDebt(report, {
        "GET /items/{id} 404": "why",
        "GET /items/{id} 503": "why",
        "GET /items/{id} 200": "drawn after all",
      }),
    ).toMatchObject({
      unlisted: [],
      stale: expect.arrayContaining(["GET /items/{id} 200"]),
    });
  });

  it("names an exempt code the document no longer declares", () => {
    const report = reportStatuses(
      parseRequestLines(OBSERVED_200),
      documentRefusing({ 200: [], 413: ["request_too_large"] }),
    );
    expect(report.staleCodes).toEqual([
      "housekeeping_job_running",
      "idempotency_key_in_flight",
      "insufficient_storage",
      "internal_error",
      "rate_limited",
      "write_contention",
    ]);
    expect(unreachedDebt(report, {}).stale).toContain("code rate_limited");
  });

  it("reads the request lines out of a log that carries everything else too", () => {
    const lines = parseRequestLines(
      [
        "Listening on http://127.0.0.1:0",
        JSON.stringify({ level: "info", message: "setup code" }),
        "{ not json",
        "",
        OBSERVED_200,
      ].join("\n"),
    );

    expect(lines).toEqual([
      {
        method: "GET",
        transport: "http",
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

  it("neither requires nor holds stale a status only a race draws", () => {
    const race = reportStatuses(
      parseRequestLines(OBSERVED_200),
      documentRefusing({ 200: [], 409: ["idempotency_key_in_flight"] }),
    );
    expect(race.unanswered).toEqual([]);

    // A door's own code beside the race's is still held to a fixture.
    const mixed = reportStatuses(
      parseRequestLines(OBSERVED_200),
      documentRefusing({
        200: [],
        409: ["idempotency_key_in_flight", "version_conflict"],
      }),
    );
    expect(mixed.unanswered).toEqual(["GET /items/{id} 409"]);
  });

  it("holds a HEAD answer to a HEAD operation when the document declares one", () => {
    const report = reportStatuses(
      parseRequestLines(
        logLine({
          method: "HEAD",
          path: "/items/x",
          route: "/items/{id}",
          status: 404,
        }),
      ),
      {
        paths: {
          "/items/{id}": {
            get: { responses: { "200": {}, "404": {} } },
            head: { responses: { "200": {} } },
          },
        },
      },
    );
    expect(report.undeclared).toEqual([
      {
        operation: "HEAD /items/{id}",
        status: 404,
        codes: [],
        declared: [200],
      },
    ]);
  });

  it("exits end to end on each thing it refuses, and 0 on a clean run", async () => {
    // The script is the shell CI runs, so its exit paths are what a red
    // check rests on. Driven against hand-written logs and a server that
    // serves only the document.
    const script = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      "scripts",
      "check-statuses.ts",
    );
    const tsx = resolve(script, "..", "..", "node_modules", ".bin", "tsx");
    let statuses = [200, 401, 403];
    let refusing: Record<number, string[]> | undefined;
    const server = createServer((_req, res) => {
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify(
          refusing === undefined
            ? documentDeclaring(statuses)
            : documentRefusing(refusing),
        ),
      );
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const address = server.address();
    const url = `http://127.0.0.1:${String(typeof address === "object" && address ? address.port : 0)}`;
    const states: string[] = [];
    const stateWith = (main: string[], fresh: string[] = []) => {
      const state = mkdtempSync(join(tmpdir(), "check-statuses-"));
      states.push(state);
      writeFileSync(join(state, "server.log"), main.join("\n"));
      if (fresh.length > 0) {
        mkdirSync(join(state, FRESH_SERVER_LOGS));
        writeFileSync(
          join(state, FRESH_SERVER_LOGS, "fixture.log"),
          fresh.join("\n"),
        );
      }
      return state;
    };
    const run = (state: string, ...extra: string[]) =>
      new Promise<{ status: number | null; stderr: string }>((done) => {
        const child = spawn(tsx, [
          script,
          "--state",
          state,
          "--url",
          url,
          ...extra,
        ]);
        let stderr = "";
        child.stderr.on("data", (chunk: Buffer) => {
          stderr += chunk.toString();
        });
        child.on("close", (status) => done({ status, stderr }));
      });
    const UNLISTED_ROUTE = logLine({
      method: "GET",
      path: "/unlisted",
      route: "/unlisted",
      status: 200,
    });
    try {
      const clean = await run(stateWith([OBSERVED_200, OBSERVED_403]));
      expect(clean.stderr).toBe("");
      expect(clean.status).toBe(0);

      const controlRequest = (transport: "http" | "local_socket") =>
        logLine({
          method: "POST",
          path: "/_control/setup/claim",
          route: "/_control/setup/claim",
          status: 201,
          transport,
        });
      const privateRun = await run(
        stateWith([OBSERVED_200, controlRequest("local_socket")]),
      );
      expect(privateRun.stderr).toBe("");
      expect(privateRun.status).toBe(0);
      const exposed = await run(
        stateWith([OBSERVED_200, controlRequest("http")]),
      );
      expect(exposed.stderr).toContain("POST /_control/setup/claim");
      expect(exposed.status).toBe(1);

      statuses = [200, 401];
      const undeclared = await run(stateWith([OBSERVED_200, OBSERVED_403]));
      expect(undeclared.stderr).toContain("GET /items/{id} answered 403");
      expect(undeclared.status).toBe(1);

      const inFresh = await run(stateWith([OBSERVED_200], [OBSERVED_403]));
      expect(inFresh.stderr).toContain("GET /items/{id} answered 403");
      expect(inFresh.status).toBe(1);

      statuses = [200, 401, 403];
      const unlisted = await run(stateWith([OBSERVED_200, UNLISTED_ROUTE]));
      expect(unlisted.stderr).toContain("GET /unlisted");
      expect(unlisted.status).toBe(1);

      const undrawn = await run(stateWith([OBSERVED_200]), "--complete");
      expect(undrawn.stderr).toContain("GET /items/{id} 403");
      expect(undrawn.status).toBe(1);

      refusing = { 200: [], 403: ["forbidden"] };
      const unlistedCode = await run(stateWith([OBSERVED_200, OBSERVED_403]));
      expect(unlistedCode.stderr).toContain(
        "GET /items/{id} 403 type_not_permitted",
      );
      expect(unlistedCode.status).toBe(1);

      refusing = { 200: [], 403: ["forbidden", "type_not_permitted"] };
      const listedCode = await run(stateWith([OBSERVED_200, OBSERVED_403]));
      expect(listedCode.stderr).toBe("");
      expect(listedCode.status).toBe(0);
    } finally {
      server.close();
      for (const state of states)
        rmSync(state, { recursive: true, force: true });
    }
  });
});

describe("the sign-in routes", () => {
  const tokenLine = (status: number, path = "/auth/oauth2/token") =>
    logLine({ method: "POST", path, route: "/auth/*", status });

  it("hold a route the sign-in library serves under its pattern to the statuses declared for it", () => {
    const caught = reportStatuses(
      parseRequestLines([tokenLine(400), tokenLine(418)].join("\n")),
      documentDeclaring([200]),
    );
    expect(caught.undeclared).toEqual([
      {
        operation: "POST /auth/oauth2/token",
        status: 418,
        codes: [],
        declared: [...SIGN_IN_ROUTE_STATUSES["POST /auth/oauth2/token"]!],
      },
    ]);
    expect(caught.unexplained).toEqual([]);

    // The witness: a declared status passes, and so do the limiter's and the
    // write lock's, which no route answers on its own account.
    const passed = reportStatuses(
      parseRequestLines(
        [tokenLine(400), tokenLine(429), tokenLine(503)].join("\n"),
      ),
      documentDeclaring([200]),
    );
    expect(passed.undeclared).toEqual([]);
  });

  it("count no door for a path the catch-all refuses, and still hold a served one", () => {
    const refused = (path: string) =>
      logLine({
        method: "POST",
        path,
        route: "/auth/*",
        status: 404,
        error_code: "not_found",
      });
    const report = reportStatuses(
      parseRequestLines(
        [
          refused("/auth/verify-password"),
          refused("/auth/not-a-route/"),
          // A served route spelled with a percent-escape, logged decoded.
          refused("/auth/change-password"),
          // The witness: a served route under the pattern is still held.
          tokenLine(418),
        ].join("\n"),
      ),
      documentDeclaring([200]),
    );
    expect([...report.unpublished.keys()]).toEqual(["POST /auth/oauth2/token"]);
    expect(report.unexplained).toEqual([]);
    expect(report.undeclared.map((u) => u.operation)).toEqual([
      "POST /auth/oauth2/token",
    ]);
  });

  it("hold a sign-in route the server serves itself to its declared statuses", () => {
    const report = reportStatuses(
      parseRequestLines(
        logLine({
          method: "GET",
          path: "/auth/grants",
          route: "/auth/grants",
          status: 418,
        }),
      ),
      documentDeclaring([200]),
    );
    expect(
      report.undeclared.map((u) => `${u.operation} ${String(u.status)}`),
    ).toEqual(["GET /auth/grants 418"]);
  });

  it("report a route under the library's pattern that nothing names", () => {
    const report = reportStatuses(
      parseRequestLines(
        [
          tokenLine(200, "/auth/not-a-route"),
          tokenLine(404, "/auth/bare"),
        ].join("\n"),
      ),
      documentDeclaring([200]),
    );
    expect(report.unexplained).toEqual([
      "POST /auth/bare",
      "POST /auth/not-a-route",
    ]);
  });

  it("resolve the published registration operation under the pattern by its path", () => {
    const report = reportStatuses(
      parseRequestLines(tokenLine(201, "/auth/oauth2/register")),
      {
        paths: {
          "/auth/oauth2/register": {
            post: { responses: { "201": { description: "Registered" } } },
          },
        },
      },
    );
    expect(report.observed.get("POST /auth/oauth2/register")?.has(201)).toBe(
      true,
    );
    expect(report.unpublished.size).toBe(0);
  });

  it("are each named with why, and every unpublished sign-in route declares its statuses", () => {
    for (const route of Object.keys(SIGN_IN_ROUTE_STATUSES)) {
      expect(UNPUBLISHED_ROUTES[route], route).toBeDefined();
    }
    const signInRoutes = Object.keys(UNPUBLISHED_ROUTES).filter((route) =>
      / \/(?:auth|\.well-known)\//.test(route),
    );
    for (const route of signInRoutes) {
      expect(SIGN_IN_ROUTE_STATUSES[route], route).toBeDefined();
    }
  });
});
