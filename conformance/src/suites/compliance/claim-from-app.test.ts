import { rm } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  bootUnclaimedServer,
  stopServer,
} from "../../../scripts/marfa-server.js";
import {
  asDrawn,
  offeredValues,
  readControls,
  visibleText,
} from "../../utils/approval-form.js";
import { controlRequest } from "../../utils/control-request.js";
import {
  FRESH_SERVER_TIMEOUT_MS,
  keepStatusLog,
} from "../../utils/fresh-server.js";
import {
  ADMIN_TOOLS,
  ALL_TOOLS,
  connectMcp,
  toolNames,
} from "../../utils/mcp.js";
import { CALLBACK, pkce } from "../../utils/signed-in.js";
import { tempFolder } from "../../utils/temp-folder.js";

/**
 * Claiming a new instance in the sign-in page an app opens: the setup code
 * page, `return_to` carried through setup, and the authorization that
 * follows the claim.
 */

const CLIENT = "x-real-ip";
const PROXIED = {
  MARFA_TRUSTED_PROXY_HEADER: CLIENT,
  MARFA_TRUSTED_PROXY_CIDRS: "127.0.0.0/8",
};
const OWNER = { username: "owner", password: "correct horse battery" };
const AUTHORIZE = "/oauth/authorize?client_id=an-app&state=kept%20state";
const DEVICE_CODE_MS = 10 * 60_000;
const SETUP_SESSION_MS = 15 * 60_000;
const BUDGET_MS = 3 * FRESH_SERVER_TIMEOUT_MS;

const CODE_PLACE = "in its terminal, or in its host's log";
const APPROVAL_AFTER =
  "After you create your account, you choose what the app can access, or turn it down.";
const APPROVAL_NEXT =
  "Next, you choose what the app can access, or turn it down.";
const WRONG_CODE =
  "That setup code isn't right, or Marfa has replaced it since. Enter the newest code Marfa shows.";
const DEVICE_EXPIRED = "Start connecting again in the app or on the device";

interface Instance {
  url: string;
  origin: string;
  /** A new setup code, as `marfa setup code` gives one; the earlier code stops working. */
  code(): Promise<string>;
  advanceClock(ms: number): Promise<void>;
  /** Stops the server and starts it again on the same state, which replaces its setup code. */
  restart(): Promise<void>;
}

/** A fresh unclaimed server for one test, stopped when it ends. */
async function withInstance(
  env: Record<string, string>,
  run: (instance: Instance) => Promise<void>,
): Promise<void> {
  const state = tempFolder("marfa-claim-from-app-");
  let running = false;
  let controlSocket = "";
  const boot = async (): Promise<string> => {
    const server = await bootUnclaimedServer({
      state,
      env: { ...PROXIED, ...env },
    });
    running = true;
    controlSocket = server.controlSocket;
    return server.url;
  };
  const control = async (
    path: string,
    body: unknown,
  ): Promise<Record<string, unknown>> => {
    const answer = await controlRequest(controlSocket, path, {
      method: "POST",
      body,
    });
    expect(answer.status, path).toBe(200);
    return answer.body;
  };
  try {
    const url = await boot();
    const instance: Instance = {
      url,
      origin: new URL(url).origin,
      code: async () =>
        (await control("/_control/setup/code", {})).code as string,
      advanceClock: async (ms) => {
        await control("/_control/test/clock", { advance_ms: ms });
      },
      restart: async () => {
        await stopServer({ state });
        running = false;
        instance.url = await boot();
        instance.origin = new URL(instance.url).origin;
      },
    };
    await run(instance);
  } finally {
    if (running) {
      await stopServer({ state });
      keepStatusLog(state);
    }
    await rm(state, { recursive: true, force: true });
  }
}

/** A browser on the instance's own pages: a cookie jar, and an address it calls from. */
class Browser {
  private readonly jar = new Map<string, string>();

  constructor(
    private readonly instance: Instance,
    private readonly address: string,
  ) {}

  holds(name: string): boolean {
    return this.jar.has(name);
  }

  cookie(): string {
    return [...this.jar].map(([name, value]) => `${name}=${value}`).join("; ");
  }

