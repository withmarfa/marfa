/**
 * The content security policy every HTML page the server renders carries.
 *
 * The pages act on the owner's signed-in session, so a policy that allows
 * only the server's own scripts and styles limits what an injection into one
 * of them can do. Each test that asserts an absence has its witness: the
 * thing it says is absent is shown producible first.
 */
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseScope } from "@withmarfa/shared";
import { createTestContext } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import {
  renderConsentScreen,
  renderDeviceConsentScreen,
  renderDeviceDecisionPage,
  renderDevicePage,
} from "./test-render.js";
import {
  consoleContentSecurityPolicy,
  contentSecurityPolicy,
  pageSecurityPolicy,
} from "./content-security-policy.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.cleanup();
});

const HTML = { accept: "text/html" };

/**
 * The attributes of every `<name ...>` start tag in `html`, read by splitting
 * on the tag's opening rather than by a pattern for the whole tag: this is a
 * scan of markup this server wrote, not a filter for markup somebody else
 * did.
 */
function startTagAttributes(html: string, name: string): string[] {
  return html
    .split(`<${name}`)
    .slice(1)
    .filter((rest) => /^[\s>]/.test(rest))
    .map((rest) => rest.slice(0, rest.indexOf(">")));
}

/** The directives of a policy, by name. */
function directives(policy: string): Map<string, string[]> {
  return new Map(
    policy
      .split(";")
      .map((part) => part.trim().split(/\s+/))
      .filter((parts) => parts[0] !== "" && parts[0] !== undefined)
      .map(([name, ...values]) => [name ?? "", values]),
  );
}

describe("the policy", () => {
  it("refuses inline script and style without a nonce, and any other origin's", () => {
    const policy = directives(contentSecurityPolicy("abc"));
    expect(policy.get("default-src")).toEqual(["'none'"]);
    // By nonce alone and not by origin: an origin source would also admit
    // whatever this origin serves under that type, and the blob link door
    // serves an uploader's bytes under the uploader's type, without a
    // credential.
    expect(policy.get("script-src")).toEqual(["'nonce-abc'"]);
    expect(policy.get("style-src")).toEqual(["'nonce-abc'"]);
    for (const [name, values] of policy) {
      expect(values, name).not.toContain("'unsafe-inline'");
      expect(values, name).not.toContain("'unsafe-eval'");
      expect(values, name).not.toContain("*");
    }
    expect(policy.get("base-uri")).toEqual(["'none'"]);
    expect(policy.get("frame-ancestors")).toEqual(["'none'"]);
  });

  it("lets only a console page load an image from its own origin, and every page load an inline one", () => {
    const baseline = directives(contentSecurityPolicy("abc"));
    const consolePolicy = directives(consoleContentSecurityPolicy("abc"));
    // The witness: the console policy is the baseline with additions, so the
    // difference in `img-src` is the one under test.
    expect(consolePolicy.get("connect-src")).toEqual(["'self'"]);
    expect(baseline.get("connect-src")).toBeUndefined();
    expect(baseline.get("img-src")).toEqual(["data:"]);
    expect(consolePolicy.get("img-src")).toEqual(["'self'", "data:"]);
  });
});

describe("pageSecurityPolicy", () => {
  /** A tiny app: one door answering each kind of thing. */
  function app(): Hono {
    const router = new Hono();
    router.use("*", pageSecurityPolicy);
    router.get("/page", (c) => c.html("<p>page</p>"));
    router.get("/data", (c) => c.json({ ok: true }));
    router.get("/own", (c) =>
      c.html("<p>own</p>", 200, { "Content-Security-Policy": "sandbox" }),
    );
    router.get(
      "/raw",
      () =>
        new Response("<p>raw</p>", {
          headers: { "content-type": "text/html" },
        }),
    );
    router.get("/boom", () => {
      throw new Error("boom");
    });
    router.onError(
      () =>
        new Response("<p>error</p>", {
          status: 500,
          headers: { "content-type": "text/html" },
        }),
    );
    return router;
  }

  it("puts the policy on any HTML answer, however it was made", async () => {
    for (const path of ["/page", "/raw", "/boom"]) {
      const res = await app().request(path);
      expect(res.headers.get("content-type"), path).toContain("text/html");
      expect(res.headers.get("content-security-policy"), path).toMatch(
        /script-src 'nonce-[\w+/=-]{16,}'/,
      );
    }
  });

  it("leaves a JSON answer and a policy a door already sent alone", async () => {
    // The witness for the case above: the same app answers something the
    // middleware does not touch, so the assertion is about the middleware.
    const data = await app().request("/data");
    expect(data.headers.get("content-security-policy")).toBeNull();
    const own = await app().request("/own");
    expect(own.headers.get("content-security-policy")).toBe("sandbox");
  });

  it("uses a nonce of its own for each response", async () => {
    const seen = new Set<string>();
    for (let i = 0; i < 20; i++) {
      const res = await app().request("/page");
      const nonce = /'nonce-([^']+)'/.exec(
        res.headers.get("content-security-policy") ?? "",
      )?.[1];
      expect(nonce).toBeTruthy();
      seen.add(nonce ?? "");
    }
    expect(seen.size).toBe(20);
  });
});

