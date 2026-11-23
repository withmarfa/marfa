import { rm } from "node:fs/promises";
import { request } from "node:http";
import { afterAll, describe, expect, it } from "vitest";
import {
  bootUnclaimedServer,
  stopServer,
} from "../../../scripts/marfa-server.js";
import { signInOwnerWithPassword } from "../../client/owner-session.js";
import { readControls } from "../../utils/approval-form.js";
import { controlRequest } from "../../utils/control-request.js";
import {
  approvedApp,
  bootFreshServer,
  bootRefused,
  FRESH_SERVER_TIMEOUT_MS,
  keepStatusLog,
  serverOutput,
  stopFreshServers,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { pageField, visibleText } from "../../utils/page-html.js";
import { listened, settingLines } from "../../utils/refused-boot.js";
import { TEST_OWNER } from "../../utils/target.js";
import { tempFolder } from "../../utils/temp-folder.js";

/** Claiming from off the machine, and recovering the owner with a code a start prints. */

const CLIENT = "x-real-ip";
const ELSEWHERE = "203.0.113.7";
const PROXIED = {
  MARFA_TRUSTED_PROXY_HEADER: CLIENT,
  MARFA_TRUSTED_PROXY_CIDRS: "127.0.0.0/8",
};
const CLAIM_ADDRESS = "https://marfa.example";
const NEW_PASSWORD = "a recovered owner password";
const HOUR_MS = 60 * 60_000;
const CODE_SHAPE = /^[A-Z2-7]{5}(-[A-Z2-7]{5}){4}$/;
const MISMATCH = "The passwords don't match.";

interface Unclaimed {
  state: string;
  url: string;
  controlSocket: string;
}

const states: string[] = [];

afterAll(async () => {
  for (const state of states) {
    await stopServer({ state });
    keepStatusLog(state);
    await rm(state, { recursive: true, force: true });
  }
  await stopFreshServers();
}, 4 * FRESH_SERVER_TIMEOUT_MS);

/** A server with no owner and no seeded sign-in address. */
async function bootUnclaimed(
  label: string,
  env: Record<string, string> = {},
): Promise<Unclaimed> {
  const state = tempFolder(`marfa-${label}-`);
  states.push(state);
  return bootAgain(state, env);
}

async function bootAgain(
  state: string,
  env: Record<string, string> = {},
): Promise<Unclaimed> {
  const server = await bootUnclaimedServer({
    state,
    env: { MARFA_SIGN_IN_ADDRESS: "", ...PROXIED, ...env },
  });
  return { state, ...server };
}

function codesIn(log: string, kind: "setup" | "recovery"): string[] {
  return [...log.matchAll(new RegExp(`${kind} code: ([A-Z2-7-]+)`, "g"))].map(
    (match) => match[1]!,
  );
}

async function lastRecoveryCode(server: FreshServer): Promise<string> {
  const codes = codesIn(await server.output(), "recovery");
  expect(codes.length).toBeGreaterThan(0);
  return codes.at(-1)!;
}

function post(
  url: string,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${url}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function answer(
  response: Response,
): Promise<{ status: number; code?: string }> {
  const body = (await response.json().catch(() => ({}))) as {
    error?: { code?: string };
  };
  return { status: response.status, code: body.error?.code };
}

async function storedConfig(socket: string): Promise<Record<string, unknown>> {
  const read = await controlRequest(socket, "/config");
  expect(read.status).toBe(200);
  return read.body;
}

function cookiesOf(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0])
    .join("; ");
}

async function pageText(url: string, cookie?: string): Promise<string> {
  const page = await fetch(`${url}/setup`, {
    headers: cookie === undefined ? {} : { cookie },
  });
  expect(page.status).toBe(200);
  return page.text();
}

/** Whether a password sign-in with `password` gives the owner a session. */
async function signsIn(server: FreshServer, password: string) {
  return signInOwnerWithPassword(server.apiUrl, new URL(server.apiUrl).origin, {
    username: TEST_OWNER.username,
    password,
  }).then(
    () => true,
    () => false,
  );
}

