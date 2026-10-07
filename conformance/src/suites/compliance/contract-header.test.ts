import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  stopFreshServers,
  type FreshServer,
} from "../../utils/fresh-server.js";

/**
 * The contract version on the answers that need a setting to be reached
 * (`instance/contract-header`): a request the limiter refuses and a
 * cross-origin preflight the CORS layer answers. The shared server runs with
 * the limiter off and no origin allowed, so both are made on a server of the
 * fixture's own.
 */
const ORIGIN = "https://app.example.test";
/** Low enough to reach in a handful of reads: a read is allowed twice it. */
const LIMIT = 3;

let server: FreshServer | undefined;

beforeAll(async () => {
  server = await bootFreshServer("contract-header", {
    RATE_LIMIT_ENABLED: "true",
    RATE_LIMIT_REQUESTS: String(LIMIT),
    CORS_ORIGINS: ORIGIN,
  });
}, FRESH_SERVER_TIMEOUT_MS);

afterAll(stopFreshServers, FRESH_SERVER_TIMEOUT_MS);

describe("X-Marfa-Contract on the limiter's and the origin layer's answers", () => {
  it("sends its contract version on a request the limiter refuses", async () => {
    const root = (await (await fetch(`${server!.apiUrl}/`)).json()) as {
      contract: number;
    };
    const read = () =>
      fetch(`${server!.apiUrl}/items?limit=1`, {
        headers: { Authorization: `Bearer ${server!.workingKey}` },
      });

    // The witness: the allowance is spent by reads the server answers, each
    // carrying the version, before the one it refuses.
    let refused: Response | undefined;
    for (let call = 1; call <= 3 * LIMIT && refused === undefined; call++) {
      const answer = await read();
      if (answer.status === 429) refused = answer;
      else expect(answer.status, `read ${String(call)}`).toBe(200);
    }
    expect(refused, "the limiter refused nothing").toBeDefined();
    expect(refused!.headers.get("X-Marfa-Contract")).toBe(
      String(root.contract),
    );
    expect(
      ((await refused!.json()) as { error: { code: string } }).error.code,
    ).toBe("rate_limited");
  }, 120_000);

  it("sends its contract version on a preflight from an origin the instance allows", async () => {
    const root = (await (await fetch(`${server!.apiUrl}/`)).json()) as {
      contract: number;
    };
    const preflight = await fetch(`${server!.apiUrl}/items`, {
      method: "OPTIONS",
      headers: {
        Origin: ORIGIN,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "authorization,content-type",
      },
    });
    // The witness: the origin layer answered this one itself, naming the
    // origin, rather than the request falling through to a route.
    expect(preflight.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);
    expect(preflight.headers.get("X-Marfa-Contract")).toBe(
      String(root.contract),
    );
  }, 120_000);
});
