import http from "node:http";
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
 * to, what every address together leaves in the audit log, the refusal a
 * caller from elsewhere meets before the instance has a sign-in address,
 * and what the device page and the loopback redirect take from the request,
 * and how long an access token lasts. Each case talks from an address of its
 * own, which the server believes from a header, so no case holds another
 * back, and each count of audit records has a server of its own.
 */
let limited: FreshServer;
let unset: FreshServer;
let registrations: FreshServer;
let codes: FreshServer;
let windowed: FreshServer;
let abandoned: FreshServer;
let unoffered: FreshServer;
let unentered: FreshServer;
let origin: string;
let addresses = 0;

const CLIENT_HEADER = "x-conformance-client";

beforeAll(async () => {
  [
    limited,
    unset,
    registrations,
    codes,
    windowed,
    abandoned,
    unoffered,
    unentered,
  ] = await Promise.all([
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
    bootFreshServer("register-audit-allowance", {
      MARFA_TRUSTED_PROXY_HEADER: CLIENT_HEADER,
      MARFA_TRUSTED_PROXY_CIDRS: "127.0.0.0/8",
      MARFA_RATE_LIMIT_ENABLED: "true",
    }),
    bootFreshServer("device-code-audit-allowance", {
      MARFA_TRUSTED_PROXY_HEADER: CLIENT_HEADER,
      MARFA_TRUSTED_PROXY_CIDRS: "127.0.0.0/8",
      MARFA_RATE_LIMIT_ENABLED: "true",
    }),
    bootFreshServer("register-audit-window", {
      MARFA_TRUSTED_PROXY_HEADER: CLIENT_HEADER,
      MARFA_TRUSTED_PROXY_CIDRS: "127.0.0.0/8",
      MARFA_RATE_LIMIT_ENABLED: "true",
    }),
    bootFreshServer("register-audit-abandoned", {
      MARFA_TRUSTED_PROXY_HEADER: CLIENT_HEADER,
      MARFA_TRUSTED_PROXY_CIDRS: "127.0.0.0/8",
      MARFA_RATE_LIMIT_ENABLED: "true",
      MARFA_TEST_TUNING: "write_wait_ms=10000",
    }),
    bootFreshServer("unoffered-clients-bound"),
    bootFreshServer("unentered-device-codes-bound"),
  ]);
  origin = await issuerOrigin(limited);
}, 8 * FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  await Promise.allSettled([
    limited.stop(),
    unset.stop(),
    registrations.stop(),
    codes.stop(),
    windowed.stop(),
    abandoned.stop(),
    unoffered.stop(),
    unentered.stop(),
  ]);
}, 8 * FRESH_SERVER_TIMEOUT_MS);

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

/** The audit records of `action`, newest first. */
async function audited(
  server: FreshServer,
  action: string,
): Promise<{ details?: { unrecorded_after?: number; source?: string } }[]> {
  const response = await fetch(
    `${server.apiUrl}/audit?${new URLSearchParams({ action, limit: "200" })}`,
    { headers: { authorization: `Bearer ${server.managementKey}` } },
  );
  expect(response.status).toBe(200);
  const { data } = (await response.json()) as {
    data: { details?: { unrecorded_after?: number; source?: string } }[];
  };
  return data;
}

const METADATA = JSON.stringify({
  client_name: "audit allowance fixture",
  application_type: "native",
  redirect_uris: ["http://127.0.0.1/callback"],
  token_endpoint_auth_method: "none",
});

function register(server: FreshServer, address: string): Promise<Response> {
  return fetch(`${server.apiUrl}/auth/oauth2/register`, {
    method: "POST",
    headers: { "content-type": "application/json", [CLIENT_HEADER]: address },
    body: METADATA,
  });
}

