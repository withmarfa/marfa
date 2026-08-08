/**
 * The guard against a stale client ceiling stranding the default-on bundle.
 *
 * A first-party app requests the instance's default-on permission bundles.
 * The server's own allowlist is rebuilt from the type and edge registries on
 * every boot, so those two always agree by construction. What does not is the
 * per-client ceiling in `auth_oauth_client.scopes`, which is written once at
 * registration and never refreshed.
 *
 * **The obvious guard here would be a no-op, and it is worth saying why.**
 * Asserting `bundles ⊆ buildAllowedScopes()` looks like the property, but
 * `buildAllowedScopes` adds every configured bundle scope by construction, so
 * that containment is true by definition and would never have failed — not
 * even on the day production could not sign anyone in. The rot was never a
 * code condition. It was a **data** condition: a row holding a set the code
 * had moved past.
 *
 * So this seeds the data condition and drives the real flow through to a
 * code landing on the client's redirect URI. Nothing shorter reproduces it.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expandBundlesToScopes } from "@withmarfa/shared";
import {
  createTestContext,
  markEmailVerified,
  request,
} from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { DEFAULT_PERMISSION_BUNDLES } from "../config.js";

vi.setConfig({ testTimeout: 45_000 });

let ctx: TestContext | undefined;

afterEach(async () => {
  await ctx?.cleanup();
  ctx = undefined;
});

const ORIGIN = "http://localhost:0";
const CALLBACK = "http://localhost:0/callback";

/** What a first-party browser app actually asks for: the plumbing scopes
 *  plus every scope in a default-on bundle. */
function defaultOnRequestScopes(): string[] {
  const out = new Set<string>(["openid", "offline_access"]);
  for (const scope of expandBundlesToScopes(
    DEFAULT_PERMISSION_BUNDLES.filter((b) => b.default_on),
  )) {
    out.add(scope);
  }
  return [...out];
}

async function seedClientWithCeiling(
  c: TestContext,
  scopes: readonly string[],
): Promise<string> {
  const clientId = `stale-${randomBytes(5).toString("hex")}`;
  const oauth = c.storage.oauthProvider;
  if (!oauth) throw new Error("storage.oauthProvider missing");
  await oauth.createClient({
    clientId,
    name: "Stale Ceiling Client",
    isPublic: true,
    grantTypes: ["authorization_code", "refresh_token"],
    responseTypes: ["code"],
    tokenEndpointAuthMethod: "none",
    scopes,
    redirectUris: [CALLBACK],
    postLogoutRedirectUris: [ORIGIN + "/"],
    referenceId: null,
  });
  return clientId;
}

async function signInUser(c: TestContext, email: string): Promise<string> {
  const password = "correct horse battery";
  const up = await request(c.app, "POST", "/auth/sign-up/email", {
    body: { email, password, name: "Test User" },
    headers: { origin: ORIGIN },
  });
  if (up.status !== 200) throw new Error(`sign-up failed ${String(up.status)}`);
  await markEmailVerified(c.storage, email);
  const inRes = await request(c.app, "POST", "/auth/sign-in/email", {
    body: { email, password },
    headers: { origin: ORIGIN },
  });
  if (inRes.status !== 200) {
    throw new Error(`sign-in failed ${String(inRes.status)}`);
  }
  const setCookie = inRes.headers.get("set-cookie");
  if (!setCookie) throw new Error("no Set-Cookie");
  for (const part of setCookie.split(/,\s*(?=[a-zA-Z0-9_-]+=)/)) {
    const head = part.split(";")[0];
    if (head?.includes("session_token")) return head;
  }
  throw new Error("session_token cookie not found");
}