/** Whether the owner's browser session still opens the owner's own door. */
async function browserLive(server: FreshServer, cookie: string) {
  const response = await fetch(`${server.apiUrl}/owner/passkeys`, {
    headers: { cookie },
  });
  await response.body?.cancel();
  return response.status === 200;
}

async function itemsStatus(server: FreshServer, token: string) {
  const response = await fetch(`${server.apiUrl}/items?type=core.note`, {
    headers: { authorization: `Bearer ${token}` },
  });
  await response.body?.cancel();
  return response.status;
}

async function ownerId(server: FreshServer): Promise<unknown> {
  const status = await controlRequest(
    server.controlSocket,
    "/_control/setup/status",
  );
  expect(status.status).toBe(200);
  return status.body.owner_id;
}

/** A claimed server that prints a recovery code at each start after its first. */
async function recoverable(
  label: string,
  env: Record<string, string> = {},
): Promise<FreshServer> {
  return bootFreshServer(label, { MARFA_OWNER_RECOVERY: "true", ...env });
}

/** What a recovery leaves that a client can see. */
async function afterRecovery(
  server: FreshServer,
  before: { owner: unknown; cookie: string; app: string },
) {
  return {
    sameOwner: (await ownerId(server)) === before.owner,
    oldPassword: await signsIn(server, TEST_OWNER.password),
    newPassword: await signsIn(server, NEW_PASSWORD),
    oldBrowser: await browserLive(server, before.cookie),
    key: await itemsStatus(server, server.workingKey),
    app: await itemsStatus(server, before.app),
  };
}

async function beforeRecovery(server: FreshServer) {
  return {
    owner: await ownerId(server),
    cookie: server.ownerCookie,
    app: (await approvedApp(server, ["core.note:read"])).token,
  };
}

/** What a request sends that names a host other than the instance's own. */
function forged(
  url: string,
  method: string,
  path: string,
  body?: string,
): Promise<number> {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const sent = request(
      {
        host: target.hostname,
        port: target.port,
        method,
        path,
        headers: {
          host: "marfa.attacker.example",
          "x-forwarded-host": "marfa.attacker.example",
          "x-forwarded-proto": "https",
          [CLIENT]: ELSEWHERE,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
      },
      (response) => {
        response.resume();
        response.on("end", () => resolve(response.statusCode ?? 0));
      },
    );
    sent.on("error", reject);
    sent.end(body);
  });
}

