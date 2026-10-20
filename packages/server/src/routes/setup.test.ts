import { afterEach, describe, expect, it, vi } from "vitest";
import { createClaimTestApp } from "../auth/claim-test-app.js";
import {
  getClaimStatus,
  issueSetupCode,
  issueSetupTicket,
  requireOwnerSession,
} from "../auth/instance-claim.js";
import { readInstanceConfig } from "../storage/instance-config.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function fixture(settings: Record<string, string> = {}) {
  const ctx = await createClaimTestApp(origin, settings);
  cleanups.push(ctx.cleanup);
  return ctx;
}

const origin = "http://localhost:8600";
const details = {
  email: "owner@example.com",
  password: "correct horse battery",
};
const json = (body: unknown, headers: Record<string, string> = {}) => ({
  method: "POST",
  headers: { "content-type": "application/json", ...headers },
  body: JSON.stringify(body),
});
const form = (
  body: Record<string, string>,
  headers: Record<string, string> = {},
) => ({
  method: "POST",
  headers: {
    "content-type": "application/x-www-form-urlencoded",
    ...headers,
  },
  body: new URLSearchParams(body).toString(),
  redirect: "manual" as const,
});
const cookieHeader = (response: Response) =>
  response.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
const sessionCookies = (response: Response) =>
  response.headers
    .getSetCookie()
    .filter((value) => value.includes("session_token="));

type Fixture = Awaited<ReturnType<typeof fixture>>;

/** A setup session, as the browser holds it after the exchange. */
async function setupSession({ app, storage }: Fixture) {
  await issueSetupCode(storage);
  const { ticket } = await issueSetupTicket(storage);
  const exchanged = await app.request(
    "/setup/exchange",
    json({ ticket }, { origin }),
  );
  expect(exchanged.status).toBe(200);
  return cookieHeader(exchanged);
}

describe("the claim signs the owner in", () => {
  it("answers a browser claim with the session a password sign-in sets, and a sign-in within the last five minutes", async () => {
    const ctx = await fixture();
    const setup = await setupSession(ctx);
    const claimed = await ctx.app.request(
      "/owner",
      json(details, { origin, cookie: setup }),
    );
    expect(claimed.status).toBe(201);
    const session = sessionCookies(claimed);
    expect(session).toHaveLength(1);
    const cookie = session[0]!.split(";")[0]!;
    expect(
      (await ctx.app.request("/owner", { headers: { cookie } })).status,
    ).toBe(200);
    await requireOwnerSession(ctx.storage, ctx.auth, new Headers({ cookie }), {
      recent: true,
    });
    // Adding a passkey needs a recent sign-in, and asks for nothing more.
    const options = await ctx.app.request(
      `${origin}/auth/passkey/generate-register-options`,
      { headers: { cookie, origin } },
    );
    expect(options.status).toBe(200);
    expect(
      claimed.headers
        .getSetCookie()
        .some((value) => /^marfa\.setup=;.*Max-Age=0/i.test(value)),
    ).toBe(true);

    const login = await ctx.app.request(
      `${origin}/auth/sign-in/email`,
      json(details, { origin }),
    );
    const attributes = (value: string) =>
      value
        .split(";")
        .slice(1)
        .map((part) => part.trim().toLowerCase())
        .filter((part) => !part.startsWith("expires="))
        .sort();
    expect(attributes(session[0]!)).toEqual(
      attributes(sessionCookies(login)[0]!),
    );
  });

  it("sets no session for a claim without an origin, a refused claim, or a repeated claim", async () => {
    const ctx = await fixture();
    const { code } = await issueSetupCode(ctx.storage);
    const refused = [
      await ctx.app.request(
        "/owner",
        json({ ...details, code: "WRONG" }, { origin }),
      ),
      await ctx.app.request(
        "/owner",
        json({ ...details, password: "short", code }, { origin }),
      ),
      await ctx.app.request(
        "/owner",
        json({ ...details, code }, { origin: "https://elsewhere.example" }),
      ),
    ];
    expect(refused.map((r) => r.status)).toEqual([401, 400, 403]);
    for (const response of refused)
      expect(sessionCookies(response)).toEqual([]);
    const script = await ctx.app.request("/owner", json({ ...details, code }));
    expect(script.status).toBe(201);
    expect(sessionCookies(script)).toEqual([]);
    const repeated = await ctx.app.request(
      "/owner",
      json({ ...details, code }, { origin }),
    );
    expect(repeated.status).toBe(409);
    expect(sessionCookies(repeated)).toEqual([]);
  });

  it("gives the one session to the one browser that wins a race", async () => {
    const ctx = await fixture();
    const setup = await setupSession(ctx);
    const race = await Promise.all(
      [0, 1].map(() =>
        Promise.resolve(
          ctx.app.request("/owner", json(details, { origin, cookie: setup })),
        ),
      ),
    );
    expect(race.map((r) => r.status).sort()).toEqual([201, 409]);
    const winner = race.find((r) => r.status === 201)!;
    const loser = race.find((r) => r.status === 409)!;
    expect(sessionCookies(winner)).toHaveLength(1);
    expect(sessionCookies(loser)).toEqual([]);
  });

  it("keeps the claim when the sign-in that follows it fails", async () => {
    const ctx = await fixture();
    const setup = await setupSession(ctx);
    const handler = ctx.auth.handler.bind(ctx.auth);
    vi.spyOn(ctx.auth, "handler").mockImplementation((request, address) =>
      new URL(request.url).pathname === "/auth/sign-in/email"
        ? Promise.resolve(new Response("{}", { status: 503 }))
        : handler(request, address),
    );
    const claimed = await ctx.app.request(
      "/owner",
      json(details, { origin, cookie: setup }),
    );
    expect(claimed.status).toBe(201);
    expect(sessionCookies(claimed)).toEqual([]);
    expect((await getClaimStatus(ctx.storage)).claimed).toBe(true);
  });
});

