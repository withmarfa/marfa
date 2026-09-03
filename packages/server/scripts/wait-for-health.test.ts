/**
 * The readiness probe's own tests, and the one they exist for is the last
 * case in the file: two different failures must produce two different
 * reports. That is the whole point of the change — the loop previously
 * described a refused connection, a wrong port and a server answering 503
 * with the identical sentence, and a diagnosis that could only be settled
 * by reproducing the run locally is what it cost.
 */
import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import {
  waitForHealth,
  describeAttempt,
  attemptTimeoutMs,
} from "./wait-for-health.js";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (s) =>
        new Promise<void>((resolve) => {
          s.close(() => {
            resolve();
          });
        }),
    ),
  );
});

/** A server answering `status` on every request, on an ephemeral port. */
async function serve(status: number): Promise<string> {
  const server = createServer((_req, res) => {
    res.writeHead(status);
    res.end("{}");
  });
  servers.push(server);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve();
    });
  });
  const addr = server.address();
  if (addr === null || typeof addr === "string") {
    throw new Error("server did not bind a port");
  }
  return `http://127.0.0.1:${String(addr.port)}/health`;
}

/**
 * A port nothing is listening on. Bound and released, so the number is
 * real and free rather than a guess that might collide with a live
 * service and turn a refusal case into a success.
 */
async function closedPort(): Promise<string> {
  const server = createServer();
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve();
    });
  });
  const addr = server.address();
  if (addr === null || typeof addr === "string") {
    throw new Error("server did not bind a port");
  }
  const { port } = addr;
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
  return `http://127.0.0.1:${String(port)}/health`;
}

describe("attemptTimeoutMs", () => {
  it("derives a per-attempt ceiling that leaves room for many attempts", () => {
    // The property, not the number: one hung attempt must not be able to
    // consume the budget. Asserting 3000 directly would pass for a
    // derivation that happens to produce it from the wrong budget.
    expect(attemptTimeoutMs(90_000)).toBe(3_000);
    expect(attemptTimeoutMs(90_000) * 30).toBeLessThanOrEqual(90_000);
    expect(attemptTimeoutMs(30_000) * 30).toBeLessThanOrEqual(30_000);
  });

  it("never returns zero, so a tiny budget still makes one real attempt", () => {
    expect(attemptTimeoutMs(1)).toBeGreaterThan(0);
  });
});

describe("waitForHealth", () => {
  it("succeeds on a 200 and says so", async () => {
    const url = await serve(200);
    const r = await waitForHealth({ url, budgetMs: 5_000 });
    expect(r.ok).toBe(true);
    expect(r.attempts).toBe(1);
  });

  it("reports the status when the endpoint answers and refuses", async () => {
    const url = await serve(503);
    const r = await waitForHealth({ url, budgetMs: 600, pollIntervalMs: 50 });
    expect(r.ok).toBe(false);
    expect(r.lastOutcome).toContain("503");
    expect(r.attempts).toBeGreaterThan(1);
  });

  it("reports the connection error when nothing is listening", async () => {
    const url = await closedPort();
    const r = await waitForHealth({ url, budgetMs: 600, pollIntervalMs: 50 });
    expect(r.ok).toBe(false);
    // The socket-level cause, not the bare "fetch failed" wrapper — that
    // wrapper is identical for every network failure and names nothing.
    expect(r.lastOutcome).toMatch(/ECONNREFUSED|ConnectionRefused|refused/i);
  });

  it("stops early, and says why, when the caller abandons the wait", async () => {
    const url = await closedPort();
    const r = await waitForHealth({
      url,
      budgetMs: 5_000,
      shouldStop: () => "the process exited 1 after its listen line",
    });
    expect(r.ok).toBe(false);
    expect(r.stoppedEarly).toBe(true);
    expect(r.lastOutcome).toContain("exited 1");
    // Nothing was polled, so an early stop cannot be mistaken for a
    // budget expiry in the report.
    expect(r.attempts).toBe(0);
  });

  it("describes a refusal and a non-200 differently", async () => {
    // The case this file exists for. Both failures previously produced
    // `role=X /health never answered 200` and nothing else.
    const refused = await waitForHealth({
      url: await closedPort(),
      budgetMs: 400,
      pollIntervalMs: 50,
    });
    const rejected = await waitForHealth({
      url: await serve(503),
      budgetMs: 400,
      pollIntervalMs: 50,
    });
    expect(refused.ok).toBe(false);
    expect(rejected.ok).toBe(false);
    expect(refused.lastOutcome).not.toBe(rejected.lastOutcome);
  });
});

describe("describeAttempt", () => {
  it("keeps a non-Error rejection readable rather than printing [object Object]", () => {
    expect(describeAttempt({ nope: true })).not.toContain("[object Object]");
    expect(describeAttempt({ nope: true })).toContain("object");
    expect(describeAttempt("plain string")).toBe("plain string");
  });
});
