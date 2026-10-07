/**
 * The root route, which is the one door a caller holding nothing can ask
 * what it is talking to.
 *
 * `compliance/instance.test.ts` asserts what it serves, but that suite needs
 * a booted server and runs in a separate job, so the boot wiring (`index.ts`
 * resolving the identity and handing it to `createApp`) and the contract
 * number are held here as well, where a change to either fails first.
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createTestContext } from "./test-utils.js";
import type { TestContext } from "./test-utils.js";
import { ensureInstanceId } from "./storage/instance-id.js";
import { buildPublishedOpenAPISpec } from "./openapi-published.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("GET /", () => {
  it("names the instance its own storage holds", async () => {
    const res = await ctx.app.request("/");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      name: string;
      version: string;
      instance_id: string;
      contract: number;
      features: string[];
    };
    expect(body.name).toBe("marfa");
    // Against the store, not against a shape. A hardcoded or invented id
    // satisfies every assertion about format, and the wiring this covers is
    // exactly the step that could hand the app somebody else's name.
    expect(body.instance_id).toBe(await ensureInstanceId(ctx.storage.settings));
    expect(body.features.length).toBeGreaterThan(0);
  });

  it("answers the contract version its document carries", async () => {
    const body = (await (await ctx.app.request("/")).json()) as {
      contract: unknown;
    };
    const document = (await buildPublishedOpenAPISpec()) as {
      info: { version: string };
    };
    expect(Number.isInteger(body.contract)).toBe(true);
    // As strings, so a document version that is numerically equal but
    // spelled differently, `1.0` for `1`, is caught here too.
    expect(document.info.version).toBe(String(body.contract));
  });

  it("carries none of the rate limiter's headers, since it is mounted ahead of it", async () => {
    const limited = await createTestContext({
      rateLimitEnabled: true,
      rateLimitDefaultLimit: 2,
    });
    try {
      // Witness: a door behind the limiter carries them on the same app.
      const behind = await limited.app.request("/items", {
        headers: { Authorization: `Bearer ${limited.workingKey}` },
      });
      expect(behind.headers.get("X-RateLimit-Limit")).not.toBeNull();
      // Past what the limiter would allow a GET, so a root moved behind it
      // is refused here even with the header assertion gone.
      for (let i = 0; i < 2 * 2 + 1; i++) {
        const res = await limited.app.request("/");
        expect(res.status).toBe(200);
        expect(res.headers.get("X-RateLimit-Limit")).toBeNull();
      }
    } finally {
      await limited.cleanup();
    }
  });

  it("answers without a credential", async () => {
    // The whole point of the door. It is mounted ahead of the auth
    // middleware, and a caller that has to present something to learn the
    // instance's name cannot use it to decide what to present.
    const res = await ctx.app.request("/");
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Error-Code")).toBeNull();
  });

  it("answers a browser with a page and a program with the JSON", async () => {
    const browser = await ctx.app.request("/", {
      headers: {
        accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    });
    expect(browser.status).toBe(200);
    expect(browser.headers.get("content-type")).toContain("text/html");
    expect(browser.headers.get("vary")).toContain("Accept");
    expect(await browser.text()).toContain("Marfa is running");

    // Witness: the same address, asked the way programs ask, is the JSON.
    for (const accept of [undefined, "*/*", "application/json"]) {
      const program = await ctx.app.request("/", {
        headers: accept === undefined ? {} : { accept },
      });
      expect(program.headers.get("content-type")).toContain("application/json");
      expect(program.headers.get("vary")).toContain("Accept");
      expect(((await program.json()) as { name: string }).name).toBe("marfa");
    }
  });

  it("serves the same identity as GET /config", async () => {
    // Three doors, one name, and all three are in this package: the root,
    // `/config` and the export manifest. The conformance suite asserts them
    // together against a booted server; this holds the root against
    // `/config`, and `export.test.ts` holds the manifest against
    // `ensureInstanceId`, so neither pair can drift between conformance
    // runs.
    const root = (await (await ctx.app.request("/")).json()) as {
      instance_id: string;
    };
    const res = await ctx.app.request("/config", {
      headers: { Authorization: `Bearer ${ctx.workingKey}` },
    });
    expect(res.status).toBe(200);
    const config = (await res.json()) as { instance_id: string };
    expect(config.instance_id).toBe(root.instance_id);
  });
});

describe("Vary: Accept", () => {
  it("rides a refusal at the root, and no other path's answer", async () => {
    const refused = await ctx.app.request("/?stray=1");
    expect(refused.status).toBe(400);
    expect(refused.headers.get("vary")).toContain("Accept");
    const elsewhere = await ctx.app.request("/health");
    expect(elsewhere.headers.get("vary") ?? "").not.toContain("Accept");
  });
});
