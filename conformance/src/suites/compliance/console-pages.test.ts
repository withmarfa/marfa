import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  bootUnclaimedServer,
  stopServer,
} from "../../../scripts/marfa-server.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  keepStatusLog,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { pageField, visibleText } from "../../utils/page-html.js";
import { TEST_OWNER as OWNER } from "../../utils/target.js";

/**
 * The owner's console pages: what a browser that is not signed in is sent to,
 * what a program is still told, and Home at the root.
 *
 * This file boots servers of its own: signing in is counted per address, and
 * a case here signs the owner out.
 */
const CLIENT_HEADER = "x-conformance-client";
const BROWSER = {
  accept: "text/html,application/xhtml+xml",
  "sec-fetch-mode": "navigate",
};
/** The console pages a browser can open, each served at its own address. */
const CONSOLE_PAGES = [
  "/auth/owner/manage",
  "/auth/owner/keys",
  "/auth/owner/keys/new",
  "/auth/owner/keys/00000000-0000-4000-8000-000000000000",
  "/auth/owner/keys/00000000-0000-4000-8000-000000000000/copy",
  "/auth/owner/restore",
  "/auth/owner/general",
  "/auth/owner/health",
  "/auth/owner/profile",
  "/auth/owner/passkeys",
];

let server: FreshServer | undefined;
let origin: string;

beforeAll(async () => {
  server = await bootFreshServer("console-pages", {
    TRUSTED_PROXY_HEADER: CLIENT_HEADER,
  });
  const discovery = await fetch(
    `${server.apiUrl}/.well-known/oauth-authorization-server/auth`,
  );
  origin = new URL(((await discovery.json()) as { issuer: string }).issuer)
    .origin;
}, 2 * FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  await server?.stop();
}, 2 * FRESH_SERVER_TIMEOUT_MS);

let nextAddress = 1;

/** The session cookie of a new sign-in, from an address of its own. */
async function signedInCookie(): Promise<string> {
  const res = await fetch(`${server!.apiUrl}/auth/sign-in/email`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin,
      [CLIENT_HEADER]: `192.0.2.${String(nextAddress++)}`,
    },
    body: JSON.stringify({ email: OWNER.email, password: OWNER.password }),
  });
  expect(res.status).toBe(200);
  const cookie = /(?:^|,\s*)([\w.-]*session_token=[^;]+)/.exec(
    res.headers.get("set-cookie") ?? "",
  )?.[1];
  expect(cookie).toBeDefined();
  return cookie!;
}

function get(path: string, headers: Record<string, string> = {}) {
  return fetch(`${server!.apiUrl}${path}`, { headers, redirect: "manual" });
}

