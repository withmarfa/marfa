import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pageLinks, visibleText } from "../pages/reading.js";
import type { Connector, ConnectorRun } from "../storage/interface.js";
import {
  createTestContext,
  request,
  type TestContext,
  cleanupTestContext,
} from "../test-utils.js";
import { connectorStatus, SILENT_AFTER_MS } from "./connector-status.js";

const HOUR = 60 * 60 * 1000;
const NOW = Date.parse("2026-10-20T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();

function run(outcome: ConnectorRun["outcome"]): ConnectorRun {
  return {
    id: "01a0c000-0000-7000-8000-000000000003",
    connector_id: "01a0c000-0000-7000-8000-000000000001",
    outcome,
    started_at: ago(HOUR),
    finished_at: ago(HOUR),
    summary: null,
    error: null,
    reported_at: ago(HOUR),
  };
}

function connector(overrides: Partial<Connector> = {}): Connector {
  return {
    id: "01a0c000-0000-7000-8000-000000000001",
    key_id: "01a0c000-0000-7000-8000-000000000002",
    source: "mail-reader",
    name: "mail reader",
    description: null,
    problems: {},
    read_only_types: [],
    last_heartbeat_at: ago(HOUR),
    last_run: null,
    registered_at: ago(10 * HOUR),
    updated_at: ago(HOUR),
    hold_expires_at: null,
    ...overrides,
  };
}

describe("what the console says about a connector", () => {
  it("puts a failed run before problems, problems before silence, and silence before running", () => {
    const old = ago(SILENT_AFTER_MS + HOUR);
    const quiet = { last_heartbeat_at: old, registered_at: old };
    const problems = { problems: { auth: "expired" } };
    const failed = { last_run: run("failed") };
    const state = (overrides: Partial<Connector>) =>
      connectorStatus(connector(overrides), NOW).state;
    // Witness: a connector with none of these is running.
    expect(state({})).toBe("running");
    expect(state(quiet)).toBe("silent");
    expect(state({ ...quiet, ...problems })).toBe("problems");
    expect(state({ ...quiet, ...problems, ...failed })).toBe("failing");
  });

  it("counts a run report or a registration as hearing from the connector", () => {
    const old = ago(SILENT_AFTER_MS + HOUR);
    const base = { last_heartbeat_at: null, registered_at: old };
    expect(connectorStatus(connector(base), NOW).state).toBe("silent");
    expect(
      connectorStatus(connector({ ...base, registered_at: ago(HOUR) }), NOW)
        .state,
    ).toBe("running");
    expect(
      connectorStatus(connector({ ...base, last_run: run("succeeded") }), NOW)
        .state,
    ).toBe("running");
  });
});

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => {
  await cleanupTestContext(ctx);
});

const BROWSER = { accept: "text/html,application/xhtml+xml" };
const page = (path: string) =>
  ctx.app.request(path, {
    headers: { ...BROWSER, cookie: ctx.owner.cookie },
  });

describe("the connectors pages", () => {
  it("shows an empty list, then a failing connector in the list, on its own page and on Home", async () => {
    const empty = visibleText(
      await (await page("/auth/owner/connectors")).text(),
    );
    expect(empty).toContain("No connectors");

    const made = await request(ctx.app, "POST", "/connectors", {
      key: ctx.workingKey,
      body: { name: "mail reader", description: "Reads a mailbox." },
    });
    expect(made.status).toBe(201);
    const { id } = (await made.json()) as Connector;
    const run = await request(ctx.app, "POST", `/connectors/${id}/runs`, {
      key: ctx.workingKey,
      body: {
        outcome: "failed",
        started_at: new Date(Date.now() - 2000).toISOString(),
        finished_at: new Date(Date.now() - 1000).toISOString(),
        error: "The mailbox refused the sign-in.",
      },
    });
    expect(run.status).toBe(201);

    const listHtml = await (await page("/auth/owner/connectors")).text();
    const list = visibleText(listHtml);
    expect(list).toContain("mail reader");
    expect(list).toContain("Failing");
    expect(pageLinks(listHtml).map((link) => link.href)).toContain(
      `/auth/owner/connectors/${id}`,
    );

    const detail = visibleText(
      await (await page(`/auth/owner/connectors/${id}`)).text(),
    );
    expect(detail).toContain("The last run failed");
    expect(detail).toContain("The mailbox refused the sign-in.");

    const home = visibleText(await (await page("/")).text());
    expect(home).toContain("Needs attention");
    expect(home).toContain("mail reader failed its last run");
  });

  it("answers a connector that is not there with a page that says so, and refuses an undeclared key", async () => {
    const missing = await page(
      "/auth/owner/connectors/01a0c000-0000-7000-8000-000000000000",
    );
    expect(missing.status).toBe(404);
    expect(missing.headers.get("content-type")).toContain("text/html");
    const extra = await page("/auth/owner/connectors?nope=1");
    expect(extra.status).toBe(400);
  });
});
