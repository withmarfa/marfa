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
  renderDeviceConsentScreen,
  renderDeviceDecisionPage,
} from "./device-pages.js";
import { renderConsentScreen } from "./test-render.js";
import {
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
    expect(policy.get("script-src")).toEqual(["'self'", "'nonce-abc'"]);
    expect(policy.get("style-src")).toEqual(["'self'"]);
    for (const [name, values] of policy) {
      expect(values, name).not.toContain("'unsafe-inline'");
      expect(values, name).not.toContain("'unsafe-eval'");
      expect(values, name).not.toContain("*");
    }
    expect(policy.get("base-uri")).toEqual(["'none'"]);
    expect(policy.get("frame-ancestors")).toEqual(["'none'"]);
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
        /script-src 'self' 'nonce-[\w+/=-]{16,}'/,
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
        /default-src 'none'; script-src 'self' 'nonce-/,
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
      "script-src 'self' 'nonce-",
    );
  });

  it("leaves the JSON the same doors answer without the policy", async () => {
    const res = await ctx.app.request("/");
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("content-security-policy")).toBeNull();
  });

  it("names, in the policy, the nonce its inline scripts carry", async () => {
    const res = await ctx.app.request("/auth/device", { headers: HTML });
    const html = await res.text();
    const nonce = /'nonce-([^']+)'/.exec(
      res.headers.get("content-security-policy") ?? "",
    )?.[1];
    expect(nonce).toBeTruthy();
    const inline = [...html.matchAll(/<script(?![^>]*\bsrc=)([^>]*)>/g)];
    // Witness: the page has an inline script at all.
    expect(inline.length).toBeGreaterThan(0);
    for (const [, attributes] of inline) {
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
    unverified: true,
    scopes,
    clientId: "c",
    oauthQuery: "a=b",
    // A re-consent, so the sections with spacing render as well as the groups.
    priorScopes: ["core.note:read", "core.event:read"],
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
      unverified: true,
    }),
    "the device decision page": renderDeviceDecisionPage({ approved: true }),
  };

  it("uses no inline style, no style element and no inline handler", () => {
    for (const [name, html] of Object.entries(pages)) {
      expect(html, name).not.toMatch(/\sstyle\s*=/i);
      expect(html, name).not.toMatch(/\son[a-z]+\s*=/i);
      expect(html, name).not.toContain("<style");
    }
  });

  it("gives its inline script the nonce, and shows the scan can find one", () => {
    // The witness: the first-time page has an inline script, so a scan of
    // inline scripts looks at something.
    const inline = [...consent.matchAll(/<script(?![^>]*\bsrc=)([^>]*)>/g)];
    expect(inline.length).toBeGreaterThan(0);
    for (const [, attributes] of inline) {
      expect(attributes).toContain('nonce="test-nonce"');
    }
  });
});