describe("every page the app renders", () => {
  /** The doors that take no parameter, as the app's route table lists them. */
  function plainGetDoors(): string[] {
    return [
      ...new Set(
        ctx.app.routes
          .filter((r) => r.method === "GET" && !r.path.includes(":"))
          .map((r) => r.path)
          .filter((path) => !path.includes("*")),
      ),
    ];
  }

  it("carries the policy on every door that answers HTML", async () => {
    const answeredHtml: string[] = [];
    for (const path of plainGetDoors()) {
      // Asked as a browser asks, with no credential: a door that wants one
      // answers its refusal as a page, which is HTML too and needs the policy.
      const res = await ctx.app.request(path, { headers: HTML });
      if (!(res.headers.get("content-type") ?? "").includes("text/html")) {
        continue;
      }
      answeredHtml.push(path);
      expect(res.headers.get("content-security-policy"), path).toMatch(
        /default-src 'none'; script-src 'nonce-/,
      );
    }
    // The witness that the loop looked at something: these are pages, and
    // they answered.
    expect(answeredHtml).toEqual(
      expect.arrayContaining(["/", "/auth/sign-in", "/auth/device"]),
    );
    // And a path no door serves answers its page too.
    const missing = await ctx.app.request("/no-such-door", { headers: HTML });
    expect(missing.headers.get("content-type")).toContain("text/html");
    expect(missing.headers.get("content-security-policy")).toContain(
      "script-src 'nonce-",
    );
  });

  it("carries the policy on a page a later middleware refused before any door ran", async () => {
    // A read-view header the app refuses is answered by middleware mounted
    // well before the doors, and as a page when asked for one.
    const res = await ctx.app.request("/auth/sign-in", {
      headers: { ...HTML, "X-Marfa-Read-View": "x" },
    });
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("content-security-policy")).toContain(
      "script-src 'nonce-",
    );
  });

  it("leaves the JSON the same doors answer without the policy", async () => {
    const res = await ctx.app.request("/");
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("content-security-policy")).toBeNull();
  });

  it("names, in the policy, the nonce its script and stylesheet carry", async () => {
    const res = await ctx.app.request("/auth/device", { headers: HTML });
    const html = await res.text();
    const nonce = /'nonce-([^']+)'/.exec(
      res.headers.get("content-security-policy") ?? "",
    )?.[1];
    expect(nonce).toBeTruthy();
    // Every script tag and the stylesheet link carry the nonce: the policy
    // allows nothing by origin. The empty icon link names a data address,
    // which the policy admits for images, so it has no nonce.
    const links = startTagAttributes(html, "link");
    const stylesheets = links.filter((attributes) =>
      attributes.includes('rel="stylesheet"'),
    );
    const tags = [...startTagAttributes(html, "script"), ...stylesheets];
    // Witness: the page has some, a script and a stylesheet among them, and
    // the icon link is the one link the filter leaves out.
    expect(startTagAttributes(html, "script").length).toBeGreaterThan(0);
    expect(stylesheets.length).toBeGreaterThan(0);
    expect(links.length).toBeGreaterThan(stylesheets.length);
    for (const attributes of tags) {
      expect(attributes).toContain(`nonce="${nonce ?? ""}"`);
    }
  });

  it("uses no inline style attribute and no inline handler on any page it renders", async () => {
    for (const path of [
      "/",
      "/auth/sign-in",
      "/auth/device",
      "/no-such-door",
    ]) {
      const html = await (
        await ctx.app.request(path, { headers: HTML })
      ).text();
      expect(html, path).not.toMatch(/\sstyle\s*=/i);
      expect(html, path).not.toMatch(/\son[a-z]+\s*=/i);
      expect(html, path).not.toContain("<style");
    }
  });
});

describe("the pages with scopes on them", () => {
  const scopes = ["core.note:read", "core.task:write", "keys.mint", "*:read"]
    .map(parseScope)
    .filter((scope) => scope !== null);
  const consent = renderConsentScreen({
    clientName: "App",
    scopes,
    clientId: "c",
    oauthQuery: "a=b",
    // A re-consent, so the sections with spacing render as well as the groups.
    priorScopes: ["core.note:read", "core.event:write"],
  });
  const pages: Record<string, string> = {
    "the consent page": consent,
    "the consent page, first time": renderConsentScreen({
      clientName: "App",
      scopes,
      clientId: "c",
      oauthQuery: "a=b",
    }),
    "the device approval page": renderDeviceConsentScreen({
      clientName: "App",
      scopes,
      userCode: "ABCD1234",
    }),
    "the device decision page": renderDeviceDecisionPage({ approved: true }),
    "the device code page": renderDevicePage({ prefilled: "" }),
  };

  it("uses no inline style, no style element and no inline handler", () => {
    for (const [name, html] of Object.entries(pages)) {
      expect(html, name).not.toMatch(/\sstyle\s*=/i);
      expect(html, name).not.toMatch(/\son[a-z]+\s*=/i);
      expect(html, name).not.toContain("<style");
    }
  });

  it("carries no script of its own beyond the shared file, and the scan can tell a page that does", () => {
    // The witness: a page with an inline script is something the scan sees.
    expect(
      startTagAttributes('<script nonce="n">run()</script>', "script"),
    ).toEqual([' nonce="n"']);
    const shared =
      /^ src="\/auth\/static\/pages\.js\?v=[0-9a-f]{40}" nonce="[^"]+" defer(="")?$/;
    for (const [name, html] of Object.entries(pages)) {
      const found = startTagAttributes(html, "script");
      // The approval pages load the shared script, which only keeps their
      // summary lines true; the page that ends them loads none.
      if (name === "the device decision page") expect(found, name).toEqual([]);
      else {
        expect(found, name).toHaveLength(1);
        expect(found[0], name).toMatch(shared);
      }
    }
  });
});
