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
 * `buildAllowedScopes` adds every configured bundle scope it does not
 * explicitly withhold, so that containment is true by definition for a
 * shipped bundle and would never have failed — not
 * even on the day production could not sign anyone in. The rot was never a
 * code condition. It was a **data** condition: a row holding a set the code
 * had moved past.
 *
 * So this seeds the data condition and drives the real flow through to a
 * code landing on the client's redirect URI. Nothing shorter reproduces it.
 *
 * **The bar moved once, and the file kept its name.** Narrowing stopped the
 * dead end but still handed back a grant missing everything the ceiling had
 * not heard of, which is the same rot one step later. The ceiling now
 * catches up to the bundle scopes a request names, so the assertion here is
 * the whole default-on set rather than its intersection with the stale row.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
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
    // **Nothing is stranded**, which is what this file is named for and is
    // stronger than what it used to assert.
    //
    // It expected exactly the intersection with the stale ceiling, three
    // scopes of the sixty-odd requested. That was the best the narrowing
    // could do on its own: a code reached the redirect URI, so the client no
    // longer dead-ended, but the newer half of the default-on bundle was
    // silently absent from the grant. Six scopes went missing from a real
    // client that way and nothing reported it.
    //
    // The ceiling now catches up to the bundle scopes a request names, so
    // the whole default-on set survives. Asserted as a set rather than as
    // "more than the intersection", because a partial survival is exactly
    // the defect and would pass a weaker check.
    expect((body.scope ?? "").split(" ").filter(Boolean).sort()).toEqual(
      [...requested].sort(),
    );
    // And the seeded staleness was real, so this is not passing because the
    // fixture stopped being stale.
    expect(stale.length).toBeLessThan(requested.length);
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
 * Coverage check over the call sites this repository owns.
 *
 * The defect was one call site writing a snapshot of a moving value. The way
 * it recurs is a second call site doing the same thing, added by someone who
 * never saw this. So the Marfa-side sources are scanned rather than listed,
 * and a new one fails the build until it is named with a reason.
 *
 * **What this cannot see, stated because the previous version of this comment
 * claimed a completeness it did not have.** The vendored OAuth plugin serves
 * two registration endpoints of its own, `POST /oauth2/create-client` and
 * `POST /admin/oauth2/create-client`, both reachable through the `/auth/*`
 * catch-all and both writing `auth_oauth_client.scopes` directly through
 * Better Auth's adapter. They never call Marfa's store, so no scan of this
 * tree reaches them. They write the registrant's own requested ceiling, which
 * is the correct behavior for a registration endpoint — the point of naming
 * them here is that "every writer is covered" would be false, and a guard
 * that overstates its reach is worse than one that states its edge.
 */
/**
 * The text of the object literal starting at `open`, balanced across nesting
 * and blind to braces inside strings.
 *
 * The scan used to slice a fixed 1200 characters instead. That held only by
 * luck: the seed script's `scopes:` already sat 880 characters in behind an
 * explanatory comment, so three more lines of prose would have moved it out
 * of the window and the guard would have gone quiet without anything failing.
 */
function objectLiteralAt(source: string, open: number): string {
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < source.length; i++) {
    const ch = source[i];
    if (quote !== null) {
      if (ch === "\\") i += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") quote = ch;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  return source.slice(open);
}

/**
 * Every scope value written by a `createClient` call in this source, in order.
 *
 * Two things the previous scan could not do. It located a call with `indexOf`,
 * so a second call in the same file was invisible; and it recognized two
 * receiver spellings from a mutually exclusive pair, so a file whose first hit
 * was one spelling never had the other looked for. A third spelling already
 * existed in the tree. Matching on the method rather than the receiver means
 * there is no list to fall behind.
 */
function scopeWritersIn(source: string): string[] {
  const written: string[] = [];
  const calls = /\.createClient\(\s*\{/g;
  let match: RegExpExecArray | null;
  while ((match = calls.exec(source)) !== null) {
    const open = source.indexOf("{", match.index);
    const scopes = /scopes:\s*([^,\n]+)/.exec(objectLiteralAt(source, open));
    // A call written on one line ends the property with the object's own
    // brace rather than a comma, so the capture runs on into it. Left in,
    // `null }` reads as a ceiling and the guard fails on a call that writes
    // none.
    const value = scopes?.[1]?.replace(/[\s})]+$/, "");
    if (value !== undefined && value !== "null") written.push(value);
  }
  return written;
}

/** Every `.ts` under a directory, tests excluded. */
function walkTypeScript(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    if (statSync(abs).isDirectory()) {
      out.push(...walkTypeScript(abs));
    } else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) {
      out.push(abs);
    }
  }
  return out;
}

