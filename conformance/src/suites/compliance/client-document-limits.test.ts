import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import {
  authorizeQuery,
  issuerOrigin,
  pkce,
  signIn as ownerCookie,
} from "../../utils/signed-in.js";

/**
 * The limits on fetching a client ID metadata document, and the owner's own
 * share of them. The document's host resolves, by a scripted lookup, to an
 * address that is not public, so a fetch the server makes answers
 * `invalid_client` and one a limit keeps it from making answers
 * `temporarily_unavailable`. The server believes a header naming the
 * caller's address, and each case starts a new minute.
 */
let server: FreshServer;
let origin: string;
let cookie: string;

const CLIENT_HEADER = "x-conformance-client";
const HOST = "app.client-documents.example";
const STALLED = "stalled.client-documents.example";
const MINUTE = 60_000;
let clients = 0;

beforeAll(async () => {
  server = await bootFreshServer("client-document-limits", {
    MARFA_TRUSTED_PROXY_HEADER: CLIENT_HEADER,
    MARFA_TRUSTED_PROXY_CIDRS: "127.0.0.0/8",
    MARFA_RATE_LIMIT_ENABLED: "true",
  });
  origin = await issuerOrigin(server);
  cookie = await ownerCookie(server, origin);
  await server.setFault(`resolve:${HOST}=10.0.0.1`);
}, FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  await server.stop();
}, FRESH_SERVER_TIMEOUT_MS);

beforeEach(async () => {
  await server.advanceClock(MINUTE + 1_000);
});

/** A client ID no copy is kept of. */
function clientId(): string {
  clients++;
  return `https://${HOST}/clients/${String(clients)}.json`;
}

/** How many lookups of the stalled host have begun. */
async function stalls(): Promise<number> {
  const armed = await server.faults();
  return armed.find((fault) => fault.name === `resolve:${STALLED}`)?.fired ?? 0;
}

/** How many lookups of the document's host the server has made. */
async function lookups(): Promise<number> {
  const armed = await server.faults();
  return armed.find((fault) => fault.name === `resolve:${HOST}`)?.fired ?? 0;
}

/** A device code request naming `id`, from `address`, answered by its `error`. */
async function deviceCode(id: string, address: string): Promise<string> {
  const response = await fetch(`${server.apiUrl}/oauth/device-authorization`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      [CLIENT_HEADER]: address,
    },
    body: new URLSearchParams({ client_id: id, scope: "content:read" }),
  });
  expect(response.status).toBe(400);
  return ((await response.json()) as { error: string }).error;
}

/** An authorization request naming `id`, from `address`, as the owner's browser or nobody's. */
function authorizing(
  id: string,
  address: string,
  session?: string,
): Promise<Response> {
  const query = authorizeQuery(id, "content:read", pkce());
  return fetch(`${server.apiUrl}/oauth/authorize?${query.toString()}`, {
    redirect: "manual",
    headers: {
      [CLIENT_HEADER]: address,
      ...(session === undefined ? {} : { cookie: session }),
    },
  });
}

/** The `error` of an answer that refused the client. */
async function refused(response: Response): Promise<string> {
  expect(response.status).toBe(400);
  return ((await response.json()) as { error: string }).error;
}

/** Spends every address's thirty fetches from three addresses. */
async function spendEveryAddress(block: number): Promise<void> {
  for (let a = 1; a <= 3; a++) {
    for (let i = 0; i < 10; i++) {
      expect(
        await deviceCode(clientId(), `10.${String(block)}.${String(a)}.1`),
      ).toBe("invalid_client");
    }
  }
  expect(
    await deviceCode(clientId(), `10.${String(block)}.9.1`),
    "every address's fetches are not spent",
  ).toBe("temporarily_unavailable");
}

