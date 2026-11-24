import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:https";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import {
  authorizeQuery,
  CALLBACK,
  issuerOrigin,
  pkce,
  signIn as ownerCookie,
} from "../../utils/signed-in.js";
import { tempFolder } from "../../utils/temp-folder.js";

/**
 * The limits on fetching a client ID metadata document, and the owner's own
 * share of them. The document's host resolves, by a scripted lookup, to an
 * address that is not public, so a fetch the server makes answers
 * `invalid_client` and one a limit keeps it from making answers
 * `temporarily_unavailable`. The server believes a header naming the
 * caller's address, and each case starts a new minute. The documents a client
 * publishes with a value past a registration bound are served by an `https`
 * server of the fixture's own, whose certificate the target is told to trust
 * for that one host (`trust:<hostname>`), and whose host resolves, by a
 * scripted lookup, to a public address the connection is sent from to this
 * machine.
 */
let server: FreshServer;
let origin: string;
let cookie: string;

const CLIENT_HEADER = "x-conformance-client";
const HOST = "app.client-documents.example";
const STALLED = "stalled.client-documents.example";
const MINUTE = 60_000;
let clients = 0;

const DOCUMENT_HOST = "published.client-documents.example";
const PUBLIC_ADDRESS = "93.184.216.34";
let published: Server;
let publishedPort: number;
/** The documents the fixture's server answers with, by path. */
const documents = new Map<string, string>();

