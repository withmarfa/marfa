import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { TestContext } from "../../client/types.js";
import { createTestContext, cleanup } from "../../utils/setup.js";

let ctx: TestContext;
let apiUrl: string;

beforeAll(async () => {
  ({ ctx, apiUrl } = await createTestContext("compliance", "page-policy"));
});

afterAll(async () => {
  await cleanup(ctx);
});

/** The run owner's browser session, which `pnpm marfa:up` writes. */
function ownerCookie(): string {
  const cookie = process.env.MARFA_OWNER_COOKIE;
  expect(cookie, "MARFA_OWNER_COOKIE is required").toBeTruthy();
  return cookie!;
}

describe("the page policy", () => {
  it("sends a content security policy with every HTML page and a nonce of its own with each", async () => {
    const asBrowser = { accept: "text/html" };
    const nonces = new Set<string>();
    const pages = [
      ["/", 200, false],
      ["/auth/sign-in", 200, true],
      ["/auth/owner/passkeys", 200, true],
      ["/auth/device", 200, false],
      ["/no-such-page", 404, false],
    ] as const;
    for (const [path, status, connects] of pages) {
      const res =
        path === "/auth/owner/passkeys"
          ? await fetch(`${apiUrl}${path}`, {
              headers: { ...asBrowser, cookie: ownerCookie() },
            })
          : await fetch(`${apiUrl}${path}`, { headers: asBrowser });
      expect(res.status, path).toBe(status);
      expect(res.headers.get("content-type"), path).toContain("text/html");
      const policy = res.headers.get("content-security-policy") ?? "";
      const directives = new Map(
        policy.split(";").map((part) => {
          const [name, ...sources] = part.trim().split(/\s+/);
          return [name, sources];
        }),
      );
      expect(directives.get("default-src"), path).toEqual(["'none'"]);
      const scripts = directives.get("script-src");
      expect(scripts, path).toHaveLength(1);
      const nonce = /^'nonce-([^']+)'$/.exec(scripts?.[0] ?? "")?.[1];
      expect(nonce, path).toBeTruthy();
      expect(directives.get("style-src"), path).toEqual([
        `'nonce-${nonce ?? ""}'`,
      ]);
      expect(directives.get("connect-src"), path).toEqual(
        connects ? ["'self'"] : undefined,
      );
      expect(directives.get("img-src"), path).toEqual(["data:"]);
      expect(policy, path).not.toContain("unsafe-inline");
      nonces.add(nonce ?? "");
    }
    expect(nonces.size).toBe(pages.length);

    // The witness: the same root asked the way a program asks is JSON, and
    // sends no page policy.
    const data = await fetch(`${apiUrl}/`);
    expect(data.headers.get("content-type")).toContain("application/json");
    expect(data.headers.get("content-security-policy")).toBeNull();
  });
});
