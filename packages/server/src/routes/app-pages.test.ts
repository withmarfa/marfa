import { DEVICE_CODE_GRANT_TYPE } from "@better-auth/oauth-provider";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  pageFields,
  pageForms,
  pageLinks,
  visibleText,
} from "../pages/reading.js";
import { HOSTILE } from "../pages/test-fixture.js";
import { hashApiKey } from "../middleware/auth.js";
import {
  createTestContext,
  mintWorkingKey,
  request,
  seedOauthBearer,
  TEST_API_KEY_SALT,
} from "../test-utils.js";
import type { TestContext } from "../test-utils.js";

vi.setConfig({ testTimeout: 60_000 });

let ctx: TestContext;
let counter = 0;

beforeAll(async () => {
  ctx = await createTestContext({});
});

afterAll(async () => {
  await ctx.cleanup();
});

async function page(path: string): Promise<{ status: number; html: string }> {
  const res = await ctx.ownerRequest(path, {
    headers: { accept: "text/html" },
  });
  return { status: res.status, html: await res.text() };
}

/** Disconnects every app, through the door the pages use. */
async function disconnectAll(): Promise<void> {
  const listed = await ctx.ownerRequest("/owner/sign-ins");
  const { data } = (await listed.json()) as {
    data: { id: string; kind: string }[];
  };
  for (const row of data.filter((r) => r.kind === "app"))
    await ctx.ownerRequest(`/owner/sign-ins/${row.id}`, { method: "DELETE" });
}

/** A key the app made, as the pages tell one from the owner's own. */
async function appKey(clientId: string, label: string): Promise<string> {
  counter += 1;
  const key = await ctx.storage.keys.create(
    {
      label,
      source: `app-pages-${String(counter)}`,
      permissions: [],
      type_permissions: { "core.note": "read" },
      extension_permissions: {},
      edge_permissions: {},
      metadata_permissions: {},
      profile_permissions: {},
      default_tier: "library",
      oauth_client_id: clientId,
    },
    hashApiKey(`marfa_k1_app_${String(counter)}`, TEST_API_KEY_SALT),
  );
  return key.id;
}

/** Connects a client that registered for the device grant, as the command line does. */
async function connectCommandLine(): Promise<string> {
  const origin = "http://localhost:0";
  const registered = await request(ctx.app, "POST", "/auth/oauth2/register", {
    body: {
      client_name: "marfa on a laptop",
      application_type: "native",
      grant_types: [DEVICE_CODE_GRANT_TYPE, "refresh_token"],
      token_endpoint_auth_method: "none",
      redirect_uris: [`${origin}/callback`],
      response_types: [],
    },
    headers: { origin },
  });
  const { client_id: clientId } = (await registered.json()) as {
    client_id: string;
  };
  const started = await request(ctx.app, "POST", "/auth/device/code", {
    form: { client_id: clientId, scope: "core.note:read" },
    headers: { origin },
  });
  const { user_code: userCode } = (await started.json()) as {
    user_code: string;
  };
  await request(
    ctx.app,
    "GET",
    `/auth/device/consent?user_code=${encodeURIComponent(userCode)}`,
    { headers: { cookie: ctx.owner.cookie } },
  );
  const decided = await request(ctx.app, "POST", "/auth/device/consent", {
    form: {
      user_code: userCode,
      decision: "approve",
      scopes: ["core.note:read"],
    },
    headers: { origin, cookie: ctx.owner.cookie },
  });
  expect(decided.status).toBe(200);
  return clientId;
}

/** The names of the apps a list page shows, in order. */
function rowsOf(html: string): string[] {
  return pageLinks(html)
    .filter((link) => /^\/auth\/owner\/apps\/[^/]+$/.test(link.href))
    .map((link) => link.text);
}

