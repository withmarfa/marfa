import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import {
  authorize,
  authorizeQuery,
  connect,
  issuerOrigin,
  pkce,
  registerApp,
  sentTo,
  signIn as ownerCookie,
} from "../../utils/signed-in.js";
import { TEST_OWNER } from "../../utils/target.js";

/**
 * The limits each door that opens a sign-in or a client holds one address
 * to, the refusal a caller from elsewhere meets before the instance has a
 * sign-in address, and what the device page and the loopback redirect take
 * from the request, and how long an access token lasts. Each case talks from
 * an address of its own, which the
 * server believes from a header, so no case holds another back.
 */
let limited: FreshServer;
let unset: FreshServer;
let origin: string;
let addresses = 0;

const CLIENT_HEADER = "x-conformance-client";

beforeAll(async () => {
  [limited, unset] = await Promise.all([
    bootFreshServer("sign-in-door-limits", {
      MARFA_TRUSTED_PROXY_HEADER: CLIENT_HEADER,
      MARFA_TRUSTED_PROXY_CIDRS: "127.0.0.0/8",
      MARFA_RATE_LIMIT_ENABLED: "true",
    }),
    bootFreshServer("sign-in-address-unset", {
      MARFA_TRUSTED_PROXY_HEADER: CLIENT_HEADER,
      MARFA_TRUSTED_PROXY_CIDRS: "127.0.0.0/8",
      MARFA_SIGN_IN_ADDRESS: "",
    }),
  ]);
  origin = await issuerOrigin(limited);
}, 2 * FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  await Promise.allSettled([limited.stop(), unset.stop()]);
}, 2 * FRESH_SERVER_TIMEOUT_MS);

function nextAddress(): string {
  addresses += 1;
  return `198.51.100.${String(addresses)}`;
}

function signIn(
  server: FreshServer,
  email: string,
  password: string,
  address: string,
  from = origin,
): Promise<Response> {
  return fetch(`${server.apiUrl}/auth/sign-in`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: from,
      [CLIENT_HEADER]: address,
    },
    body: JSON.stringify({ email, password }),
  });
}

/** The statuses of `count` calls answered before the first `429`, and that refusal. */
async function untilRefused(
  count: number,
  call: (n: number) => Promise<Response>,
): Promise<{ answered: number[]; refused?: Response }> {
  const answered: number[] = [];
  for (let n = 0; n < count; n++) {
    const response = await call(n);
    if (response.status === 429) return { answered, refused: response };
    answered.push(response.status);
    await response.body?.cancel();
  }
  return { answered };
}

