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

/** A server that answers 200, but only after `delayMs`. */
async function slowServe(delayMs: number): Promise<string> {
  const server = createServer((_req, res) => {
    setTimeout(() => {
      res.writeHead(200);
      res.end("{}");
    }, delayMs);
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
    // Budgets that are not multiples of thirty are where a rounded
    // derivation breaks the guarantee while the round numbers above stay
    // green, so they are the cases worth asserting.
    for (const budget of [90_000, 30_000, 90_050, 4_631, 46]) {
      expect(attemptTimeoutMs(budget) * 30).toBeLessThanOrEqual(budget);
    }
  });

  it("never returns zero, so a tiny budget still makes one real attempt", () => {
    expect(attemptTimeoutMs(1)).toBeGreaterThan(0);
  });
});

describe("waitForHealth", () => {
  it("takes the per-attempt ceiling the caller gives it", async () => {
    // The boot smoke hands this function what is left of a budget it
    // shares with the wait for the listen line, so the derived ceiling
    // narrows as the boot gets slower. A healthy endpoint answering in
    // 400ms fails against the ceiling a 3s remainder derives, and passes
    // against the one the caller configured — same server, same budget.
    const url = await slowServe(400);
    const derived = await waitForHealth({
      url,
      budgetMs: 1_200,
      pollIntervalMs: 50,
    });
    expect(derived.ok).toBe(false);

    const given = await waitForHealth({
      url,
      budgetMs: 1_200,
      attemptTimeoutMs: 1_200,
      pollIntervalMs: 50,
    });
    expect(given.ok).toBe(true);
  });

  it("succeeds on a 200 and says so", async () => {
    const url = await serve(200);
    const r = await waitForHealth({ url, budgetMs: 5_000 });
    expect(r.ok).toBe(true);
    expect(r.attempts).toBe(1);
  });

  it("tells a refusal and a non-200 apart, and names each", async () => {
    // The case this file exists for, and it is one claim rather than two:
    // both failures previously produced `role=X /health never answered 200`
    // and nothing else, so naming each is only half of it — they also have
    // to differ.
    // The budget is derived rather than picked, because one of the
    // assertions below counts attempts against a wall clock. A cycle costs
    // an attempt timeout, which is a thirtieth of the budget, plus a poll
    // interval — so two cycles fit whenever the budget is a little over
    // twice the interval. Forty times it is roughly eighteen times the
    // headroom two attempts need.
    //
    // That headroom is the point. This runs on a shared machine, and a
    // process that is not scheduled reaches its deadline having made one
    // attempt, which reads as "it did not retry" and means "it was not
    // given a turn". At 600ms it read the runner rather than the code and
    // reddened a branch that had not touched this file.
    const POLL_MS = 50;
    const BUDGET_MS = 40 * POLL_MS;
    const rejected = await waitForHealth({
      url: await serve(503),
      budgetMs: BUDGET_MS,
      pollIntervalMs: POLL_MS,
    });
    const refused = await waitForHealth({
      url: await closedPort(),
      budgetMs: BUDGET_MS,
      pollIntervalMs: POLL_MS,
    });
    expect(rejected.ok).toBe(false);
    expect(rejected.lastOutcome).toContain("503");
    expect(rejected.attempts).toBeGreaterThan(1);
    // The socket-level cause, not the bare "fetch failed" wrapper — that
    // wrapper is identical for every network failure and names nothing.
    expect(refused.ok).toBe(false);
    expect(refused.lastOutcome).toMatch(
      /ECONNREFUSED|ConnectionRefused|refused/i,
    );
    expect(refused.lastOutcome).not.toBe(rejected.lastOutcome);
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

  it("reports a stop reason that only becomes true as the budget expires", async () => {
    // The boot smoke's stop reason is the child process exiting, and the
    // exit can land while the final attempt is still in flight. Consulting
    // the reason only at the top of the loop discards it in exactly that
    // case, and the crash is then reported as an endpoint that never
    // answered — the confusion this module exists to remove.
    //
    // Tied to the elapsed budget rather than to a timer, so there is no
    // race to lose: the reason is null for every consultation the loop can
    // make, and true for any consultation after it.
    const url = await closedPort();
    const start = Date.now();
    const r = await waitForHealth({
      url,
      budgetMs: 300,
      pollIntervalMs: 50,
      shouldStop: () =>
        Date.now() - start >= 300
          ? "the process exited 1 after its listen line"
          : null,
    });
    expect(r.ok).toBe(false);
    expect(r.stoppedEarly).toBe(true);
    expect(r.lastOutcome).toContain("exited 1");
  });
});

describe("describeAttempt", () => {
  it("keeps a non-Error rejection readable rather than printing [object Object]", () => {
    expect(describeAttempt({ nope: true })).not.toContain("[object Object]");
    expect(describeAttempt({ nope: true })).toContain("object");
    expect(describeAttempt("plain string")).toBe("plain string");
  });

  it("survives every shape a throw can take", () => {
    // This is the reporting path, so a throw in here would swallow the
    // diagnosis it exists to produce — which is worse than the silence it
    // replaced, because the run then fails for a second reason nobody can
    // see past.
    for (const thrown of [undefined, null, 7, false, Symbol("x"), []]) {
      expect(() => describeAttempt(thrown)).not.toThrow();
      expect(describeAttempt(thrown)).not.toContain("[object Object]");
    }
  });
});
