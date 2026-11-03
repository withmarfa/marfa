import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  stopFreshServers,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { HeldLock } from "../../utils/held-lock.js";

/**
 * Other requests during a long bulk page.
 *
 * **How a fixture knows the page is part way.** An atomic page holds the
 * write lock from its first entry to its commit, so a second connection that
 * is refused the lock from outside the process, while the page has not yet
 * answered, is the page in flight. A page under `atomic: false` commits each
 * entry on its own, so a read that finds its first entry written and its last
 * not is a read the server answered in the middle of it.
 *
 * **Its own server**, because a page of thousands of entries would slow every
 * fixture sharing the run's server, because one test sets the busy budget,
 * and because the limiter is on here: counting a request is a write, so a
 * read that had to wait for the lock to be counted would wait for the page.
 * The budget is short enough that the page outlasts it many times over, and
 * long enough that no single entry does. The caps are far above what the
 * fixtures send.
 */
const BUDGET_MS = 300;
const PAGE = 3_000;
const SCHEDULER_NEVER_POLLS_MS = "2147483647";

let server: FreshServer;

beforeAll(async () => {
  server = await bootFreshServer("bulk-page-answers-others", {
    SQLITE_BUSY_BUDGET_MS: String(BUDGET_MS),
    MARFA_HOUSEKEEPING_POLL_INTERVAL_MS: SCHEDULER_NEVER_POLLS_MS,
    RATE_LIMIT_ENABLED: "true",
    RATE_LIMIT_REQUESTS: "1000000",
    RATE_LIMIT_KEYS_REQUESTS: "1000",
  });
}, 2 * FRESH_SERVER_TIMEOUT_MS);

afterAll(stopFreshServers, 2 * FRESH_SERVER_TIMEOUT_MS);

const runSqlite = promisify(execFile);

/** Whether a connection from outside the server is refused the write lock now. */
async function lockIsHeld(): Promise<boolean> {
  try {
    await runSqlite(
      "sqlite3",
      ["-bail", "-cmd", ".timeout 0", server.sqlitePath, "BEGIN IMMEDIATE;"],
      { timeout: 10_000 },
    );
    return false;
  } catch (error) {
    if (String((error as { stderr?: unknown }).stderr).includes("locked"))
      return true;
    throw error;
  }
}

function send(method: string, path: string, body?: unknown) {
  return fetch(`${server.apiUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${server.workingKey}`,
      ...(body !== undefined && { "Content-Type": "application/json" }),
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
}

function notes(tag: string, body: string, atomic: boolean) {
  return {
    mode: "upsert",
    atomic,
    items: Array.from({ length: PAGE }, (_, i) => ({
      type: "core.note",
      source_id: `${tag}-${String(i)}`,
      properties: { title: `${tag} ${String(i)}`, body },
    })),
  };
}

/** Writes a page of notes and returns their ids, in entry order. */
async function seed(tag: string): Promise<string[]> {
  const response = await send(
    "POST",
    "/items/bulk",
    notes(tag, "before", true),
  );
  expect(response.status).toBe(200);
  const { results } = (await response.json()) as {
    results: { id: string; outcome: string }[];
  };
  expect(results.every(({ outcome }) => outcome === "created")).toBe(true);
  return results.map(({ id }) => id);
}

async function bodyOf(id: string): Promise<string> {
  const response = await send("GET", `/items/${id}`);
  expect(response.status).toBe(200);
  return ((await response.json()) as { item: { properties: { body: string } } })
    .item.properties.body;
}

/** Starts `request` and reports whether it has been answered yet. */
function track(request: Promise<Response>) {
  const state = { answered: false };
  const response = request.then((answer) => {
    state.answered = true;
    return answer;
  });
  return { response, state };
}

async function untilLockHeld(page: { state: { answered: boolean } }) {
  while (!(await lockIsHeld())) {
    expect(page.state.answered, "the page ended before it was seen").toBe(
      false,
    );
  }
}

describe("a bulk page leaves the server answering other requests", () => {
  it("answers a read of an item an atomic items page is updating, with the item as it was", async () => {
    const ids = await seed("atomic-read");
    const page = track(
      send("POST", "/items/bulk", notes("atomic-read", "after", true)),
    );
    await untilLockHeld(page);

    expect(await bodyOf(ids[0]!)).toBe("before");
    expect(page.state.answered).toBe(false);
    expect(await lockIsHeld()).toBe(true);

    expect((await page.response).status).toBe(200);
    expect(await bodyOf(ids[0]!)).toBe("after");
  }, 120_000);

  it("answers a read in the middle of an items page under atomic: false", async () => {
    const ids = await seed("partial-read");
    const page = track(
      send("POST", "/items/bulk", notes("partial-read", "after", false)),
    );
    while ((await bodyOf(ids[0]!)) !== "after") {
      expect(page.state.answered, "the page ended before it was seen").toBe(
        false,
      );
    }
    // The first entry is written and the last is not: answered mid-page.
    expect(await bodyOf(ids[PAGE - 1]!)).toBe("before");
    expect(page.state.answered).toBe(false);

    expect((await page.response).status).toBe(200);
    expect(await bodyOf(ids[PAGE - 1]!)).toBe("after");
  }, 120_000);

  it("answers a read while an atomic edges page is written", async () => {
    const [hub, ...targets] = await seed("edges-read");
    const page = track(
      send("POST", "/edges/bulk", {
        atomic: true,
        edges: targets.map((target) => ({
          source_id: hub!,
          target_id: target,
          edge_type: "about",
        })),
      }),
    );
    await untilLockHeld(page);

    expect(await bodyOf(hub!)).toBe("before");
    expect(page.state.answered).toBe(false);

    const answered = await page.response;
    expect(answered.status).toBe(200);
    const { counts } = (await answered.json()) as {
      counts: { created: number };
    };
    expect(counts.created).toBe(PAGE - 1);
  }, 120_000);
});

describe("a write that waits behind a bulk page", () => {
  it("lands after an atomic page that holds the lock longer than the busy budget", async () => {
    await seed("waiting-write");
    const page = track(
      send("POST", "/items/bulk", notes("waiting-write", "after", true)),
    );
    await untilLockHeld(page);
    const started = performance.now();

    const single = await send("POST", "/items", {
      type: "core.note",
      properties: { title: "behind the page", body: "waited" },
    });
    const waitedMs = performance.now() - started;

    expect((await page.response).status).toBe(200);
    expect(single.status).toBe(201);
    // Witness that the page held the lock for longer than the budget, so
    // the write above was not admitted on the budget alone.
    expect(waitedMs).toBeGreaterThan(BUDGET_MS);
  }, 120_000);

  it("is still refused 503 write_contention behind a lock held from outside for longer than the budget", async () => {
    const lock = await HeldLock.take(server.sqlitePath);
    try {
      const refused = await send("POST", "/items", {
        type: "core.note",
        properties: { title: "behind a stalled holder", body: "refused" },
      });
      expect(refused.status).toBe(503);
      const { error } = (await refused.json()) as {
        error: { code: string; details: { budget_ms: number } };
      };
      expect(error.code).toBe("write_contention");
      expect(error.details.budget_ms).toBe(BUDGET_MS);
    } finally {
      await lock.release();
    }
  }, 120_000);
});