describe("a console page asked for by a browser that is not signed in", () => {
  it("goes to sign in, carrying the page's path and query as where to return", async () => {
    for (const path of [
      ...CONSOLE_PAGES,
      "/auth/owner/manage?tab=keys&x=%20y",
    ]) {
      const res = await get(path, BROWSER);
      expect(res.status, path).toBe(302);
      expect(res.headers.get("location"), path).toBe(
        `/auth/sign-in?return_to=${encodeURIComponent(path)}`,
      );
    }
    // Witness: the same page, with the owner's session, is the page itself.
    const cookie = await signedInCookie();
    const page = await get("/auth/owner/manage", { ...BROWSER, cookie });
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
  });

  it("serves the Profile page and the Password and passkeys page to the signed-in owner, each under its heading", async () => {
    const cookie = await signedInCookie();
    for (const [path, heading] of [
      ["/auth/owner/profile", "Profile"],
      ["/auth/owner/passkeys", "Password and passkeys"],
    ] as const) {
      const page = await get(path, { ...BROWSER, cookie });
      expect(page.status, path).toBe(200);
      expect(page.headers.get("content-type"), path).toContain("text/html");
      expect(await page.text(), path).toMatch(
        new RegExp(`<h1[^>]*>${heading}</h1>`),
      );
    }
  });

  it("goes to sign in with no way back for an address too long to carry", async () => {
    const base = "/auth/owner/manage?x=";
    const fits = `${base}${"a".repeat(2048 - base.length)}`;
    expect(fits).toHaveLength(2048);
    // Witness: the longest address that fits is carried whole.
    const carried = await get(fits, BROWSER);
    expect(carried.headers.get("location")).toBe(
      `/auth/sign-in?return_to=${encodeURIComponent(fits)}`,
    );
    const res = await get(`${fits}a`, BROWSER);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/auth/sign-in?return_to=%2F");
  });

  it("is sent back to the page once it has signed in", async () => {
    const wanted = "/auth/owner/manage?tab=keys";
    const res = await fetch(`${server!.apiUrl}/auth/sign-in`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin,
        [CLIENT_HEADER]: `192.0.2.${String(nextAddress++)}`,
      },
      body: new URLSearchParams({ ...OWNER, return_to: wanted }),
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(wanted);
  });

  it("is not given a redirect that a cache could hand to somebody else", async () => {
    const res = await get("/auth/owner/manage", BROWSER);
    expect(res.status).toBe(302);
    expect(res.headers.get("cache-control")).toContain("no-store");
  });

  it("is sent to sign in again when its session has ended", async () => {
    const cookie = await signedInCookie();
    const open = await get("/auth/owner/manage", { ...BROWSER, cookie });
    expect(open.status).toBe(200);
    const out = await fetch(`${server!.apiUrl}/auth/sign-out`, {
      method: "POST",
      headers: { "content-type": "application/json", origin, cookie },
      body: "{}",
    });
    expect(out.ok).toBe(true);
    const next = await get("/auth/owner/manage", { ...BROWSER, cookie });
    expect(next.status).toBe(302);
    expect(next.headers.get("location")).toBe(
      `/auth/sign-in?return_to=${encodeURIComponent("/auth/owner/manage")}`,
    );
  });
});

describe("the pages for API keys", () => {
  it("never carry a key's plaintext, even for the key just made", async () => {
    const cookie = await signedInCookie();
    const made = await fetch(`${server!.apiUrl}/keys`, {
      method: "POST",
      headers: { "content-type": "application/json", origin, cookie },
      body: JSON.stringify({
        label: "Plaintext witness",
        source: "plaintext-witness",
        permissions: ["instance.read"],
      }),
    });
    expect(made.status).toBe(201);
    const { id, key } = (await made.json()) as { id: string; key: string };
    // Witness: the plaintext exists, in the answer to the mint.
    expect(key).toMatch(/^marfa_k1_/);
    for (const path of [
      "/auth/owner/keys",
      "/auth/owner/keys/new",
      `/auth/owner/keys/${id}`,
      `/auth/owner/keys/${id}/copy`,
    ]) {
      const res = await get(path, { ...BROWSER, cookie });
      expect(res.status, path).toBe(200);
      const html = await res.text();
      expect(html, path).not.toContain(key);
    }
    // Witness: the key's own page does name the key.
    const page = await (
      await get(`/auth/owner/keys/${id}`, { ...BROWSER, cookie })
    ).text();
    expect(page).toContain("Plaintext witness");
  });
});

describe("a console page asked for by anything but a browser", () => {
  it("is not redirected to sign in, whether it asks for JSON, anything, or carries a credential", async () => {
    for (const path of CONSOLE_PAGES) {
      for (const headers of [
        {} as Record<string, string>,
        { accept: "*/*" },
        { accept: "application/json" },
        { ...BROWSER, authorization: "Bearer not-a-real-credential" },
      ]) {
        const res = await get(path, headers);
        expect([401, 403], `${path} ${JSON.stringify(headers)}`).toContain(
          res.status,
        );
        expect(res.headers.get("location")).toBeNull();
      }
      // Witness: the same page asked the browser's way is the redirect.
      expect((await get(path, BROWSER)).status, path).toBe(302);
    }
  });
});