  private keep(response: Response): Response {
    for (const line of response.headers.getSetCookie()) {
      const [pair = "", ...attributes] = line.split(";");
      const at = pair.indexOf("=");
      const name = pair.slice(0, at).trim();
      const value = pair.slice(at + 1).trim();
      const ended =
        value === "" ||
        attributes.some((attribute) => /^\s*max-age=0\s*$/i.test(attribute));
      if (ended) this.jar.delete(name);
      else this.jar.set(name, value);
    }
    return response;
  }

  private headers(): Record<string, string> {
    return {
      accept: "text/html",
      [CLIENT]: this.address,
      ...(this.jar.size === 0 ? {} : { cookie: this.cookie() }),
    };
  }

  async get(path: string): Promise<Response> {
    return this.keep(
      await fetch(new URL(path, this.instance.url), {
        redirect: "manual",
        headers: this.headers(),
      }),
    );
  }

  async post(path: string, fields: [string, string][]): Promise<Response> {
    return this.keep(
      await fetch(new URL(path, this.instance.url), {
        method: "POST",
        redirect: "manual",
        headers: {
          ...this.headers(),
          origin: this.instance.origin,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams(fields),
      }),
    );
  }
}

/** Where a redirect sends the browser, as a path and query on the instance. */
function location(response: Response): string {
  expect([302, 303], `a redirect, not ${String(response.status)}`).toContain(
    response.status,
  );
  const sent = response.headers.get("location");
  expect(sent).not.toBeNull();
  return sent!;
}

function pathAndQuery(target: string, base: string): string {
  const url = new URL(target, base);
  return `${url.pathname}${url.search}`;
}

/** The `return_to` a page's forms carry. */
function carried(html: string): string[] {
  return offeredValues(html, "return_to");
}

/** The hidden fields a page's form posts beside what the person types. */
function hiddenFields(html: string): [string, string][] {
  return readControls(html)
    .filter((control) => control.type === "hidden")
    .map((control) => [control.name, control.value]);
}

/** The sign-in page that continues to `back`. */
function throughSignIn(back: string): string {
  return `/auth/sign-in?return_to=${encodeURIComponent(back)}`;
}

/** The link a page offers, decoded. */
function links(html: string): string[] {
  return [...html.matchAll(/href="([^"]*)"/g)].map((match) =>
    match[1]!.replaceAll("&amp;", "&"),
  );
}

interface Discovery {
  registration_endpoint: string;
  token_endpoint: string;
  device_authorization_endpoint: string;
}

/**
 * What an MCP client learns before it opens a browser: the `401` from
 * `/mcp/admin`, the resource's scopes, and the authorization server.
 */
async function discover(
  instance: Instance,
): Promise<{ scope: string; resource: string; discovery: Discovery }> {
  const challenged = await fetch(`${instance.url}/mcp/admin`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  expect(challenged.status).toBe(401);
  const metadataUrl = /resource_metadata="([^"]+)"/.exec(
    challenged.headers.get("www-authenticate") ?? "",
  )?.[1];
  expect(metadataUrl).toBeDefined();
  const metadata = (await (await fetch(metadataUrl!)).json()) as {
    resource: string;
    scopes_supported: string[];
    authorization_servers: string[];
  };
  const discovery = (await (
    await fetch(
      `${metadata.authorization_servers[0]!}/.well-known/oauth-authorization-server`,
    )
  ).json()) as Discovery;
  return {
    scope: metadata.scopes_supported.join(" "),
    resource: metadata.resource,
    discovery,
  };
}

/** Every tool `/mcp/admin` lists to `token`. */
async function adminToolsListed(
  instance: Instance,
  token: string,
): Promise<string[]> {
  const connection = await connectMcp(
    instance.url,
    token,
    "2026-07-28",
    "/mcp/admin",
  );
  try {
    return await toolNames(connection);
  } finally {
    await connection.close();
  }
}

/**
 * The setup a person does in the sign-in page an app opened: the setup code
 * page at `signIn`, the code, then the owner's details. Answers the claim's
 * redirect.
 */
