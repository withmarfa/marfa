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
  types: readonly string[] = [],
  access?: string,
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
      ...(access === undefined ? [] : [["access", access] as [string, string]]),
      ...scopes.map((s): [string, string] => ["scopes", s]),
      ...types.map((t): [string, string] => ["types", t]),
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
      const notes = selectNamed(html, "Note");
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

  it("says that editing includes adding and deleting items, where a level to edit is offered, on both pages", async () => {
    const line = "Edit includes adding and deleting items.";
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
      const notes = rows.find((r) => r.control.label === "Note");
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

describe("what the approval pages and the key form say of a permission", () => {
  const booted = bootFor("approval-words");
  beforeAll(booted.up, 2 * FRESH_SERVER_TIMEOUT_MS);
  afterAll(booted.down, 2 * FRESH_SERVER_TIMEOUT_MS);

  const TWELVE = [
    "audit.read",
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
    "webhooks.manage",
  ];

  const keyForm = async (): Promise<string> => {
    const res = await fetch(`${server.apiUrl}/auth/owner/keys/new`, {
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    return res.text();
  };

  // The first switch of the group is read with the group's heading and the line
  // under it, which counts what is on and so differs by page.
  const ownWords = (text: string | undefined): string | undefined =>
    text?.replace(
      /^More control over Marfa (?:\d+ things? asked[^.]*? turn it on|\d+ of \d+ turned on) /,
      "",
    );

  it("describes each permission in the same words on both pages and on the key form", async () => {
    const pages = await bothPages(`core.note:read ${TWELVE.join(" ")}`);
    const form = await keyForm();
    for (const permission of TWELVE) {
      const onForm = ownWords(
        readRows(form).find((r) => r.control.value === permission)?.text,
      );
      expect(onForm, `the key form: ${permission}`).toBeTruthy();
      for (const [page, html] of pages) {
        const row = readRows(html).find((r) => r.control.value === permission);
        expect(ownWords(row?.text), `${page}: ${permission}`).toBe(onForm);
      }
    }
  });

  it("marks the permissions that delete for good on the key form, and no other", async () => {
    const marked = ["instance.maintain", "schema.write", "items.purge"];
    const form = await keyForm();
    for (const permission of TWELVE) {
      const row = readRows(form).find((r) => r.control.value === permission);
      expect(row, permission).toBeDefined();
      expect(/can't be undone/i.test(row?.text ?? ""), permission).toBe(
        marked.includes(permission),
      );
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

  it("shows a scope the app holds in full without offering it as a choice, and does not post it, on the consent screen", async () => {
    const app = await holder();
    const { html } = await consentScreen(app, "core.note:read core.task:read");
    expect(selectNamed(html, "Note")).toBeUndefined();
    expect(selectNamed(html, "Task")?.options.map((o) => o.label)).toEqual([
      "No access",
      "Read only",
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
      ).toEqual(["Read only", "Read and edit"]);
      // A type the app holds nothing of keeps the choice of no access.
      expect(
        selectNamed(html, "Task")?.options.map((o) => o.label),
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
        ["", "Read only"],
        [c.write, "Read and edit"],
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
      label: "Profile",
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
    expect(again?.pathname).toBe("/auth/authorize");
    // The witness: the same page with Task left on is a code.
    const approved = await decide(
      server,
      origin,
      cookie,
      screen.consent,
      true,
      defaultSubmission(screen.html, "scopes"),
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

describe("what an approval grants an app whose access ended while the screen was open", () => {
  const booted = bootFor("approval-ended");
  beforeAll(booted.up, 2 * FRESH_SERVER_TIMEOUT_MS);
  afterAll(booted.down, 2 * FRESH_SERVER_TIMEOUT_MS);

  const HELD = "core.note:write keys.mint";
  const ASKED = `${HELD} core.task:read`;

  /** The app holds `HELD`, having been approved on the consent screen. */
  async function holder(): Promise<App> {
    const app = await register(ASKED);
    const screen = await consentScreen(app, HELD);
    // The permission starts off, so the person turns it on.
    const sent = await decide(
      server,
      origin,
      cookie,
      screen.consent,
      true,
      HELD.split(" "),
    );
    expect(sent?.searchParams.get("code")).toBeTruthy();
    return app;
  }

  /** The person disconnects the app from another tab. */
  async function disconnect(app: App): Promise<void> {
    const authorization = { authorization: `Bearer ${server.managementKey}` };
    const listed = await fetch(`${server.apiUrl}/auth/grants`, {
      headers: authorization,
    });
    const grant = (
      (await listed.json()) as { data: { id: string; client_id: string }[] }
    ).data.find((g) => g.client_id === app.clientId);
    expect(grant, "the app had no grant to disconnect").toBeDefined();
    const revoked = await fetch(`${server.apiUrl}/auth/grants/${grant!.id}`, {
      method: "DELETE",
      headers: authorization,
    });
    expect(revoked.status).toBe(204);
  }

  /** The scopes the code of an approval on the consent screen exchanges for. */
  async function exchanged(
    app: App,
    screen: Screen,
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
    expect(screen.consent.pathname).toBe("/auth/authorize");
    return (answer.body.scope ?? "").split(" ").sort();
  }

  /** The consent screen for `ASKED`, asked with a proof the code can be redeemed with. */
  async function askAgain(app: App): Promise<{
    screen: Screen;
    proof: ReturnType<typeof pkce>;
  }> {
    const proof = pkce();
    const landed = await sentTo(
      server,
      await authorize(
        server,
        authorizeQuery(app.clientId, ASKED, proof),
        cookie,
      ),
    );
    expect(landed?.pathname, String(landed)).toBe("/auth/authorize");
    const page = await fetch(landed!, { headers: { cookie } });
    return { screen: { html: await page.text(), consent: landed! }, proof };
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
    );
    expect(await exchanged(app, screen, sent, proof)).toEqual([
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

  it("gives back nothing the person ended, and denies where nothing new is chosen, on the consent screen", async () => {
    const app = await holder();
    const { screen, proof } = await askAgain(app);
    const posted = defaultSubmission(screen.html, "scopes");
    await disconnect(app);

    const denied = await decide(
      server,
      origin,
      cookie,
      screen.consent,
      true,
      posted.filter((v) => v !== "core.task:read"),
    );
    expect(denied?.searchParams.get("error")).toBe("access_denied");
    expect(denied?.searchParams.get("code")).toBeNull();

    // The witness: the tasks they chose are all they get. The notes and key
    // making they held come back with no control shown.
    const sent = await decide(
      server,
      origin,
      cookie,
      screen.consent,
      true,
      posted,
    );
    expect(await exchanged(app, screen, sent, proof)).toEqual([
      "core.task:read",
    ]);
  });

  it("gives back no held read through Read only beside the write once the app is disconnected", async () => {
    const asked = "core.note:read core.note:write core.task:read";
    /** Approve the read alone, then post Read only and the tasks on a second screen. */
    async function readOnlyAndTasks(cut: boolean): Promise<string[]> {
      const app = await register(asked);
      const first = await consentScreen(app, "core.note:read");
      const held = await decide(server, origin, cookie, first.consent, true, [
        "core.note:read",
      ]);
      expect(held?.searchParams.get("code")).toBeTruthy();
      const proof = pkce();
      const landed = await sentTo(
        server,
        await authorize(
          server,
          authorizeQuery(app.clientId, asked, proof),
          cookie,
        ),
      );
      const page = await fetch(landed!, { headers: { cookie } });
      const screen = { html: await page.text(), consent: landed! };
      const readOnly = selectNamed(screen.html, "Note")?.options.find(
        (o) => o.label === "Read only",
      );
      // The held level is offered, and posts nothing.
      expect(readOnly?.value).toBe("");
      if (cut) await disconnect(app);
      const sent = await decide(server, origin, cookie, screen.consent, true, [
        readOnly?.value ?? "?",
        "core.task:read",
      ]);
      return exchanged(app, screen, sent, proof);
    }

    // The witness: while the read is held, it comes with the approval.
    expect(await readOnlyAndTasks(false)).toEqual([
      "core.note:read",
      "core.task:read",
    ]);
    expect(await readOnlyAndTasks(true)).toEqual(["core.task:read"]);
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

  it("answers an approval with nothing chosen as access_denied, as declining is answered", async () => {
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
  expect(landed?.pathname, String(landed)).toBe("/auth/authorize");
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
  return token(
    server,
    {
      grant_type: "authorization_code",
      code: code!,
      redirect_uri: CALLBACK,
      code_verifier: proof.verifier,
      client_id: app.clientId,
    },
    app,
  );
}

describe("what the approval pages offer an app that asks for all data, and what choosing types grants", () => {
  const booted = bootFor("approval-types-offer");
  beforeAll(booted.up, 2 * FRESH_SERVER_TIMEOUT_MS);
  afterAll(booted.down, 2 * FRESH_SERVER_TIMEOUT_MS);

  it("offers all data as one choice with the choice to choose types, and a control for each type, on both pages", async () => {
    for (const [page, html] of await bothPages(ALL)) {
      const all = selectNamed(html, "All your data");
      expect(all?.name, page).toBe("scopes");
      expect(
        all?.options.map((o) => [o.value, o.label]),
        page,
      ).toEqual([
        ["", "No access"],
        ["*:read", "Read only"],
        ["*:write", "Read and edit"],
        [CHOOSE, "Choose types"],
      ]);
      const types = readControls(html).filter((c) => c.name === "types");
      const ids = types.map((c) =>
        c.options.at(-1)?.value.replace(/:write$/, ""),
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
        ).toEqual(["No access", "Read only", "Read and edit"]);
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
        ).toEqual(["No access", "Read only"]);
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
    expect(visibleText(await denied.text())).toMatch(/didn't approve access/i);
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
    expect(again?.pathname).toBe("/auth/authorize");
    const page = await (await fetch(again!, { headers: { cookie } })).text();
    expect(visibleText(page)).toContain("Already allowed");
    // A type held in full is shown as held and offered no more.
    const offered = readControls(page)
      .filter((c) => c.name === "types")
      .map((c) => c.options.at(-1)?.value);
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
    const sent = await decide(
      server,
      origin,
      cookie,
      again!,
      true,
      [CHOOSE],
      [""],
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
    const refreshed = await token(
      server,
      {
        grant_type: "refresh_token",
        refresh_token: issued.body.refresh_token ?? "",
        client_id: app.clientId,
      },
      app,
    );
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
    // "Profile" row is titled like the second type.
    for (const [id, label] of [
      ["aic.ticket.task", "Task"],
      ["aic.me.profile", "Profile"],
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
          .map((r) => r.control.options.at(-1)?.value),
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
                  `<div[^>]*\\bid="${id}"[^>]*>([\\s\\S]*?)</div>`,
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
        (r) => r.control.label === "Profile",
      );
      const byName = (name: string) =>
        profiles.find((r) => r.control.name === name)?.text ?? "";
      expect(profiles, page).toHaveLength(2);
      expect(byName("types"), page).toContain("aic.me.profile");
      // The page's own row says what it covers, and names no identifier.
      expect(byName("scopes"), page).not.toContain("aic.me.profile");
      expect(
        byName("scopes")
          .replace(/^.*?Profile/, "")
          .trim(),
        page,
      ).toMatch(/^Your name, email address and avatar/);
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

describe("what full access on the approval pages grants", () => {
  const booted = bootFor("approval-full-access");
  beforeAll(booted.up, 2 * FRESH_SERVER_TIMEOUT_MS);
  afterAll(booted.down, 2 * FRESH_SERVER_TIMEOUT_MS);

  const REQUEST = "core.note:read core.note:write core.task:read";

  it("offers full access selected, and choosing access, on both pages", async () => {
    for (const [page, html] of await bothPages(REQUEST)) {
      expect(offeredValues(html, "access"), page).toEqual(["full", "choose"]);
      expect(defaultSubmission(html, "access"), page).toEqual(["full"]);
      expect(visibleText(html), page).toContain("Full access");
      expect(visibleText(html), page).toContain("Choose access");
    }
  });

  it("offers no choice of access where the request names nothing to choose", async () => {
    for (const [page, html] of await bothPages("openid")) {
      expect(offeredValues(html, "access"), page).toEqual([]);
    }
  });

  it("issues a token for the whole request when the person approves with full access and posts no scope", async () => {
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
    const sent = await decide(
      server,
      origin,
      cookie,
      landed!,
      true,
      [],
      [],
      "full",
    );
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
      "core.task:read",
    ]);
  });

  it("witness: the same post without full access is a denial", async () => {
    const app = await register(REQUEST);
    const landed = await sentTo(
      server,
      await authorize(
        server,
        authorizeQuery(app.clientId, REQUEST, pkce()),
        cookie,
      ),
    );
    const sent = await decide(server, origin, cookie, landed!, true, []);
    expect(sent?.searchParams.get("code")).toBeNull();
    expect(sent?.searchParams.get("error")).toBe("access_denied");
  });

  it("never grants a scope the request did not name, whatever the form adds", async () => {
    const app = await register("core.note:read");
    const proof = pkce();
    const landed = await sentTo(
      server,
      await authorize(
        server,
        authorizeQuery(app.clientId, "core.note:read", proof),
        cookie,
      ),
    );
    const sent = await decide(
      server,
      origin,
      cookie,
      landed!,
      true,
      ["core.note:write", "keys.mint"],
      [],
      "full",
    );
    const exchanged = await token(server, {
      grant_type: "authorization_code",
      code: sent?.searchParams.get("code") ?? "",
      redirect_uri: CALLBACK,
      code_verifier: proof.verifier,
      client_id: app.clientId,
    });
    expect(exchanged.status, JSON.stringify(exchanged.body)).toBe(200);
    expect(exchanged.body.scope).toBe("core.note:read");
  });

  it("approves a device code for the whole request with full access and no scope", async () => {
    const app = await register(REQUEST);
    const screen = await deviceScreen(app, REQUEST);
    const approved = await decideDevice(screen, "approve", [], [], "full");
    expect(approved.status).toBe(200);
    await approved.body?.cancel();
    const minted = await poll(app, screen);
    expect(minted.status, JSON.stringify(minted.body)).toBe(200);
    expect(minted.body.scope?.split(" ").sort()).toEqual([
      "core.note:read",
      "core.note:write",
      "core.task:read",
    ]);
  });

  it("never grants a scope the device code did not carry, whatever the form adds", async () => {
    const app = await register("core.note:read");
    const screen = await deviceScreen(app, "core.note:read");
    const approved = await decideDevice(
      screen,
      "approve",
      ["keys.mint"],
      [],
      "full",
    );
    expect(approved.status).toBe(200);
    await approved.body?.cancel();
    const minted = await poll(app, screen);
    expect(minted.body.scope).toBe("core.note:read");
  });
});
