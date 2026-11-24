import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  asDrawn,
  defaultSubmission,
  heldOn,
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
  ALL_TOOLS,
  callTool,
  connectMcp,
  toolNames,
  toolResult,
} from "../../utils/mcp.js";
import {
  authorize,
  authorizeQuery,
  CALLBACK,
  decide,
  decideResponse,
  issuerOrigin,
  pkce,
  registerApp,
  itemsStatus,
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
  expect(landed?.pathname, `landed on ${String(landed)}`).toBe("/auth/consent");
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
  const issued = await fetch(`${server.apiUrl}/oauth/device-authorization`, {
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

/** A person's post on the device approval page, carrying the access the page was drawn on. */
async function decideDevice(
  screen: DeviceScreen,
  decision: "approve" | "deny",
  scopes: readonly string[],
  types: readonly string[] = [],
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
      ["held", heldOn(screen.html)],
      ...scopes.map((s): [string, string] => ["scopes", s]),
      ...types.map((t): [string, string] => ["types", t]),
    ]),
  });
}

/** An approval on the consent screen `consent` is the address of, posting `fields`. */
function approveWith(
  consent: URL,
  fields: readonly [string, string][],
  accept?: string,
): Promise<Response> {
  return fetch(`${server.apiUrl}/auth/consent`, {
    method: "POST",
    redirect: "manual",
    headers: {
      cookie,
      origin,
      "content-type": "application/x-www-form-urlencoded",
      ...(accept ? { accept } : {}),
    },
    body: new URLSearchParams([
      ["decision", "approve"],
      ["authorization_request", consent.search.slice(1)],
      ...fields,
    ]),
  });
}