async function claimThrough(
  browser: Browser,
  instance: Instance,
  signIn: string,
  back: string,
): Promise<Response> {
  const codePage = await browser.get(signIn);
  expect(codePage.status).toBe(200);
  const codeHtml = await codePage.text();
  expect(visibleText(codeHtml)).toContain(CODE_PLACE);
  expect(visibleText(codeHtml)).toContain(APPROVAL_AFTER);
  expect(carried(codeHtml)).toEqual([back]);

  const exchanged = await browser.post("/setup/exchange", [
    ["code", await instance.code()],
    ["return_to", back],
  ]);
  expect(exchanged.status).toBe(303);
  expect(location(exchanged)).toBe(
    `/setup?return_to=${encodeURIComponent(back)}`,
  );
  expect(browser.holds("marfa_setup")).toBe(true);

  const details = await browser.get(location(exchanged));
  expect(details.status).toBe(200);
  const detailsHtml = await details.text();
  expect(detailsHtml).toContain('id="owner-form"');
  expect(visibleText(detailsHtml)).toContain(APPROVAL_NEXT);
  expect(carried(detailsHtml)).toEqual([back]);

  return browser.post("/setup/claim", [
    ["username", OWNER.username],
    ["password", OWNER.password],
    ["name", ""],
    ["email", ""],
    ["return_to", back],
  ]);
}