describe("client ID metadata documents", () => {
  it("holds one address to ten fetches a minute and every address together to thirty", async () => {
    const before = await lookups();
    for (let i = 0; i < 10; i++) {
      expect(await deviceCode(clientId(), "192.0.2.1")).toBe("invalid_client");
    }
    expect(await lookups()).toBe(before + 10);
    expect(await deviceCode(clientId(), "192.0.2.1")).toBe(
      "temporarily_unavailable",
    );
    expect(await lookups(), "a refused request was fetched").toBe(before + 10);
    // The witness: another address still has fetches left, until every
    // address together has made thirty.
    for (let a = 2; a <= 3; a++) {
      for (let i = 0; i < 10; i++) {
        expect(await deviceCode(clientId(), `192.0.2.${String(a)}`)).toBe(
          "invalid_client",
        );
      }
    }
    expect(await deviceCode(clientId(), "192.0.2.4")).toBe(
      "temporarily_unavailable",
    );
    expect(await lookups()).toBe(before + 30);
  });

  it("fetches for the owner's signed-in request while strangers keep every address's fetches spent", async () => {
    await spendEveryAddress(1);
    const before = await lookups();
    const owner = await authorizing(clientId(), "10.1.9.1", cookie);
    expect(await refused(owner)).toBe("invalid_client");
    expect(await lookups()).toBe(before + 1);
    // A stranger from the same address is still held.
    expect(await deviceCode(clientId(), "10.1.9.1")).toBe(
      "temporarily_unavailable",
    );
    expect(await lookups()).toBe(before + 1);
  });

  it("holds the owner's signed-in requests to ten fetches a minute of their own", async () => {
    for (let i = 0; i < 10; i++) {
      const owner = await authorizing(clientId(), "198.51.100.1", cookie);
      expect(await refused(owner)).toBe("invalid_client");
    }
    const before = await lookups();
    const past = await authorizing(clientId(), "198.51.100.2", cookie);
    expect(await refused(past)).toBe("temporarily_unavailable");
    expect(await lookups()).toBe(before);
    // The owner's share is apart from every address's: a stranger still fetches.
    expect(await deviceCode(clientId(), "198.51.100.3")).toBe("invalid_client");
  });

  it("sends a signed-out browser to sign in first, and the request then fetches with the owner's share", async () => {
    const id = clientId();
    // The witness: with fetches left, a signed-out request is fetched and refused.
    expect(await refused(await authorizing(clientId(), "203.0.113.1"))).toBe(
      "invalid_client",
    );
    await server.advanceClock(MINUTE + 1_000);
    await spendEveryAddress(2);
    const before = await lookups();
    const signedOut = await authorizing(id, "203.0.113.2");
    expect(signedOut.status).toBe(302);
    const location = new URL(
      signedOut.headers.get("location") ?? "",
      server.apiUrl,
    );
    expect(location.pathname).toBe("/auth/sign-in");
    const back = location.searchParams.get("return_to") ?? "";
    expect(new URL(back, server.apiUrl).searchParams.get("client_id")).toBe(id);
    expect(await lookups()).toBe(before);
    // Signed in, the same request is fetched from the owner's share.
    const again = await fetch(new URL(back, server.apiUrl), {
      redirect: "manual",
      headers: { [CLIENT_HEADER]: "203.0.113.2", cookie },
    });
    expect(await refused(again)).toBe("invalid_client");
    expect(await lookups()).toBe(before + 1);
    // With prompt=none there is no sign-in to send it to.
    const none = authorizeQuery(clientId(), "content:read", pkce(), {
      prompt: "none",
    });
    const silent = await fetch(
      `${server.apiUrl}/oauth/authorize?${none.toString()}`,
      { redirect: "manual", headers: { [CLIENT_HEADER]: "203.0.113.3" } },
    );
    expect(await refused(silent)).toBe("temporarily_unavailable");
  });

  it("answers a signed-out browser as before when the client's host does not answer or every fetch is in use", async () => {
    await server.setFault(`resolve:${STALLED}=stall:4000`);
    try {
      // Four fetches whose host does not answer hold every fetch there is.
      const stalled = [1, 2, 3, 4].map((a) =>
        authorizing(
          `https://${STALLED}/clients/${String(a)}.json`,
          `192.0.2.${String(100 + a)}`,
        ),
      );
      while ((await stalls()) < 4) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const busy = await authorizing(clientId(), "192.0.2.110");
      expect(await refused(busy)).toBe("temporarily_unavailable");
      for (const answer of await Promise.all(stalled)) {
        expect(await refused(answer)).toBe("temporarily_unavailable");
      }
      // The witness: with fetches free, the same request is fetched.
      expect(await refused(await authorizing(clientId(), "192.0.2.111"))).toBe(
        "invalid_client",
      );
    } finally {
      await server.clearFault(`resolve:${STALLED}`);
    }
  });
});