describe("the claim and setup pages", () => {
  it("shows the setup code, then the details once the setup session is live, then that it is claimed", async () => {
    const ctx = await fixture();
    const first = await ctx.app.request("/setup");
    const code = await first.text();
    expect(code).toContain('id="code-form"');
    expect(code).toContain('aria-label="Step 1 of 6"');
    expect(code).not.toContain('id="owner-form"');
    // Both commands name the private socket, because the command refuses to run without one.
    expect(code).toContain("marfa --socket PATH setup code");
    expect(code).toContain("control/marfa.sock");
    expect(code).toMatch(
      /marfa --socket (?:"|&quot;)\$MARFA_CONTROL_SOCKET(?:"|&quot;) setup code/,
    );
    expect(code).toContain("setup open");
    const cookie = await setupSession(ctx);
    for (let refresh = 0; refresh < 2; refresh++) {
      const page = await ctx.app.request("/setup", { headers: { cookie } });
      const html = await page.text();
      expect(html).toContain('id="owner-form"');
      expect(html).toContain('aria-label="Step 2 of 6"');
    }
    // Back from the details reads the code page, and changes nothing.
    const back = await ctx.app.request("/setup?step=code", {
      headers: { cookie },
    });
    const backHtml = await back.text();
    expect(backHtml).toContain('id="code-form"');
    expect(backHtml).toContain('aria-label="Step 1 of 6"');
    expect(back.headers.get("set-cookie")).toBeNull();
    const details2 = await ctx.app.request("/setup", { headers: { cookie } });
    const detailsHtml = await details2.text();
    expect(detailsHtml).toContain('id="owner-form"');
    expect(detailsHtml).toContain('href="/setup?step=code"');
    await ctx.app.request("/owner", json(details, { origin, cookie }));
    const afterClaim = await ctx.app.request("/setup?step=code", {
      headers: { cookie },
    });
    expect(await afterClaim.text()).toContain(
      "This Marfa already has an owner",
    );
    const claimed = await (await ctx.app.request("/setup")).text();
    expect(claimed).toContain("This Marfa already has an owner");
    expect(claimed).toContain('href="/auth/sign-in"');
    expect(claimed).not.toContain('id="owner-form"');
  });

  it("exchanges a typed code through the form, and says why when it can't", async () => {
    const ctx = await fixture();
    const { code } = await issueSetupCode(ctx.storage);
    const wrong = await ctx.app.request(
      "/setup/exchange",
      form({ code: "WRONG-CODE" }, { origin }),
    );
    expect(wrong.status).toBe(401);
    const html = await wrong.text();
    expect(html).toContain(
      "That setup code isn&#39;t right. Check it and try again.",
    );
    expect(html).toMatch(/<input[^>]*id="code"[^>]*aria-invalid="true"/);
    expect(html).toMatch(/<input[^>]*id="code"[^>]*autofocus/);
    expect(wrong.headers.get("set-cookie")).toBeNull();

    const empty = await ctx.app.request(
      "/setup/exchange",
      form({ code: " " }, { origin }),
    );
    expect(empty.status).toBe(400);
    expect(await empty.text()).toContain("Enter the setup code.");

    const exchanged = await ctx.app.request(
      "/setup/exchange",
      form({ code: code.toLowerCase() }, { origin }),
    );
    expect(exchanged.status).toBe(303);
    expect(exchanged.headers.get("location")).toBe("/setup");
    expect(exchanged.headers.get("set-cookie")).toContain("HttpOnly");
    expect(
      (await ctx.app.request("/setup/exchange", form({ code }))).status,
      "an exchange from no origin",
    ).toBe(403);
  });

  it("refuses a key the forms do not send, and keeps the code unspent", async () => {
    const ctx = await fixture();
    const { code } = await issueSetupCode(ctx.storage);
    for (const stray of ["bogus", "_trace", "ticket"]) {
      const refused = await ctx.app.request(
        "/setup/exchange",
        form({ code, [stray]: "1" }, { origin }),
      );
      expect(refused.status, stray).toBe(400);
      const body = (await refused.json()) as {
        error: { code: string; details?: { unknown_body_fields?: string[] } };
      };
      expect(body.error.code).toBe("validation_error");
      expect(body.error.details?.unknown_body_fields).toEqual([stray]);
      expect(refused.headers.get("set-cookie")).toBeNull();
    }
    const claim = await ctx.app.request(
      "/setup/claim",
      form({ ...details, code, bogus: "1" }, { origin }),
    );
    expect(claim.status).toBe(400);
    expect(
      (
        (await claim.json()) as {
          error: { details: { unknown_body_fields: string[] } };
        }
      ).error.details.unknown_body_fields,
    ).toEqual(["bogus"]);
    expect((await getClaimStatus(ctx.storage)).claimed).toBe(false);
    // The witness: the same request without the stray key exchanges the code.
    const exchanged = await ctx.app.request(
      "/setup/exchange",
      form({ code }, { origin }),
    );
    expect(exchanged.status).toBe(303);
  });

  it("names the wait when the address has used its attempts", async () => {
    const ctx = await fixture();
    for (let attempt = 0; attempt < 10; attempt++)
      expect(
        (
          await ctx.app.request(
            "/setup/exchange",
            form({ code: "WRONG-CODE" }, { origin }),
          )
        ).status,
      ).toBe(401);
    const spent = await ctx.app.request(
      "/setup/exchange",
      form({ code: "WRONG-CODE" }, { origin }),
    );
    expect(spent.status).toBe(429);
    expect(await spent.text()).toMatch(
      /Too many tries\. Try again in \d+ minutes\./,
    );
  });

  it("claims through the form, signs the owner in and goes to the passkey step", async () => {
    const ctx = await fixture();
    const setup = await setupSession(ctx);
    const claimed = await ctx.app.request(
      "/setup/claim",
      form({ ...details, name: "" }, { origin, cookie: setup }),
    );
    expect(claimed.status).toBe(303);
    expect(claimed.headers.get("location")).toBe("/setup/passkey");
    const cookie = sessionCookies(claimed)[0]!.split(";")[0]!;
    const passkey = await ctx.app.request("/setup/passkey", {
      headers: { cookie },
    });
    expect(passkey.status).toBe(200);
    const html = await passkey.text();
    expect(html).toContain("Add a passkey");
    expect(html).toContain('aria-label="Step 3 of 6"');
  });

  it("answers a refused form claim as the page, keeping what was typed except the password", async () => {
    const ctx = await fixture();
    const setup = await setupSession(ctx);
    const short = await ctx.app.request(
      "/setup/claim",
      form(
        { email: "owner@example.com", name: "Ada", password: "short" },
        { origin, cookie: setup },
      ),
    );
    expect(short.status).toBe(400);
    expect(sessionCookies(short)).toEqual([]);
    const html = await short.text();
    expect(html).toContain("Password must contain 8 to 128 characters.");
    expect(html).toMatch(/<input[^>]*id="password"[^>]*aria-invalid="true"/);
    expect(html).toContain('value="owner@example.com"');
    expect(html).toContain('value="Ada"');
    expect(html).not.toContain("short");
    const email = await ctx.app.request(
      "/setup/claim",
      form(
        { email: "not an email", password: details.password },
        { origin, cookie: setup },
      ),
    );
    expect(email.status).toBe(400);
    expect(await email.text()).toMatch(
      /<input[^>]*id="email"[^>]*aria-invalid="true"/,
    );
    expect((await getClaimStatus(ctx.storage)).claimed).toBe(false);

    const ended = await ctx.app.request(
      "/setup/claim",
      form(details, { origin, cookie: "marfa.setup=gone" }),
    );
    expect(ended.status).toBe(401);
    expect(await ended.text()).toContain("Your setup session ended.");

    await ctx.app.request(
      "/setup/claim",
      form(details, { origin, cookie: setup }),
    );
    const late = await ctx.app.request(
      "/setup/claim",
      form(details, { origin, cookie: setup }),
    );
    expect(late.status).toBe(409);
    expect(sessionCookies(late)).toEqual([]);
    expect(await late.text()).toContain("This Marfa already has an owner");
  });

  it("keeps a script's form claim as it was: JSON back, and no session", async () => {
    const ctx = await fixture();
    const { code } = await issueSetupCode(ctx.storage);
    const claimed = await ctx.app.request(
      "/setup/claim",
      form({ ...details, code }),
    );
    expect(claimed.status).toBe(201);
    expect(await claimed.json()).toMatchObject({ email: details.email });
    expect(sessionCookies(claimed)).toEqual([]);
  });
});