describe("a console page asked for by a browser while the instance is unclaimed", () => {
  let state: string | undefined;
  let url: string;

  beforeAll(async () => {
    state = await mkdtemp(join(tmpdir(), "marfa-console-unclaimed-"));
    ({ url } = await bootUnclaimedServer({ state }));
  }, 2 * FRESH_SERVER_TIMEOUT_MS);

  afterAll(async () => {
    if (!state) return;
    await stopServer({ state });
    keepStatusLog(state);
    await rm(state, { recursive: true, force: true });
  }, 2 * FRESH_SERVER_TIMEOUT_MS);

  it("is sent to set the instance up, not to a sign-in nobody can use", async () => {
    for (const path of CONSOLE_PAGES) {
      const res = await fetch(`${url}${path}`, {
        headers: BROWSER,
        redirect: "manual",
      });
      expect(res.status, path).toBe(302);
      expect(res.headers.get("location"), path).toBe("/setup");
    }
  });
});

describe("Home, at the root", () => {
  it("is shown to the owner's browser, headed by the instance's name", async () => {
    const cookie = await signedInCookie();
    const { name } = (await (await get("/")).json()) as { name: string };
    const res = await get("/", { ...BROWSER, cookie });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("vary")).toContain("Accept");
    const html = await res.text();
    expect(/<h1\b[^>]*>([^<]*)<\/h1>/.exec(html)?.[1]).toBe(name);
    // Witness: a visitor is shown the notice, not the owner's page.
    expect(visibleText(await (await get("/", BROWSER)).text())).toContain(
      "running",
    );
  });

  it("holds a search for pages and settings", async () => {
    const cookie = await signedInCookie();
    const html = await (await get("/", { ...BROWSER, cookie })).text();
    expect(pageField(html, "q")).toBeDefined();
    // Witness: a visitor is not shown it.
    expect(
      pageField(await (await get("/", BROWSER)).text(), "q"),
    ).toBeUndefined();
  });

  it("is not cached", async () => {
    const cookie = await signedInCookie();
    const res = await get("/", { ...BROWSER, cookie });
    expect(res.headers.get("cache-control")).toContain("no-store");
  });

  it("takes a search from the owner's browser", async () => {
    const cookie = await signedInCookie();
    for (const q of ["keys", "", "a".repeat(5000), "%00%0a", "<b>x</b>"]) {
      const res = await get(`/?q=${q}`, { ...BROWSER, cookie });
      expect(res.status, q.slice(0, 20)).toBe(200);
      expect(await res.text(), q.slice(0, 20)).not.toContain("<b>x</b>");
    }
  });

  it("refuses a search from anybody else, and any other key from everybody", async () => {
    const cookie = await signedInCookie();
    const refused = [
      ["a browser with no session", BROWSER, "q"],
      ["a program holding the owner's session", { cookie }, "q"],
      [
        "a browser with a credential",
        { ...BROWSER, authorization: "Bearer not-a-real-credential" },
        "q",
      ],
      ["the owner's browser", { ...BROWSER, cookie }, "stray"],
    ] as const;
    for (const [who, headers, key] of refused) {
      const res = await get(`/?${key}=1`, headers);
      expect(res.status, who).toBe(400);
      expect(res.headers.get("vary"), who).toContain("Accept");
      // A browser is shown the refusal as a page; anything else is given the envelope.
      if (res.headers.get("content-type")?.includes("application/json")) {
        const body = (await res.json()) as {
          error: { code: string; details: { unknown_parameters: string[] } };
        };
        expect(body.error.code, who).toBe("validation_error");
        expect(body.error.details.unknown_parameters, who).toEqual([key]);
      } else {
        expect(res.headers.get("content-type"), who).toContain("text/html");
      }
    }
    // Witness: a program asking for the envelope gets it.
    const program = await get("/?q=1", { cookie, accept: "application/json" });
    expect(program.headers.get("content-type")).toContain("application/json");
  });
});