describe("the connected apps list", () => {
  it("says there are none, and offers neither search nor kinds, until there is an app", async () => {
    await disconnectAll();
    const none = (await page("/auth/owner/apps")).html;
    expect(visibleText(none)).toContain("No connected apps");
    expect(pageFields(none).find((f) => f.name === "q")).toBeUndefined();
    expect(pageFields(none).find((f) => f.name === "kind")).toBeUndefined();
    // Witness: with an app the same page has what it left out.
    await seedOauthBearer(ctx, ["core.note:read"], { clientName: "Notes" });
    const one = (await page("/auth/owner/apps")).html;
    expect(pageFields(one).find((f) => f.name === "q")).toBeDefined();
    expect(pageFields(one).find((f) => f.name === "kind")).toBeDefined();
    expect(visibleText(one)).not.toContain("No connected apps");
  });

  it("lists an app with its kind, what it can reach, when it was approved and that it was never used, linking to its page", async () => {
    await disconnectAll();
    const app = await seedOauthBearer(ctx, ["core.note:read"], {
      clientName: "Notes",
    });
    const { status, html } = await page("/auth/owner/apps");
    expect(status).toBe(200);
    const link = pageLinks(html).find(
      (l) => l.href === `/auth/owner/apps/${app.grantId}`,
    );
    expect(link?.text).toContain("Notes");
    expect(link?.text).toContain("App.");
    expect(link?.text).toContain("Approved");
    expect(link?.text).toContain("Never used");
  });

  it("tells a web page, the command line and an app apart, and filters by kind", async () => {
    await disconnectAll();
    await seedOauthBearer(ctx, ["core.note:read"], { clientName: "Notes" });
    await seedOauthBearer(ctx, ["core.note:read"], {
      clientName: "Reader",
      webRedirectUri: "https://reader.example/callback",
    });
    await connectCommandLine();
    const all = rowsOf((await page("/auth/owner/apps")).html);
    expect(all).toHaveLength(3);
    const text = all.join("\n");
    expect(text).toContain("Web page at reader.example");
    expect(text).toContain("Command line");

    const only = async (kind: string) =>
      rowsOf((await page(`/auth/owner/apps?kind=${kind}`)).html);
    expect(await only("web")).toEqual([
      expect.stringContaining("Reader") as string,
    ]);
    expect(await only("cli")).toEqual([
      expect.stringContaining("marfa on a laptop") as string,
    ]);
    expect(await only("app")).toEqual([
      expect.stringContaining("Notes") as string,
    ]);
    // A kind the list does not know is no filter.
    expect(await only("nonsense")).toHaveLength(3);
  });

  it("says when a kind has none, and points back to all", async () => {
    await disconnectAll();
    await seedOauthBearer(ctx, ["core.note:read"], { clientName: "Notes" });
    const { html } = await page("/auth/owner/apps?kind=cli");
    expect(visibleText(html)).toContain("None of this kind");
    expect(visibleText(html)).toContain("Choose All kinds to see the rest.");
    expect(rowsOf(html)).toEqual([]);
  });

  it("searches the names, and says so when nothing matches", async () => {
    await disconnectAll();
    await seedOauthBearer(ctx, ["core.note:read"], { clientName: "Notes" });
    await seedOauthBearer(ctx, ["core.note:read"], { clientName: "Reader" });
    const hit = (await page("/auth/owner/apps?q=read")).html;
    expect(rowsOf(hit)).toEqual([expect.stringContaining("Reader") as string]);
    const none = (await page("/auth/owner/apps?q=zebra")).html;
    expect(visibleText(none)).toContain("No apps match");
  });

  it("pages ten at a time and takes the size from the address", async () => {
    await disconnectAll();
    for (let n = 1; n <= 11; n += 1)
      await seedOauthBearer(ctx, ["core.note:read"], {
        clientName: `App ${String(n).padStart(2, "0")}`,
      });
    const first = (await page("/auth/owner/apps")).html;
    expect(rowsOf(first)).toHaveLength(10);
    expect(visibleText(first)).toContain("1–10 of 11");
    const second = (await page("/auth/owner/apps?page=2")).html;
    expect(rowsOf(second)).toHaveLength(1);
    const wide = (await page("/auth/owner/apps?size=25")).html;
    expect(rowsOf(wide)).toHaveLength(11);
  });

  it("writes a name made of markup as text", async () => {
    await disconnectAll();
    const app = await seedOauthBearer(ctx, ["core.note:read"], {
      clientName: HOSTILE,
    });
    for (const path of [
      "/auth/owner/apps",
      `/auth/owner/apps/${app.grantId}`,
    ]) {
      const { html } = await page(path);
      expect(html, path).not.toContain("<script>window.__injected");
      expect(html, path).not.toContain("<b>bold</b>");
      expect(visibleText(html), path).toContain(HOSTILE);
    }
  });

  it("refuses a query key it does not know", async () => {
    const res = await ctx.ownerRequest("/auth/owner/apps?surprise=1");
    expect(res.status).toBe(400);
  });
});

describe("Home, for the connected apps", () => {
  it("counts them", async () => {
    await disconnectAll();
    expect(visibleText((await page("/")).html)).toMatch(
      /Apps you've approved, and what each can access None/,
    );
    await seedOauthBearer(ctx, ["core.note:read"], { clientName: "One" });
    await seedOauthBearer(ctx, ["core.note:read"], { clientName: "Two" });
    expect(visibleText((await page("/")).html)).toContain(
      "Apps you've approved, and what each can access 2 apps",
    );
  });
});

