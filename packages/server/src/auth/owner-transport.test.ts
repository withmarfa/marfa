import { expect, it } from "vitest";
import { createClaimTestApp } from "./claim-test-app.js";
import { claimOwner } from "./instance-claim.js";
import { createMarfaAuth } from "./instance.js";
const details = {
  email: "owner@example.com",
  password: "correct horse battery",
};
const json = (origin: string) => ({
  method: "POST",
  headers: { "content-type": "application/json", origin },
  body: JSON.stringify(details),
});
it("refuses password entry and sign-in over a configured remote HTTP origin", async () => {
  const baseURL = "http://marfa.example.com";
  const ctx = await createClaimTestApp(baseURL);
  try {
    await claimOwner(ctx.storage, ctx.auth, {
      ...details,
      proof: { kind: "local" },
    });
    for (const path of ["/setup", "/auth/sign-in"]) {
      const page = await ctx.app.request(`${baseURL}${path}`);
      expect(page.status).toBe(403);
      expect(await page.text()).not.toContain('type="password"');
    }
    for (const path of ["/auth/sign-in/email", "/auth/sign-up/email"])
      expect(
        (await ctx.app.request(`${baseURL}${path}`, json(baseURL))).status,
      ).toBe(403);
    expect(
      (
        await ctx.app.request(`${baseURL}/auth/sign-in`, {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            origin: baseURL,
          },
          body: new URLSearchParams(details),
        })
      ).status,
    ).toBe(403);
    expect(
      await ctx.storage.__sqliteAll("SELECT id FROM auth_session"),
    ).toHaveLength(0);

    // A valid session from an earlier safe listener cannot administer an
    // instance subsequently exposed on an insecure configured origin.
    const safe = createMarfaAuth({
      db: ctx.storage.betterAuthDb as Parameters<
        typeof createMarfaAuth
      >[0]["db"],
      storage: ctx.storage,
      baseURL: "http://localhost:8600",
      secret: ctx.auth.signingSecret,
    });
    await safe.ready;
    const login = await safe.handler(
      new Request(
        "http://localhost:8600/auth/sign-in/email",
        json("http://localhost:8600"),
      ),
      null,
    );
    expect(login.status).toBe(200);
    const cookie = login.headers
      .getSetCookie()
      .map((part) => part.split(";")[0])
      .join("; ");
    expect(
      await ctx.auth.getSession(new Headers({ cookie }), { readOnly: true }),
    ).not.toBeNull();
    expect(
      (await ctx.app.request(`${baseURL}/owner`, { headers: { cookie } }))
        .status,
    ).toBe(403);
  } finally {
    await ctx.cleanup();
  }
});

it.each([
  "http://localhost:8600",
  "http://127.0.0.1:8600",
  "http://[::1]:8600",
  "https://marfa.example.com",
])("allows owner sign-in at %s", async (baseURL) => {
  const ctx = await createClaimTestApp(baseURL);
  try {
    await claimOwner(ctx.storage, ctx.auth, {
      ...details,
      proof: { kind: "local" },
    });
    expect((await ctx.app.request(`${baseURL}/auth/sign-in`)).status).toBe(200);
    // A TLS proxy can forward over a local HTTP connection while the public
    // issuer and browser Origin remain HTTPS.
    const requestOrigin = baseURL.startsWith("https:")
      ? "http://127.0.0.1:8600"
      : baseURL;
    const login = await ctx.app.request(
      `${requestOrigin}/auth/sign-in/email`,
      json(baseURL),
    );
    expect(login.status).toBe(200);
    if (baseURL.startsWith("https:"))
      expect(login.headers.get("set-cookie")).toContain("Secure");
    const cookie = login.headers
      .getSetCookie()
      .map((part) => part.split(";")[0])
      .join("; ");
    expect(
      (await ctx.app.request(`${requestOrigin}/owner`, { headers: { cookie } }))
        .status,
    ).toBe(200);
  } finally {
    await ctx.cleanup();
  }
});