describe("call sites that persist a client scope ceiling", () => {
  // `writers` is the number of ceiling-writing calls the file is allowed, so
  // a second one appearing inside a file that is already named still fails.
  const DOORS: { file: string; writers: number; justification: string }[] = [
    {
      file: "src/routes/oauth-register.ts",
      writers: 1,
      justification:
        "Dynamic client registration. The array is the ceiling the third-party " +
        "client asked for and a security boundary — not a copy of ours, and " +
        "correctly frozen.",
    },
  ];

  it("discovers every Marfa-side writer, and each is deliberate", () => {
    const root = fileURLToPath(new URL("../..", import.meta.url));
    // Walked, not listed. A hardcoded candidate list cannot fail when
    // somebody adds a file, which is the only thing this guard is for.
    const sources = [
      ...walkTypeScript(join(root, "src")),
      ...walkTypeScript(join(root, "scripts")),
    ];

    const persisting: [string, number][] = [];
    for (const abs of sources) {
      const written = scopeWritersIn(readFileSync(abs, "utf8"));
      if (written.length > 0) {
        persisting.push([
          relative(root, abs).split(sep).join("/"),
          written.length,
        ]);
      }
    }

    const byFile = (a: [string, number], b: [string, number]): number =>
      a[0].localeCompare(b[0]);
    expect(persisting.sort(byFile)).toEqual(
      DOORS.map((d): [string, number] => [d.file, d.writers]).sort(byFile),
    );
  });

  it("sees a second call in a file, not just the first", () => {
    const source = `
      await oauthProvider.createClient({ clientId: "a", scopes: null });
      await oauthProvider.createClient({ clientId: "b", scopes: ["core.note:read"] });
    `;
    expect(scopeWritersIn(source)).toEqual(['["core.note:read"]']);
  });

  it("sees a receiver spelling it has never been told about", () => {
    // A third spelling already exists in this tree. Matching on the method
    // means the scan cannot fall behind a list of receivers.
    const source = `store.oauth.provider.createClient({ scopes: ["x:read"] });`;
    expect(scopeWritersIn(source)).toEqual(['["x:read"]']);
  });

  it("reads past an options object longer than any fixed window", () => {
    const padding = `      // ${"prose ".repeat(40)}\n`.repeat(8);
    const source = `oauth.createClient({\n${padding}  scopes: ["late:read"],\n});`;
    expect(source.length).toBeGreaterThan(1200);
    expect(scopeWritersIn(source)).toEqual(['["late:read"]']);
  });

  it("is not fooled by a brace inside a string", () => {
    const source = `oauth.createClient({ name: "a } b", scopes: ["s:read"] });`;
    expect(scopeWritersIn(source)).toEqual(['["s:read"]']);
  });

  it("every named door carries a reason", () => {
    for (const door of DOORS) {
      expect(door.justification.length).toBeGreaterThan(40);
    }
  });

  it("the seed script writes no ceiling", () => {
    const root = fileURLToPath(new URL("../..", import.meta.url));
    const source = readFileSync(
      new URL("src/scripts/seed-oauth-clients.ts", `file://${root}`),
      "utf8",
    );
    expect(source).toContain("scopes: null");
    // The generating shape, named so a revert is loud rather than quiet.
    expect(source).not.toContain("buildAllowedScopes");
  });
});