/** A browser's form post to a setup door, as its page sends it. */
function formPost(
  url: string,
  path: string,
  fields: Record<string, string>,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${url}${path}`, {
    method: "POST",
    redirect: "manual",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "text/html",
      origin: new URL(url).origin,
      ...headers,
    },
    body: new URLSearchParams(fields),
  });
}

describe("the setup code", () => {
  it(
    "is twenty-five letters and digits in five groups of five, is claimed with however a person types it, and is printed with a link that works once",
    async () => {
      const server = await bootUnclaimed("setup-code-shape");
      const log = serverOutput(server.state);
      const [code] = codesIn(log, "setup");
      expect(code).toMatch(CODE_SHAPE);
      const line = log.split("\n").find((one) => one.includes("setup code:"))!;
      const ticket = /\/setup#handoff=([0-9a-f]+)/.exec(line)?.[1];
      expect(ticket).toBeDefined();
      const origin = new URL(server.url).origin;
      const exchange = () =>
        post(server.url, "/setup/exchange", { ticket }, { origin });
      expect((await exchange()).status).toBe(200);
      expect(await answer(await exchange())).toEqual({
        status: 401,
        code: "setup_proof_invalid",
      });
      // The witness: the line's code is still good, typed in lowercase with spaces.
      const typed = ` ${code!.toLowerCase().replaceAll("-", " ")}\n`;
      expect(
        (await post(server.url, "/setup/claim", { ...TEST_OWNER, code: typed }))
          .status,
      ).toBe(201);
    },
    FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "is the shape of a recovery code too",
    async () => {
      const server = await recoverable("recovery-code-shape");
      await server.restart();
      expect(await lastRecoveryCode(server)).toMatch(CODE_SHAPE);
    },
    2 * FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "refuses a claim form whose two passwords differ, with both password fields empty and nothing claimed",
    async () => {
      const server = await bootUnclaimed("claim-confirm");
      const [code] = codesIn(serverOutput(server.state), "setup");
      const claimed = async () =>
        (await controlRequest(server.controlSocket, "/_control/setup/status"))
          .body.claimed;
      const fields = {
        username: TEST_OWNER.username,
        name: "",
        password: TEST_OWNER.password,
        code: code!,
      };
      const refused = await formPost(server.url, "/setup/claim", {
        ...fields,
        confirm_password: `${TEST_OWNER.password}!`,
      });
      expect(refused.status).toBe(400);
      const html = await refused.text();
      expect(visibleText(html)).toContain(MISMATCH);
      expect(pageField(html, "username")?.value).toBe(TEST_OWNER.username);
      expect(pageField(html, "password")?.value ?? "").toBe("");
      expect(pageField(html, "confirm_password")?.value ?? "").toBe("");
      expect(html).not.toContain(TEST_OWNER.password);
      expect(await claimed()).toBe(false);

      // The witness: the same form with the passwords alike claims.
      const matched = await formPost(server.url, "/setup/claim", {
        ...fields,
        confirm_password: TEST_OWNER.password,
      });
      expect(matched.status).toBe(303);
      expect(await claimed()).toBe(true);
    },
    FRESH_SERVER_TIMEOUT_MS,
  );
});

describe("the claim address", () => {
  it(
    "stores MARFA_CLAIM_ADDRESS as the sign-in address of an instance with no owner, and names the full setup address in the setup code's line",
    async () => {
      // The witness: without the setting nothing is stored and the line names
      // the page alone.
      const plain = await bootUnclaimed("claim-address-plain");
      expect(await storedConfig(plain.controlSocket)).not.toHaveProperty(
        "sign_in_address",
      );
      expect(serverOutput(plain.state)).toMatch(
        /Claim this Marfa at \/setup with setup code: [A-Z2-7-]+/,
      );

      const set = await bootUnclaimed("claim-address-set", {
        MARFA_CLAIM_ADDRESS: `${CLAIM_ADDRESS}/`,
      });
      expect((await storedConfig(set.controlSocket)).sign_in_address).toBe(
        CLAIM_ADDRESS,
      );
      expect(serverOutput(set.state)).toMatch(
        new RegExp(
          `Claim this Marfa at ${CLAIM_ADDRESS}/setup with setup code: [A-Z2-7-]+`,
        ),
      );
    },
    2 * FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "claims from a caller off this machine once MARFA_CLAIM_ADDRESS has stored the sign-in address, and refuses it 403 without",
    async () => {
      const plain = await bootUnclaimed("claim-address-refused-claim");
      const [plainCode] = codesIn(serverOutput(plain.state), "setup");
      const refused = await post(
        plain.url,
        "/setup/claim",
        { ...TEST_OWNER, code: plainCode },
        { [CLIENT]: ELSEWHERE },
      );
      expect(await answer(refused)).toEqual({
        status: 403,
        code: "forbidden",
      });
      // The private socket's claim is open to the machine as before.
      expect(
        (
          await controlRequest(plain.controlSocket, "/_control/setup/claim", {
            method: "POST",
            body: TEST_OWNER,
          })
        ).status,
      ).toBe(201);

      const set = await bootUnclaimed("claim-address-claim", {
        MARFA_CLAIM_ADDRESS: CLAIM_ADDRESS,
      });
      const [code] = codesIn(serverOutput(set.state), "setup");
      const claimed = await post(
        set.url,
        "/setup/claim",
        { ...TEST_OWNER, code },
        { [CLIENT]: ELSEWHERE },
      );
      expect(claimed.status).toBe(201);
      expect(
        (await controlRequest(set.controlSocket, "/_control/setup/status")).body
          .claimed,
      ).toBe(true);
    },
    2 * FRESH_SERVER_TIMEOUT_MS,
  );

  it.each([
    ["an http address off this machine", "http://marfa.example"],
    ["an address with a path", "https://marfa.example/marfa"],
    ["an address with a query", "https://marfa.example/?at=1"],
    ["a host with no scheme", "marfa.example"],
  ])(
    "refuses to start on a MARFA_CLAIM_ADDRESS that is %s, naming the setting",
    async (_, value) => {
      const refused = await bootRefused("claim-address-invalid", {
        extraEnv: { MARFA_CLAIM_ADDRESS: value },
      });
      try {
        expect(refused).toMatchObject({ code: 1, signal: null });
        expect(listened(refused)).toBe(false);
        const lines = settingLines(refused);
        expect(lines).toHaveLength(1);
        expect(lines[0]).toMatch(/^MARFA_CLAIM_ADDRESS /);
      } finally {
        await refused.stop();
      }
    },
    FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "leaves an owned instance's sign-in address as the owner set it, and logs at each start that MARFA_CLAIM_ADDRESS is ignored",
    async () => {
      const ignored = (state: string) =>
        serverOutput(state).split("MARFA_CLAIM_ADDRESS is ignored").length - 1;
      const first = await bootUnclaimed("claim-address-owned", {
        MARFA_CLAIM_ADDRESS: "https://first.example",
      });
      const { state, controlSocket } = first;
      expect((await storedConfig(controlSocket)).sign_in_address).toBe(
        "https://first.example",
      );
      expect(ignored(state)).toBe(0);
      expect(
        (
          await controlRequest(controlSocket, "/_control/setup/claim", {
            method: "POST",
            body: TEST_OWNER,
          })
        ).status,
      ).toBe(201);
      const moved = await controlRequest(controlSocket, "/config", {
        method: "PATCH",
        body: {
          sign_in_address: "https://owner.example",
          confirm_sign_in_address_change: true,
          skip_sign_in_address_check: true,
        },
      });
      expect(moved.status, JSON.stringify(moved.body)).toBe(200);

      await stopServer({ state });
      const again = await bootAgain(state, {
        MARFA_CLAIM_ADDRESS: CLAIM_ADDRESS,
      });
      expect((await storedConfig(again.controlSocket)).sign_in_address).toBe(
        "https://owner.example",
      );
      expect(ignored(state)).toBe(1);

      await stopServer({ state });
      const third = await bootAgain(state, {
        MARFA_CLAIM_ADDRESS: CLAIM_ADDRESS,
      });
      expect((await storedConfig(third.controlSocket)).sign_in_address).toBe(
        "https://owner.example",
      );
      expect(ignored(state)).toBe(2);
    },
    3 * FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "never takes the sign-in address from a request's Host, X-Forwarded-Host or client address header",
    async () => {
      const server = await bootUnclaimed("claim-address-forged");
      const [code] = codesIn(serverOutput(server.state), "setup");
      expect(await forged(server.url, "GET", "/setup")).toBe(200);
      expect(
        await forged(
          server.url,
          "POST",
          "/setup/exchange",
          JSON.stringify({ code: "WRONG-CODE" }),
        ),
      ).toBe(403);
      expect(
        await forged(
          server.url,
          "POST",
          "/setup/claim",
          JSON.stringify({ ...TEST_OWNER, code }),
        ),
      ).toBe(403);
      expect(await storedConfig(server.controlSocket)).not.toHaveProperty(
        "sign_in_address",
      );

      // The witness: the private socket stores one, and the same claim from
      // off the machine then goes through.
      const set = await controlRequest(server.controlSocket, "/config", {
        method: "PATCH",
        body: { sign_in_address: CLAIM_ADDRESS },
      });
      expect(set.status, JSON.stringify(set.body)).toBe(200);
      expect((await storedConfig(server.controlSocket)).sign_in_address).toBe(
        CLAIM_ADDRESS,
      );
      expect(
        await forged(
          server.url,
          "POST",
          "/setup/claim",
          JSON.stringify({ ...TEST_OWNER, code }),
        ),
      ).toBe(201);
      expect((await storedConfig(server.controlSocket)).sign_in_address).toBe(
        CLAIM_ADDRESS,
      );
    },
    FRESH_SERVER_TIMEOUT_MS,
  );
});

describe("owner recovery", () => {
  it(
    "prints a recovery code at each start of an instance with an owner while MARFA_OWNER_RECOVERY is on, and ends it at a start with the setting off",
    async () => {
      const server = await recoverable("recovery-issued");
      // The first start had no owner to recover.
      expect(codesIn(await server.output(), "recovery")).toHaveLength(0);
      await server.restart();
      const log = await server.output();
      expect(codesIn(log, "recovery")).toHaveLength(1);
      expect(log).toMatch(
        /Recover this Marfa's owner at \/setup with recovery code: [A-Z2-7-]+\. It works once, for 60 minutes\./,
      );
      const code = await lastRecoveryCode(server);
      expect(await pageText(server.apiUrl)).toContain("Recover the owner");

      await server.restart({ env: { MARFA_OWNER_RECOVERY: "false" } });
      expect(codesIn(await server.output(), "recovery")).toHaveLength(1);
      expect(await pageText(server.apiUrl)).not.toContain("Recover the owner");
      const origin = new URL(server.apiUrl).origin;
      expect(
        await answer(
          await post(server.apiUrl, "/setup/exchange", { code }, { origin }),
        ),
      ).toEqual({ status: 409, code: "owner_exists" });
      expect(
        await answer(
          await post(server.apiUrl, "/setup/recover", {
            code,
            password: NEW_PASSWORD,
          }),
        ),
      ).toEqual({ status: 401, code: "setup_proof_invalid" });
      expect(await signsIn(server, TEST_OWNER.password)).toBe(true);
    },
    3 * FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "prints no recovery code and creates no owner while the instance has none",
    async () => {
      const server = await bootUnclaimed("recovery-unclaimed", {
        MARFA_OWNER_RECOVERY: "true",
      });
      const log = serverOutput(server.state);
      // The witness: the same start printed its setup code.
      expect(codesIn(log, "setup")).toHaveLength(1);
      expect(codesIn(log, "recovery")).toHaveLength(0);
      const [setupCode] = codesIn(log, "setup");
      expect(
        await answer(
          await post(server.url, "/setup/recover", {
            code: setupCode,
            password: NEW_PASSWORD,
          }),
        ),
      ).toEqual({ status: 404, code: "owner_not_found" });
      expect(
        (await controlRequest(server.controlSocket, "/_control/setup/status"))
          .body.claimed,
      ).toBe(false);
    },
    FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "replaces the recovery code at each start and refuses the replaced one",
    async () => {
      const server = await recoverable("recovery-replaced");
      await server.restart();
      const first = await lastRecoveryCode(server);
      await server.restart();
      const second = await lastRecoveryCode(server);
      expect(second).not.toBe(first);
      const origin = new URL(server.apiUrl).origin;
      expect(
        await answer(
          await post(
            server.apiUrl,
            "/setup/exchange",
            { code: first },
            { origin },
          ),
        ),
      ).toEqual({ status: 401, code: "setup_proof_invalid" });
      // The witness: the code the latest start printed opens recovery.
      expect(
        (
          await post(
            server.apiUrl,
            "/setup/exchange",
            { code: second },
            { origin },
          )
        ).status,
      ).toBe(200);
    },
    3 * FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "refuses a recovery code sixty minutes after the start that printed it",
    async () => {
      const server = await recoverable("recovery-expiry");
      await server.restart();
      const code = await lastRecoveryCode(server);
      await server.advanceClock(HOUR_MS - 60_000);
      // The witness: a minute before the hour is out, the code is offered.
      expect(await pageText(server.apiUrl)).toContain("Recover the owner");
      await server.advanceClock(2 * 60_000);
      expect(await pageText(server.apiUrl)).not.toContain("Recover the owner");
      expect(
        await answer(
          await post(
            server.apiUrl,
            "/setup/exchange",
            { code },
            { origin: new URL(server.apiUrl).origin },
          ),
        ),
      ).toEqual({ status: 401, code: "setup_proof_invalid" });
    },
    2 * FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "spends a recovery code at its first use",
    async () => {
      const server = await recoverable("recovery-single-use");
      await server.restart();
      const code = await lastRecoveryCode(server);
      const origin = new URL(server.apiUrl).origin;
      expect(
        (await post(server.apiUrl, "/setup/exchange", { code }, { origin }))
          .status,
      ).toBe(200);
      expect(
        await answer(
          await post(server.apiUrl, "/setup/exchange", { code }, { origin }),
        ),
      ).toEqual({ status: 401, code: "setup_proof_invalid" });
      expect(
        await answer(
          await post(server.apiUrl, "/setup/recover", {
            code,
            password: NEW_PASSWORD,
          }),
        ),
      ).toEqual({ status: 401, code: "setup_proof_invalid" });
      expect(await signsIn(server, TEST_OWNER.password)).toBe(true);
    },
    2 * FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "accepts only one of two uses of a recovery code sent at once, to recover and to exchange",
    async () => {
      const [server, exchanging] = await Promise.all([
        recoverable("recovery-race"),
        recoverable("recovery-race-exchange"),
      ]);
      await Promise.all([server.restart(), exchanging.restart()]);
      const code = await lastRecoveryCode(server);
      const passwords = [`${NEW_PASSWORD} one`, `${NEW_PASSWORD} two`];
      const recovered = await Promise.all(
        passwords.map(async (password) =>
          answer(
            await post(server.apiUrl, "/setup/recover", { code, password }),
          ),
        ),
      );
      expect(recovered.map((one) => one.status).sort()).toEqual([200, 401]);
      expect(recovered.find((one) => one.status === 401)?.code).toBe(
        "setup_proof_invalid",
      );
      const won = passwords[recovered.findIndex((one) => one.status === 200)]!;
      const lost = passwords.find((password) => password !== won)!;
      expect(await signsIn(server, won)).toBe(true);
      expect(await signsIn(server, lost)).toBe(false);

      const next = await lastRecoveryCode(exchanging);
      const origin = new URL(exchanging.apiUrl).origin;
      const exchanged = await Promise.all(
        [0, 1].map(async () =>
          answer(
            await post(
              exchanging.apiUrl,
              "/setup/exchange",
              { code: next },
              { origin },
            ),
          ),
        ),
      );
      expect(exchanged.map((one) => one.status).sort()).toEqual([200, 401]);
      expect(exchanged.find((one) => one.status === 401)?.code).toBe(
        "setup_proof_invalid",
      );
    },
    3 * FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "recovers the owner on the setup page: the code opens a new password form, which ends every browser session and keeps keys and apps",
    async () => {
      const server = await recoverable("recovery-page");
      const before = await beforeRecovery(server);
      await server.restart();
      const code = await lastRecoveryCode(server);
      const origin = new URL(server.apiUrl).origin;

      const first = await pageText(server.apiUrl);
      expect(first).toContain("Recover the owner");
      expect(first).toContain('action="/setup/exchange"');
      // The form as the page sends it: its hidden fields and the code.
      const hidden = readControls(first)
        .filter((control) => control.type === "hidden")
        .map((control): [string, string] => [control.name, control.value]);
      const exchanged = await fetch(`${server.apiUrl}/setup/exchange`, {
        method: "POST",
        redirect: "manual",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          accept: "text/html",
          origin,
        },
        body: new URLSearchParams([...hidden, ["code", code]]),
      });
      expect(exchanged.status).toBe(303);
      expect(exchanged.headers.get("location")).toBe("/setup");
      const setup = cookiesOf(exchanged);
      expect(await pageText(server.apiUrl, setup)).toContain(
        'id="recover-form"',
      );
      // The witness: the browser, the key and the app work before the form is sent.
      expect(await browserLive(server, before.cookie)).toBe(true);
      expect(await itemsStatus(server, before.app)).toBe(200);

      const sent = await fetch(`${server.apiUrl}/setup/recover`, {
        method: "POST",
        redirect: "manual",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          cookie: setup,
          origin,
        },
        body: new URLSearchParams({ password: NEW_PASSWORD }),
      });
      await sent.body?.cancel();
      expect(sent.status).toBe(303);
      expect(await afterRecovery(server, before)).toEqual({
        sameOwner: true,
        oldPassword: false,
        newPassword: true,
        oldBrowser: false,
        key: 200,
        app: 200,
      });
      expect(
        (
          await post(
            server.apiUrl,
            "/setup/recover",
            { password: "another owner password" },
            { cookie: setup, origin },
          )
        ).status,
      ).toBe(401);
    },
    2 * FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "refuses a recovery form whose two passwords differ, with both password fields empty, and keeps the password and the code for another try",
    async () => {
      const server = await recoverable("recovery-confirm");
      await server.restart();
      const code = await lastRecoveryCode(server);
      const exchanged = await formPost(server.apiUrl, "/setup/exchange", {
        code,
        purpose: "recovery",
      });
      expect(exchanged.status).toBe(303);
      const setup = cookiesOf(exchanged);

      const refused = await formPost(
        server.apiUrl,
        "/setup/recover",
        { password: NEW_PASSWORD, confirm_password: `${NEW_PASSWORD}!` },
        { cookie: setup },
      );
      expect(refused.status).toBe(400);
      const html = await refused.text();
      expect(visibleText(html)).toContain(MISMATCH);
      expect(html).toContain('id="recover-form"');
      expect(pageField(html, "password")?.value ?? "").toBe("");
      expect(pageField(html, "confirm_password")?.value ?? "").toBe("");
      expect(html).not.toContain(NEW_PASSWORD);
      expect(await signsIn(server, TEST_OWNER.password)).toBe(true);

      // The witness: the same session, with the passwords alike, recovers.
      const matched = await formPost(
        server.apiUrl,
        "/setup/recover",
        { password: NEW_PASSWORD, confirm_password: NEW_PASSWORD },
        { cookie: setup },
      );
      expect(matched.status).toBe(303);
      expect(await signsIn(server, NEW_PASSWORD)).toBe(true);
      expect(await signsIn(server, TEST_OWNER.password)).toBe(false);
    },
    2 * FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "leaves after a recovery by code the state the private socket's recovery leaves",
    async () => {
      const [byCode, bySocket] = await Promise.all([
        recoverable("recovery-by-code"),
        recoverable("recovery-by-socket"),
      ]);
      const [codeBefore, socketBefore] = await Promise.all([
        beforeRecovery(byCode),
        beforeRecovery(bySocket),
      ]);
      await byCode.restart();
      const code = await lastRecoveryCode(byCode);

      const recovered = await post(byCode.apiUrl, "/setup/recover", {
        code,
        password: NEW_PASSWORD,
      });
      expect(recovered.status).toBe(200);
      expect(await recovered.json()).toEqual({ recovered: true });
      const local = await controlRequest(
        bySocket.controlSocket,
        "/_control/owner/recover",
        { method: "POST", body: { password: NEW_PASSWORD } },
      );
      expect(local.status).toBe(200);

      const expected = {
        sameOwner: true,
        oldPassword: false,
        newPassword: true,
        oldBrowser: false,
        key: 200,
        app: 200,
      };
      expect(await afterRecovery(byCode, codeBefore)).toEqual(expected);
      expect(await afterRecovery(bySocket, socketBefore)).toEqual(expected);
    },
    3 * FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "refuses a new password the private socket's recovery refuses, and keeps the code for another try",
    async () => {
      const server = await recoverable("recovery-password-rules");
      await server.restart();
      const code = await lastRecoveryCode(server);
      for (const refused of ["7 chars", "x".repeat(129)]) {
        expect(
          (
            await controlRequest(
              server.controlSocket,
              "/_control/owner/recover",
              {
                method: "POST",
                body: { password: refused },
              },
            )
          ).status,
        ).toBe(400);
        expect(
          await answer(
            await post(server.apiUrl, "/setup/recover", {
              code,
              password: refused,
            }),
          ),
        ).toEqual({ status: 400, code: "validation_error" });
      }
      expect(await signsIn(server, TEST_OWNER.password)).toBe(true);
      expect(
        (
          await post(server.apiUrl, "/setup/recover", {
            code,
            password: NEW_PASSWORD,
          })
        ).status,
      ).toBe(200);
      expect(await signsIn(server, NEW_PASSWORD)).toBe(true);
    },
    2 * FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "limits recovery code attempts to ten per address in fifteen minutes",
    async () => {
      const server = await recoverable("recovery-attempts", {
        MARFA_TRUSTED_PROXY_HEADER: "x-conformance-client",
        MARFA_TRUSTED_PROXY_CIDRS: "127.0.0.0/8",
      });
      await server.restart();
      const code = await lastRecoveryCode(server);
      const origin = new URL(server.apiUrl).origin;
      const from = (address: string) => ({
        origin,
        "x-conformance-client": address,
      });
      for (let attempt = 0; attempt < 10; attempt++) {
        expect(
          await answer(
            await post(
              server.apiUrl,
              "/setup/exchange",
              { code: "WRONG-CODE" },
              from("192.0.2.1"),
            ),
          ),
        ).toEqual({ status: 401, code: "setup_proof_invalid" });
      }
      expect(
        await answer(
          await post(
            server.apiUrl,
            "/setup/exchange",
            { code },
            from("192.0.2.1"),
          ),
        ),
      ).toEqual({ status: 429, code: "rate_limited" });
      expect(
        await answer(
          await post(
            server.apiUrl,
            "/setup/recover",
            { code, password: NEW_PASSWORD },
            from("192.0.2.1"),
          ),
        ),
      ).toEqual({ status: 429, code: "rate_limited" });
      // The witness: the same code from another address goes through.
      expect(
        (
          await post(
            server.apiUrl,
            "/setup/exchange",
            { code },
            from("192.0.2.2"),
          )
        ).status,
      ).toBe(200);
    },
    2 * FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "leaves the recovery code out of the request log and the health answer",
    async () => {
      const server = await recoverable("recovery-private");
      await server.restart();
      const code = await lastRecoveryCode(server);
      const origin = new URL(server.apiUrl).origin;
      expect(
        (await post(server.apiUrl, "/setup/exchange", { code }, { origin }))
          .status,
      ).toBe(200);
      const health = await (await fetch(`${server.apiUrl}/health`)).text();
      const local = await controlRequest(server.controlSocket, "/health");

      const lines = (await server.output()).split("\n").flatMap((line) => {
        try {
          return [JSON.parse(line) as Record<string, unknown>];
        } catch {
          return [];
        }
      });
      const requests = lines.filter(
        (line) =>
          typeof line.level !== "string" || typeof line.message !== "string",
      );
      // The witness: the exchange is in the request log, and the code is in
      // the server's own line.
      expect(
        requests.some(
          (line) => line.path === "/setup/exchange" && line.status === 200,
        ),
      ).toBe(true);
      expect(
        lines.some(
          (line) =>
            typeof line.message === "string" && line.message.includes(code),
        ),
      ).toBe(true);
      for (const line of requests) {
        expect(JSON.stringify(line)).not.toContain(code);
      }
      expect(health).not.toContain(code);
      expect(JSON.stringify(local.body)).not.toContain(code);
    },
    2 * FRESH_SERVER_TIMEOUT_MS,
  );
});