/** An approval on the device approval page for `screen`'s code, posting `fields`. */
function approveDeviceWith(
  screen: DeviceScreen,
  fields: readonly [string, string][],
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
      ["decision", "approve"],
      ...fields,
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

/** The admin level and the rows Custom chooses from, the controls that give permissions. */
const adminControls = (html: string) =>
  readControls(html).filter((c) => c.name === "admin" || c.name === "powers");

const adminLevels = (html: string): string[] =>
  readControls(html)
    .find((c) => c.name === "admin")
    ?.options.map((o) => o.value) ?? [];

/** The app's grant, as the owner's grant list shows it. */
async function grantOf(app: App): Promise<{ id: string; scopes: string[] }> {
  const listed = await fetch(`${server.apiUrl}/grants`, {
    headers: { authorization: `Bearer ${server.managementKey}` },
  });
  const grant = (
    (await listed.json()) as {
      data: { id: string; client_id: string; scopes: string[] }[];
    }
  ).data.find((g) => g.client_id === app.clientId);
  expect(grant, "the app holds no grant").toBeDefined();
  return grant!;
}

/** The person disconnects the app from another tab. */
async function disconnect(app: App): Promise<void> {
  const revoked = await fetch(
    `${server.apiUrl}/grants/${(await grantOf(app)).id}`,
    {
      method: "DELETE",
      headers: { authorization: `Bearer ${server.managementKey}` },
    },
  );
  expect(revoked.status).toBe(200);
}

/** The person narrows the app's access to `scopes` from another tab. */
async function narrow(app: App, scopes: string[]): Promise<void> {
  const grant = await grantOf(app);
  const narrowed = await fetch(`${server.apiUrl}/grants/${grant.id}`, {
    method: "PATCH",
    headers: {
      authorization: `Bearer ${server.managementKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ scopes, expected_scopes: grant.scopes }),
  });
  expect(narrowed.status, await narrowed.text()).toBe(200);
}

const CHANGED = "This app's access changed after this page opened.";

/** A post answered with the approval page drawn again, saying the access changed. */
async function drawnAgain(answered: Response): Promise<string> {
  expect(answered.status).toBe(409);
  expect(answered.headers.get("content-type")).toContain("text/html");
  const html = await answered.text();
  expect(visibleText(html)).toContain(CHANGED);
  return html;
}

describe("what the approval pages offer", () => {
  const booted = bootFor("approval-offers");
  beforeAll(booted.up, 2 * FRESH_SERVER_TIMEOUT_MS);
  afterAll(booted.down, 2 * FRESH_SERVER_TIMEOUT_MS);

  it("offers a type asked at both levels as one control on both pages", async () => {
    for (const [page, html] of await bothPages(
      "core.note:read core.note:write core.task:read",
    )) {
      const notes = selectNamed(html, "Note");
      expect(notes?.name, page).toBe("scopes");
      expect(
        notes?.options.map((o) => [o.value, o.label]),
        page,
      ).toEqual([
        ["core.note:write", "Read and Edit"],
        ["core.note:read", "Read Only"],
        ["", "No Access"],
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

  it("says that editing includes adding and deleting items, where a level to edit is offered, on both pages", async () => {
    const line = "Edit includes adding and deleting.";
    for (const [page, html] of await bothPages(
      "core.note:read core.note:write",
    )) {
      expect(visibleText(html), page).toContain(line);
    }
    // The witness: asked for reads only, no level to edit is offered and the line is not.
    for (const [page, html] of await bothPages("core.note:read")) {
      expect(visibleText(html), page).not.toContain(line);
    }
    // A definition's level to edit registers and changes types and deletes no item.
    for (const [page, html] of await bothPages("metadata.types:write")) {
      expect(visibleText(html), page).not.toContain(line);
    }
  });

  it("offers no level above the one the request names, on both pages", async () => {
    for (const [page, html] of await bothPages(
      "core.note:read core.note:write core.task:read",
    )) {
      expect(
        selectNamed(html, "Task")?.options.map((o) => o.label),
        page,
      ).toEqual(["Read Only", "No Access"]);
      expect(offeredValues(html, "scopes"), page).not.toContain(
        "core.task:write",
      );
    }
  });

  it("offers only the scopes the request names, on both pages", async () => {
    const scope = "core.note:read";
    for (const [page, html] of await bothPages(scope)) {
      expect(offeredValues(html, "scopes"), page).toEqual([scope]);
      expect(adminControls(html), page).toEqual([]);
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

  it("says under the items that a scope reaching later types does, on both pages", async () => {
    for (const [page, html] of await bothPages(
      "core.note:read *:read *:write",
    )) {
      expect(visibleText(html), page).toContain(
        "Types added later are included.",
      );
      // A page without scripts shows no choice, so it names the levels.
      expect(visibleText(html), page).toContain(
        "Read Only and Read and Edit include types added later. Each Type does not.",
      );
    }
    // The witness: asked for one type only, the page says nothing of later types.
    for (const [page, html] of await bothPages("core.note:read")) {
      expect(visibleText(html), page).not.toMatch(/added later/i);
      expect(visibleText(html), page).not.toContain("Each Type does not");
    }
  });

  it("offers the permissions a request names as one admin level at Full Access, each row starting at Allow, on both pages", async () => {
    const asked = ["keys.mint", "webhooks.manage", "items.purge"];
    for (const [page, html] of await bothPages(
      `core.note:read ${asked.join(" ")}`,
    )) {
      const admin = readControls(html).filter((c) => c.name === "admin");
      expect(admin, page).toHaveLength(1);
      expect(adminLevels(html), page).toEqual(["full", "none", "custom"]);
      expect(admin[0]!.value, page).toBe("full");
      const rows = readControls(html).filter((c) => c.name === "powers");
      expect(rows.map((c) => c.value).sort(), page).toEqual([...asked].sort());
      for (const row of rows)
        expect(
          row.options.map((o) => [o.value, o.selected]),
          `${page}: ${row.value}`,
        ).toEqual([
          [row.value, true],
          ["", false],
        ]);
      // A permission is never a field named scopes, which the note is.
      expect(offeredValues(html, "scopes"), page).toEqual(["core.note:read"]);
    }
  });
});

describe("the admin level on the approval pages", () => {
  const booted = bootFor("approval-admin");
  beforeAll(booted.up, 2 * FRESH_SERVER_TIMEOUT_MS);
  afterAll(booted.down, 2 * FRESH_SERVER_TIMEOUT_MS);

  /** The scopes a token carries after an approval of `scope` that posts `fields`. */
  async function granted(
    scope: string,
    fields: [string, string][],
  ): Promise<string[]> {
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
    const sent = await sentTo(server, await approveWith(landed!, fields));
    const code = sent?.searchParams.get("code");
    expect(code, String(sent)).toBeTruthy();
    const exchanged = await token(server, {
      grant_type: "authorization_code",
      code: code!,
      redirect_uri: CALLBACK,
      code_verifier: proof.verifier,
      client_id: app.clientId,
    });
    expect(exchanged.status, JSON.stringify(exchanged.body)).toBe(200);
    return exchanged.body.scope?.split(" ").sort() ?? [];
  }

  const ASKED = "core.note:read keys.mint instance.read audit.read";
  const NOTE: [string, string] = ["scopes", "core.note:read"];

  it("offers Limited only where it holds some of the powers asked and not all, on both pages", async () => {
    for (const [page, html] of await bothPages(
      "core.note:read instance.read keys.mint",
    )) {
      expect(adminLevels(html), page).toEqual([
        "full",
        "limited",
        "none",
        "custom",
      ]);
      // A page without scripts shows no choice, so it defines Limited.
      expect(visibleText(html), page).toMatch(
        /Limited lets the app only [^.]+\./,
      );
    }
    for (const asked of ["keys.mint items.purge", "instance.read audit.read"])
      for (const [page, html] of await bothPages(`core.note:read ${asked}`)) {
        expect(adminLevels(html), `${page}: ${asked}`).toEqual([
          "full",
          "none",
          "custom",
        ]);
        expect(visibleText(html), page).not.toContain("Limited lets");
      }
    // Only what the app does not hold counts: holding keys.mint leaves
    // instance.read alone new, and Limited would give all of it.
    const asked = "core.note:read instance.read keys.mint";
    const app = await register(asked);
    const first = await consentScreen(app, "core.note:read keys.mint");
    const held = await approveWith(first.consent, asDrawn(first.html));
    expect((await sentTo(server, held))?.searchParams.get("code")).toBeTruthy();
    const again = await consentScreen(app, asked);
    expect(adminLevels(again.html)).toEqual(["full", "none", "custom"]);
  });

  it("shows no admin level to a request that names no permission, on both pages", async () => {
    for (const [page, html] of await bothPages("core.note:read"))
      expect(adminControls(html), page).toEqual([]);
    // The witness: one permission asked brings the level.
    for (const [page, html] of await bothPages("core.note:read audit.read"))
      expect(adminLevels(html), page).toContain("full");
  });

  it("offers no admin level or row for a power the app holds, on both pages", async () => {
    const held = "core.note:read keys.mint";
    const app = await register(`${held} audit.read`);
    const first = await consentScreen(app, held);
    const approved = await approveWith(first.consent, [
      ["scopes", "core.note:read"],
      ["admin", "full"],
    ]);
    expect(
      (await sentTo(server, approved))?.searchParams.get("code"),
    ).toBeTruthy();

    const more = `${held} audit.read`;
    const browser = await consentScreen(app, more);
    const device = await deviceScreen(app, more);
    for (const [page, html] of [
      ["the consent screen", browser.html],
      ["the device approval page", device.html],
    ] as const) {
      expect(
        readControls(html)
          .filter((c) => c.name === "powers")
          .map((c) => c.value),
        page,
      ).toEqual(["audit.read"]);
      expect(visibleText(html), page).toMatch(
        /Already allowed.*Admin access: make keys/,
      );
    }
    const again = await deviceScreen(app, held);
    expect(adminControls(again.html)).toEqual([]);
  });

  it("grants the permissions of the admin level posted, on both pages", async () => {
    expect(await granted(ASKED, [NOTE, ["admin", "full"]])).toEqual([
      "audit.read",
      "core.note:read",
      "instance.read",
      "keys.mint",
    ]);
    expect(await granted(ASKED, [NOTE, ["admin", "limited"]])).toEqual([
      "audit.read",
      "core.note:read",
      "instance.read",
    ]);
    expect(await granted(ASKED, [NOTE, ["admin", "none"]])).toEqual([
      "core.note:read",
    ]);
    // The device approval page reads the level the same way.
    const app = await register(ASKED);
    const screen = await deviceScreen(app, ASKED);
    const answered = await fetch(`${server.apiUrl}/auth/device/consent`, {
      method: "POST",
      redirect: "manual",
      headers: {
        cookie,
        origin,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams([
        ["user_code", screen.userCode],
        ["decision", "approve"],
        NOTE,
        ["admin", "limited"],
      ]),
    });
    expect(answered.status).toBe(200);
    await answered.body?.cancel();
    const issued = await poll(app, screen);
    expect(issued.status).toBe(200);
    expect(issued.body.scope?.split(" ").sort()).toEqual([
      "audit.read",
      "core.note:read",
      "instance.read",
    ]);
  });

  it("grants under Custom exactly the powers allowed", async () => {
    expect(
      await granted(ASKED, [
        NOTE,
        ["admin", "custom"],
        ["powers", ""],
        ["powers", "keys.mint"],
        ["powers", "audit.read"],
      ]),
    ).toEqual(["audit.read", "core.note:read", "keys.mint"]);
    expect(
      await granted(ASKED, [
        NOTE,
        ["admin", "custom"],
        ["powers", ""],
        ["powers", ""],
      ]),
    ).toEqual(["core.note:read"]);
  });

  it("counts no power row posted beside a level other than Custom", async () => {
    const rows: [string, string][] = [
      ["powers", "keys.mint"],
      ["powers", "audit.read"],
    ];
    expect(await granted(ASKED, [NOTE, ["admin", "none"], ...rows])).toEqual([
      "core.note:read",
    ]);
    expect(await granted(ASKED, [NOTE, ...rows])).toEqual(["core.note:read"]);
    expect(
      await granted(ASKED, [
        NOTE,
        ["admin", "limited"],
        ["powers", "keys.mint"],
      ]),
    ).toEqual(["audit.read", "core.note:read", "instance.read"]);
    // The witness: the same rows under Custom count.
    expect(await granted(ASKED, [NOTE, ["admin", "custom"], ...rows])).toEqual([
      "audit.read",
      "core.note:read",
      "keys.mint",
    ]);
  });

  it("refuses an admin level or a power the request did not name, or a permission posted as a scope, and grants nothing", async () => {
    const app = await register(`${ASKED} items.purge`);
    const landed = await sentTo(
      server,
      await authorize(
        server,
        authorizeQuery(app.clientId, "core.note:read keys.mint", pkce()),
        cookie,
      ),
    );
    for (const fields of [
      [NOTE, ["admin", "custom"], ["powers", "items.purge"]],
      [NOTE, ["admin", "custom"], ["powers", "core.note:read"]],
      [NOTE, ["admin", "everything"]],
      // A permission comes only through the admin level, never as a scope.
      [NOTE, ["scopes", "keys.mint"], ["admin", "none"]],
      [NOTE, ["scopes", "keys.mint"], ["admin", "full"]],
    ] as [string, string][][]) {
      const refused = await approveWith(landed!, fields);
      expect(refused.status, JSON.stringify(fields)).toBe(400);
      await refused.body?.cancel();
    }
    const unasked = await register("core.note:read");
    const plain = await sentTo(
      server,
      await authorize(
        server,
        authorizeQuery(unasked.clientId, "core.note:read", pkce()),
        cookie,
      ),
    );
    const levelled = await approveWith(plain!, [NOTE, ["admin", "none"]]);
    expect(levelled.status).toBe(400);
    await levelled.body?.cancel();
    // The witness: the same requests, posted within them, are codes.
    for (const [consent, fields] of [
      [landed!, [NOTE, ["admin", "custom"], ["powers", "keys.mint"]]],
      [plain!, [NOTE]],
    ] as [URL, [string, string][]][]) {
      const sent = await sentTo(server, await approveWith(consent, fields));
      expect(sent?.searchParams.get("code"), String(sent)).toBeTruthy();
    }
  });
});

describe("what the approval pages say of a permission", () => {
  const booted = bootFor("approval-words");
  beforeAll(booted.up, 2 * FRESH_SERVER_TIMEOUT_MS);
  afterAll(booted.down, 2 * FRESH_SERVER_TIMEOUT_MS);

  const EVERY = [
    "audit.read",
    "backups.manage",
    "blobs.manage",
    "config.manage",
    "connectors.manage",
    "grants.manage",
    "instance.maintain",
    "instance.read",
    "items.purge",
    "keys.manage",
    "keys.mint",
    "schema.write",
    "sign_ins.manage",
    "webhooks.manage",
  ];

  // The first row is read with the hint above the rows.
  const ownWords = (text: string | undefined): string | undefined =>
    text?.replace(/^With Custom, choose which to allow\. /, "");

  it("describes each permission in the same words on both pages", async () => {
    const [[, consent], ...others] = await bothPages(
      `core.note:read ${EVERY.join(" ")}`,
    );
    for (const permission of EVERY) {
      const words = ownWords(
        readRows(consent).find((r) => r.control.value === permission)?.text,
      );
      expect(words, `the consent screen: ${permission}`).toBeTruthy();
      for (const [page, html] of others) {
        const row = readRows(html).find((r) => r.control.value === permission);
        expect(ownWords(row?.text), `${page}: ${permission}`).toBe(words);
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
      expect(text, page).toContain("Now: Read Only");
      expect(text, page).toContain("It also wants");
    }
    // The witness: an app that holds nothing shows neither.
    const fresh = visibleText(
      (await consentScreen(await register(WIDE), WIDE)).html,
    );
    expect(fresh).not.toContain("Already allowed");
    expect(fresh).not.toContain("It also wants");
  });

  it("shows a scope the app holds in full without offering it as a choice, and does not post it, on the consent screen", async () => {
    const app = await holder();
    const { html } = await consentScreen(app, "core.note:read core.task:read");
    expect(selectNamed(html, "Note")).toBeUndefined();
    expect(selectNamed(html, "Task")?.options.map((o) => o.label)).toEqual([
      "Read Only",
      "No Access",
    ]);
    // The page posts nothing for it: the server adds what the app still holds
    // (`keys-and-oauth/approval-held-now`).
    expect(
      readControls(html).filter((c) => c.value === "core.note:read"),
    ).toEqual([]);
    expect(defaultSubmission(html, "scopes")).toEqual(["core.task:read"]);
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
        selectNamed(html, "Note")?.options.map((o) => o.label),
        page,
      ).toEqual(["Read and Edit", "Read Only"]);
      // A type the app holds nothing of keeps the choice of no access.
      expect(
        selectNamed(html, "Task")?.options.map((o) => o.label),
        page,
      ).toEqual(["Read Only", "No Access"]);
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
    expect(again?.pathname).toBe("/auth/consent");
    const page = await fetch(again!, { headers: { cookie } });
    const approved = await decide(
      server,
      origin,
      cookie,
      again!,
      true,
      ["core.note:read"],
      [],
      heldOn(await page.text()),
    );
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
    // What was chosen is nothing new, and the request names both levels the
    // app holds, so the token carries both.
    expect(issued.body.scope?.split(" ").sort()).toEqual([
      "core.note:read",
      "core.note:write",
    ]);
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

describe("what the approval pages offer an app that holds a read and asks for the write", () => {
  const booted = bootFor("approval-keep");
  beforeAll(booted.up, 2 * FRESH_SERVER_TIMEOUT_MS);
  afterAll(booted.down, 2 * FRESH_SERVER_TIMEOUT_MS);

  interface Case {
    held: string;
    asked: string;
    label: string;
    write: string;
  }

  /** An app holding `held` asks for `asked`: each page offers the held read beside the write. */
  async function offersTheHeldRead(c: Case): Promise<void> {
    const app = await register(`${c.held} ${c.asked}`);
    const first = await consentScreen(app, c.held);
    const sent = await decide(
      server,
      origin,
      cookie,
      first.consent,
      true,
      defaultSubmission(first.html, "scopes"),
    );
    expect(sent?.searchParams.get("code")).toBeTruthy();
    const browser = await consentScreen(app, c.asked);
    const device = await deviceScreen(app, c.asked);
    for (const [page, html] of [
      ["the consent screen", browser.html],
      ["the device approval page", device.html],
    ] as const) {
      const select = selectNamed(html, c.label);
      expect(
        select?.options.map((o) => [o.value, o.label]),
        page,
      ).toEqual([
        [c.write, "Read and Edit"],
        ["", "Read Only"],
      ]);
      // The write is what was asked, so it is what the page starts on.
      expect(select?.value, page).toBe(c.write);
    }
  }

  it("offers the held read beside the write, on both pages, for an item type's write asked while its read is held", async () => {
    await offersTheHeldRead({
      held: "core.note:read",
      asked: "core.note:write",
      label: "Note",
      write: "core.note:write",
    });
  });

  it("offers the held read beside the write, on both pages, for a type's write asked beside a wildcard read the app holds", async () => {
    await offersTheHeldRead({
      held: "core.*:read",
      asked: "core.*:read core.note:write",
      label: "Note",
      write: "core.note:write",
    });
  });

  it("offers the held read beside the write, on both pages, for the profile's write asked while its read is held", async () => {
    await offersTheHeldRead({
      held: "profile:read",
      asked: "profile:write",
      label: "Your profile",
      write: "profile:write",
    });
  });
});

describe("what an approval with everything newly asked turned off does for an app that already holds access", () => {
  const booted = bootFor("approval-returning");
  beforeAll(booted.up, 2 * FRESH_SERVER_TIMEOUT_MS);
  afterAll(booted.down, 2 * FRESH_SERVER_TIMEOUT_MS);

  const HELD = "core.note:read";
  const ASKED = "core.note:read core.task:read";

  /** An app that holds read of notes and is registered to ask for tasks too. */
  async function holder(): Promise<App> {
    const app = await register(ASKED);
    const screen = await consentScreen(app, HELD);
    const sent = await decide(
      server,
      origin,
      cookie,
      screen.consent,
      true,
      defaultSubmission(screen.html, "scopes"),
    );
    expect(sent?.searchParams.get("code")).toBeTruthy();
    return app;
  }

  /** What the page posts when Task is set to no access and the rest is left. */
  function tasksOff(html: string): string[] {
    const posted = defaultSubmission(html, "scopes").filter(
      (v) => v !== "core.task:read",
    );
    // What the page posts, and nothing newly asked: what the app holds is not
    // posted.
    expect(posted).toEqual([]);
    return posted;
  }

  it("answers an approval with everything newly asked turned off as access_denied for an app that already holds access, on the consent screen", async () => {
    const app = await holder();
    const screen = await consentScreen(app, ASKED);
    const denied = await decide(
      server,
      origin,
      cookie,
      screen.consent,
      false,
      [],
    );
    const sent = await decide(
      server,
      origin,
      cookie,
      screen.consent,
      true,
      tasksOff(screen.html),
      [],
      heldOn(screen.html),
    );
    expect(sent?.href.startsWith(CALLBACK), String(sent)).toBe(true);
    expect(sent?.searchParams.get("error")).toBe("access_denied");
    expect(sent?.searchParams.get("state")).toBe(
      denied?.searchParams.get("state"),
    );
    expect(sent?.searchParams.get("code")).toBeNull();
    // Nothing was granted: the app is asked again for what it asked.
    const again = await sentTo(
      server,
      await authorize(
        server,
        authorizeQuery(app.clientId, ASKED, pkce()),
        cookie,
      ),
    );
    expect(again?.pathname).toBe("/auth/consent");
    // The witness: the same page with Task left on is a code.
    const approved = await decide(
      server,
      origin,
      cookie,
      screen.consent,
      true,
      defaultSubmission(screen.html, "scopes"),
      [],
      heldOn(screen.html),
    );
    expect(approved?.searchParams.get("code")).toBeTruthy();
  });

  it("denies a device code approved with everything newly asked turned off by an app that already holds access, on the device approval page", async () => {
    const app = await holder();
    const screen = await deviceScreen(app, ASKED);
    const answered = await decideDevice(
      screen,
      "approve",
      tasksOff(screen.html),
    );
    expect(answered.status).toBe(200);
    await answered.body?.cancel();
    const polled = await poll(app, screen);
    expect(polled.status).toBe(400);
    expect(polled.body.error).toBe("access_denied");
    // The witness: the same page with Task left on is a token.
    const again = await deviceScreen(app, ASKED);
    expect(
      (
        await decideDevice(
          again,
          "approve",
          defaultSubmission(again.html, "scopes"),
        )
      ).status,
    ).toBe(200);
    const issued = await poll(app, again);
    expect(issued.status).toBe(200);
    expect(issued.body.scope?.split(" ").sort()).toEqual([
      "core.note:read",
      "core.task:read",
    ]);
  });
});

describe("what an approval grants an app whose access changed while the screen was open", () => {
  const booted = bootFor("approval-ended");
  beforeAll(booted.up, 2 * FRESH_SERVER_TIMEOUT_MS);
  afterAll(booted.down, 2 * FRESH_SERVER_TIMEOUT_MS);

  const HELD = "core.note:write keys.mint";
  const ASKED = `${HELD} core.task:read`;

  /** The app holds `held`, having been approved on the consent screen as drawn. */
  async function holder(held = HELD, asked = ASKED): Promise<App> {
    const app = await register(asked);
    const screen = await consentScreen(app, held);
    const sent = await sentTo(
      server,
      await approveWith(screen.consent, asDrawn(screen.html)),
    );
    expect(sent?.searchParams.get("code")).toBeTruthy();
    return app;
  }

  /** The scopes the code of an approval on the consent screen exchanges for. */
  async function exchanged(
    app: App,
    sent: URL | undefined,
    proof: ReturnType<typeof pkce>,
  ): Promise<string[]> {
    expect(sent?.searchParams.get("code"), String(sent)).toBeTruthy();
    const answer = await token(server, {
      grant_type: "authorization_code",
      code: sent?.searchParams.get("code") ?? "",
      redirect_uri: CALLBACK,
      code_verifier: proof.verifier,
      client_id: app.clientId,
    });
    expect(answer.status, JSON.stringify(answer.body)).toBe(200);
    return (answer.body.scope ?? "").split(" ").sort();
  }

  /** The consent screen for `asked`, asked with a proof the code can be redeemed with. */
  async function askAgain(
    app: App,
    asked = ASKED,
  ): Promise<{
    screen: Screen;
    proof: ReturnType<typeof pkce>;
  }> {
    const proof = pkce();
    const landed = await sentTo(
      server,
      await authorize(
        server,
        authorizeQuery(app.clientId, asked, proof),
        cookie,
      ),
    );
    expect(landed?.pathname, String(landed)).toBe("/auth/consent");
    const page = await fetch(landed!, { headers: { cookie } });
    return { screen: { html: await page.text(), consent: landed! }, proof };
  }

  /** Whether a browser request for `scope` is answered with a code and no screen. */
  async function holds(app: App, scope: string): Promise<boolean> {
    const sent = await sentTo(
      server,
      await authorize(
        server,
        authorizeQuery(app.clientId, scope, pkce()),
        cookie,
      ),
    );
    return sent?.href.startsWith(CALLBACK) === true;
  }

  it("adds the access the app still holds to what is approved on the consent screen", async () => {
    const app = await holder();
    const { screen, proof } = await askAgain(app);
    // The page posts the choices and the mechanisms, never the access held.
    const posted = defaultSubmission(screen.html, "scopes");
    expect(posted.sort()).toEqual(["core.task:read"]);
    const sent = await decide(
      server,
      origin,
      cookie,
      screen.consent,
      true,
      posted,
      [],
      heldOn(screen.html),
    );
    expect(await exchanged(app, sent, proof)).toEqual([
      "core.note:write",
      "core.task:read",
      "keys.mint",
    ]);
  });

  it("adds the access the app still holds to what is approved on the device approval page", async () => {
    const app = await holder();
    const device = await deviceScreen(app, ASKED);
    expect(defaultSubmission(device.html, "scopes")).toEqual([
      "core.task:read",
    ]);
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
    expect(issued.status, JSON.stringify(issued.body)).toBe(200);
    expect(issued.body.scope?.split(" ").sort()).toEqual([
      "core.note:write",
      "core.task:read",
      "keys.mint",
    ]);
  });

  it("draws the consent screen again and grants nothing once the app is disconnected while it is open", async () => {
    const app = await holder();
    const { screen, proof } = await askAgain(app);
    await disconnect(app);

    // A caller that takes only JSON is told of the conflict, and one that
    // takes a page gets the page drawn again.
    const json = await approveWith(
      screen.consent,
      asDrawn(screen.html),
      "application/json",
    );
    expect(json.status).toBe(409);
    expect(
      ((await json.json()) as { error?: { code?: string } }).error?.code,
    ).toBe("conflict");
    await drawnAgain(
      await approveWith(
        screen.consent,
        asDrawn(screen.html),
        "application/json, text/html",
      ),
    );
    const html = await drawnAgain(
      await approveWith(screen.consent, asDrawn(screen.html)),
    );
    expect(await holds(app, "core.note:write")).toBe(false);
    expect(await holds(app, "core.task:read")).toBe(false);
    // The page drawn again offers what was held as new, and posting it
    // grants what it now shows.
    expect(visibleText(html)).not.toContain("Already allowed");
    expect(heldOn(html)).not.toBe(heldOn(screen.html));
    const sent = await sentTo(
      server,
      await approveWith(screen.consent, [
        ["held", heldOn(html)],
        ["scopes", "core.task:read"],
        ["admin", "none"],
      ]),
    );
    expect(await exchanged(app, sent, proof)).toEqual(["core.task:read"]);
  });

  it("gives back no held read through Read Only beside the write once the app is disconnected", async () => {
    const asked = "core.note:read core.note:write core.task:read";
    /** Approve the read alone, then post Read Only and the tasks on a second screen. */
    async function readOnlyAndTasks(cut: boolean): Promise<{
      app: App;
      answered: Response;
      proof: ReturnType<typeof pkce>;
    }> {
      const app = await register(asked);
      const first = await consentScreen(app, "core.note:read");
      const held = await decide(server, origin, cookie, first.consent, true, [
        "core.note:read",
      ]);
      expect(held?.searchParams.get("code")).toBeTruthy();
      const { screen, proof } = await askAgain(app, asked);
      const readOnly = selectNamed(screen.html, "Note")?.options.find(
        (o) => o.label === "Read Only",
      );
      // The held level is offered, and posts nothing.
      expect(readOnly?.value).toBe("");
      if (cut) await disconnect(app);
      const answered = await decideResponse(
        server,
        origin,
        cookie,
        screen.consent,
        true,
        [readOnly?.value ?? "?", "core.task:read"],
        [],
        heldOn(screen.html),
      );
      return { app, answered, proof };
    }

    // The witness: while the read is held, it comes with the approval.
    const kept = await readOnlyAndTasks(false);
    expect(
      await exchanged(
        kept.app,
        await sentTo(server, kept.answered),
        kept.proof,
      ),
    ).toEqual(["core.note:read", "core.task:read"]);
    const cut = await readOnlyAndTasks(true);
    await drawnAgain(cut.answered);
    expect(await holds(cut.app, "core.note:read")).toBe(false);
    expect(await holds(cut.app, "core.task:read")).toBe(false);
  });

  it("draws the page again for a stale post that names more than the request, rather than refusing it", async () => {
    const app = await holder();
    const { screen } = await askAgain(app);
    const beyond: [string, string][] = [
      ...asDrawn(screen.html),
      ["scopes", "core.bookmark:read"],
    ];
    // The witness: on the access the page was drawn on, the post is refused.
    const refused = await approveWith(screen.consent, beyond);
    expect(refused.status, await refused.text()).toBe(400);
    await disconnect(app);
    await drawnAgain(await approveWith(screen.consent, beyond));
    expect(await holds(app, "core.task:read")).toBe(false);
  });

  it("draws the page again for a post with no held field from an app that holds access, and approves one from an app that holds none", async () => {
    const app = await holder();
    const { screen } = await askAgain(app);
    const unsaid = asDrawn(screen.html).filter(([name]) => name !== "held");
    await drawnAgain(await approveWith(screen.consent, unsaid));
    expect(await holds(app, "core.task:read")).toBe(false);
    // The witness: the same post with the page's held value is a code.
    const said = await sentTo(
      server,
      await approveWith(screen.consent, asDrawn(screen.html)),
    );
    expect(said?.searchParams.get("code")).toBeTruthy();

    const fresh = await register(ASKED);
    const first = await consentScreen(fresh, ASKED);
    expect(heldOn(first.html)).toBe("");
    const sent = await sentTo(
      server,
      await approveWith(
        first.consent,
        asDrawn(first.html).filter(([name]) => name !== "held"),
      ),
    );
    expect(sent?.searchParams.get("code")).toBeTruthy();
  });

  it("refuses the device code of a screen left open once the app is disconnected, and grants nothing", async () => {
    const app = await holder();
    const device = await deviceScreen(app, ASKED);
    const posted = defaultSubmission(device.html, "scopes");
    await disconnect(app);

    const answered = await decideDevice(device, "approve", posted);
    expect(answered.status).toBe(404);
    const polled = await poll(app, device);
    expect(polled.body.error).toBe("invalid_grant");
    expect(polled.body.access_token).toBeUndefined();
  });

  it("draws the page again and restores no power the person removed while it was open, at Full and at Limited, on both pages", async () => {
    const asked = "core.note:read audit.read instance.read keys.mint";
    for (const level of ["full", "limited"]) {
      const app = await holder("audit.read", asked);
      const { screen } = await askAgain(app, asked);
      const device = await deviceScreen(app, asked);
      for (const html of [screen.html, device.html]) {
        expect(visibleText(html), level).toMatch(
          /Already allowed.*Admin access: read the activity log/,
        );
        // Limited gives instance.read and not keys.mint, so it is offered.
        expect(adminLevels(html), level).toContain("limited");
      }
      await narrow(app, []);

      const fields = (html: string): [string, string][] => [
        ...asDrawn(html).filter(([name]) => name !== "admin"),
        ["admin", level],
      ];
      const browser = await drawnAgain(
        await approveWith(screen.consent, fields(screen.html)),
      );
      const onDevice = await drawnAgain(
        await approveDeviceWith(device, fields(device.html)),
      );
      // Read against the access the page was drawn on, either level would
      // keep audit.read; nothing is granted instead.
      expect(await holds(app, "audit.read"), level).toBe(false);
      expect(await holds(app, "instance.read"), level).toBe(false);
      const pending = await poll(app, device);
      expect(pending.body.error, level).toBe("authorization_pending");
      // Each page drawn again offers the power removed as new.
      for (const html of [browser, onDevice])
        expect(
          readControls(html)
            .filter((c) => c.name === "powers")
            .flatMap((c) => c.options.map((o) => o.value).filter(Boolean))
            .sort(),
          level,
        ).toEqual(["audit.read", "instance.read", "keys.mint"]);

      // The witness: the page drawn again grants the level it shows.
      const approved = await approveDeviceWith(device, fields(onDevice));
      expect(approved.status, level).toBe(200);
      await approved.body?.cancel();
      const issued = await poll(app, device);
      expect(issued.status, JSON.stringify(issued.body)).toBe(200);
      expect(issued.body.scope?.split(" ").sort(), level).toEqual(
        level === "full"
          ? ["audit.read", "core.note:read", "instance.read", "keys.mint"]
          : ["audit.read", "core.note:read", "instance.read"],
      );
    }
  });
});

describe("what a page drawn again keeps of the choices posted", () => {
  const booted = bootFor("approval-redrawn");
  beforeAll(booted.up, 2 * FRESH_SERVER_TIMEOUT_MS);
  afterAll(booted.down, 2 * FRESH_SERVER_TIMEOUT_MS);

  const ASKED =
    "core.note:read core.note:write core.task:read audit.read instance.read keys.mint";

  const chosenOf = (html: string, label: string) =>
    selectNamed(html, label)?.options.find((o) => o.selected)?.value;
  const levelOf = (html: string) =>
    readControls(html)
      .find((c) => c.name === "admin")
      ?.options.find((o) => o.selected)?.value;
  const allowed = (html: string) =>
    readControls(html)
      .filter((c) => c.name === "powers")
      .flatMap((c) => c.options.filter((o) => o.selected && o.value))
      .map((o) => o.value)
      .sort();
  const choicesOpen = (html: string) => /<details\b[^>]*\sopen[\s>]/.test(html);

  it("draws the page again with the choices the post made that it still offers, open, on both pages", async () => {
    const app = await register(ASKED);
    const first = await consentScreen(app, "core.task:read");
    const held = await approveWith(first.consent, asDrawn(first.html));
    expect((await sentTo(server, held))?.searchParams.get("code")).toBeTruthy();
    const browser = await consentScreen(app, ASKED);
    const device = await deviceScreen(app, ASKED);
    // The witness: a page opened starts at what the request names, its
    // choices closed.
    for (const html of [browser.html, device.html]) {
      expect(chosenOf(html, "Note")).toBe("core.note:write");
      expect(levelOf(html)).toBe("full");
      expect(allowed(html)).toEqual([
        "audit.read",
        "instance.read",
        "keys.mint",
      ]);
      expect(choicesOpen(html)).toBe(false);
    }
    await narrow(app, []);

    const chosen = (html: string): [string, string][] => [
      ["held", heldOn(html)],
      ["scopes", "core.note:read"],
      ["admin", "custom"],
      ["powers", ""],
      ["powers", "instance.read"],
      ["powers", ""],
    ];
    const pages = [
      await drawnAgain(
        await approveWith(browser.consent, chosen(browser.html)),
      ),
      await drawnAgain(await approveDeviceWith(device, chosen(device.html))),
    ];
    for (const html of pages) {
      expect(choicesOpen(html)).toBe(true);
      expect(chosenOf(html, "Note")).toBe("core.note:read");
      // Task is new on the page drawn again, and the post chose nothing for it.
      expect(selectNamed(html, "Task")?.options.map((o) => o.value)).toContain(
        "core.task:read",
      );
      expect(chosenOf(html, "Task")).toBe("");
      expect(levelOf(html)).toBe("custom");
      expect(allowed(html)).toEqual(["instance.read"]);
    }
  });

  it("keeps showing what the app already holds beside the open choices on a page drawn again, and grants it with what the page shows", async () => {
    const app = await register(ASKED);
    const first = await consentScreen(app, "core.note:read core.task:read");
    const held = await approveWith(first.consent, asDrawn(first.html));
    expect((await sentTo(server, held))?.searchParams.get("code")).toBeTruthy();
    const proof = pkce();
    const landed = await sentTo(
      server,
      await authorize(
        server,
        authorizeQuery(app.clientId, ASKED, proof),
        cookie,
      ),
    );
    const screen = await (await fetch(landed!, { headers: { cookie } })).text();
    expect(visibleText(screen)).toContain("Already allowed");
    await narrow(app, ["core.task:read"]);

    const again = await drawnAgain(
      await approveWith(landed!, [
        ["held", heldOn(screen)],
        ["scopes", "core.note:write"],
        ["admin", "none"],
      ]),
    );
    expect(choicesOpen(again)).toBe(true);
    expect(chosenOf(again, "Note")).toBe("core.note:write");
    // What the app still holds is on the page beside the choices.
    expect(visibleText(again)).toMatch(/Already allowed.*Task/);
    const sent = await sentTo(
      server,
      await approveWith(landed!, asDrawn(again)),
    );
    const issued = await redeem(app, sent, proof);
    expect(sorted(issued.body.scope)).toEqual([
      "core.note:read",
      "core.note:write",
      "core.task:read",
    ]);
  });

  it("says under the rows a page without scripts shows which choice makes them count, on both pages", async () => {
    const lines = [
      "These count when Settings, keys and more is set to Custom.",
      "These count when Your items is set to Each Type.",
    ];
    for (const [page, html] of await bothPages("*:read keys.mint")) {
      for (const line of lines) expect(visibleText(html), page).toContain(line);
    }
    // The witness: with no level above them, no row needs the line.
    for (const [page, html] of await bothPages("core.note:read")) {
      expect(visibleText(html), page).not.toContain("These count when");
    }
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
    const raw = await fetch(`${server.apiUrl}/auth/consent`, {
      method: "POST",
      redirect: "manual",
      headers: {
        cookie,
        origin,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams([
        ["decision", "approve"],
        ["authorization_request", screen.consent.search.slice(1)],
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
    expect(asked?.pathname).toBe("/auth/consent");
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

  it("answers an approval with nothing chosen as access_denied, as declining is answered", async () => {
    const scope = "offline_access core.note:read";
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
    for (const chosen of [[], [""], ["offline_access"]]) {
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
    expect(again?.pathname).toBe("/auth/consent");
    // The witness: choosing the note as well is a code.
    const approved = await decide(
      server,
      origin,
      cookie,
      screen.consent,
      true,
      ["core.note:read"],
    );
    expect(approved?.searchParams.get("code")).toBeTruthy();
  });

  it("denies a device code approved with nothing chosen", async () => {
    const scope = "offline_access core.note:read";
    for (const chosen of [[], ["offline_access"]]) {
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

  it("approves a request that names only offline_access, which offers nothing to turn off", async () => {
    const scope = "offline_access";
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

const ALL = "*:read *:write";
const CHOOSE = "choose-types";
const sorted = (scope: string | undefined) =>
  (scope ?? "")
    .split(" ")
    .filter((s) => s !== "")
    .sort();

/** The token a chosen set of types is exchanged for through the consent screen. */
async function browserToken(
  app: App,
  asked: string,
  scopes: readonly string[],
  types: readonly string[],
) {
  const proof = pkce();
  const landed = await sentTo(
    server,
    await authorize(server, authorizeQuery(app.clientId, asked, proof), cookie),
  );
  expect(landed?.pathname, String(landed)).toBe("/auth/consent");
  const sent = await decide(
    server,
    origin,
    cookie,
    landed!,
    true,
    scopes,
    types,
  );
  return { sent, proof };
}

async function redeem(
  app: App,
  sent: URL | undefined,
  proof: { verifier: string },
) {
  const code = sent?.searchParams.get("code");
  expect(code, String(sent)).toBeTruthy();
  return token(server, {
    grant_type: "authorization_code",
    code: code!,
    redirect_uri: CALLBACK,
    code_verifier: proof.verifier,
    client_id: app.clientId,
  });
}

describe("what the approval pages offer an app that asks for all data, and what choosing types grants", () => {
  const booted = bootFor("approval-types-offer");
  beforeAll(booted.up, 2 * FRESH_SERVER_TIMEOUT_MS);
  afterAll(booted.down, 2 * FRESH_SERVER_TIMEOUT_MS);

  it("offers all data as one choice with the choice to choose types, and a control for each type, on both pages", async () => {
    for (const [page, html] of await bothPages(ALL)) {
      const all = selectNamed(html, "Your items");
      expect(all?.name, page).toBe("scopes");
      expect(
        all?.options.map((o) => [o.value, o.label]),
        page,
      ).toEqual([
        ["*:write", "Read and Edit"],
        ["*:read", "Read Only"],
        ["", "No Access"],
        [CHOOSE, "Each Type…"],
      ]);
      const types = readControls(html).filter((c) => c.name === "types");
      const ids = types.map((c) =>
        c.options.at(0)?.value.replace(/:write$/, ""),
      );
      expect(ids.length, page).toBeGreaterThanOrEqual(20);
      expect(ids, page).toContain("core.note");
      // The platform's own bookkeeping is no choice of the person's.
      expect(
        ids.filter((id) => id?.startsWith("system.")),
        page,
      ).toEqual([]);
      for (const c of types)
        expect(
          c.options.map((o) => o.label),
          page,
        ).toEqual(["Read and Edit", "Read Only", "No Access"]);
      // Nothing changed: the page posts all data and no type.
      expect(defaultSubmission(html, "scopes"), page).toEqual(["*:write"]);
    }
  });

  it("offers no choice of types for a request that does not name all data", async () => {
    for (const [page, html] of await bothPages("core.*:read core.note:read")) {
      expect(offeredValues(html, "scopes"), page).not.toContain(CHOOSE);
      expect(
        readControls(html).filter((c) => c.name === "types"),
        page,
      ).toEqual([]);
    }
  });

  it("offers a type no higher than the level asked for all data", async () => {
    for (const [page, html] of await bothPages("*:read")) {
      for (const c of readControls(html).filter((c) => c.name === "types"))
        expect(
          c.options.map((o) => o.label),
          page,
        ).toEqual(["Read Only", "No Access"]);
    }
  });

  it("issues a token for exactly the types chosen, and not all data, on the device approval page", async () => {
    const app = await register(ALL);
    const screen = await deviceScreen(app, ALL);
    const approved = await decideDevice(
      screen,
      "approve",
      [CHOOSE],
      ["core.event:read", "core.task:write"],
    );
    expect(approved.status).toBe(200);
    const issued = await poll(app, screen);
    expect(issued.status, JSON.stringify(issued.body)).toBe(200);
    expect(sorted(issued.body.scope)).toEqual([
      "core.event:read",
      "core.task:read",
      "core.task:write",
    ]);
  });

  it("issues a token for all data and none of the type controls when types were not chosen", async () => {
    const app = await register(ALL);
    const { sent, proof } = await browserToken(
      app,
      ALL,
      ["*:read"],
      ["core.note:write", "core.task:read"],
    );
    const issued = await redeem(app, sent, proof);
    expect(sorted(issued.body.scope)).toEqual(["*:read"]);
    // A type deleted since the page was drawn is posted with the rest and means nothing.
    const stale = await browserToken(
      await register(ALL),
      ALL,
      ["*:read"],
      ["core.unheard:read", "core.note:write"],
    );
    expect(stale.sent?.searchParams.get("code")).toBeTruthy();
    const screen = await deviceScreen(await register(ALL), ALL);
    expect(
      (
        await decideDevice(
          screen,
          "approve",
          ["*:write"],
          ["core.note:read", "core.unheard:read"],
        )
      ).status,
    ).toBe(200);
  });
});

describe("what the approval pages refuse an app that asks for all data, and deny when no type is chosen", () => {
  const booted = bootFor("approval-types-refuse");
  beforeAll(booted.up, 2 * FRESH_SERVER_TIMEOUT_MS);
  afterAll(booted.down, 2 * FRESH_SERVER_TIMEOUT_MS);

  it("answers choosing types with none turned on as access_denied, as declining is answered, on both pages", async () => {
    const app = await register(ALL);
    const { sent } = await browserToken(app, ALL, [CHOOSE], ["", ""]);
    expect(sent?.searchParams.get("error")).toBe("access_denied");
    expect(sent?.searchParams.get("code")).toBeNull();
    const screen = await deviceScreen(await register(ALL), ALL);
    const denied = await decideDevice(screen, "approve", [CHOOSE], []);
    expect(denied.status).toBe(200);
    expect(visibleText(await denied.text())).toContain(
      "Your device isn’t connected",
    );
    expect((await poll(app, screen)).status).not.toBe(200);
  });

  it("refuses a type the request does not reach, and grants nothing, on the consent screen", async () => {
    // Asked only to read: a type's write is above the level asked.
    const asked = "*:read";
    for (const bad of [
      "core.note:write",
      "system.connection:read",
      "core.unheard:read",
      "core.*:read",
      "keys.mint",
    ]) {
      const app = await register(asked);
      const landed = await sentTo(
        server,
        await authorize(
          server,
          authorizeQuery(app.clientId, asked, pkce()),
          cookie,
        ),
      );
      const refused = await decideResponse(
        server,
        origin,
        cookie,
        landed!,
        true,
        [CHOOSE],
        ["core.task:read", bad],
      );
      expect(refused.status, bad).toBe(400);
      expect(refused.headers.get("location"), bad).toBeNull();
    }
    // The witness: the same post without the stray type is granted.
    const { sent } = await browserToken(
      await register(asked),
      asked,
      [CHOOSE],
      ["core.task:read"],
    );
    expect(sent?.searchParams.get("code")).toBeTruthy();
  });

  it("refuses a type the request does not reach, and grants nothing, on the device approval page", async () => {
    const asked = "*:read";
    for (const bad of ["core.note:write", "system.connection:read"]) {
      const app = await register(asked);
      const screen = await deviceScreen(app, asked);
      const refused = await decideDevice(
        screen,
        "approve",
        [CHOOSE],
        ["core.task:read", bad],
      );
      expect(refused.status, bad).toBe(400);
      // The code is still pending: nothing was granted.
      expect(["authorization_pending", "slow_down"], bad).toContain(
        (
          await token(server, {
            grant_type: DEVICE_GRANT,
            device_code: screen.deviceCode,
            client_id: app.clientId,
          })
        ).body.error,
      );
    }
  });
});

describe("what the approval pages keep when an app holds types and asks again for all data", () => {
  const booted = bootFor("approval-types-held");
  beforeAll(booted.up, 2 * FRESH_SERVER_TIMEOUT_MS);
  afterAll(booted.down, 2 * FRESH_SERVER_TIMEOUT_MS);

  it("issues a token for exactly the types chosen, and not all data, on the consent screen", async () => {
    const app = await register(ALL);
    const { sent, proof } = await browserToken(
      app,
      ALL,
      [CHOOSE],
      ["core.note:write", "core.task:read", ""],
    );
    const issued = await redeem(app, sent, proof);
    expect(issued.status, JSON.stringify(issued.body)).toBe(200);
    // A write brings the read the request named, as it does for a type asked by name.
    expect(sorted(issued.body.scope)).toEqual([
      "core.note:read",
      "core.note:write",
      "core.task:read",
    ]);
    // The token the narrowed request was exchanged for works.
    expect(await itemsStatus(server, issued.body.access_token ?? "")).toBe(200);
  });

  it("does not let a token for the types chosen reach a type left off", async () => {
    const app = await register(ALL);
    const { sent, proof } = await browserToken(
      app,
      ALL,
      [CHOOSE],
      ["core.task:read"],
    );
    const issued = await redeem(app, sent, proof);
    const read = (type: string) =>
      fetch(`${server.apiUrl}/items?type=${type}&limit=1`, {
        headers: { authorization: `Bearer ${issued.body.access_token ?? ""}` },
      });
    expect((await read("core.task")).status).toBe(200);
    // The witness is the line above: the same token reads the type it was given.
    expect((await read("core.note")).status).toBe(403);
  });

  it("keeps the types an app holds when it asks again for all data, and shows them as held", async () => {
    const app = await register(ALL);
    const first = await browserToken(app, ALL, [CHOOSE], ["core.note:read"]);
    expect(first.sent?.searchParams.get("code")).toBeTruthy();
    const proof = pkce();
    const again = await sentTo(
      server,
      await authorize(
        server,
        authorizeQuery(app.clientId, "*:read", proof),
        cookie,
      ),
    );
    expect(again?.pathname).toBe("/auth/consent");
    const page = await (await fetch(again!, { headers: { cookie } })).text();
    expect(visibleText(page)).toContain("Already allowed");
    // A type held in full is shown as held and offered no more.
    const offered = readControls(page)
      .filter((c) => c.name === "types")
      .map((c) => c.options.at(0)?.value);
    expect(offered).not.toContain("core.note:read");
    expect(offered).toContain("core.task:read");
    // Choosing another type keeps the held one.
    const sent = await decide(
      server,
      origin,
      cookie,
      again!,
      true,
      [CHOOSE],
      ["core.task:read"],
      heldOn(page),
    );
    const issued = await redeem(app, sent, proof);
    expect(sorted(issued.body.scope)).toEqual([
      "core.note:read",
      "core.task:read",
    ]);
  });

  it("denies and keeps what an app holds when it asks again for all data and nothing new is chosen", async () => {
    const app = await register(ALL);
    await browserToken(app, ALL, [CHOOSE], ["core.note:read"]);
    const again = await sentTo(
      server,
      await authorize(
        server,
        authorizeQuery(app.clientId, "*:read", pkce()),
        cookie,
      ),
    );
    const page = await (await fetch(again!, { headers: { cookie } })).text();
    const sent = await decide(
      server,
      origin,
      cookie,
      again!,
      true,
      [CHOOSE],
      [""],
      heldOn(page),
    );
    expect(sent?.searchParams.get("error")).toBe("access_denied");
    const still = await sentTo(
      server,
      await authorize(
        server,
        authorizeQuery(app.clientId, "core.note:read", pkce()),
        cookie,
      ),
    );
    expect(still?.href.startsWith(CALLBACK), String(still)).toBe(true);
  });

  it("keeps the types an app holds on the device approval page when it asks again for all data", async () => {
    const app = await register(ALL);
    const first = await deviceScreen(app, ALL);
    expect(
      (await decideDevice(first, "approve", [CHOOSE], ["core.note:read"]))
        .status,
    ).toBe(200);
    const again = await deviceScreen(app, "*:read");
    expect(visibleText(again.html)).toContain("Already allowed");
    expect(
      (await decideDevice(again, "approve", [CHOOSE], ["core.task:read"]))
        .status,
    ).toBe(200);
    const issued = await poll(app, again);
    expect(sorted(issued.body.scope)).toEqual([
      "core.note:read",
      "core.task:read",
    ]);
  });

  it("refreshes a token for the types chosen without widening them to all data", async () => {
    const app = await register(`${ALL} offline_access`);
    const { sent, proof } = await browserToken(
      app,
      `${ALL} offline_access`,
      [CHOOSE, "offline_access"],
      ["core.task:read"],
    );
    const issued = await redeem(app, sent, proof);
    expect(sorted(issued.body.scope)).toEqual([
      "core.task:read",
      "offline_access",
    ]);
    const refreshed = await token(server, {
      grant_type: "refresh_token",
      refresh_token: issued.body.refresh_token ?? "",
      client_id: app.clientId,
    });
    expect(refreshed.status, JSON.stringify(refreshed.body)).toBe(200);
    expect(sorted(refreshed.body.scope)).toEqual([
      "core.task:read",
      "offline_access",
    ]);
  });
});

describe("what the approval pages say of item types that share a label", () => {
  const booted = bootFor("approval-types-same-label");
  beforeAll(async () => {
    await booted.up();
    // The shipped `core.task` is labeled "Task" too, and the page's own
    // "Your profile" row is titled like the second type.
    for (const [id, label] of [
      ["aic.ticket.task", "Task"],
      ["aic.me.profile", "Your profile"],
    ]) {
      const registered = await fetch(`${server.apiUrl}/types`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${server.workingKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          id,
          label,
          fields: { title: { type: "string" } },
        }),
      });
      expect(registered.status, await registered.clone().text()).toBe(201);
    }
  }, 2 * FRESH_SERVER_TIMEOUT_MS);
  afterAll(booted.down, 2 * FRESH_SERVER_TIMEOUT_MS);

  /** The rows named `label`, each with what a person reads under the label. */
  const linesUnder = (html: string, label: string): string[] =>
    readRows(html)
      .filter((r) => r.control.label === label)
      .map((r) =>
        r.text.slice(r.text.lastIndexOf(label) + label.length).trim(),
      );

  it("shows each of them with its identifier, and a type with a label of its own without one, on both pages", async () => {
    for (const [page, html] of await bothPages(ALL)) {
      expect(linesUnder(html, "Task"), page).toEqual([
        "core.task",
        "aic.ticket.task",
      ]);
      expect(
        readRows(html)
          .filter((r) => r.control.label === "Task")
          .map((r) => r.control.options.at(0)?.value),
        page,
      ).toEqual(["core.task:write", "aic.ticket.task:write"]);
      expect(linesUnder(html, "Note"), page).toEqual([""]);
    }
  });

  it("describes the control of each of them by its identifier, and keeps the label as its name", async () => {
    for (const [page, html] of await bothPages(ALL)) {
      const described = readRows(html)
        .filter((r) => r.control.label === "Task")
        .map((r) =>
          (r.control.describedby ?? "")
            .split(" ")
            .filter(Boolean)
            .map((id) =>
              visibleText(
                new RegExp(
                  `<(?:div|span)[^>]*\\bid="${id}"[^>]*>([\\s\\S]*?)</(?:div|span)>`,
                ).exec(html)?.[1] ?? "",
              ),
            )
            .join(" "),
        );
      expect(described, page).toEqual(["core.task", "aic.ticket.task"]);
    }
  });

  it("gives a type the identifier when a page's own row shares its label, and that row none", async () => {
    const asked = "*:read profile:read";
    const app = await register(ALL);
    const screens: [string, string][] = [
      ["the consent screen", (await consentScreen(app, asked)).html],
      ["the device approval page", (await deviceScreen(app, asked)).html],
    ];
    for (const [page, html] of screens) {
      const profiles = readRows(html).filter(
        (r) => r.control.label === "Your profile",
      );
      const byName = (name: string) =>
        profiles.find((r) => r.control.name === name)?.text ?? "";
      expect(profiles, page).toHaveLength(2);
      expect(byName("types"), page).toContain("aic.me.profile");
      // The page's own row names no identifier, and the page says what it covers.
      expect(byName("scopes"), page).not.toContain("aic.me.profile");
      const profile = /<h2>Profile<\/h2>[\s\S]*?<\/section>/.exec(html)?.[0];
      expect(visibleText(profile ?? ""), page).toContain(
        "Name, username, email and picture.",
      );
    }
  });

  it("shows no identifier where only one type of a label is on the page, though the instance has two", async () => {
    // The witness for the test above: the same label, asked of one type alone.
    const one = await consentScreen(
      await register(ALL),
      "core.task:read core.note:read",
    );
    expect(linesUnder(one.html, "Task")).toEqual([""]);
  });
});

describe("what the approval pages say of one item type shown in two rows", () => {
  const booted = bootFor("approval-types-one-type-twice");
  beforeAll(booted.up, 2 * FRESH_SERVER_TIMEOUT_MS);
  afterAll(booted.down, 2 * FRESH_SERVER_TIMEOUT_MS);

  it("shows no identifier under either row, because both are the same type", async () => {
    // Asked beside all data, the type has a row of its own and one in the list of types.
    const { html } = await consentScreen(
      await register(ALL),
      "*:read core.task:write",
    );
    const tasks = readRows(html).filter((r) => r.control.label === "Task");
    // The witness: it is shown twice.
    expect(tasks.map((r) => r.control.name).sort()).toEqual([
      "scopes",
      "types",
    ]);
    for (const row of tasks)
      expect(row.text.slice(row.text.lastIndexOf("Task") + 4).trim()).toBe("");
  });
});

describe("what the approval pages start at, and what a page approved as drawn grants", () => {
  const booted = bootFor("approval-as-drawn");
  beforeAll(booted.up, 2 * FRESH_SERVER_TIMEOUT_MS);
  afterAll(booted.down, 2 * FRESH_SERVER_TIMEOUT_MS);

  const REQUEST = "core.note:read core.note:write core.task:read keys.mint";

  it("starts every choice at what the request names, on both pages", async () => {
    for (const [page, html] of await bothPages(REQUEST)) {
      expect(selectNamed(html, "Note")?.value, page).toBe("core.note:write");
      expect(selectNamed(html, "Task")?.value, page).toBe("core.task:read");
      expect(defaultSubmission(html, "admin"), page).toEqual(["full"]);
      expect(defaultSubmission(html, "powers"), page).toEqual(["keys.mint"]);
      // Each choice also offers less than the request names.
      expect(offeredValues(html, "admin"), page).toContain("none");
      expect(
        selectNamed(html, "Task")?.options.map((o) => o.value),
        page,
      ).toEqual(["core.task:read", ""]);
    }
  });

  it("grants the whole request for a page approved as drawn, on both pages", async () => {
    const app = await register(REQUEST);
    const proof = pkce();
    const landed = await sentTo(
      server,
      await authorize(
        server,
        authorizeQuery(app.clientId, REQUEST, proof),
        cookie,
      ),
    );
    const page = await fetch(landed!, { headers: { cookie } });
    const sent = await sentTo(
      server,
      await approveWith(landed!, asDrawn(await page.text())),
    );
    const exchanged = await token(server, {
      grant_type: "authorization_code",
      code: sent?.searchParams.get("code") ?? "",
      redirect_uri: CALLBACK,
      code_verifier: proof.verifier,
      client_id: app.clientId,
    });
    expect(exchanged.status, JSON.stringify(exchanged.body)).toBe(200);
    expect(exchanged.body.scope?.split(" ").sort()).toEqual(
      REQUEST.split(" ").sort(),
    );

    const device = await register(REQUEST);
    const screen = await deviceScreen(device, REQUEST);
    const approved = await approveDeviceWith(screen, asDrawn(screen.html));
    expect(approved.status).toBe(200);
    await approved.body?.cancel();
    const minted = await poll(device, screen);
    expect(minted.status, JSON.stringify(minted.body)).toBe(200);
    expect(minted.body.scope?.split(" ").sort()).toEqual(
      REQUEST.split(" ").sort(),
    );
  });

  it("offers nothing to choose where the request names only offline_access", async () => {
    for (const [page, html] of await bothPages("offline_access")) {
      expect(visibleText(html), page).not.toContain("Choose…");
      expect(
        readControls(html).filter((c) => c.tag === "select"),
        page,
      ).toEqual([]);
    }
  });

  it("offers nothing to choose where the app's standing consent covers every scope, on both pages", async () => {
    const app = await register(REQUEST);
    const first = await consentScreen(app, REQUEST);
    // The witness: the same request, before anything is held, offers choices.
    expect(visibleText(first.html)).toContain("Choose…");
    const approved = await sentTo(
      server,
      await approveWith(first.consent, asDrawn(first.html)),
    );
    expect(approved?.searchParams.get("code")).toBeTruthy();

    const again = await sentTo(
      server,
      await authorize(
        server,
        authorizeQuery(app.clientId, REQUEST, pkce(), { prompt: "consent" }),
        cookie,
      ),
    );
    expect(again?.pathname).toBe("/auth/consent");
    const browser = await fetch(again!, { headers: { cookie } });
    const device = await deviceScreen(app, REQUEST);
    for (const [page, html] of [
      ["the consent screen", await browser.text()],
      ["the device approval page", device.html],
    ] as const) {
      expect(visibleText(html), page).not.toContain("Choose…");
      expect(
        readControls(html).filter((c) => c.tag === "select"),
        page,
      ).toEqual([]);
    }
  });
});

describe("what the approval pages offer and grant an app that names no scope", () => {
  const booted = bootFor("approval-no-scope");
  beforeAll(booted.up, 2 * FRESH_SERVER_TIMEOUT_MS);
  afterAll(booted.down, 2 * FRESH_SERVER_TIMEOUT_MS);

  const DATA = ["content:read", "content:write", "edge.*:read", "edge.*:write"];
  const PERMISSIONS = [
    "schema.write",
    "keys.mint",
    "items.purge",
    "webhooks.manage",
    "config.manage",
    "audit.read",
    "grants.manage",
    "instance.read",
    "instance.maintain",
    "connectors.manage",
    "blobs.manage",
    "keys.manage",
  ];

  /** Registers as an MCP client does when it is told no scope: naming none. */
  async function registerNamingNone(): Promise<App> {
    const response = await fetch(`${server.apiUrl}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "names no scope",
        application_type: "native",
        redirect_uris: [CALLBACK],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
    });
    expect(response.status).toBe(201);
    return {
      clientId: ((await response.json()) as { client_id: string }).client_id,
    };
  }

  /** The consent screen of an authorization request, naming `scope` or none. */
  async function screenFor(
    app: App,
    scope: string | undefined,
    proof = pkce(),
  ) {
    const query = authorizeQuery(app.clientId, scope ?? "", proof);
    if (scope === undefined) query.delete("scope");
    const landed = await sentTo(server, await authorize(server, query, cookie));
    expect(landed?.pathname, String(landed)).toBe("/auth/consent");
    const page = await fetch(landed!, { headers: { cookie } });
    expect(page.status).toBe(200);
    return { html: await page.text(), consent: landed!, proof };
  }

  async function call(
    accessToken: string,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<number> {
    const response = await fetch(`${server.apiUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${accessToken}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    await response.body?.cancel();
    return response.status;
  }

  it("offers an app that names no scope the owner's content and links, read only beside read and edit or chosen types, and no permission", async () => {
    const { html } = await screenFor(await registerNamingNone(), undefined);
    expect(
      selectNamed(html, "Your content")?.options.map((o) => [o.value, o.label]),
    ).toEqual([
      ["content:write", "Read and Edit"],
      ["content:read", "Read Only"],
      ["", "No Access"],
      [CHOOSE, "Each Type…"],
    ]);
    const types = readControls(html).filter((c) => c.name === "types");
    const ids = types.map((c) => c.options.at(0)?.value.replace(/:write$/, ""));
    expect(ids).toEqual(expect.arrayContaining(["core.note", "core.task"]));
    expect(ids.filter((id) => /^(system|marfa)\./.test(id ?? ""))).toEqual([]);
    for (const c of types)
      expect(c.options.map((o) => o.label)).toEqual([
        "Read and Edit",
        "Read Only",
        "No Access",
      ]);
    expect(selectNamed(html, "Your items")).toBeUndefined();
    expect(
      selectNamed(html, "Links between items")?.options.map((o) => [
        o.value,
        o.label,
      ]),
    ).toEqual([
      ["edge.*:write", "Read and Edit"],
      ["edge.*:read", "Read Only"],
      ["", "No Access"],
    ]);
    expect(adminControls(html)).toEqual([]);
    const offered = offeredValues(html, "scopes");
    for (const permission of PERMISSIONS)
      expect(offered, permission).not.toContain(permission);
    expect(offered.filter((v) => /^(metadata|profile)/.test(v))).toEqual([]);
  });

  it("offers a permission to an app that names no scope at registration and asks for it by name", async () => {
    const { html } = await screenFor(
      await registerNamingNone(),
      "core.note:write keys.mint",
    );
    expect(
      readControls(html)
        .filter((c) => c.name === "powers")
        .map((c) => c.value),
    ).toEqual(["keys.mint"]);
    expect(selectNamed(html, "Your items")).toBeUndefined();
    expect(selectNamed(html, "Your content")).toBeUndefined();
  });

  it("issues an app that names no scope a token that reads and writes items and links, and mints no key and reads no settings", async () => {
    const app = await registerNamingNone();
    const { html, consent, proof } = await screenFor(app, undefined);
    const sent = await sentTo(
      server,
      await approveWith(consent, asDrawn(html)),
    );
    const issued = await redeem(app, sent, proof);
    expect(issued.status, JSON.stringify(issued.body)).toBe(200);
    expect(sorted(issued.body.scope)).toEqual(
      [...DATA, "offline_access"].sort(),
    );
    const bearer = issued.body.access_token!;
    expect(
      await call(bearer, "POST", "/items", {
        type: "core.note",
        properties: { title: "kept" },
      }),
    ).toBe(201);
    expect(await call(bearer, "GET", "/items?limit=1")).toBe(200);
    expect(await call(bearer, "GET", "/edges?limit=1")).toBe(200);
    // Content leaves out the system types, which a person's own key reads.
    expect(
      await call(bearer, "GET", "/items?type=system.folder&include=hidden"),
    ).toBe(403);
    expect(
      await call(bearer, "POST", "/keys", {
        label: "minted",
        source: "app/minted",
      }),
    ).toBe(403);
    expect(await call(bearer, "GET", "/config")).toBe(403);
    expect(await call(bearer, "GET", "/keys")).toBe(403);

    // A refresh keeps what was approved and never adds a permission.
    const widened = await token(server, {
      grant_type: "refresh_token",
      refresh_token: issued.body.refresh_token!,
      client_id: app.clientId,
      scope: "*:write keys.mint",
    });
    expect(widened.status).toBe(400);
    expect(widened.body.error).toBe("invalid_scope");
    const refreshed = await token(server, {
      grant_type: "refresh_token",
      refresh_token: issued.body.refresh_token!,
      client_id: app.clientId,
    });
    expect(refreshed.status, JSON.stringify(refreshed.body)).toBe(200);
    expect(sorted(refreshed.body.scope)).toEqual(
      [...DATA, "offline_access"].sort(),
    );
  });

  it("serves an app that names no scope every tool at /mcp, and each works within its content", async () => {
    const app = await registerNamingNone();
    const { html, consent, proof } = await screenFor(app, undefined);
    const sent = await sentTo(
      server,
      await approveWith(consent, asDrawn(html)),
    );
    const issued = await redeem(app, sent, proof);
    expect(issued.status, JSON.stringify(issued.body)).toBe(200);
    const mcp = await connectMcp(server.apiUrl, issued.body.access_token!);
    try {
      expect(await toolNames(mcp)).toEqual([...ALL_TOOLS].sort());
      const overview = toolResult(await callTool(mcp, "marfa_overview", {}));
      expect(overview.types).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: "core.note" })]),
      );
      const note = toolResult(
        await callTool(mcp, "marfa_create", {
          type: "core.note",
          properties: { title: "by the default", body: "one" },
        }),
      ) as { id: string; version: number };
      const found = toolResult(
        await callTool(mcp, "marfa_find", { type: "core.note" }),
      ) as { items: { id: string }[] };
      expect(found.items.map((item) => item.id)).toContain(note.id);
      const got = toolResult(
        await callTool(mcp, "marfa_get", { ids: [note.id] }),
      ) as { items: { id: string }[] };
      expect(got.items.map((item) => item.id)).toEqual([note.id]);
      toolResult(
        await callTool(mcp, "marfa_update", {
          id: note.id,
          version: note.version,
          properties: { body: "two" },
        }),
      );
      const talk = toolResult(
        await callTool(mcp, "marfa_create", {
          type: "core.conversation",
          properties: { title: "a talk" },
        }),
      ) as { id: string };
      toolResult(
        await callTool(mcp, "marfa_write_rows", {
          id: talk.id,
          table: "messages",
          operations: [
            {
              op: "put",
              values: {
                author: "person",
                text: "hello",
                sent_at: "2026-01-01T00:00:00Z",
              },
            },
          ],
        }),
      );
      const rows = toolResult(
        await callTool(mcp, "marfa_read_rows", {
          id: talk.id,
          table: "messages",
        }),
      ) as { rows: { values: { text: string } }[] };
      expect(rows.rows.map((row) => row.values.text)).toEqual(["hello"]);
      const preview = toolResult(
        await callTool(mcp, "marfa_delete", { ids: [note.id] }),
      );
      toolResult(
        await callTool(mcp, "marfa_delete", {
          ids: [note.id],
          confirm: preview.confirm,
        }),
      );
    } finally {
      await mcp.close();
    }
  });

  it("issues an app that names no scope a token that only reads when the person chooses Read Only", async () => {
    const app = await registerNamingNone();
    const { html, consent, proof } = await screenFor(app, undefined);
    // The page's own form, with Read Only chosen in both of its rows.
    const readOnly = defaultSubmission(html, "scopes").map((value) =>
      value.replace(/:write$/, ":read"),
    );
    expect(readOnly.sort()).toEqual(
      ["content:read", "edge.*:read", "offline_access"].sort(),
    );
    const sent = await decide(server, origin, cookie, consent, true, readOnly);
    const issued = await redeem(app, sent, proof);
    expect(issued.status, JSON.stringify(issued.body)).toBe(200);
    expect(sorted(issued.body.scope)).toEqual(
      ["content:read", "edge.*:read", "offline_access"].sort(),
    );
    const bearer = issued.body.access_token!;
    expect(await call(bearer, "GET", "/items?limit=1")).toBe(200);
    // The witness that the write is refused for its scope: the full token above writes.
    expect(
      await call(bearer, "POST", "/items", {
        type: "core.note",
        properties: { title: "refused" },
      }),
    ).toBe(403);
  });

  it("issues an app that names no scope a token for exactly the types chosen read only, which reads them, is refused the rest and writes nothing", async () => {
    const app = await registerNamingNone();
    const { consent, proof } = await screenFor(app, undefined);
    // Links left at No Access, and the mechanism the page posts as a hidden field.
    const sent = await decide(
      server,
      origin,
      cookie,
      consent,
      true,
      [CHOOSE, "", "offline_access"],
      ["core.note:read", "core.task:read", ""],
    );
    const issued = await redeem(app, sent, proof);
    expect(issued.status, JSON.stringify(issued.body)).toBe(200);
    expect(sorted(issued.body.scope)).toEqual([
      "core.note:read",
      "core.task:read",
      "offline_access",
    ]);
    const bearer = issued.body.access_token!;
    expect(await call(bearer, "GET", "/items?type=core.note&limit=1")).toBe(
      200,
    );
    expect(await call(bearer, "GET", "/items?type=core.task&limit=1")).toBe(
      200,
    );
    // The witness is the two reads above; a token for all of content reads this type.
    expect(await call(bearer, "GET", "/items?type=core.event&limit=1")).toBe(
      403,
    );
    // The full token of this group writes a note; this one may not.
    expect(
      await call(bearer, "POST", "/items", {
        type: "core.note",
        properties: { title: "refused" },
      }),
    ).toBe(403);
    const refreshed = await token(server, {
      grant_type: "refresh_token",
      refresh_token: issued.body.refresh_token!,
      client_id: app.clientId,
    });
    expect(refreshed.status, JSON.stringify(refreshed.body)).toBe(200);
    expect(sorted(refreshed.body.scope)).toEqual([
      "core.note:read",
      "core.task:read",
      "offline_access",
    ]);
  });

  it("offers content with the choice to choose types, at no level above the one asked, on both pages", async () => {
    for (const [scope, levels] of [
      [
        "content:read content:write",
        ["Read and Edit", "Read Only", "No Access"],
      ],
      ["content:read", ["Read Only", "No Access"]],
    ] as const) {
      for (const [page, html] of await bothPages(scope)) {
        expect(offeredValues(html, "scopes"), page).toContain(CHOOSE);
        const types = readControls(html).filter((c) => c.name === "types");
        expect(types.length, page).toBeGreaterThanOrEqual(20);
        for (const c of types)
          expect(
            c.options.map((o) => o.label),
            page,
          ).toEqual(levels);
      }
    }
  });

  it("issues a token for exactly the types chosen in place of content, and not content, on the device approval page", async () => {
    const asked = "content:read content:write";
    const app = await register(asked);
    const screen = await deviceScreen(app, asked);
    const approved = await decideDevice(
      screen,
      "approve",
      [CHOOSE],
      ["core.note:read", "core.task:write"],
    );
    expect(approved.status).toBe(200);
    const issued = await poll(app, screen);
    expect(issued.status, JSON.stringify(issued.body)).toBe(200);
    expect(sorted(issued.body.scope)).toEqual([
      "core.note:read",
      "core.task:read",
      "core.task:write",
    ]);
  });

  it("refuses a type that content read only does not reach, and grants nothing, on the consent screen", async () => {
    const asked = "content:read";
    for (const bad of [
      "core.note:write",
      "system.connection:read",
      "marfa.anything:read",
      "core.unheard:read",
      "*:read",
    ]) {
      const { consent } = await screenFor(await registerNamingNone(), asked);
      const refused = await decideResponse(
        server,
        origin,
        cookie,
        consent,
        true,
        [CHOOSE],
        ["core.task:read", bad],
      );
      expect(refused.status, bad).toBe(400);
      expect(refused.headers.get("location"), bad).toBeNull();
    }
    // The witness: the same post without the stray type is granted.
    const { consent } = await screenFor(await registerNamingNone(), asked);
    const sent = await decide(
      server,
      origin,
      cookie,
      consent,
      true,
      [CHOOSE],
      ["core.task:read"],
    );
    expect(sent?.searchParams.get("code")).toBeTruthy();
  });
});