describe("what every address together leaves in the audit log", () => {
  it("registers every client from every address, records ten in fifteen minutes, and counts the rest on the newest record", async () => {
    for (let a = 1; a <= 7; a++) {
      const { answered } = await untilRefused(10, () =>
        register(registrations, `192.0.2.${String(a)}`),
      );
      expect(answered).toEqual(Array<number>(10).fill(201));
    }
    const full = await audited(registrations, "auth.client.created");
    expect(full).toHaveLength(10);
    expect(full[0]?.details?.source).toBe("registration");
    expect(full[0]?.details?.unrecorded_after).toBe(60);
    expect(full[1]?.details?.unrecorded_after).toBeUndefined();
    await registrations.advanceClock(15 * 60 * 1000);
    expect((await register(registrations, "203.0.113.9")).status).toBe(201);
    const held = await audited(registrations, "auth.client.created");
    expect(held).toHaveLength(11);
    expect(held[0]?.details?.unrecorded_after).toBeUndefined();
    expect(held[1]?.details?.unrecorded_after).toBe(60);
  });

  it("measures the fifteen minutes from when a registration's record is written", async () => {
    await windowed.pauseClock(true);
    try {
      await windowed.setFault("hold:write=auth.client.created");
      const first = register(windowed, "192.0.2.1");
      await windowed.waitForHold("hold:write");
      await windowed.advanceClock(1_000);
      await windowed.clearFault("hold:write");
      expect((await first).status).toBe(201);
      for (let n = 2; n <= 10; n++) {
        expect((await register(windowed, `192.0.2.${String(n)}`)).status).toBe(
          201,
        );
      }
      await windowed.advanceClock(15 * 60 * 1000 - 1);
      expect((await register(windowed, "192.0.2.11")).status).toBe(201);
      const inside = await audited(windowed, "auth.client.created");
      expect(inside).toHaveLength(10);
      expect(inside[0]?.details?.unrecorded_after).toBe(1);
      await windowed.advanceClock(1);
      expect((await register(windowed, "192.0.2.12")).status).toBe(201);
      expect(await audited(windowed, "auth.client.created")).toHaveLength(11);
    } finally {
      await windowed.pauseClock(false);
    }
  });

  it("writes no more than ten registration records when the callers leave before their writes", async () => {
    // Hold the writer until the registration callers disconnect.
    await abandoned.setFault("hold:bulk-page=1");
    const page = fetch(`${abandoned.apiUrl}/items/bulk`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${abandoned.workingKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        mode: "upsert",
        items: [
          {
            type: "core.note",
            source_id: "held-page",
            properties: { title: "held page" },
          },
        ],
      }),
    });
    await abandoned.waitForHold("hold:bulk-page");
    // The eleventh caller write to reach the writer's queue fails there, so its
    // firing says the ten before it are queued.
    await abandoned.setFault("fail:lock=11");
    const left = await Promise.all(
      Array.from({ length: 11 }, (_, n) => {
        const request = http.request(
          `${abandoned.apiUrl}/auth/oauth2/register`,
          {
            method: "POST",
            agent: false,
            headers: {
              "content-type": "application/json",
              [CLIENT_HEADER]: `198.51.100.${String(n + 1)}`,
            },
          },
          (response) => response.resume(),
        );
        request.on("error", () => undefined);
        return new Promise<http.ClientRequest>((sent) => {
          request.end(METADATA, () => {
            sent(request);
          });
        });
      }),
    );
    await expect
      .poll(
        async () =>
          (await abandoned.faults()).find((fault) => fault.name === "fail:lock")
            ?.fired,
        { timeout: 60_000 },
      )
      .toBe(1);
    for (const request of left) request.destroy();
    await abandoned.clearFault("fail:lock");
    await abandoned.clearFault("hold:bulk-page");
    expect((await page).status).toBe(200);

    // A registration that answers was queued behind every one that left.
    expect((await register(abandoned, "203.0.113.1")).status).toBe(201);
    const first = await audited(abandoned, "auth.client.created");
    expect(first).toHaveLength(10);
    expect(first[0]?.details?.unrecorded_after).toBe(1);

    await abandoned.advanceClock(60_001);
    for (let n = 2; n <= 11; n++) {
      expect((await register(abandoned, `203.0.113.${String(n)}`)).status).toBe(
        201,
      );
    }
    const held = await audited(abandoned, "auth.client.created");
    expect(held).toHaveLength(10);
    expect(held[0]?.details?.unrecorded_after).toBe(11);
  });

  it("issues every device code from every address, records ten in fifteen minutes, and counts the rest on the newest record", async () => {
    const app = await registerApp(codes, "core.note:read", {
      grant_types: ["urn:ietf:params:oauth:grant-type:device_code"],
    });
    const code = (address: string) =>
      fetch(`${codes.apiUrl}/auth/device/code`, {
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
    for (let a = 1; a <= 3; a++) {
      const { answered } = await untilRefused(30, () =>
        code(`192.0.2.${String(a)}`),
      );
      expect(answered).toEqual(Array<number>(30).fill(200));
    }
    const issued = "auth.device_code.issued";
    const full = await audited(codes, issued);
    expect(full).toHaveLength(10);
    expect(full[0]?.details?.unrecorded_after).toBe(80);
    await codes.advanceClock(15 * 60 * 1000);
    expect((await code("203.0.113.9")).status).toBe(200);
    const held = await audited(codes, issued);
    expect(held).toHaveLength(11);
    expect(held[0]?.details?.unrecorded_after).toBeUndefined();
  });
});