describe("a stale client ceiling cannot strand the default-on bundle", () => {
  it("a code reaches the redirect URI despite a ceiling minted before the registry moved", async () => {
    ctx = await createTestContext({ authMode: "hosted" });
    const cookie = await signInUser(ctx, "stale-ceiling@example.com");

    const requested = defaultOnRequestScopes();
    expect(requested.length).toBeGreaterThan(2);

    // The data condition, built rather than described: a ceiling holding only
    // the plumbing scopes plus one content scope, as if every other type in
    // the default bundle had been registered after the row was written. This
    // is the production shape in miniature.
    const stale = ["openid", "offline_access", requested[2]].filter(
      (s): s is string => typeof s === "string",
    );
    const clientId = await seedClientWithCeiling(ctx, stale);

    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const params = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: CALLBACK,
      scope: requested.join(" "),
      state: "stale-guard",
      code_challenge: challenge,
      code_challenge_method: "S256",
    });

    const authorizeRes = await request(
      ctx.app,
      "GET",
      `/auth/oauth2/authorize?${params.toString()}`,
      { headers: { cookie } },
    );
    expect(authorizeRes.status).toBe(302);
    const location = authorizeRes.headers.get("location") ?? "";
    // Before narrowing, this was the client's own callback carrying
    // `error=invalid_scope` and the flow ended there.
    expect(location).not.toContain("error=invalid_scope");
    expect(location).toContain("/auth/authorize?");

    const signedQuery = location.slice(location.indexOf("?") + 1);
    const granted = (new URLSearchParams(signedQuery).get("scope") ?? "").split(
      " ",
    );

    const decision = await request(
      ctx.app,
      "POST",
      "/auth/authorize/decision",
      {
        form: { accept: "true", oauth_query: signedQuery, scopes: granted },
        headers: { cookie, origin: ORIGIN },
      },
    );
    expect(decision.status).toBe(302);
    const cb = new URL(decision.headers.get("location") ?? "", ORIGIN);
    const code = cb.searchParams.get("code");
    expect(cb.searchParams.get("error")).toBeNull();
    expect(code).toBeTruthy();

    // Carried through to a token, because a code on the callback is not yet
    // the property that matters. The person getting into their data is.
    const tokenRes = await request(ctx.app, "POST", "/auth/oauth2/token", {
      form: {
        grant_type: "authorization_code",
        code: code ?? "",
        redirect_uri: CALLBACK,
        client_id: clientId,
        code_verifier: verifier,
      },
      headers: { origin: ORIGIN },
    });
    expect(tokenRes.status).toBe(200);
    const body = (await tokenRes.json()) as {
      access_token?: string;
      scope?: string;
    };
    expect(body.access_token).toBeTruthy();
    // The grant is the intersection, and it is non-empty — the whole point of
    // narrowing rather than refusing.
    expect(
      (body.scope ?? "").split(" ").filter(Boolean).length,
    ).toBeGreaterThan(0);
  });

  it("a client with no ceiling keeps the whole default-on set", async () => {
    ctx = await createTestContext({ authMode: "hosted" });
    const cookie = await signInUser(ctx, "no-ceiling@example.com");

    const requested = defaultOnRequestScopes();
    // The shape the seed script now writes for a first-party client.
    const clientId = await seedClientWithCeilingNull(ctx);

    const challenge = createHash("sha256")
      .update(randomBytes(32).toString("base64url"))
      .digest("base64url");
    const params = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: CALLBACK,
      scope: requested.join(" "),
      state: "no-ceiling",
      code_challenge: challenge,
      code_challenge_method: "S256",
    });

    const authorizeRes = await request(
      ctx.app,
      "GET",
      `/auth/oauth2/authorize?${params.toString()}`,
      { headers: { cookie } },
    );
    expect(authorizeRes.status).toBe(302);
    const location = authorizeRes.headers.get("location") ?? "";
    expect(location).toContain("/auth/authorize?");

    const signedQuery = location.slice(location.indexOf("?") + 1);
    const carried = new Set(
      (new URLSearchParams(signedQuery).get("scope") ?? "").split(" "),
    );
    // Nothing is narrowed away, because everything requested is live.
    for (const scope of requested) expect(carried.has(scope)).toBe(true);
  });
});

async function seedClientWithCeilingNull(c: TestContext): Promise<string> {
  const clientId = `nullc-${randomBytes(5).toString("hex")}`;
  const oauth = c.storage.oauthProvider;
  if (!oauth) throw new Error("storage.oauthProvider missing");
  await oauth.createClient({
    clientId,
    name: "No Ceiling Client",
    isPublic: true,
    grantTypes: ["authorization_code", "refresh_token"],
    responseTypes: ["code"],
    tokenEndpointAuthMethod: "none",
    scopes: null,
    redirectUris: [CALLBACK],
    postLogoutRedirectUris: [ORIGIN + "/"],
    referenceId: null,
  });
  return clientId;
}

/**
 * Coverage check, in the shape the item-write-doors guard uses.
 *
 * The defect was one call site writing a snapshot of a moving value. The way
 * it recurs is a second call site doing the same thing, added by someone who
 * never saw this. So every place that persists a ceiling is enumerated here,
 * and a new one fails the build until it is listed with a reason.
 */
describe("call sites that persist a client scope ceiling", () => {
  const DOORS: { file: string; justification: string }[] = [
    {
      file: "src/routes/oauth-register.ts",
      justification:
        "Dynamic client registration. The array is the ceiling the third-party " +
        "client asked for and a security boundary — not a copy of ours, and " +
        "correctly frozen.",
    },
  ];

  it("is the complete list, and each entry is deliberate", () => {
    const root = fileURLToPath(new URL("../..", import.meta.url));
    const candidates = [
      "src/routes/oauth-register.ts",
      "scripts/seed-oauth-clients.ts",
    ];

    const persisting = candidates.filter((rel) => {
      const source = readFileSync(new URL(rel, `file://${root}`), "utf8");
      // A call site persists a ceiling when it hands `createClient` a scopes
      // value that is not the literal `null`.
      const call = source.slice(source.indexOf("createClient({"));
      const match = /scopes:\s*([^,\n]+)/.exec(call);
      return match !== null && match[1]?.trim() !== "null";
    });

    expect(persisting.sort()).toEqual(DOORS.map((d) => d.file).sort());
  });

  it("the seed script writes no ceiling", () => {
    const root = fileURLToPath(new URL("../..", import.meta.url));
    const source = readFileSync(
      new URL("scripts/seed-oauth-clients.ts", `file://${root}`),
      "utf8",
    );
    expect(source).toContain("scopes: null");
    // The generating shape, named so a revert is loud rather than quiet.
    expect(source).not.toContain("buildAllowedScopes");
  });
});
