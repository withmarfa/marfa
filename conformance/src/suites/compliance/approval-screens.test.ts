import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  defaultSubmission,
  offeredValues,
  readControls,
  readRows,
  visibleText,
} from "../../utils/approval-form.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import {
  authorize,
  authorizeQuery,
  CALLBACK,
  decide,
  issuerOrigin,
  pkce,
  registerApp,
  sentTo,
  signIn,
  token,
  type App,
} from "../../utils/signed-in.js";

/**
 * The two pages a person approves an app on, the consent screen and the
 * device approval page: what they offer from a request and from what the app
 * already holds, and what a post to them grants. Read as a person and a form
 * read them, by roles, field names and visible text.
 *
 * A person has to be signed in, and an instance has one owner, so this file
 * boots a server of its own.
 */
let server: FreshServer;
let origin: string;
let cookie: string;

const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

/**
 * A device approval page is a code lookup, and the owner may make ten in a
 * window, so each group of fixtures below boots a server of its own and stays
 * within that.
 */
function bootFor(name: string): {
  up: () => Promise<void>;
  down: () => Promise<void>;
} {
  return {
    async up() {
      server = await bootFreshServer(name);
      origin = await issuerOrigin(server);
      cookie = await signIn(server, origin);
    },
    async down() {
      await server.stop();
    },
  };
}

/** An app that can ask in a browser and on a device. */
function register(scope: string): Promise<App> {
  return registerApp(server, scope, {
    grant_types: ["authorization_code", "refresh_token", DEVICE_GRANT],
  });
}

interface Screen {
  html: string;
  /** Where the page is, which the decision posts back to. */
  consent: URL;
}

/** The consent screen a request for `scope` lands a signed-in person on. */
async function consentScreen(app: App, scope: string): Promise<Screen> {
  const landed = await sentTo(
    server,
    await authorize(
      server,
      authorizeQuery(app.clientId, scope, pkce()),
      cookie,
    ),
  );
  expect(landed?.pathname, `landed on ${String(landed)}`).toBe(
    "/auth/authorize",
  );
  const page = await fetch(landed!, { headers: { cookie } });
  expect(page.status).toBe(200);
  return { html: await page.text(), consent: landed! };
}

interface DeviceScreen {
  html: string;
  userCode: string;
  deviceCode: string;
  interval: number;
}

/** The device approval page for a code the app asked for. */
async function deviceScreen(app: App, scope: string): Promise<DeviceScreen> {
  const issued = await fetch(`${server.apiUrl}/auth/device/code`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: app.clientId, scope }),
  });
  expect(issued.status).toBe(200);
  const code = (await issued.json()) as {
    user_code: string;
    device_code: string;
    interval: number;
  };
  const page = await fetch(
    `${server.apiUrl}/auth/device/consent?user_code=${encodeURIComponent(code.user_code)}`,
    { headers: { cookie }, redirect: "manual" },
  );
  expect(page.status, page.headers.get("location") ?? "").toBe(200);
  return {
    html: await page.text(),
    userCode: code.user_code,
    deviceCode: code.device_code,
    interval: code.interval,
  };
}