const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

/** Registers a device client and answers its ID. */
async function deviceClient(server: FreshServer): Promise<string> {
  const response = await fetch(`${server.apiUrl}/auth/oauth2/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "stored bound fixture",
      application_type: "native",
      grant_types: [DEVICE_GRANT],
      response_types: [],
      token_endpoint_auth_method: "none",
    }),
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as { client_id: string }).client_id;
}

function askForCode(server: FreshServer, clientId: string): Promise<Response> {
  return fetch(`${server.apiUrl}/auth/device/code`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, scope: "core.note:read" }),
  });
}

async function deviceCode(
  server: FreshServer,
  clientId: string,
): Promise<{ device_code: string; user_code: string }> {
  const response = await askForCode(server, clientId);
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as { device_code: string; user_code: string };
}

/** The owner enters `userCode` on the verification page. */
async function enter(server: FreshServer, userCode: string): Promise<void> {
  const cookie = await ownerCookie(server, await issuerOrigin(server));
  const page = await fetch(
    `${server.apiUrl}/auth/device/consent?${new URLSearchParams({ user_code: userCode })}`,
    { headers: { cookie } },
  );
  await page.body?.cancel();
  expect(page.status).toBe(200);
}

/** The `error` a poll of `deviceCode` answers. */
async function polled(
  server: FreshServer,
  clientId: string,
  deviceCode: string,
): Promise<string | undefined> {
  const response = await fetch(`${server.apiUrl}/auth/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: DEVICE_GRANT,
      device_code: deviceCode,
      client_id: clientId,
    }),
  });
  return ((await response.json()) as { error?: string }).error;
}

describe("what every address together leaves stored", () => {
  it("keeps at most 1000 clients no approval page has offered, removing the oldest, and keeps an offered one", async () => {
    await unoffered.pauseClock(true);
    try {
      const offered = await deviceClient(unoffered);
      await enter(unoffered, (await deviceCode(unoffered, offered)).user_code);
      const oldest = await deviceClient(unoffered);
      // The witness: the oldest one answers before the bound is reached.
      await deviceCode(unoffered, oldest);
      const next = await deviceClient(unoffered);
      for (let n = 0; n < 999; n++) await deviceClient(unoffered);
      const gone = await askForCode(unoffered, oldest);
      expect(gone.status).toBe(400);
      expect(((await gone.json()) as { error: string }).error).toBe(
        "invalid_client",
      );
      await deviceCode(unoffered, next);
      await deviceCode(unoffered, offered);
    } finally {
      await unoffered.pauseClock(false);
    }
  });

  it("keeps at most 1000 device codes nobody has entered, removing the oldest, and keeps an entered one", async () => {
    await unentered.pauseClock(true);
    try {
      const client = await deviceClient(unentered);
      const entered = await deviceCode(unentered, client);
      await enter(unentered, entered.user_code);
      const oldest = await deviceCode(unentered, client);
      expect(await polled(unentered, client, oldest.device_code)).toBe(
        "authorization_pending",
      );
      await unentered.advanceClock(1);
      const next = await deviceCode(unentered, client);
      for (let n = 0; n < 999; n++) await deviceCode(unentered, client);
      expect(await polled(unentered, client, oldest.device_code)).toBe(
        "invalid_grant",
      );
      expect(await polled(unentered, client, next.device_code)).toBe(
        "authorization_pending",
      );
      expect(await polled(unentered, client, entered.device_code)).toBe(
        "authorization_pending",
      );
    } finally {
      await unentered.pauseClock(false);
    }
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
