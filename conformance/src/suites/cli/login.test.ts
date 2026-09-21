import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { cleanup } from "../../utils/setup.js";
import { cliContext, once, releaseHeld } from "./harness.js";
import type { CliContext } from "./harness.js";

/**
 * A person signs in: the binary prints a code and a link, the person
 * approves in a browser, and the binary holds the token. Driven headless
 * here the way the server's own device-grant test drives it: the approval
 * is a signed-in browser session posting to the consent door. The token is
 * printed rather than kept, and the client is registered over HTTP and
 * handed to the binary, so nothing here writes the runner's keychain (a
 * rebuilt binary reading an earlier build's item is asked on the screen);
 * the binary still reads it, and finds nothing. The keychain round trip is
 * the crate's own test.
 *
 * What stays on the server: the owner, whom no door removes, and the
 * grant, whose refresh token is revoked when the file ends.
 */

let c: CliContext;
let refreshToken: string | undefined;
let clientId: string | undefined;

beforeAll(async () => {
  c = await cliContext("login");
});

afterAll(async () => {
  releaseHeld();
  if (refreshToken !== undefined && clientId !== undefined) {
    const form = new URLSearchParams();
    form.set("token", refreshToken);
    form.set("token_type_hint", "refresh_token");
    form.set("client_id", clientId);
    const revoked = await fetch(`${c.apiUrl}/auth/oauth2/revoke`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form,
    });
    if (!revoked.ok) {
      throw new Error(`the grant was not revoked: ${String(revoked.status)}`);
    }
  }
  await cleanup(c.ctx);
});

/**
 * One owner per instance, so one fixed pair: the scenario creates the
 * owner on a server the run booted, and on a re-run against the same
 * server finds them already there and signs in as them.
 */
const OWNER = { email: "owner@example.com", password: "correct horse battery" };

interface Owner {
  id: string;
  email: string;
  name: string;
  created_at: string;
}

describe("the owner", () => {
  it("is created through the operator's door, once, and is not a working key's to see", async () => {
    const outcome = await c.operator.run(
      ["--json", "owner", "create", "--email", OWNER.email, "--password-stdin"],
      { stdin: `${OWNER.password}\n` },
    );
    if (outcome.code === 0) {
      const created = JSON.parse(outcome.stdout) as Owner;
      expect(created.email).toBe(OWNER.email);
    } else {
      const refusal = JSON.parse(outcome.stderr) as {
        error: { server: { code: string } | null };
        exit: number;
      };
      expect(refusal.error.server?.code).toBe("owner_exists");
      expect(refusal.exit).toBe(1);
    }
    const shown = await c.operator.json<Owner>(["owner", "show"]);
    expect(shown.email).toBe(OWNER.email);

    const again = await c.operator.refused(
      ["owner", "create", "--email", "second@example.com", "--password-stdin"],
      { stdin: `${OWNER.password}\n` },
    );
    expect(again.code).toBe(1);
    expect(again.envelope.error.server?.code).toBe("owner_exists");

    const working = await c.cli.refused(["owner", "show"]);
    expect(working.code).toBe(1);
    expect(working.envelope.error.server?.code).toBe("forbidden");
  });

  it("signs in with a device code approved in a browser session, and the token reaches the data plane", async () => {
    // The client, registered the way the binary registers itself, so the
    // binary is handed an id rather than keeping one.
    const registration = await fetch(`${c.apiUrl}/auth/oauth2/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "marfa",
        application_type: "native",
        grant_types: [
          "urn:ietf:params:oauth:grant-type:device_code",
          "refresh_token",
        ],
        response_types: [],
        token_endpoint_auth_method: "none",
      }),
    });
    expect(registration.status).toBe(201);
    clientId = ((await registration.json()) as { client_id: string }).client_id;

    // The binary starts the flow and prints the code as its first line.
    const login = c.cli
      .as(undefined)
      .hold([
        "login",
        "--print-token",
        "--no-browser",
        "--client-id",
        clientId,
      ]);
    let stdout = "";
    let stderr = "";
    login.stdout!.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    login.stderr!.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const started = Date.now();
    while (!stdout.includes("\n") && Date.now() - started < 15_000) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(stdout.includes("\n"), `no code line: ${stderr}`).toBe(true);
    const first = JSON.parse(stdout.split("\n")[0]!) as {
      user_code: string;
      verification_uri: string;
      verification_uri_complete: string;
      expires_in: number;
      scope: string;
    };
    expect(first.user_code).toMatch(/^[A-Z0-9]{8}$/);
    expect(first.verification_uri_complete).toContain(first.user_code);
    expect(first.scope).toContain("*:read");

    // The person: a browser session on the sign-in surface's own origin,
    // which is where the link points, the consent screen, an approval of
    // everything the screen offers.
    const origin = new URL(first.verification_uri_complete).origin;
    const signIn = await fetch(`${origin}/auth/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify(OWNER),
    });
    expect(signIn.status).toBe(200);
    const cookie = /(?:^|,\s*)([\w.-]*session_token=[^;]+)/.exec(
      signIn.headers.get("set-cookie") ?? "",
    )?.[1];
    expect(cookie, "sign-in set no session cookie").toBeTruthy();
    const consent = await fetch(
      `${origin}/auth/device/consent?user_code=${encodeURIComponent(first.user_code)}`,
      { headers: { cookie: cookie! } },
    );
    expect(consent.status).toBe(200);
    const html = await consent.text();
    const scopes = [
      ...new Set(
        [...html.matchAll(/name="scopes"[^>]*value="([^"]+)"/g)].map(
          (m) => m[1]!,
        ),
      ),
    ];
    expect(scopes.length).toBeGreaterThan(0);
    const form = new URLSearchParams();
    form.set("user_code", first.user_code);
    form.set("decision", "approve");
    for (const scope of scopes) form.append("scopes", scope);
    const approved = await fetch(`${origin}/auth/device/consent`, {
      method: "POST",
      headers: {
        cookie: cookie!,
        origin,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: form,
    });
    expect(approved.status).toBe(200);

    // The binary's poll answers the token set, printed after the code line.
    const code = await once(login, "close");
    expect(code, stderr).toBe(0);
    const rest = stdout.slice(stdout.indexOf("\n") + 1);
    const token = JSON.parse(rest) as {
      access_token: string;
      refresh_token: string | null;
      scope: string;
      client_id: string;
    };
    expect(token.access_token).toMatch(/^marfa_at_/);
    expect(token.refresh_token).toMatch(/^marfa_rt_/);
    expect(token.scope).toContain("*:read");
    refreshToken = token.refresh_token ?? undefined;

    // The token reaches the data plane, and the binary knows whose it is.
    const me = await c.cli.as(token.access_token).json<{
      credential: { kind: string; from: string; person?: { email: string } };
    }>(["whoami"]);
    expect(me.credential.kind).toBe("token");
    expect(me.credential.from).toBe("MARFA_API_KEY");
    expect(me.credential.person?.email).toBe(OWNER.email);
    const listed = await c.cli
      .as(token.access_token)
      .json<{ data: unknown[] }>(["items", "list", "--type", "core.note"]);
    expect(Array.isArray(listed.data)).toBe(true);
  });
});