describe("claiming in the sign-in page an app opens", () => {
  it(
    "takes an authorization-code client from 401 through setup to consent and a token listed every admin tool",
    async () => {
      await withInstance({}, async (instance) => {
        const { scope, resource, discovery } = await discover(instance);
        const registered = await fetch(discovery.registration_endpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            client_name: "claiming client",
            application_type: "native",
            redirect_uris: [CALLBACK],
            grant_types: ["authorization_code", "refresh_token"],
            response_types: ["code"],
            token_endpoint_auth_method: "none",
            scope,
          }),
        });
        expect(registered.status).toBe(201);
        const clientId = ((await registered.json()) as { client_id: string })
          .client_id;
        const proof = pkce();
        const request = `/oauth/authorize?${new URLSearchParams({
          response_type: "code",
          client_id: clientId,
          redirect_uri: CALLBACK,
          state: "claim-from-app",
          scope,
          resource,
          code_challenge: proof.challenge,
          code_challenge_method: "S256",
        }).toString()}`;

        const browser = new Browser(instance, "192.0.2.10");
        const signIn = location(await browser.get(request));
        const back = new URL(signIn, instance.url).searchParams.get(
          "return_to",
        );
        expect(back).toBe(request);
        expect(new URL(signIn, instance.url).pathname).toBe("/auth/sign-in");

        const claimed = await claimThrough(browser, instance, signIn, request);
        expect(claimed.status).toBe(303);
        expect(location(claimed)).toBe(request);
        expect(browser.holds("marfa_session")).toBe(true);
        expect(browser.holds("marfa_setup")).toBe(false);

        // The request replays signed in, and the claim's session is recent
        // enough to approve admin permissions.
        const consentUrl = new URL(
          location(await browser.get(location(claimed))),
          instance.url,
        );
        expect(consentUrl.pathname).toBe("/auth/consent");
        const consent = await browser.get(
          pathAndQuery(consentUrl.href, instance.url),
        );
        expect(consent.status).toBe(200);
        const decided = await browser.post("/auth/consent", [
          ["decision", "approve"],
          ["authorization_request", consentUrl.search.slice(1)],
          ...asDrawn(await consent.text()),
        ]);
        const landed = new URL(location(decided));
        expect(`${landed.origin}${landed.pathname}`).toBe(CALLBACK);
        const code = landed.searchParams.get("code");
        expect(code).not.toBeNull();

        const issued = await fetch(discovery.token_endpoint, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "authorization_code",
            code: code!,
            redirect_uri: CALLBACK,
            client_id: clientId,
            code_verifier: proof.verifier,
            resource,
          }),
        });
        expect(issued.status).toBe(200);
        const token = ((await issued.json()) as { access_token: string })
          .access_token;
        expect(await adminToolsListed(instance, token)).toEqual(
          [...ALL_TOOLS, ...ADMIN_TOOLS].sort(),
        );
      });
    },
    BUDGET_MS,
  );

  it(
    "takes a device-code client from 401 through setup to consent and a token listed every admin tool",
    async () => {
      await withInstance({}, async (instance) => {
        const { scope, discovery } = await discover(instance);
        const flow = await startDevice(discovery, scope);
        const browser = new Browser(instance, "192.0.2.20");
        const back = `/auth/device/consent?user_code=${encodeURIComponent(flow.userCode)}`;
        const signIn = await deviceSignIn(browser, flow);
        expect(signIn).toBe(throughSignIn(back));

        const claimed = await claimThrough(browser, instance, signIn, back);
        expect(claimed.status).toBe(303);
        expect(location(claimed)).toBe(back);
        expect(browser.holds("marfa_session")).toBe(true);

        const consent = await browser.get(back);
        expect(consent.status).toBe(200);
        const approved = await browser.post("/auth/device/consent", [
          ["user_code", flow.userCode],
          ["decision", "approve"],
          ...asDrawn(await consent.text()),
        ]);
        expect(approved.status).toBe(200);

        const polled = await pollDevice(discovery, flow);
        expect(polled.access_token, JSON.stringify(polled)).toBeDefined();
        expect(await adminToolsListed(instance, polled.access_token!)).toEqual(
          [...ALL_TOOLS, ...ADMIN_TOOLS].sort(),
        );
      });
    },
    BUDGET_MS,
  );

  it(
    "says to start connecting again in the app when the device code ended during setup",
    async () => {
      await withInstance({}, async (instance) => {
        const { scope, discovery } = await discover(instance);
        const flow = await startDevice(discovery, scope);
        const browser = new Browser(instance, "192.0.2.30");
        const back = `/auth/device/consent?user_code=${encodeURIComponent(flow.userCode)}`;
        const signIn = await deviceSignIn(browser, flow);

        const codePage = await browser.get(signIn);
        expect(carried(await codePage.text())).toEqual([back]);
        const exchanged = await browser.post("/setup/exchange", [
          ["code", await instance.code()],
          ["return_to", back],
        ]);
        expect(exchanged.status).toBe(303);

        // The device code ends while the setup session stands.
        await instance.advanceClock(DEVICE_CODE_MS + 1_000);
        const details = await browser.get(location(exchanged));
        expect(await details.text()).toContain('id="owner-form"');
        const claimed = await browser.post("/setup/claim", [
          ["username", OWNER.username],
          ["password", OWNER.password],
          ["return_to", back],
        ]);
        expect(location(claimed)).toBe(back);

        const entry = location(await browser.get(back));
        expect(new URL(entry, instance.url).searchParams.get("error")).toBe(
          "expired_code",
        );
        const page = await browser.get(entry);
        expect(page.status).toBe(200);
        expect(visibleText(await page.text())).toContain(DEVICE_EXPIRED);
        expect((await pollDevice(discovery, flow)).error).toBe("expired_token");
      });
    },
    BUDGET_MS,
  );
});

interface DeviceFlow {
  clientId: string;
  userCode: string;
  deviceCode: string;
  verification: string;
}

async function startDevice(
  discovery: Discovery,
  scope: string,
): Promise<DeviceFlow> {
  const registered = await fetch(discovery.registration_endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "claiming device",
      application_type: "native",
      grant_types: [
        "urn:ietf:params:oauth:grant-type:device_code",
        "refresh_token",
      ],
      response_types: [],
      token_endpoint_auth_method: "none",
      scope,
    }),
  });
  expect(registered.status).toBe(201);
  const clientId = ((await registered.json()) as { client_id: string })
    .client_id;
  const asked = await fetch(discovery.device_authorization_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, scope }),
  });
  expect(asked.status).toBe(200);
  const code = (await asked.json()) as {
    device_code: string;
    user_code: string;
    verification_uri_complete: string;
  };
  return {
    clientId,
    userCode: code.user_code,
    deviceCode: code.device_code,
    verification: code.verification_uri_complete,
  };
}