beforeAll(async () => {
  server = await bootFreshServer("client-document-limits", {
    MARFA_TRUSTED_PROXY_HEADER: CLIENT_HEADER,
    MARFA_TRUSTED_PROXY_CIDRS: "127.0.0.0/8",
    MARFA_RATE_LIMIT_ENABLED: "true",
  });
  origin = await issuerOrigin(server);
  cookie = await ownerCookie(server, origin);
  await server.setFault(`resolve:${HOST}=10.0.0.1`);
  const folder = tempFolder("marfa-client-documents-");
  const files = {
    key: join(folder, "key.pem"),
    cert: join(folder, "cert.pem"),
  };
  execFileSync(
    "openssl",
    [
      ...[
        "req",
        "-x509",
        "-newkey",
        "ec",
        "-pkeyopt",
        "ec_paramgen_curve:prime256v1",
      ],
      ...["-nodes", "-days", "1", "-subj", `/CN=${DOCUMENT_HOST}`],
      ...["-addext", `subjectAltName=DNS:${DOCUMENT_HOST}`],
      ...["-addext", "basicConstraints=critical,CA:FALSE"],
      ...["-keyout", files.key, "-out", files.cert],
    ],
    { stdio: "ignore" },
  );
  const certificate = readFileSync(files.cert, "utf8");
  published = createServer(
    { key: readFileSync(files.key), cert: certificate },
    (request, response) => {
      const body = documents.get(request.url ?? "");
      response.writeHead(body === undefined ? 404 : 200, {
        "content-type": "application/json",
      });
      response.end(body ?? "{}");
    },
  );
  await new Promise<void>((resolve) => {
    published.listen(0, "127.0.0.1", resolve);
  });
  publishedPort = (published.address() as { port: number }).port;
  await server.setFault(`resolve:${DOCUMENT_HOST}=${PUBLIC_ADDRESS}>127.0.0.1`);
  await server.setFault(`trust:${DOCUMENT_HOST}=${certificate}`);
}, FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  await new Promise<void>((resolve) => {
    published.close(() => {
      resolve();
    });
    published.closeAllConnections();
  });
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

const BASE = { client_name: "A long-valued app", redirect_uris: [CALLBACK] };
const URI_AT_BOUND = `https://app.example/${"a".repeat(492)}`;
const URI_PAST_BOUND = `${URI_AT_BOUND}a`;

/** A scope of exactly `length` characters that names `content:read` and no other offered scope. */
function scopeOf(length: number): string {
  let scope = "content:read";
  for (let i = 0; scope.length + 8 <= length; i++) {
    scope += ` s${String(i).padStart(4, "0")}`;
  }
  return `${scope} ${"z".repeat(length - scope.length - 1)}`;
}

/** What a registration of one member is held to: a value at the bound and one past it. */
const OPTIONAL_MEMBERS: [string, unknown, unknown][] = [
  ["client_uri", URI_AT_BOUND, URI_PAST_BOUND],
  ["logo_uri", URI_AT_BOUND, URI_PAST_BOUND],
  ["tos_uri", URI_AT_BOUND, URI_PAST_BOUND],
  ["policy_uri", URI_AT_BOUND, URI_PAST_BOUND],
  ["software_id", "i".repeat(100), "i".repeat(101)],
  ["software_version", "v".repeat(100), "v".repeat(101)],
  ["scope", scopeOf(1024), scopeOf(1025)],
  [
    "contacts",
    Array.from(
      { length: 5 },
      (_, i) => `${String(i)}${"c".repeat(241)}@app.example`,
    ),
    Array.from({ length: 6 }, (_, i) => `${String(i)}@app.example`),
  ],
];

/** Serves a document that sets `members`, answering the client ID that names it. */
function publish(members: Record<string, unknown>): string {
  const path = `/clients/${randomUUID()}.json`;
  const id = `https://${DOCUMENT_HOST}:${String(publishedPort)}${path}`;
  documents.set(path, JSON.stringify({ client_id: id, ...BASE, ...members }));
  return id;
}

/** The audit records of `action` that name `id`, as the management key reads them. */
async function auditedFor(action: string, id: string): Promise<unknown[]> {
  const response = await fetch(
    `${server.apiUrl}/audit?${new URLSearchParams({ action, limit: "200" })}`,
    { headers: { authorization: `Bearer ${server.managementKey}` } },
  );
  expect(response.status).toBe(200);
  const { data } = (await response.json()) as {
    data: { resource_id?: string }[];
  };
  return data.filter((row) => row.resource_id === id);
}

/** The signed-in owner's authorization request for `id`, which asks for a scope the document may not name. */
function authorizingFor(id: string): Promise<Response> {
  return fetch(
    `${server.apiUrl}/oauth/authorize?${authorizeQuery(id, "content:read content:write", pkce()).toString()}`,
    { redirect: "manual", headers: { cookie } },
  );
}

describe("a client ID metadata document that sets an optional member past its bound", () => {
  it.each(OPTIONAL_MEMBERS)(
    "keeps %s at its bound and leaves it out past its bound, accepting the client either way",
    async (member, atBound, pastBound) => {
      const kept = publish({ [member]: atBound });
      const keptAnswer = await authorizingFor(kept);
      expect(keptAnswer.status, `${member} at its bound`).toBe(302);
      expect(
        new URL(keptAnswer.headers.get("location") ?? "", server.apiUrl)
          .pathname,
      ).toBe("/auth/consent");
      expect(await auditedFor("auth.client.created", kept)).toHaveLength(1);

      const dropped = publish({ [member]: pastBound });
      const droppedAnswer = await authorizingFor(dropped);
      expect(droppedAnswer.status, `${member} past its bound`).toBe(302);
      expect(
        new URL(droppedAnswer.headers.get("location") ?? "", server.apiUrl)
          .pathname,
      ).toBe("/auth/consent");
      expect(await auditedFor("auth.client.created", dropped)).toHaveLength(1);

      // The witness: a scope the document names is the app's ceiling, so
      // asking for one it does not name widens the ceiling; a scope left out
      // leaves the default ceiling, which already covers the request.
      const widened = async (id: string) =>
        (await auditedFor("auth.client.scopes_widened", id)).length;
      expect(await widened(kept), `${member} at its bound`).toBe(
        member === "scope" ? 1 : 0,
      );
      expect(await widened(dropped), `${member} past its bound`).toBe(0);
    },
  );

  it("refuses a client_name past its bound while one at its bound names the app on the consent screen", async () => {
    const named = publish({ client_name: "n".repeat(100) });
    const accepted = await authorizingFor(named);
    expect(accepted.status).toBe(302);
    const consent = new URL(
      accepted.headers.get("location") ?? "",
      server.apiUrl,
    );
    const screen = await fetch(consent, { headers: { cookie } });
    expect(await screen.text()).toContain("n".repeat(100));

    const overlong = publish({ client_name: "n".repeat(101) });
    expect(await refused(await authorizingFor(overlong))).toBe(
      "invalid_client",
    );
  });
});