/** A person's post on the device approval page. */
async function decideDevice(
  screen: DeviceScreen,
  decision: "approve" | "deny",
  scopes: readonly string[],
): Promise<Response> {
  return fetch(`${server.apiUrl}/auth/device/consent`, {
    method: "POST",
    redirect: "manual",
    headers: {
      cookie,
      origin,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams([
      ["user_code", screen.userCode],
      ["decision", decision],
      ...scopes.map((s): [string, string] => ["scopes", s]),
    ]),
  });
}

/** One poll of the token door for a device code. */
async function poll(app: App, screen: DeviceScreen) {
  await new Promise((resolve) =>
    setTimeout(resolve, screen.interval * 1000 + 250),
  );
  const answer = await token(server, {
    grant_type: DEVICE_GRANT,
    device_code: screen.deviceCode,
    client_id: app.clientId,
  });
  return answer;
}

/** Both pages for one request, so a rule is asserted on each. */
async function bothPages(scope: string): Promise<[string, string][]> {
  const browser = await consentScreen(await register(scope), scope);
  const device = await deviceScreen(await register(scope), scope);
  return [
    ["the consent screen", browser.html],
    ["the device approval page", device.html],
  ];
}

const selectNamed = (html: string, label: string) =>
  readControls(html).find((c) => c.tag === "select" && c.label === label);

describe("what the approval pages offer", () => {
  const booted = bootFor("approval-offers");
  beforeAll(booted.up, 2 * FRESH_SERVER_TIMEOUT_MS);
  afterAll(booted.down, 2 * FRESH_SERVER_TIMEOUT_MS);

  it("offers a type asked at both levels as one control on both pages", async () => {
    for (const [page, html] of await bothPages(
      "core.note:read core.note:write core.task:read",
    )) {
      const notes = selectNamed(html, "Notes");
      expect(notes?.name, page).toBe("scopes");
      expect(
        notes?.options.map((o) => [o.value, o.label]),
        page,
      ).toEqual([
        ["", "No access"],
        ["core.note:read", "Read only"],
        ["core.note:write", "Read and edit"],
      ]);
      // Never a box each for the read and the write.
      expect(
        readControls(html).filter(
          (c) => c.type === "checkbox" && c.value.startsWith("core.note:"),
        ),
        page,
      ).toEqual([]);
    }
  });

  it("offers no level above the one the request names, on both pages", async () => {
    for (const [page, html] of await bothPages(
      "core.note:read core.note:write core.task:read",
    )) {
      expect(
        selectNamed(html, "Tasks")?.options.map((o) => o.label),
        page,
      ).toEqual(["No access", "Read only"]);
      expect(offeredValues(html, "scopes"), page).not.toContain(
        "core.task:write",
      );
    }
  });

  it("offers only the scopes the request names, on both pages", async () => {
    const scope = "core.note:read";
    for (const [page, html] of await bothPages(scope)) {
      expect(offeredValues(html, "scopes"), page).toEqual([scope]);
      expect(
        readControls(html).filter((c) => c.role === "switch"),
        page,
      ).toEqual([]);
      const text = visibleText(html);
      for (const unasked of [
        "Your profile",
        "Which items",
        "Custom data types",
      ])
        expect(text, page).not.toContain(unasked);
    }
    // The witness: asked for, they are there.
    for (const [page, html] of await bothPages(
      "core.note:read profile:read edge.parent-of:read metadata.types:read",
    )) {
      const text = visibleText(html);
      expect(text, page).toContain("Your profile");
      expect(text, page).toContain("Which items sit inside others");
      expect(text, page).toContain("Custom data types");
    }
  });

  it("says beside a scope that reaches later types that it does, on both pages", async () => {
    for (const [page, html] of await bothPages(
      "core.note:read *:read *:write",
    )) {
      const rows = readRows(html);
      const all = rows.find((r) => r.control.label === "All your data");
      expect(all?.text, page).toMatch(/added later/i);
      const notes = rows.find((r) => r.control.label === "Notes");
      expect(notes?.text.replace(all?.text ?? "", ""), page).not.toMatch(
        /added later/i,
      );
    }
  });

  it("offers every permission turned off, on both pages", async () => {
    const permissions =
      "keys.mint webhooks.manage audit.read items.purge grants.manage config.manage schema.write";
    for (const [page, html] of await bothPages(
      `core.note:read ${permissions}`,
    )) {
      const found = readControls(html).filter((c) => c.role === "switch");
      expect(found.map((c) => c.value).sort(), page).toEqual(
        permissions.split(" ").sort(),
      );
      expect(
        found.every((c) => !c.checked),
        page,
      ).toBe(true);
      // The witness that something is on by default: the note is.
      expect(defaultSubmission(html, "scopes"), page).toEqual([
        "core.note:read",
      ]);
    }
  });

  it("marks the permissions that delete for good, and no other, on both pages", async () => {
    const marked = ["instance.maintain", "schema.write", "items.purge"];
    const others = ["keys.mint", "webhooks.manage", "audit.read"];
    for (const [page, html] of await bothPages(
      `core.note:read ${[...marked, ...others].join(" ")}`,
    )) {
      for (const literal of [...marked, ...others]) {
        const row = readRows(html).find((r) => r.control.value === literal);
        const undone = /can't be undone/i.test(row?.text ?? "");
        expect(undone, `${page}: ${literal}`).toBe(marked.includes(literal));
      }
    }
  });
});

describe("what the approval pages show of what an app holds", () => {
  const booted = bootFor("approval-held");
  beforeAll(booted.up, 2 * FRESH_SERVER_TIMEOUT_MS);
  afterAll(booted.down, 2 * FRESH_SERVER_TIMEOUT_MS);

  const WIDE = "core.note:read core.note:write core.task:read";

  /** An app that holds read of notes, having been approved in a browser. */
  async function holder(): Promise<App> {
    const app = await register(WIDE);
    const screen = await consentScreen(app, "core.note:read");
    const sent = await decide(server, origin, cookie, screen.consent, true, [
      "core.note:read",
    ]);
    expect(sent?.searchParams.get("code")).toBeTruthy();
    return app;
  }

  it("shows what the app holds apart from what it asks for, on both pages", async () => {
    const app = await holder();
    const browser = await consentScreen(app, WIDE);
    const device = await deviceScreen(app, WIDE);
    for (const [page, html] of [
      ["the consent screen", browser.html],
      ["the device approval page", device.html],
    ] as const) {
      const text = visibleText(html);
      expect(text, page).toContain("Already allowed");
      expect(text, page).toContain("Now: Read only");
      // The witness: an app that holds nothing shows no such section.
      expect(text, page).toContain("New");
    }
    const fresh = visibleText(
      (await consentScreen(await register(WIDE), WIDE)).html,
    );
    expect(fresh).not.toContain("Already allowed");
  });

  it("offers no level below what the app holds, on both pages", async () => {
    const app = await holder();
    const browser = await consentScreen(app, WIDE);
    const device = await deviceScreen(app, WIDE);
    for (const [page, html] of [
      ["the consent screen", browser.html],
      ["the device approval page", device.html],
    ] as const) {
      expect(
        selectNamed(html, "Notes")?.options.map((o) => o.label),
        page,
      ).toEqual(["Read only", "Read and edit"]);
      // A type the app holds nothing of keeps the choice of no access.
      expect(
        selectNamed(html, "Tasks")?.options.map((o) => o.label),
        page,
      ).toEqual(["No access", "Read only"]);
    }
  });

  it("keeps what the app holds when a narrower choice is approved on the consent screen", async () => {
    const app = await register(WIDE);
    const first = await consentScreen(app, WIDE);
    expect(
      (
        await decide(server, origin, cookie, first.consent, true, [
          "core.note:read",
          "core.note:write",
          "core.task:read",
        ])
      )?.searchParams.get("code"),
    ).toBeTruthy();
    // Under prompt=consent the page is shown though the app holds it all.
    const again = await sentTo(
      server,
      await authorize(
        server,
        authorizeQuery(app.clientId, WIDE, pkce(), { prompt: "consent" }),
        cookie,
      ),
    );
    expect(again?.pathname).toBe("/auth/authorize");
    const approved = await decide(server, origin, cookie, again!, true, [
      "core.note:read",
    ]);
    expect(approved?.searchParams.get("code")).toBeTruthy();
    // A request for the write is answered without asking: it is still held.
    const silent = await sentTo(
      server,
      await authorize(
        server,
        authorizeQuery(app.clientId, "core.note:write", pkce()),
        cookie,
      ),
    );
    expect(silent?.href.startsWith(CALLBACK), String(silent)).toBe(true);
    expect(silent?.searchParams.get("code")).toBeTruthy();
  });

  it("keeps what the app holds when a narrower choice is approved on the device approval page", async () => {
    const app = await register(WIDE);
    const first = await deviceScreen(app, WIDE);
    expect(
      (
        await decideDevice(
          first,
          "approve",
          offeredValues(first.html, "scopes"),
        )
      ).status,
    ).toBe(200);
    const again = await deviceScreen(app, "core.note:read core.note:write");
    const approved = await decideDevice(again, "approve", ["core.note:read"]);
    expect(approved.status).toBe(200);
    const issued = await poll(app, again);
    expect(issued.status).toBe(200);
    expect(issued.body.scope).toBe("core.note:read");
    // The write is still held: a browser request for it is answered silently.
    const silent = await sentTo(
      server,
      await authorize(
        server,
        authorizeQuery(app.clientId, "core.note:write", pkce()),
        cookie,
      ),
    );
    expect(silent?.href.startsWith(CALLBACK), String(silent)).toBe(true);
  });
});

describe("what an approval posted to the approval pages grants", () => {
  const booted = bootFor("approval-posts");
  beforeAll(booted.up, 2 * FRESH_SERVER_TIMEOUT_MS);
  afterAll(booted.down, 2 * FRESH_SERVER_TIMEOUT_MS);

  it("issues the read a chosen write includes", async () => {
    const scope = "core.note:read core.note:write";
    const app = await register(scope);
    const proof = pkce();
    const landed = await sentTo(
      server,
      await authorize(
        server,
        authorizeQuery(app.clientId, scope, proof),
        cookie,
      ),
    );
    const sent = await decide(server, origin, cookie, landed!, true, [
      "core.note:write",
    ]);
    const exchanged = await token(server, {
      grant_type: "authorization_code",
      code: sent?.searchParams.get("code") ?? "",
      redirect_uri: CALLBACK,
      code_verifier: proof.verifier,
      client_id: app.clientId,
    });
    expect(exchanged.status, JSON.stringify(exchanged.body)).toBe(200);
    expect(exchanged.body.scope?.split(" ").sort()).toEqual([
      "core.note:read",
      "core.note:write",
    ]);
    // Not when the request never named the read.
    const writeOnly = await register("core.task:write");
    const proof2 = pkce();
    const landed2 = await sentTo(
      server,
      await authorize(
        server,
        authorizeQuery(writeOnly.clientId, "core.task:write", proof2),
        cookie,
      ),
    );
    const sent2 = await decide(server, origin, cookie, landed2!, true, [
      "core.task:write",
    ]);
    const exchanged2 = await token(server, {
      grant_type: "authorization_code",
      code: sent2?.searchParams.get("code") ?? "",
      redirect_uri: CALLBACK,
      code_verifier: proof2.verifier,
      client_id: writeOnly.clientId,
    });
    expect(exchanged2.body.scope).toBe("core.task:write");
  });

  it("refuses a consent decision that names a scope the request did not, and grants nothing", async () => {
    const app = await register("core.note:read");
    const screen = await consentScreen(app, "core.note:read");
    const refused = await decide(server, origin, cookie, screen.consent, true, [
      "core.note:read",
      "core.note:write",
    ]);
    expect(refused, "a refusal sends the browser nowhere").toBeUndefined();
    const raw = await fetch(`${server.apiUrl}/auth/authorize/decision`, {
      method: "POST",
      redirect: "manual",
      headers: {
        cookie,
        origin,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams([
        ["accept", "true"],
        ["oauth_query", screen.consent.search.slice(1)],
        ["scopes", "core.note:read"],
        ["scopes", "keys.mint"],
      ]),
    });
    expect(raw.status).toBe(400);
    await raw.body?.cancel();
    // Nothing was granted: the app is asked again, not answered silently.
    const asked = await sentTo(
      server,
      await authorize(
        server,
        authorizeQuery(app.clientId, "core.note:read", pkce()),
        cookie,
      ),
    );
    expect(asked?.pathname).toBe("/auth/authorize");
    // The witness: the same decision without the extra scope is a code.
    const honest = await decide(server, origin, cookie, asked!, true, [
      "core.note:read",
    ]);
    expect(honest?.searchParams.get("code")).toBeTruthy();
  });

  it("refuses a device approval that names a scope the code did not carry, and leaves the code pending", async () => {
    const app = await register("core.note:read");
    const screen = await deviceScreen(app, "core.note:read");
    const refused = await decideDevice(screen, "approve", [
      "core.note:read",
      "keys.mint",
    ]);
    expect(refused.status).toBe(400);
    await refused.body?.cancel();
    const pending = await poll(app, screen);
    expect(pending.status).toBe(400);
    expect(pending.body.error).toBe("authorization_pending");
    // The witness: the same approval without it is a token.
    expect(
      (await decideDevice(screen, "approve", ["core.note:read"])).status,
    ).toBe(200);
    const issued = await poll(app, screen);
    expect(issued.status).toBe(200);
    expect(issued.body.scope).toBe("core.note:read");
  });

  it("answers an approval with nothing chosen as access_denied, as Deny is answered", async () => {
    const scope = "openid offline_access core.note:read";
    const app = await register(scope);
    const screen = await consentScreen(app, scope);
    const denied = await decide(
      server,
      origin,
      cookie,
      screen.consent,
      false,
      [],
    );
    expect(denied?.searchParams.get("error")).toBe("access_denied");
    for (const chosen of [[], [""], ["openid", "offline_access"]]) {
      const sent = await decide(
        server,
        origin,
        cookie,
        screen.consent,
        true,
        chosen,
      );
      expect(sent?.href.startsWith(CALLBACK), String(sent)).toBe(true);
      expect(sent?.searchParams.get("error"), JSON.stringify(chosen)).toBe(
        "access_denied",
      );
      expect(sent?.searchParams.get("state")).toBe(
        denied?.searchParams.get("state"),
      );
      expect(sent?.searchParams.get("code")).toBeNull();
    }
    // Nothing was granted by the denials: the app is asked afresh.
    const again = await sentTo(
      server,
      await authorize(
        server,
        authorizeQuery(app.clientId, scope, pkce()),
        cookie,
      ),
    );
    expect(again?.pathname).toBe("/auth/authorize");
    // The witness: choosing the note as well is a code.
    const approved = await decide(
      server,
      origin,
      cookie,
      screen.consent,
      true,
      ["openid", "core.note:read"],
    );
    expect(approved?.searchParams.get("code")).toBeTruthy();
  });

  it("denies a device code approved with nothing chosen", async () => {
    const scope = "openid offline_access core.note:read";
    for (const chosen of [[], ["openid", "offline_access"]]) {
      const app = await register(scope);
      const screen = await deviceScreen(app, scope);
      const answered = await decideDevice(screen, "approve", chosen);
      expect(answered.status, JSON.stringify(chosen)).toBe(200);
      await answered.body?.cancel();
      const polled = await poll(app, screen);
      expect(polled.status).toBe(400);
      expect(polled.body.error).toBe("access_denied");
    }
  });

  it("approves a request that names only openid and offline_access, which offers nothing to turn off", async () => {
    const scope = "openid offline_access";
    const app = await register(scope);
    const screen = await consentScreen(app, scope);
    const sent = await decide(
      server,
      origin,
      cookie,
      screen.consent,
      true,
      defaultSubmission(screen.html, "scopes"),
    );
    expect(sent?.searchParams.get("code")).toBeTruthy();
    const device = await deviceScreen(app, scope);
    expect(
      (
        await decideDevice(
          device,
          "approve",
          defaultSubmission(device.html, "scopes"),
        )
      ).status,
    ).toBe(200);
    const issued = await poll(app, device);
    expect(issued.status).toBe(200);
  });
});