/** The person opens the device link and continues: answers the sign-in page it sends them to. */
async function deviceSignIn(
  browser: Browser,
  flow: DeviceFlow,
): Promise<string> {
  const entry = await browser.get(flow.verification);
  expect(entry.status).toBe(200);
  const entered = await browser.post("/auth/device", [
    ["user_code", flow.userCode],
  ]);
  const consent = location(entered);
  return location(await browser.get(consent));
}

async function pollDevice(
  discovery: Discovery,
  flow: DeviceFlow,
): Promise<{ access_token?: string; error?: string }> {
  const answer = await fetch(discovery.token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: flow.deviceCode,
      client_id: flow.clientId,
    }),
  });
  return (await answer.json()) as { access_token?: string; error?: string };
}

describe("the setup code page an app opens", () => {
  it(
    "names an app beside the host it sends the person back to, with the caution, and names no app that sends them to the loopback",
    async () => {
      await withInstance({}, async (instance) => {
        const signInFor = async (
          name: string,
          redirect: string,
        ): Promise<string> => {
          const registered = await fetch(`${instance.url}/oauth/register`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              client_name: name,
              application_type: redirect === CALLBACK ? "native" : "web",
              redirect_uris: [redirect],
              grant_types: ["authorization_code"],
              response_types: ["code"],
              token_endpoint_auth_method: "none",
              scope: "core.note:read",
            }),
          });
          expect(registered.status).toBe(201);
          const clientId = ((await registered.json()) as { client_id: string })
            .client_id;
          const browser = new Browser(instance, "192.0.2.80");
          const request = `/oauth/authorize?${new URLSearchParams({
            response_type: "code",
            client_id: clientId,
            redirect_uri: redirect,
            state: "named",
            scope: "core.note:read",
            code_challenge: pkce().challenge,
            code_challenge_method: "S256",
          }).toString()}`;
          const page = await browser.get(location(await browser.get(request)));
          expect(page.status).toBe(200);
          return visibleText(await page.text());
        };

        const web = await signInFor(
          "Web Notes",
          "https://notes.example/callback",
        );
        expect(web).toContain(
          "Web Notes at notes.example is asking to connect to this Marfa.",
        );
        expect(web).toContain("Marfa hasn't verified this app.");
        expect(web).toContain(APPROVAL_AFTER);

        const loopback = await signInFor("Local Notes", CALLBACK);
        expect(loopback).not.toContain("Local Notes");
        expect(loopback).not.toContain("is asking to connect");
        expect(loopback).toContain(APPROVAL_AFTER);
      });
    },
    BUDGET_MS,
  );
});

