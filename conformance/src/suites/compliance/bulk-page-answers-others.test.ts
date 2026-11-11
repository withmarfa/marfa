import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  stopFreshServers,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { issuerOrigin } from "../../utils/signed-in.js";
import { TEST_OWNER } from "../../utils/target.js";

/**
 * Other requests during a long bulk page.
 *
 * **How a fixture knows the page is part way.** `hold:bulk-page=2` stops the
 * page at its second entry, so the first is done and the page has not yet
 * answered: the page is in flight for as long as the fixture says. An atomic
 * page holds its first entry uncommitted, and a page under `atomic: false`
 * has committed it.
 *
 * **Its own server**, because one test sets the write wait and because the
 * limiter is on here: counting a request is a write, so a read that had to
 * wait for the page to be counted would wait for it. The budget is short
 * enough that a held page outlasts it many times over. The caps are far above
 * what the fixtures send.
 */
const BUDGET_MS = 300;
const PAGE = 20;
const SCHEDULER_NEVER_POLLS_MS = "3600000";

let server: FreshServer;

beforeAll(async () => {
  server = await bootFreshServer("bulk-page-answers-others", {
    MARFA_TEST_TUNING: `write_wait_ms=${String(BUDGET_MS)},housekeeping_poll_ms=${SCHEDULER_NEVER_POLLS_MS}`,
    MARFA_RATE_LIMIT_ENABLED: "true",
    MARFA_RATE_LIMIT_REQUESTS: "1000000",
    MARFA_RATE_LIMIT_KEYS_REQUESTS: "1000",
  });
}, 2 * FRESH_SERVER_TIMEOUT_MS);

afterAll(stopFreshServers, 2 * FRESH_SERVER_TIMEOUT_MS);

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

/** Starts a page held at its second entry, once the server holds it there. */
async function heldPage(request: () => Promise<Response>) {
  await server.setFault("hold:bulk-page=2");
  const page = track(request());
  await server.waitForHold("hold:bulk-page");
  expect(page.state.answered, "the page ended before it was seen").toBe(false);
  return page;
}

/** Lets the held page go and returns its answer. */
async function release(page: { response: Promise<Response> }) {
  await server.clearFault("hold:bulk-page");
  return page.response;
}

afterEach(async () => {
  await server.clearFault();
});

describe("a bulk page leaves the server answering other requests", () => {
  it("answers a read of an item an atomic items page is updating, with the item as it was", async () => {
    const ids = await seed("atomic-read");
    const page = await heldPage(() =>
      send("POST", "/items/bulk", notes("atomic-read", "after", true)),
    );

    expect(await bodyOf(ids[0]!)).toBe("before");
    expect(page.state.answered).toBe(false);

    expect((await release(page)).status).toBe(200);
    expect(await bodyOf(ids[0]!)).toBe("after");
  }, 120_000);

  it("answers a read in the middle of an items page under atomic: false", async () => {
    const ids = await seed("partial-read");
    const page = await heldPage(() =>
      send("POST", "/items/bulk", notes("partial-read", "after", false)),
    );

    // The first entry is written and the last is not: answered mid-page.
    expect(await bodyOf(ids[0]!)).toBe("after");
    expect(await bodyOf(ids[PAGE - 1]!)).toBe("before");
    expect(page.state.answered).toBe(false);

    expect((await release(page)).status).toBe(200);
    expect(await bodyOf(ids[PAGE - 1]!)).toBe("after");
  }, 120_000);

  it("answers a read while an atomic edges page is written", async () => {
    const [hub, ...targets] = await seed("edges-read");
    const page = await heldPage(() =>
      send("POST", "/edges/bulk", {
        atomic: true,
        edges: targets.map((target) => ({
          source_id: hub!,
          target_id: target,
          edge_type: "about",
        })),
      }),
    );

    expect(await bodyOf(hub!)).toBe("before");
    expect(page.state.answered).toBe(false);

    const answered = await release(page);
    expect(answered.status).toBe(200);
    const { counts } = (await answered.json()) as {
      counts: { created: number };
    };
    expect(counts.created).toBe(PAGE - 1);
  }, 120_000);
});

describe("a write that waits behind a bulk page", () => {
  it("lands after an atomic page that holds the lock longer than the write wait", async () => {
    await seed("waiting-write");
    const page = await heldPage(() =>
      send("POST", "/items/bulk", notes("waiting-write", "after", true)),
    );

    const single = track(
      send("POST", "/items", {
        type: "core.note",
        properties: { title: "behind the page", body: "waited" },
      }),
    );
    // Held for twice the budget and not refused: the write waits on the
    // page and is not given up on the budget alone.
    await new Promise((resolve) => setTimeout(resolve, 2 * BUDGET_MS));
    expect(single.state.answered).toBe(false);

    expect((await release(page)).status).toBe(200);
    expect((await single.response).status).toBe(201);
  }, 120_000);

  it("counts a sign-in attempt after an atomic page that holds the lock longer than the write wait", async () => {
    // A password attempt is counted before the password is checked, in a
    // write of its own outside any transaction.
    const origin = await issuerOrigin(server);
    await seed("waiting-sign-in");
    const page = await heldPage(() =>
      send("POST", "/items/bulk", notes("waiting-sign-in", "after", true)),
    );

    const attempt = track(
      fetch(`${server.apiUrl}/auth/sign-in`, {
        method: "POST",
        headers: { "content-type": "application/json", origin },
        body: JSON.stringify({
          email: TEST_OWNER.email,
          password: "not the owner's password",
        }),
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 2 * BUDGET_MS));
    expect(attempt.state.answered).toBe(false);

    expect((await release(page)).status).toBe(200);
    expect((await attempt.response).status).toBe(401);
  }, 120_000);

  it("is still refused 503 write_contention behind a lock held for longer than the budget", async () => {
    await server.setFault("refuse:write-lock");
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
  }, 120_000);
});