describe("the limits one address is held to", () => {
  it("answers password sign-ins at any email alike, the owner's among them, until the address's limit refuses them all", async () => {
    const address = nextAddress();
    // The witness: the owner's right password from this address signs in,
    // and spends nothing.
    expect(
      (await signIn(limited, TEST_OWNER.email, TEST_OWNER.password, address))
        .status,
    ).toBe(200);
    const atOwner = await untilRefused(10, () =>
      signIn(limited, TEST_OWNER.email, "wrong", address),
    );
    expect(atOwner.answered).toEqual(Array<number>(10).fill(401));
    const elsewhere = await untilRefused(20, (n) =>
      signIn(limited, `stranger-${String(n)}@example.test`, "wrong", address),
    );
    expect(elsewhere.answered).toEqual(Array<number>(20).fill(401));
    const owner = await signIn(
      limited,
      TEST_OWNER.email,
      TEST_OWNER.password,
      address,
    );
    const stranger = await signIn(
      limited,
      "stranger-new@example.test",
      "wrong",
      address,
    );
    expect([owner.status, stranger.status]).toEqual([429, 429]);
    expect(owner.headers.get("x-error-code")).toBe(
      stranger.headers.get("x-error-code"),
    );
    const waits = [owner, stranger].map((response) =>
      Number(response.headers.get("retry-after")),
    );
    expect(waits[0]).toBeGreaterThan(0);
    expect(Math.abs(waits[0]! - waits[1]!)).toBeLessThanOrEqual(1);
    const said = async (response: Response) => {
      const { error } = (await response.json()) as {
        error: { code: string; message: string };
      };
      return [error.code, error.message];
    };
    expect(await said(owner)).toEqual(await said(stranger));
  });

  it("answers the eleventh client registration from one address in a minute 429", async () => {
    const address = nextAddress();
    const register = () =>
      fetch(`${limited.apiUrl}/auth/oauth2/register`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [CLIENT_HEADER]: address,
        },
        body: JSON.stringify({
          client_name: "door limits fixture",
          application_type: "native",
          redirect_uris: ["http://127.0.0.1/callback"],
          token_endpoint_auth_method: "none",
        }),
      });
    const { answered, refused } = await untilRefused(11, register);
    expect(answered).toEqual(Array<number>(10).fill(201));
    expect(Number(refused?.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  it("answers the thirty-first device code from one address in a minute 429", async () => {
    const app = await registerApp(limited, "core.note:read", {
      grant_types: ["urn:ietf:params:oauth:grant-type:device_code"],
    });
    const address = nextAddress();
    const code = () =>
      fetch(`${limited.apiUrl}/auth/device/code`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          [CLIENT_HEADER]: address,
        },
        body: new URLSearchParams({
          client_id: app.clientId,
          scope: "core.note:read",
        }),
      });
    const first = await code();
    expect(first.status, await first.clone().text()).toBe(200);
    const { answered, refused } = await untilRefused(30, code);
    expect(answered).toEqual(Array<number>(29).fill(200));
    expect(Number(refused?.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  it("answers the thirty-first passkey sign-in challenge from one address in a minute 429", async () => {
    const address = nextAddress();
    const challenge = () =>
      fetch(`${limited.apiUrl}/auth/passkeys/sign-in/options`, {
        method: "POST",
        headers: { origin, [CLIENT_HEADER]: address },
      });
    const { answered, refused } = await untilRefused(31, challenge);
    expect(answered).toEqual(Array<number>(30).fill(200));
    expect(Number(refused?.headers.get("retry-after"))).toBeGreaterThan(0);
  });
});

describe("an instance with no sign-in address", () => {
  it("refuses a password sign-in from a caller off this machine 403, and answers one from this machine", async () => {
    const own = await issuerOrigin(unset);
    const away = await signIn(
      unset,
      TEST_OWNER.email,
      TEST_OWNER.password,
      "203.0.113.7",
      own,
    );
    expect(away.status).toBe(403);
    const body = (await away.json()) as {
      error: { code: string; message: string };
    };
    expect(body.error.code).toBe("forbidden");
    expect(body.error.message).toContain("sign-in address");
    expect(away.headers.get("set-cookie")).toBeNull();
    // The witness: the same sign-in from the loopback is answered.
    const here = await signIn(
      unset,
      TEST_OWNER.email,
      TEST_OWNER.password,
      "127.0.0.1",
      own,
    );
    expect(here.status).toBe(200);
  });
});

describe("what a page and a redirect take from the request", () => {
  it("fills the device page's code field with the user_code it is opened with", async () => {
    const page = await fetch(
      `${limited.apiUrl}/auth/device?user_code=WXYZ-2345`,
    );
    expect(page.status).toBe(200);
    expect(await page.text()).toMatch(
      /<input id="user_code"[^>]* value="WXYZ-2345"/,
    );
    // The witness: with no user_code the field is empty.
    const blank = await fetch(`${limited.apiUrl}/auth/device`);
    expect(await blank.text()).toMatch(/<input id="user_code"[^>]* value=""/);
  });

  it("takes a loopback redirect URI on any port for one registered on the loopback", async () => {
    const app = await registerApp(limited, "core.note:read");
    const elsewhere = authorizeQuery(app.clientId, "core.note:read", pkce(), {
      redirect_uri: "http://127.0.0.1:54321/callback",
    });
    const taken = await sentTo(limited, await authorize(limited, elsewhere));
    expect(taken?.pathname).toBe("/auth/sign-in");
    // The witness: another path on the loopback is not the registered URI.
    const other = authorizeQuery(app.clientId, "core.note:read", pkce(), {
      redirect_uri: "http://127.0.0.1:54321/elsewhere",
    });
    const refused = await authorize(limited, other);
    expect((await sentTo(limited, refused))?.pathname).not.toBe(
      "/auth/sign-in",
    );
  });

  it("issues an access token that lasts an hour", async () => {
    const app = await registerApp(limited, "core.note:read");
    const cookie = await ownerCookie(limited, origin);
    const tokens = await connect(
      limited,
      origin,
      cookie,
      app,
      "core.note:read",
    );
    expect(tokens.access_token).toBeTruthy();
    expect(tokens.expires_in).toBe(3600);
  });
});
