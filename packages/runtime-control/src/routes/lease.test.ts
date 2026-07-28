/**
 * Lease route — pins three things.
 *
 * First, the identity gate. The route mints a real tenant-scoped
 * credential, so it must refuse a caller that cannot authenticate. A
 * Connection ID is not a secret, so without the gate anyone who has seen
 * one can mint against it. Authentication is per-Worker: a key derived
 * from the caller's integration name, so proving you are one integration
 * does not let you act as another.
 *
 * Second, that the platform broker key is not accepted here. It is the
 * credential that mints against any Connection in any tenant, and the
 * whole point of the derived keys is that no integration Worker holds
 * it — including a Worker still deployed with the old secret.
 *
 * Third, the mint trust boundary. The broker identifies the Connection
 * and supplies lease metadata, but it never chooses permission maps: the
 * Marfa server projects those from the Connection's persisted manifest,
 * which is the only copy of the integration's declared reach that the
 * caller cannot influence. The integration name the caller *proved* is
 * forwarded so the server can check that manifest against it; a name
 * from the request body never is.
 *
 * The test patches `globalThis.fetch` to capture the body the broker
 * POSTs to Marfa's `/system/runtime-credentials` endpoint, then asserts
 * what does and does not cross the control-plane boundary.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { deriveWorkerIdentityKey } from "@withmarfa/shared";
import { buildApp } from "../app.js";
import type { ControlPlaneEnv } from "../env.js";

interface FetchCall {
  url: string;
  method: string;
  body: unknown;
}

function mockMarfaFetch(captured: FetchCall[]): typeof fetch {
  return (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    const method = init?.method ?? "GET";
    let body: unknown = null;
    if (typeof init?.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    captured.push({ url, method, body });
    if (url.endsWith("/system/runtime-credentials") && method === "POST") {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            api_key: "marfa_k1_runtime_test",
            connection_id: "conn_x",
            expires_at: new Date(Date.now() + 600_000).toISOString(),
          }),
          { status: 201, headers: { "content-type": "application/json" } },
        ),
      );
    }
    return Promise.resolve(new Response("nope", { status: 404 }));
  };
}

const IDENTITY_ROOT = "worker-identity-root-test";
const INTEGRATION = "withmarfa.rss-watcher";
const SIBLING = "google.calendar";

function buildTestEnv(): ControlPlaneEnv {
  return {
    MARFA_API_URL: "https://staging.test",
    MARFA_RUNTIME_BROKER_KEY: "broker-key-test",
    MARFA_WORKER_IDENTITY_SECRET: IDENTITY_ROOT,
  };
}

/** Headers a correctly-deployed integration Worker sends. */
let AUTHORIZED_HEADERS: Record<string, string>;
/** The bearer half of AUTHORIZED_HEADERS, for the cases that keep the
 *  key and drop or change the integration header. */
let AUTHORIZED_BEARER: string;
let SIBLING_KEY: string;

beforeAll(async () => {
  AUTHORIZED_BEARER = `Bearer ${await deriveWorkerIdentityKey(IDENTITY_ROOT, INTEGRATION)}`;
  AUTHORIZED_HEADERS = {
    "content-type": "application/json",
    authorization: AUTHORIZED_BEARER,
    "x-marfa-integration": INTEGRATION,
  };
  SIBLING_KEY = await deriveWorkerIdentityKey(IDENTITY_ROOT, SIBLING);
});