describe("return_to through setup", () => {
  it(
    "keeps return_to on the refusal pages for a wrong code, a replaced code and an ended setup session, and answers a wrong and a replaced code alike",
    async () => {
      await withInstance({}, async (instance) => {
        const browser = new Browser(instance, "192.0.2.40");
        const codeHtml = await (
          await browser.get(throughSignIn(AUTHORIZE))
        ).text();
        expect(carried(codeHtml)).toEqual([AUTHORIZE]);

        const refusal = async (code: string) => {
          const answer = await browser.post("/setup/exchange", [
            ["code", code],
            ["return_to", AUTHORIZE],
          ]);
          const html = await answer.text();
          return {
            status: answer.status,
            carried: carried(html),
            problem: /id="setup-problem"[^>]*>([^<]*)</.exec(html)?.[1],
          };
        };
        const replaced = await instance.code();
        await instance.restart();
        const wrong = await refusal("WRONG-CODE-0000");
        expect(wrong).toEqual({
          status: 401,
          carried: [AUTHORIZE],
          problem: expect.any(String) as string,
        });
        expect(visibleText(wrong.problem!)).toBe(WRONG_CODE);
        expect(await refusal(replaced)).toEqual(wrong);

        // The setup session the code opens ends after fifteen minutes.
        const exchanged = await browser.post("/setup/exchange", [
          ["code", await instance.code()],
          ["return_to", AUTHORIZE],
        ]);
        expect(exchanged.status).toBe(303);
        // The witness: the session opens the details page while it stands.
        const standing = await (await browser.get(location(exchanged))).text();
        expect(standing).toContain('id="owner-form"');
        await instance.advanceClock(SETUP_SESSION_MS + 1_000);
        const ended = await (await browser.get(location(exchanged))).text();
        expect(ended).not.toContain('id="owner-form"');
        expect(carried(ended)).toEqual([AUTHORIZE]);
        const claim = await browser.post("/setup/claim", [
          ["username", OWNER.username],
          ["password", OWNER.password],
          ["return_to", AUTHORIZE],
        ]);
        expect(claim.status).toBe(401);
        expect(carried(await claim.text())).toEqual([AUTHORIZE]);
      });
    },
    BUDGET_MS,
  );

  it(
    "reads a return_to that leaves the instance as the default page at every step of setup",
    async () => {
      await withInstance({}, async (instance) => {
        const foreign = "https://elsewhere.example/oauth/authorize?client_id=a";
        const browser = new Browser(instance, "192.0.2.50");
        // The witness: a return_to on this instance is carried.
        expect(
          carried(await (await browser.get(throughSignIn(AUTHORIZE))).text()),
        ).toEqual([AUTHORIZE]);
        expect(
          carried(await (await browser.get(throughSignIn(foreign))).text()),
        ).toEqual(["/"]);
        expect(
          carried(
            await (
              await browser.get(
                `/setup?return_to=${encodeURIComponent(foreign)}`,
              )
            ).text(),
          ),
        ).toEqual(["/"]);

        const exchanged = await browser.post("/setup/exchange", [
          ["code", await instance.code()],
          ["return_to", foreign],
        ]);
        expect(location(exchanged)).toBe("/setup");
        const claimed = await browser.post("/setup/claim", [
          ["username", OWNER.username],
          ["password", OWNER.password],
          ["return_to", foreign],
        ]);
        expect(location(claimed)).toBe("/auth/sign-in");
      });
    },
    BUDGET_MS,
  );

  it(
    "refuses return_to on POST /owner without consuming the setup code",
    async () => {
      await withInstance({}, async (instance) => {
        const code = await instance.code();
        const owner = (body: Record<string, string>) =>
          fetch(`${instance.url}/owner`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          });
        const refused = await owner({ ...OWNER, code, return_to: AUTHORIZE });
        expect(refused.status).toBe(400);
        const body = (await refused.json()) as {
          error: { code: string; details: { unknown_body_fields: string[] } };
        };
        expect(body.error.code).toBe("validation_error");
        expect(body.error.details.unknown_body_fields).toEqual(["return_to"]);
        expect((await owner({ ...OWNER, code })).status).toBe(201);
      });
    },
    BUDGET_MS,
  );

  it(
    "refuses return_to in a JSON body on POST /setup/exchange and POST /setup/claim without spending the setup code",
    async () => {
      await withInstance({}, async (instance) => {
        const code = await instance.code();
        const json = (path: string, body: Record<string, unknown>) =>
          fetch(`${instance.url}${path}`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              origin: instance.origin,
              [CLIENT]: "192.0.2.80",
            },
            body: JSON.stringify(body),
          });
        const refused = async (path: string, body: Record<string, unknown>) => {
          const answer = await json(path, body);
          expect(answer.status, path).toBe(400);
          const error = (
            (await answer.json()) as {
              error: {
                code: string;
                details: { unknown_body_fields: string[] };
              };
            }
          ).error;
          expect(error.code, path).toBe("validation_error");
          expect(error.details.unknown_body_fields, path).toEqual([
            "return_to",
          ]);
        };
        for (const back of [AUTHORIZE, 5]) {
          await refused("/setup/exchange", { code, return_to: back });
          await refused("/setup/claim", { ...OWNER, code, return_to: back });
        }
        // The witness: the same bodies without return_to exchange the code
        // and claim the instance.
        expect((await json("/setup/exchange", { code })).status).toBe(200);
        expect((await json("/setup/claim", { ...OWNER, code })).status).toBe(
          201,
        );
      });
    },
    BUDGET_MS,
  );

  it(
    "refuses a code form that names a purpose other than recovery, or recovery with return_to, without spending the setup code",
    async () => {
      await withInstance({}, async (instance) => {
        const browser = new Browser(instance, "192.0.2.81");
        const code = await instance.code();
        for (const fields of [
          [
            ["code", code],
            ["purpose", "setup"],
          ],
          [
            ["code", code],
            ["purpose", "recovery"],
            ["return_to", AUTHORIZE],
          ],
        ] as [string, string][][]) {
          const answer = await browser.post("/setup/exchange", fields);
          expect(answer.status).toBe(400);
        }
        expect(browser.holds("marfa_setup")).toBe(false);
        // The witness: the setup code form exchanges the same code.
        const exchanged = await browser.post("/setup/exchange", [
          ["code", code],
          ["return_to", AUTHORIZE],
        ]);
        expect(exchanged.status).toBe(303);
        expect(browser.holds("marfa_setup")).toBe(true);
      });
    },
    BUDGET_MS,
  );
});

