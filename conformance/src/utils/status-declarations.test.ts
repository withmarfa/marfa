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

  it("reports a declared status no request drew, less the harness's own", () => {
    const report = reportStatuses(
      parseRequestLines(OBSERVED_200),
      documentDeclaring([200, 404, 413, 429]),
    );

    expect(report.unanswered).toEqual(["GET /items/{id} 404"]);
    expect(unreachedDebt(report, {})).toEqual({
      unlisted: ["GET /items/{id} 404"],
      stale: [],
    });
    expect(
      unreachedDebt(report, {
        "GET /items/{id} 404": "why",
        "GET /items/{id} 200": "drawn after all",
      }),
    ).toEqual({ unlisted: [], stale: ["GET /items/{id} 200"] });
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

  it("neither requires nor holds stale a status only a race draws", () => {
    const document = {
      paths: {
        "/items/{id}": {
          delete: { responses: { "200": {}, "409": {} } },
        },
      },
    };
    const report = reportStatuses(
      parseRequestLines(
        logLine({
          method: "DELETE",
          path: "/items/x",
          route: "/items/{id}",
          status: 200,
        }),
      ),
      document,
    );
    expect(report.unanswered).toEqual([]);
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
    const server = createServer((_req, res) => {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(documentDeclaring(statuses)));
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
    } finally {
      server.close();
      for (const state of states)
        rmSync(state, { recursive: true, force: true });
    }
  });
});