describe("POST /lease/:connection_id/runtime", () => {
  let originalFetch: typeof fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("leaves permission projection to the Marfa server", async () => {
    const captured: FetchCall[] = [];
    globalThis.fetch = mockMarfaFetch(captured);
    const app = buildApp();
    const env = buildTestEnv();

    const res = await app.request(
      "/lease/conn_x/runtime",
      {
        method: "POST",
        headers: AUTHORIZED_HEADERS,
        body: JSON.stringify({ label: "test", ttl_seconds: 600 }),
      },
      env,
    );
    expect(res.status).toBe(200);

    const mintCall = captured.find(
      (c) =>
        c.url.endsWith("/system/runtime-credentials") && c.method === "POST",
    );
    expect(mintCall).toBeDefined();
    expect(mintCall!.body).toEqual({
      connection_id: "conn_x",
      // The name the caller proved, forwarded so the server can check it
      // against the Connection's persisted manifest. No permission map
      // crosses this boundary in either direction.
      integration_name: INTEGRATION,
      label: "test",
      source: expect.stringMatching(/^runtime-conn_x-/),
      ttl_seconds: 600,
    });
  });

  it("forwards the proved integration, not one the body asked for", async () => {
    // The body is caller-controlled. If a name from it could reach the
    // server, the server-side manifest check would be checking the
    // caller's claim against itself.
    const captured: FetchCall[] = [];
    globalThis.fetch = mockMarfaFetch(captured);
    const res = await buildApp().request(
      "/lease/conn_x/runtime",
      {
        method: "POST",
        headers: AUTHORIZED_HEADERS,
        body: JSON.stringify({ label: "test", integration_name: SIBLING }),
      },
      buildTestEnv(),
    );
    expect(res.status).toBe(200);
    const mintCall = captured.find((c) =>
      c.url.endsWith("/system/runtime-credentials"),
    );
    expect(
      (mintCall!.body as { integration_name: string }).integration_name,
    ).toBe(INTEGRATION);
  });

  /**
   * Terminal-vs-transient classification starts here. The Worker reads
   * the `error` code off this body to decide whether to tear a
   * Connection's schedule down, so flattening every mint failure to 502
   * (or emitting an unlabelled 404) would make a deleted Connection
   * indistinguishable from a cold server — and nothing re-arms a
   * schedule that was torn down by mistake.
   */
  function stubMintStatus(
    status: number,
    message: string,
    code?: string,
  ): typeof fetch {
    // Marfa's structured error shape — `{ error: { code, message } }`.
    // Omitting `code` produces a bare-text body, standing in for a proxy
    // or WAF page that carries no verdict at all.
    const payload =
      code === undefined
        ? message
        : JSON.stringify({ error: { code, message } });
    return (input: RequestInfo | URL) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      if (url.endsWith("/system/runtime-credentials")) {
        return Promise.resolve(new Response(payload, { status }));
      }
      return Promise.resolve(new Response("unexpected", { status: 500 }));
    };
  }

  it("labels a missing connection 404 connection_not_found", async () => {
    globalThis.fetch = stubMintStatus(
      404,
      "no such connection",
      "connection_not_found",
    );
    const res = await buildApp().request(
      "/lease/conn_missing/runtime",
      {
        method: "POST",
        headers: AUTHORIZED_HEADERS,
        body: JSON.stringify({}),
      },
      buildTestEnv(),
    );

    expect(res.status).toBe(404);
    const json = await res.json<{ error: string; connection_id: string }>();
    expect(json.error).toBe("connection_not_found");
    expect(json.connection_id).toBe("conn_missing");
  });

  it("labels an inactive connection 403 connection_not_active", async () => {
    globalThis.fetch = stubMintStatus(
      403,
      "connection revoked",
      "connection_not_active",
    );
    const res = await buildApp().request(
      "/lease/conn_revoked/runtime",
      {
        method: "POST",
        headers: AUTHORIZED_HEADERS,
        body: JSON.stringify({}),
      },
      buildTestEnv(),
    );

    expect(res.status).toBe(403);
    const json = await res.json<{ error: string; connection_id: string }>();
    expect(json.error).toBe("connection_not_active");
    expect(json.connection_id).toBe("conn_revoked");
  });

  /**
   * The fleet-wide failure mode. `MARFA_RUNTIME_BROKER_KEY` rotated to a
   * valid but tenant-scoped admin key — exactly what
   * `POST /admin/tenants/{id}/keys` mints — makes the server refuse every
   * mint with 403 `forbidden`. That is a global authorization failure, not
   * a verdict on any connection. Classifying it as terminal deschedules
   * every scheduled connection in every tenant within one cron period,
   * recoverable only one connection at a time; classifying it as transient
   * costs retries until an operator fixes the key.
   */
  it("keeps a platform-credential refusal transient even though it is a 403", async () => {
    globalThis.fetch = stubMintStatus(
      403,
      "Runtime credential minting requires a platform credential (is_platform: true)",
      "forbidden",
    );
    const res = await buildApp().request(
      "/lease/conn_healthy/runtime",
      {
        method: "POST",
        headers: AUTHORIZED_HEADERS,
        body: JSON.stringify({}),
      },
      buildTestEnv(),
    );

    expect(res.status).toBe(502);
    const json = await res.json<{ error: string }>();
    expect(json.error).toBe("mint_failed");
    expect(json.error).not.toBe("connection_not_active");
  });

  it("keeps a 404 that is not connection-specific transient", async () => {
    // A wrong `MARFA_API_URL` reaches something that 404s the path. That
    // is a routing miss, not a missing connection, and it would otherwise
    // hand every connection the same terminal verdict.
    globalThis.fetch = stubMintStatus(404, "not found", "not_found");
    const res = await buildApp().request(
      "/lease/conn_healthy/runtime",
      {
        method: "POST",
        headers: AUTHORIZED_HEADERS,
        body: JSON.stringify({}),
      },
      buildTestEnv(),
    );

    expect(res.status).toBe(502);
    expect((await res.json<{ error: string }>()).error).toBe("mint_failed");
  });

  it("keeps a bodyless 403 transient", async () => {
    // A WAF or proxy page carries no code, so there is no verdict to read.
    globalThis.fetch = stubMintStatus(403, "<html>blocked</html>");
    const res = await buildApp().request(
      "/lease/conn_healthy/runtime",
      {
        method: "POST",
        headers: AUTHORIZED_HEADERS,
        body: JSON.stringify({}),
      },
      buildTestEnv(),
    );

    expect(res.status).toBe(502);
    expect((await res.json<{ error: string }>()).error).toBe("mint_failed");
  });

  it("keeps a connection code arriving on a contradicting status transient", async () => {
    globalThis.fetch = stubMintStatus(
      500,
      "connection revoked",
      "connection_not_active",
    );
    const res = await buildApp().request(
      "/lease/conn_healthy/runtime",
      {
        method: "POST",
        headers: AUTHORIZED_HEADERS,
        body: JSON.stringify({}),
      },
      buildTestEnv(),
    );

    expect(res.status).toBe(502);
    expect((await res.json<{ error: string }>()).error).toBe("mint_failed");
  });

  it("keeps a server-side failure transient as 502 mint_failed", async () => {
    globalThis.fetch = stubMintStatus(500, "database unavailable");
    const res = await buildApp().request(
      "/lease/conn_x/runtime",
      {
        method: "POST",
        headers: AUTHORIZED_HEADERS,
        body: JSON.stringify({}),
      },
      buildTestEnv(),
    );

    expect(res.status).toBe(502);
    const json = await res.json<{ error: string }>();
    expect(json.error).toBe("mint_failed");
  });

  it("answers an unrouted path with a plain not_found, distinct from the lease verdicts", async () => {
    // The catch-all is why status alone can't carry the verdict: a
    // misconfigured control-plane URL lands here with a 404 that means
    // "no such route", not "no such connection".
    const res = await buildApp().request(
      "/lease/conn_x/runtym",
      { method: "POST" },
      buildTestEnv(),
    );

    expect(res.status).toBe(404);
    const json = await res.json<{ error: string }>();
    expect(json.error).toBe("not_found");
    expect(json.error).not.toBe("connection_not_found");
  });

  it("returns 503 when MARFA_API_URL is unset", async () => {
    const app = buildApp();
    const env = {
      MARFA_RUNTIME_BROKER_KEY: "broker-key-test",
    } as unknown as ControlPlaneEnv;
    const res = await app.request(
      "/lease/conn_x/runtime",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      },
      env,
    );
    expect(res.status).toBe(503);
    const json = await res.json<{ error: string }>();
    expect(json.error).toBe("control_plane_misconfigured");
  });

  // The mint must never happen for an unauthenticated caller, so these
  // assert both the 401 and that no request reached Marfa at all.
  it("refuses a caller that sends no Authorization header", async () => {
    const captured: FetchCall[] = [];
    globalThis.fetch = mockMarfaFetch(captured);
    const res = await buildApp().request(
      "/lease/conn_x/runtime",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ label: "test", ttl_seconds: 600 }),
      },
      buildTestEnv(),
    );
    expect(res.status).toBe(401);
    expect(await res.json<{ error: string }>()).toEqual({
      error: "unauthorized",
    });
    expect(captured).toHaveLength(0);
  });

  it("refuses a caller that sends the wrong bearer", async () => {
    const captured: FetchCall[] = [];
    globalThis.fetch = mockMarfaFetch(captured);
    const res = await buildApp().request(
      "/lease/conn_x/runtime",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer not-an-identity-key",
          "x-marfa-integration": INTEGRATION,
        },
        body: JSON.stringify({ label: "test", ttl_seconds: 600 }),
      },
      buildTestEnv(),
    );
    expect(res.status).toBe(401);
    expect(captured).toHaveLength(0);
  });

  /**
   * The property the whole redesign exists for. Every Worker used to
   * hold the same platform key, so any one of them could mint against
   * any Connection. A Worker now holds a key derived from its own name
   * and cannot compute a sibling's, so presenting a sibling's key while
   * claiming to be itself — or claiming to be the sibling while holding
   * only its own key — both fail.
   */
  it("refuses a Worker presenting another integration's key", async () => {
    const captured: FetchCall[] = [];
    globalThis.fetch = mockMarfaFetch(captured);
    const res = await buildApp().request(
      "/lease/conn_x/runtime",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${SIBLING_KEY}`,
          "x-marfa-integration": INTEGRATION,
        },
        body: JSON.stringify({}),
      },
      buildTestEnv(),
    );
    expect(res.status).toBe(401);
    expect(captured).toHaveLength(0);
  });

  it("refuses a Worker claiming a name it cannot prove", async () => {
    const captured: FetchCall[] = [];
    globalThis.fetch = mockMarfaFetch(captured);
    const res = await buildApp().request(
      "/lease/conn_x/runtime",
      {
        method: "POST",
        headers: {
          ...AUTHORIZED_HEADERS,
          "x-marfa-integration": SIBLING,
        },
        body: JSON.stringify({}),
      },
      buildTestEnv(),
    );
    expect(res.status).toBe(401);
    expect(captured).toHaveLength(0);
  });

  it("refuses a caller that names no integration", async () => {
    // The header selects which key to check against, so without it
    // there is nothing to compare and no way to be authorized. Same 401
    // as a wrong key: which header is missing is not something a caller
    // that cannot authenticate should learn.
    const captured: FetchCall[] = [];
    globalThis.fetch = mockMarfaFetch(captured);
    const res = await buildApp().request(
      "/lease/conn_x/runtime",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: AUTHORIZED_BEARER,
        },
        body: JSON.stringify({}),
      },
      buildTestEnv(),
    );
    expect(res.status).toBe(401);
    expect(captured).toHaveLength(0);
  });

  it("refuses the platform broker key, which no Worker should hold", async () => {
    // A Worker deployed before the rotation still presents the old
    // shared secret. It has to be refused rather than accepted for
    // compatibility: accepting it is the defect, and the refusal is a
    // retryable 401 rather than a terminal verdict, so a Worker in that
    // state backs off until it is redeployed instead of tearing its
    // schedule down.
    const captured: FetchCall[] = [];
    globalThis.fetch = mockMarfaFetch(captured);
    const res = await buildApp().request(
      "/lease/conn_x/runtime",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer broker-key-test",
          "x-marfa-integration": INTEGRATION,
        },
        body: JSON.stringify({}),
      },
      buildTestEnv(),
    );
    expect(res.status).toBe(401);
    expect(captured).toHaveLength(0);
  });

  it("refuses every caller when the identity root is unset", async () => {
    const captured: FetchCall[] = [];
    globalThis.fetch = mockMarfaFetch(captured);
    const res = await buildApp().request(
      "/lease/conn_x/runtime",
      {
        method: "POST",
        headers: AUTHORIZED_HEADERS,
        body: JSON.stringify({}),
      },
      {
        MARFA_API_URL: "https://staging.test",
        MARFA_RUNTIME_BROKER_KEY: "broker-key-test",
      },
    );
    expect(res.status).toBe(503);
    expect((await res.json<{ error: string }>()).error).toBe(
      "control_plane_misconfigured",
    );
    expect(captured).toHaveLength(0);
  });
});

describe("POST /lease/:connection_id/oauth/:capability_id", () => {
  // Gated even though it is a 501 stub: an ungated route is how the
  // runtime mint path came to be reachable in the first place, and this
  // one is scheduled to start returning real tokens.
  it("refuses an unauthenticated caller before reporting not-implemented", async () => {
    const res = await buildApp().request(
      "/lease/conn_x/oauth/cap_calendar_read",
      { method: "POST" },
      buildTestEnv(),
    );
    expect(res.status).toBe(401);
  });

  it("refuses a Worker presenting another integration's key", async () => {
    const res = await buildApp().request(
      "/lease/conn_x/oauth/cap_calendar_read",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${SIBLING_KEY}`,
          "x-marfa-integration": INTEGRATION,
        },
      },
      buildTestEnv(),
    );
    expect(res.status).toBe(401);
  });

  it("still reports not-implemented for an authorized caller", async () => {
    const res = await buildApp().request(
      "/lease/conn_x/oauth/cap_calendar_read",
      { method: "POST", headers: AUTHORIZED_HEADERS },
      buildTestEnv(),
    );
    expect(res.status).toBe(501);
  });
});