describe("an app's own page", () => {
  it("shows its kind, when it was approved and last used, and what it can reach without a control to change it", async () => {
    await disconnectAll();
    const app = await seedOauthBearer(ctx, ["core.note:read"], {
      clientName: "Reader",
      webRedirectUri: "https://reader.example/callback",
    });
    const { status, html } = await page(`/auth/owner/apps/${app.grantId}`);
    expect(status).toBe(200);
    const text = visibleText(html);
    expect(text).toContain("Reader");
    expect(text).toMatch(/Kind Web page/);
    expect(text).toContain("Address reader.example");
    expect(text).toMatch(/Approved \w+ \d+/);
    expect(text).toMatch(/Last used Never/);
    expect(text).toContain("Your data");
    // It shows what the app holds and asks for nothing: no field but the
    // password of the confirm dialog, no save.
    expect(
      pageFields(html)
        .filter((f) => f.type !== "hidden")
        .map((f) => f.name),
    ).toEqual(["password"]);
    expect(pageForms(html).filter((f) => f.method === "post")).toEqual([]);
    expect(text).not.toContain("Save changes");
  });

  it("lists the keys the app made, linking to each key's page, and not the owner's own", async () => {
    await disconnectAll();
    const app = await seedOauthBearer(ctx, ["core.note:read"], {
      clientName: "Reader",
    });
    const made = await appKey(app.clientId, "reader sync");
    const { html } = await page(`/auth/owner/apps/${app.grantId}`);
    const link = pageLinks(html).find(
      (l) => l.href === `/auth/owner/keys/${made}`,
    );
    expect(link?.text).toContain("reader sync");
    expect(visibleText(html)).toContain(
      "Each was made with no more access than the app had.",
    );
  });

  it("says it made no keys when it made none", async () => {
    await disconnectAll();
    const app = await seedOauthBearer(ctx, ["core.note:read"], {
      clientName: "Reader",
    });
    const text = visibleText(
      (await page(`/auth/owner/apps/${app.grantId}`)).html,
    );
    expect(text).toContain("No keys");
    expect(text).toContain("Keys this app makes show here.");
  });

  it("asks about the keys at Disconnect only when the app made some, and counts them", async () => {
    await disconnectAll();
    const app = await seedOauthBearer(ctx, ["core.note:read"], {
      clientName: "Reader",
    });
    const without = visibleText(
      (await page(`/auth/owner/apps/${app.grantId}`)).html,
    );
    expect(without).toContain("Disconnect Reader?");
    expect(without).not.toContain("Also revoke the keys it made");
    expect(without).toContain("It loses access at once.");
    expect(without).not.toContain("keep working");
    await appKey(app.clientId, "one");
    await appKey(app.clientId, "two");
    const withKeys = visibleText(
      (await page(`/auth/owner/apps/${app.grantId}`)).html,
    );
    expect(withKeys).toContain("Also revoke the keys it made");
    expect(withKeys).toContain("2 keys would stop working");
    expect(withKeys).toContain(
      "Its sign-in ends at once. The keys it made keep working unless you revoke them.",
    );
    expect(withKeys).not.toContain("It loses access at once.");
  });

  it("is not there for an app that was disconnected or never was", async () => {
    await disconnectAll();
    const app = await seedOauthBearer(ctx, ["core.note:read"], {
      clientName: "Reader",
    });
    expect((await page(`/auth/owner/apps/${app.grantId}`)).status).toBe(200);
    await ctx.ownerRequest(`/owner/sign-ins/${app.grantId}`, {
      method: "DELETE",
    });
    for (const id of [app.grantId, "no-such-app"]) {
      const gone = await page(`/auth/owner/apps/${id}`);
      expect(gone.status).toBe(404);
      expect(visibleText(gone.html)).toContain("This app isn't connected");
    }
  });
});

describe("who may open the app pages", () => {
  it("is the owner alone: a key, even one that manages grants, is refused", async () => {
    const manager = await mintWorkingKey(ctx, {
      permissions: ["grants.manage"],
    });
    const res = await ctx.app.request("/auth/owner/apps", {
      headers: { authorization: `Bearer ${manager}` },
    });
    expect(res.status).toBe(403);
    const anon = await ctx.app.request("/auth/owner/apps", {
      headers: { accept: "text/html", "sec-fetch-mode": "navigate" },
    });
    expect(anon.status).toBe(302);
    expect(anon.headers.get("location")).toContain("/auth/sign-in");
  });
});