describe("the owner's steps", () => {
  it("send nobody without a session on: to setup while unclaimed, to sign-in once claimed", async () => {
    const ctx = await fixture();
    const unclaimed = await ctx.app.request("/setup/passkey", {
      redirect: "manual",
    });
    expect(unclaimed.status).toBe(302);
    expect(unclaimed.headers.get("location")).toBe("/setup");
    const setup = await setupSession(ctx);
    await ctx.app.request("/owner", json(details, { origin, cookie: setup }));
    const claimed = await ctx.app.request("/setup/name", {
      redirect: "manual",
    });
    expect(claimed.status).toBe(302);
    expect(claimed.headers.get("location")).toBe(
      "/auth/sign-in?return_to=%2Fsetup%2Fname",
    );
    // The setup session is not an owner session.
    const spent = await ctx.app.request("/setup/connect", {
      headers: { cookie: setup },
      redirect: "manual",
    });
    expect(spent.status).toBe(302);
    expect((await ctx.app.request("/setup/elsewhere")).status).toBe(404);
  });

  it("show each step of the six", async () => {
    const ctx = await fixture();
    const setup = await setupSession(ctx);
    const claimed = await ctx.app.request(
      "/owner",
      json(details, { origin, cookie: setup }),
    );
    const cookie = sessionCookies(claimed)[0]!.split(";")[0]!;
    const expected = {
      passkey: [3, "Add a passkey"],
      name: [4, "Name this Marfa"],
      connect: [5, "Connect something"],
      backups: [6, "Backing up"],
    } as const;
    for (const [step, [number, title]] of Object.entries(expected)) {
      const page = await ctx.app.request(`/setup/${step}`, {
        headers: { cookie },
      });
      expect(page.status, step).toBe(200);
      expect(page.headers.get("cache-control")).toContain("no-store");
      const html = await page.text();
      expect(html, step).toContain(title);
      expect(html, step).toContain(`aria-label="Step ${String(number)} of 6"`);
    }
    // The passkey step asks for a recent sign-in in a dialog, not a redirect.
    const passkeyStep = await (
      await ctx.app.request("/setup/passkey", { headers: { cookie } })
    ).text();
    expect(passkeyStep).toContain("data-confirm-dialog");
    expect(passkeyStep).not.toContain("prompt=login");
    // A new computer has no server saved, so the command names this one.
    const connect = await ctx.app.request("/setup/connect", {
      headers: { cookie },
    });
    expect(await connect.text()).toContain(`marfa --url ${origin} login`);
  });

  it("tell the owner where the data is kept, which depends on whether a bucket is set", async () => {
    const backups = async (settings: Record<string, string>) => {
      const ctx = await fixture(settings);
      const setup = await setupSession(ctx);
      const claimed = await ctx.app.request(
        "/owner",
        json(details, { origin, cookie: setup }),
      );
      const cookie = sessionCookies(claimed)[0]!.split(";")[0]!;
      const page = await ctx.app.request("/setup/backups", {
        headers: { cookie },
      });
      expect(page.status).toBe(200);
      return page.text();
    };
    const folder = await backups({});
    expect(folder).toContain("all its data in one folder");
    expect(folder).not.toContain("bucket");
    const bucket = await backups({
      S3_BUCKET: "marfa-data",
      S3_ACCESS_KEY_ID: "key",
      S3_SECRET_ACCESS_KEY: "secret",
    });
    expect(bucket).toContain("bucket");
    expect(bucket).not.toContain("all its data in one folder");
  });

  it("keep the instance's other settings when they save its name", async () => {
    const ctx = await fixture();
    const setup = await setupSession(ctx);
    const claimed = await ctx.app.request(
      "/owner",
      json(details, { origin, cookie: setup }),
    );
    const cookie = sessionCookies(claimed)[0]!.split(";")[0]!;
    await ctx.storage.settings.set(
      "instance_config",
      JSON.stringify({ name: "Before", trash_retention_days: 12 }),
    );
    const saved = await ctx.app.request(
      "/setup/name",
      form({ name: "  Library  " }, { origin, cookie }),
    );
    expect(saved.status).toBe(303);
    expect(saved.headers.get("location")).toBe("/setup/connect");
    expect(await readInstanceConfig(ctx.storage.settings)).toEqual({
      name: "Library",
      trash_retention_days: 12,
    });
    const audit = await ctx.storage.audit.list({ action: "config.update" });
    expect(audit.data).toHaveLength(1);

    const blank = await ctx.app.request(
      "/setup/name",
      form({ name: " " }, { origin, cookie }),
    );
    expect(blank.status).toBe(303);
    expect(await readInstanceConfig(ctx.storage.settings)).toEqual({
      trash_retention_days: 12,
    });

    // A body that is not a form has no name in it, which is not a blank one.
    await ctx.storage.settings.set(
      "instance_config",
      JSON.stringify({ name: "Kept", trash_retention_days: 12 }),
    );
    const asJson = await ctx.app.request(
      "/setup/name",
      json({ name: "Other" }, { origin, cookie }),
    );
    expect(asJson.status).toBe(400);
    expect(await readInstanceConfig(ctx.storage.settings)).toEqual({
      name: "Kept",
      trash_retention_days: 12,
    });
    const stray = await ctx.app.request(
      "/setup/name",
      form({ name: "Other", bogus: "1" }, { origin, cookie }),
    );
    expect(stray.status).toBe(400);
    await ctx.storage.settings.set(
      "instance_config",
      JSON.stringify({ trash_retention_days: 12 }),
    );

    const long = await ctx.app.request(
      "/setup/name",
      form({ name: "x".repeat(201) }, { origin, cookie }),
    );
    expect(long.status).toBe(400);
    expect(await long.text()).toContain("That name can&#39;t be used.");
    expect(await readInstanceConfig(ctx.storage.settings)).toEqual({
      trash_retention_days: 12,
    });
    expect(
      (
        await ctx.app.request(
          "/setup/name",
          form({ name: "No origin" }, { cookie }),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await ctx.app.request(
          "/setup/name",
          form({ name: "No session" }, { origin }),
        )
      ).status,
    ).toBe(401);
  });
});