describe("a claim another tab or a refused sign-in finished", () => {
  it(
    "answers a second tab's setup forms with the claimed notice, whose sign-in continues to return_to, and spends no recovery attempt",
    async () => {
      await withInstance({ MARFA_OWNER_RECOVERY: "true" }, async (instance) => {
        const first = new Browser(instance, "192.0.2.60");
        const second = new Browser(instance, "192.0.2.61");
        const code = await instance.code();
        for (const tab of [first, second]) {
          const exchanged = await tab.post("/setup/exchange", [
            ["code", code],
            ["return_to", AUTHORIZE],
          ]);
          expect(exchanged.status).toBe(303);
        }
        const claimed = await first.post("/setup/claim", [
          ["username", OWNER.username],
          ["password", OWNER.password],
          ["return_to", AUTHORIZE],
        ]);
        expect(location(claimed)).toBe(AUTHORIZE);

        const notices = [
          await second.post("/setup/claim", [
            ["username", "another"],
            ["password", "another owner password"],
            ["return_to", AUTHORIZE],
          ]),
          await second.post("/setup/exchange", [
            ["code", code],
            ["return_to", AUTHORIZE],
          ]),
          await second.post("/setup/exchange", [
            ["code", "   "],
            ["return_to", AUTHORIZE],
          ]),
          await second.get(`/setup?return_to=${encodeURIComponent(AUTHORIZE)}`),
        ];
        for (const notice of notices) {
          const html = await notice.text();
          expect(visibleText(html)).toContain(
            "This Marfa already has an owner",
          );
          expect(links(html)).toContain(throughSignIn(AUTHORIZE));
        }
        expect(notices.map((notice) => notice.status)).toEqual([
          409, 409, 409, 200,
        ]);

        // The notice's sign-in continues to the authorization.
        const signInHtml = await (
          await second.get(throughSignIn(AUTHORIZE))
        ).text();
        expect(signInHtml).toContain('name="password"');
        expect(carried(signInHtml)).toEqual([AUTHORIZE]);
        const signedIn = await second.post("/auth/sign-in", [
          ["username", OWNER.username],
          ["password", OWNER.password],
          ["return_to", AUTHORIZE],
        ]);
        expect(location(signedIn)).toBe(AUTHORIZE);

        // A setup code form posted to the claimed instance is never read as
        // a recovery code: eleven from one address are all answered with
        // the notice, and that address still has its recovery attempts.
        const stale = new Browser(instance, "192.0.2.62");
        for (let i = 0; i < 11; i++) {
          const answer = await stale.post("/setup/exchange", [
            ["code", `STALE-CODE-${String(i)}`],
            ["return_to", AUTHORIZE],
          ]);
          expect(answer.status).toBe(409);
        }
        const recovery = (browser: Browser) =>
          browser.post("/setup/exchange", [
            ["code", "WRONG-RECOVERY"],
            ["purpose", "recovery"],
          ]);
        expect((await recovery(stale)).status).toBe(401);
        // The witness: ten recovery codes spend an address's attempts.
        const spender = new Browser(instance, "192.0.2.63");
        for (let i = 0; i < 10; i++)
          expect((await recovery(spender)).status).toBe(401);
        expect((await recovery(spender)).status).toBe(429);
      });
    },
    BUDGET_MS,
  );

  it(
    "reads a code form from a plain /setup page left open while the instance was claimed as a setup code, with or without its return_to, and spends no recovery attempt",
    async () => {
      await withInstance({ MARFA_OWNER_RECOVERY: "true" }, async (instance) => {
        const stale = new Browser(instance, "192.0.2.64");
        const setupHtml = await (await stale.get("/setup")).text();
        expect(setupHtml).toContain('action="/setup/exchange"');
        const setupForm = hiddenFields(setupHtml);
        const owner = await fetch(`${instance.url}/owner`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...OWNER, code: await instance.code() }),
        });
        expect(owner.status).toBe(201);
        // A start with recovery on prints a recovery code, which the
        // recovery page then offers.
        await instance.restart();
        const recoveryHtml = await (await stale.get("/setup")).text();
        expect(visibleText(recoveryHtml)).toContain("Recover the owner");
        const recoveryForm = hiddenFields(recoveryHtml);

        // The setup code form as the page sent it, then ten with no hidden
        // field at all: each is answered with the notice.
        for (let i = 0; i < 11; i++) {
          const answer = await stale.post("/setup/exchange", [
            ...(i === 0 ? setupForm : []),
            ["code", `STALE-CODE-${String(i)}`],
          ]);
          expect(answer.status).toBe(409);
          expect(visibleText(await answer.text())).toContain(
            "This Marfa already has an owner",
          );
        }
        const recovery = (browser: Browser) =>
          browser.post("/setup/exchange", [
            ...recoveryForm,
            ["code", "WRONG-RECOVERY"],
          ]);
        expect((await recovery(stale)).status).toBe(401);
        // The witness: ten codes from the recovery page's form spend an
        // address's attempts.
        const spender = new Browser(instance, "192.0.2.65");
        for (let i = 0; i < 10; i++)
          expect((await recovery(spender)).status).toBe(401);
        expect((await recovery(spender)).status).toBe(429);
      });
    },
    BUDGET_MS,
  );

  it(
    "sends a claim whose sign-in is refused to the sign-in page that continues to return_to",
    async () => {
      await withInstance({}, async (instance) => {
        const address = "192.0.2.70";
        // An address that has spent its password attempts is refused the
        // sign-in that follows its claim.
        for (let i = 0; i < 10; i++) {
          const refused = await fetch(`${instance.url}/auth/sign-in`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              origin: instance.origin,
              [CLIENT]: address,
            },
            body: JSON.stringify({ ...OWNER, password: "incorrect password" }),
          });
          expect(refused.status).toBe(401);
        }
        const browser = new Browser(instance, address);
        const exchanged = await browser.post("/setup/exchange", [
          ["code", await instance.code()],
          ["return_to", AUTHORIZE],
        ]);
        expect(exchanged.status).toBe(303);
        const claimed = await browser.post("/setup/claim", [
          ["username", OWNER.username],
          ["password", OWNER.password],
          ["return_to", AUTHORIZE],
        ]);
        expect(location(claimed)).toBe(throughSignIn(AUTHORIZE));
        expect(browser.holds("marfa_session")).toBe(false);

        const signInHtml = await (await browser.get(location(claimed))).text();
        expect(carried(signInHtml)).toEqual([AUTHORIZE]);
        const elsewhere = new Browser(instance, "192.0.2.71");
        const signedIn = await elsewhere.post("/auth/sign-in", [
          ["username", OWNER.username],
          ["password", OWNER.password],
          ["return_to", AUTHORIZE],
        ]);
        expect(location(signedIn)).toBe(AUTHORIZE);
      });
    },
    BUDGET_MS,
  );
});

describe("GET /health on an instance with no owner", () => {
  it(
    "answers claimed false to a caller with no credential, and true once the instance is claimed",
    async () => {
      await withInstance({}, async (instance) => {
        const claimed = async () =>
          (
            (await (await fetch(`${instance.url}/health`)).json()) as {
              claimed: unknown;
            }
          ).claimed;
        expect(await claimed()).toBe(false);
        const owner = await fetch(`${instance.url}/owner`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...OWNER, code: await instance.code() }),
        });
        expect(owner.status).toBe(201);
        expect(await claimed()).toBe(true);
      });
    },
    BUDGET_MS,
  );
});
