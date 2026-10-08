/**
 * The authorize surface's stale-ceiling catch-up writes only for a signed-in
 * person, behind the request shapes the plugin is certain to refuse, and
 * behind a redirect URI the client actually registered.
 *
 * `narrowAuthorizeScopes` is a `hooks.before` matcher, so it runs ahead of the
 * plugin resolving a session and ahead of the plugin validating
 * `redirect_uri`. The catch-up inside it persists an `UPDATE` on
 * `auth_oauth_client.scopes`, the row a client is given when it omits
 * `scope`. Measured before the session gate: an unauthenticated
 * `GET /auth/oauth2/authorize` naming a client's registered callback and the
 * bundle union returned 302 and took the client's stored ceiling from one
 * scope to the whole union, so the next genuine sign-in met a consent screen
 * asking for the union.
 *
 * **The response is a 302 either way, so every assertion here reads the
 * stored row.** `storedCeiling` goes back through `oauth.getClient`, which is
 * the same read the hook and the plugin both make.
 */
import type { PermissionBundle } from "@withmarfa/shared";
import { expandBundlesToScopes, isValidScope } from "@withmarfa/shared";
import { createHash, randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PERMISSION_BUNDLES } from "../config.js";
import type { TestContext } from "../test-utils.js";
import { createTestContext, request } from "../test-utils.js";
import { bundlePublishedScopes } from "./ceiling-catchup.js";
import { SESSION_CRITICAL_SCOPES } from "./mint-ceiling.js";
import { buildAllowedScopes } from "./oauth-provider.js";
import {
  isLoopbackIpLiteral,
  matchesRegisteredRedirectUri,
} from "./redirect-uri-match.js";

vi.setConfig({ testTimeout: 45_000 });

let ctx: TestContext | undefined;

afterEach(async () => {
  await ctx?.cleanup();
  ctx = undefined;
});

const ORIGIN = "http://localhost:0";
const CALLBACK = "http://localhost:0/callback";
/**
 * A callback no client in these tests registers. The reproduction's whole
 * point is that a stranger can supply this and a real client cannot.
 *
 * HTTPS deliberately. The plugin's query schema refuses a non-loopback HTTP
 * redirect on shape alone, so an `http://` attacker URL would be refused for
 * a reason that has nothing to do with registration — and the reproduction
 * would still pass with the registration gate deleted for the wrong reason.
 * This URL is well-formed, and being unregistered is the only thing wrong
 * with it.
 */
const UNREGISTERED = "https://attacker.example/callback";

/** The scope the ceiling starts at: one literal, bundle-published, held. */
const SEEDED_SCOPE = "core.note:read";

async function seedClient(
  c: TestContext,
  opts: { scopes: readonly string[] | null; redirectUris: readonly string[] },
): Promise<string> {
  const clientId = `ctrl-${randomBytes(5).toString("hex")}`;
  const oauth = c.storage.oauthProvider;
  if (!oauth) throw new Error("storage.oauthProvider missing");
  await oauth.createClient({
    clientId,
    name: "Client Control Test Client",
    isPublic: true,
    grantTypes: ["authorization_code", "refresh_token"],
    responseTypes: ["code"],
    tokenEndpointAuthMethod: "none",
    scopes: opts.scopes === null ? null : [...opts.scopes],
    redirectUris: [...opts.redirectUris],
    postLogoutRedirectUris: [ORIGIN + "/"],
  });
  return clientId;
}

/** The row as it stands, read the way the hook and the plugin both read it. */
async function storedCeiling(
  c: TestContext,
  clientId: string,
): Promise<readonly string[] | null> {
  const client = await c.storage.oauthProvider?.getClient(clientId);
  return client?.scopes ?? null;
}

/**
 * Every scope the configured bundles publish — what a hostile caller names
 * when it wants the row as wide as one request can make it, and what the
 * original measurement used.
 */
function bundleUnion(): string[] {
  return [...expandBundlesToScopes(DEFAULT_PERMISSION_BUNDLES)];
}

function authorizeUrl(opts: {
  clientId: string;
  scope: string;
  redirectUri: string;
  responseType?: string;
}): string {
  const challenge = createHash("sha256")
    .update(randomBytes(32).toString("base64url"))
    .digest("base64url");
  const params = new URLSearchParams({
    response_type: opts.responseType ?? "code",
    client_id: opts.clientId,
    redirect_uri: opts.redirectUri,
    scope: opts.scope,
    state: "client-control",
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  return `/auth/oauth2/authorize?${params.toString()}`;
}

/** Unauthenticated on purpose: no cookie. */
async function authorizeAnonymously(
  c: TestContext,
  opts: { clientId: string; scope: string; redirectUri: string },
): Promise<Response> {
  return request(c.app, "GET", authorizeUrl(opts));
}

/** A signed-in person's session cookie. */
async function signIn(c: TestContext): Promise<string> {
  const { email, password } = c.owner;
  const res = await request(c.app, "POST", "/auth/sign-in/email", {
    body: { email, password },
    headers: { origin: ORIGIN },
  });
  if (res.status !== 200) throw new Error(`sign-in ${String(res.status)}`);
  const setCookie = res.headers.get("set-cookie") ?? "";
  for (const part of setCookie.split(/,\s*(?=[a-zA-Z0-9_-]+=)/)) {
    const head = part.split(";")[0];
    if (head?.includes("session_token")) return head;
  }
  throw new Error("session_token cookie not found");
}

/** The same request, from a signed-in person. */
async function authorizeSignedIn(
  c: TestContext,
  cookie: string,
  opts: { clientId: string; scope: string; redirectUri: string },
  extra = "",
): Promise<Response> {
  return request(c.app, "GET", `${authorizeUrl(opts)}${extra}`, {
    headers: { cookie },
  });
}

describe("the authorize ceiling catch-up writes only for a signed-in person", () => {
  it("leaves the ceiling alone for a request nobody signed in made, and sends them to sign in first", async () => {
    ctx = await createTestContext({});
    const union = bundleUnion();
    const clientId = await seedClient(ctx, {
      scopes: [SEEDED_SCOPE],
      redirectUris: [CALLBACK],
    });
    const asked = authorizeUrl({
      clientId,
      scope: union.join(" "),
      redirectUri: CALLBACK,
    });

    const res = await request(ctx.app, "GET", asked);
    expect(res.status).toBe(302);
    expect(await storedCeiling(ctx, clientId)).toEqual([SEEDED_SCOPE]);
    // To sign in, carrying the request unchanged, every scope it named
    // included, rather than a request already narrowed to the old ceiling.
    const location = new URL(res.headers.get("location") ?? "", ORIGIN);
    expect(location.pathname).toBe("/auth/sign-in");
    const back = location.searchParams.get("return_to") ?? "";
    const carried = new URL(back, ORIGIN);
    expect(carried.pathname).toBe("/auth/oauth2/authorize");
    expect(carried.searchParams.get("scope")).toBe(union.join(" "));

    // Signed in, the same request heals the ceiling on the way to consent.
    const cookie = await signIn(ctx);
    const healed = await request(ctx.app, "GET", back, { headers: { cookie } });
    expect(healed.status).toBe(302);
    expect(healed.headers.get("location")).toContain("/auth/authorize?");
    expect((await storedCeiling(ctx, clientId))?.length).toBe(union.length);
  });

  it("answers a script that fetched the request with where to sign in", async () => {
    ctx = await createTestContext({});
    const clientId = await seedClient(ctx, {
      scopes: [SEEDED_SCOPE],
      redirectUris: [CALLBACK],
    });
    const res = await request(
      ctx.app,
      "GET",
      authorizeUrl({
        clientId,
        scope: bundleUnion().join(" "),
        redirectUri: CALLBACK,
      }),
      { headers: { accept: "application/json" } },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { redirect?: boolean; url?: string };
    expect(body.redirect).toBe(true);
    expect(body.url).toMatch(/^\/auth\/sign-in\?return_to=/);
    expect(await storedCeiling(ctx, clientId)).toEqual([SEEDED_SCOPE]);
  });

  it("leaves the ceiling alone for prompt=none from nobody, which the plugin answers login_required", async () => {
    // Nobody can be sent anywhere under `prompt=none`, so the request is
    // narrowed to the ceiling as it stands and the plugin judges it. The
    // session scopes are left out of the request because a session scope
    // the ceiling lacks is refused rather than narrowed away.
    ctx = await createTestContext({});
    const clientId = await seedClient(ctx, {
      scopes: [SEEDED_SCOPE],
      redirectUris: [CALLBACK],
    });
    const scope = bundleUnion()
      .filter((s) => !SESSION_CRITICAL_SCOPES.includes(s))
      .join(" ");
    const res = await request(
      ctx.app,
      "GET",
      `${authorizeUrl({ clientId, scope, redirectUri: CALLBACK })}&prompt=none`,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("error=login_required");
    expect(await storedCeiling(ctx, clientId)).toEqual([SEEDED_SCOPE]);
  });

  it("does not send anybody to sign in when nothing needs catching up", async () => {
    ctx = await createTestContext({});
    const clientId = await seedClient(ctx, {
      scopes: [SEEDED_SCOPE],
      redirectUris: [CALLBACK],
    });
    const res = await authorizeAnonymously(ctx, {
      clientId,
      scope: SEEDED_SCOPE,
      redirectUri: CALLBACK,
    });
    expect(res.status).toBe(302);
    // The plugin's own sign-in redirect, which signs the request.
    const location = new URL(res.headers.get("location") ?? "", ORIGIN);
    expect(location.pathname).toBe("/auth/sign-in");
    expect(location.searchParams.has("sig")).toBe(true);
    expect(location.searchParams.has("return_to")).toBe(false);
  });
});

describe("the authorize ceiling catch-up writes only behind a registered redirect URI", () => {
  it("does not widen the stored ceiling for a request naming an unregistered redirect URI", async () => {
    ctx = await createTestContext({});
    const cookie = await signIn(ctx);
    const union = bundleUnion();
    // The fixture has to be one the catch-up would otherwise act on, or the
    // test passes for the wrong reason. Both halves are asserted rather than
    // assumed: the union is strictly wider than the seeded ceiling, so there
    // is genuinely something to widen by, and every literal in it clears the
    // live allowlist, so nothing about the scope list is what refuses this.
    expect(union.length).toBeGreaterThan(1);
    expect(union).toContain(SEEDED_SCOPE);
    const live = new Set(buildAllowedScopes());
    for (const scope of union) expect(live.has(scope)).toBe(true);

    const victim = await seedClient(ctx, {
      scopes: [SEEDED_SCOPE],
      redirectUris: [CALLBACK],
    });
    // The control is the same request against a client whose callback the
    // caller does name. It is what makes the fixture discriminating — the
    // only difference between the two is the redirect URI — and it doubles as
    // the barrier for the audit assertion below.
    const control = await seedClient(ctx, {
      scopes: [SEEDED_SCOPE],
      redirectUris: [CALLBACK],
    });

    const attack = await authorizeSignedIn(ctx, cookie, {
      clientId: victim,
      scope: union.join(" "),
      redirectUri: UNREGISTERED,
    });
    // Stated rather than relied on: the refusal is invisible in the response,
    // which is why nothing here asserts on it.
    expect(attack.status).toBe(302);
    expect(await storedCeiling(ctx, victim)).toEqual([SEEDED_SCOPE]);

    const permitted = await authorizeSignedIn(ctx, cookie, {
      clientId: control,
      scope: union.join(" "),
      redirectUri: CALLBACK,
    });
    expect(permitted.status).toBe(302);
    const widened = await storedCeiling(ctx, control);
    expect(widened?.length).toBe(union.length);

    // A completed control request has its audit row; the refused victim has none.
    const audits = await ctx.storage.audit.list({
      action: "auth.client.scopes_widened",
      limit: 50,
    });
    expect(audits.data.some((row) => row.resource_id === control)).toBe(true);
    expect(audits.data.some((row) => row.resource_id === control)).toBe(true);
    expect(audits.data.some((row) => row.resource_id === victim)).toBe(false);
  });

  it("still catches a stale ceiling up on a request the client could actually receive", async () => {
    // The feature is reordered, not removed. A client that has aged out of
    // the registry still self-heals, and the audit trail still says which
    // surface moved the row.
    ctx = await createTestContext({});
    const cookie = await signIn(ctx);
    const union = bundleUnion();
    const clientId = await seedClient(ctx, {
      scopes: [SEEDED_SCOPE],
      redirectUris: [CALLBACK],
    });

    const res = await authorizeSignedIn(ctx, cookie, {
      clientId,
      scope: union.join(" "),
      redirectUri: CALLBACK,
    });
    expect(res.status).toBe(302);

    const after = await storedCeiling(ctx, clientId);
    expect(after?.length).toBe(union.length);
    // Widen-only, never shrink: the seeded literal survives at the front.
    expect(after?.[0]).toBe(SEEDED_SCOPE);

    const audits = await ctx.storage.audit.list({
      action: "auth.client.scopes_widened",
      limit: 10,
    });
    expect(audits.data.length >= 1).toBe(true);
    const row = audits.data.find((r) => r.resource_id === clientId);
    expect(row?.details.surface).toBe("authorize");
  });

  it("catches up for a loopback redirect on a port the client never registered", async () => {
    // The native and CLI shape, and the reason the matcher is not a string
    // comparison. RFC 8252 §7.3 lets a native app bind an ephemeral loopback
    // port, so the port it registered is almost never the port it listens on
    // — and those are precisely the clients whose registrations go stale.
    ctx = await createTestContext({});
    const cookie = await signIn(ctx);
    const union = bundleUnion();
    const clientId = await seedClient(ctx, {
      scopes: [SEEDED_SCOPE],
      redirectUris: ["http://127.0.0.1:8123/cb"],
    });

    const res = await authorizeSignedIn(ctx, cookie, {
      clientId,
      scope: union.join(" "),
      // Same scheme, host, path and query. Only the port moved.
      redirectUri: "http://127.0.0.1:54321/cb",
    });
    expect(res.status).toBe(302);
    expect((await storedCeiling(ctx, clientId))?.length).toBe(union.length);
  });

  it("never writes a scope this server cannot grant into the stored ceiling", async () => {
    // The read-before-write bound on WHAT lands, as opposed to the two gates
    // above, which bound WHO may cause a write. A request naming a literal
    // the platform has never heard of still catches its live scopes up — that
    // is the narrowing this hook exists for, and refusing the whole request
    // would strand exactly the client whose cached scope list has gone stale
    // — but the unknown literal itself cannot reach the row.
    //
    // Both halves of the fixture are load-bearing: the bundle-published
    // literals are what a catch-up widens by, and the unknown one is on no
    // allowlist, so it is the thing that must not appear.
    ctx = await createTestContext({});
    const cookie = await signIn(ctx);
    const union = bundleUnion();
    const unknown = "core.nonexistent.type:read";
    expect(buildAllowedScopes()).not.toContain(unknown);

    const clientId = await seedClient(ctx, {
      scopes: [SEEDED_SCOPE],
      // Registered, so the redirect-uri gate is not what decides this one.
      redirectUris: [CALLBACK],
    });

    const res = await authorizeSignedIn(ctx, cookie, {
      clientId,
      scope: [...union, unknown].join(" "),
      redirectUri: CALLBACK,
    });
    expect(res.status).toBe(302);

    const after = await storedCeiling(ctx, clientId);
    expect(after).not.toContain(unknown);
    // And the request was one a catch-up genuinely acted on, so the absence
    // above is the bound doing its job rather than nothing having happened.
    expect(after?.length).toBe(union.length);
  });

  /**
   * Request shapes the plugin refuses ABOVE its own redirect-URI check.
   *
   * Each of these returned 302 with a plugin error and still took the ceiling
   * from one scope to the whole union, because the hook reproduced only the
   * `response_type` and `redirect_uri` gates and four refusals sit above
   * them. They are parameterized rather than written out because the property
   * is identical and the list is the point: the gate list and this list have
   * to move together.
   *
   * `max_age=not-a-number` is deliberately ABSENT. The plugin refuses it in
   * its query schema, which is not reproduced, so the ceiling does move on
   * that one. A test asserting otherwise would be asserting a property the
   * code does not have.
   */
  const refusedAboveRedirectCheck: [string, Record<string, string>][] = [
    ["a JAR request object", { request: "eyJhbGciOiJub25lIn0.e30." }],
    ["a request_uri this provider cannot resolve", { request_uri: "urn:x:1" }],
    [
      "prompt=select_account with no select-account page",
      {
        prompt: "select_account",
      },
    ],
    [
      "select_account alongside another prompt",
      { prompt: "login select_account" },
    ],
  ];

  for (const [name, extra] of refusedAboveRedirectCheck) {
    it(`does not widen the stored ceiling for ${name}`, async () => {
      ctx = await createTestContext({});
      const cookie = await signIn(ctx);
      const union = bundleUnion();
      const clientId = await seedClient(ctx, {
        scopes: [SEEDED_SCOPE],
        // Registered on purpose. These shapes are refused above the plugin's
        // redirect-URI check, so a fixture that also failed that check would
        // pass for the wrong reason and stay green with the gate deleted.
        redirectUris: [CALLBACK],
      });

      const res = await request(
        ctx.app,
        "GET",
        `${authorizeUrl({
          clientId,
          scope: union.join(" "),
          redirectUri: CALLBACK,
        })}&${new URLSearchParams(extra).toString()}`,
        { headers: { cookie } },
      );
      expect(res.status).toBe(302);
      expect(await storedCeiling(ctx, clientId)).toEqual([SEEDED_SCOPE]);
    });
  }

  it("does not widen the stored ceiling for a response type the plugin will refuse", async () => {
    // The plugin's own first gate. An implicit-flow request is
    // `unsupported_response_type` there, and there is no grant in it worth
    // moving a registration row for.
    ctx = await createTestContext({});
    const cookie = await signIn(ctx);
    const union = bundleUnion();
    const clientId = await seedClient(ctx, {
      scopes: [SEEDED_SCOPE],
      redirectUris: [CALLBACK],
    });

    const res = await request(
      ctx.app,
      "GET",
      authorizeUrl({
        clientId,
        scope: union.join(" "),
        redirectUri: CALLBACK,
        responseType: "token",
      }),
      { headers: { cookie } },
    );
    expect(res.status).toBe(302);
    expect(await storedCeiling(ctx, clientId)).toEqual([SEEDED_SCOPE]);
  });
});

/**
 * The containment the authorize surface leans on in place of a live-allowlist
 * pass of its own.
 *
 * The device surface clears its whole request against the allowlist at
 * initiation, because it refuses rather than narrows, and its catch-up runs
 * only at the approval, on the scopes a person ticked. The authorize surface
 * cannot: dropping a dead literal and letting the rest through is the reason
 * its hook exists, so a request naming one still reaches the catch-up.
 * What keeps a scope this server cannot grant out of the stored row is not a
 * pass there but the catch-up's own bound — it widens only by scopes the
 * bundles publish, and `buildAllowedScopes` folds every grammatically valid
 * bundle scope into the live allowlist by construction.
 *
 * **A literal this build withheld was the one class that argument did not
 * reach**, because it is grammatical and the fold takes it in on grammar
 * alone — so each function dropped it on a separate explicit rule instead,
 * and two rules can disagree where one construction cannot.
 * `bundlePublishedScopes` keeping what `buildAllowedScopes` drops writes a
 * scope into a client's stored ceiling that no request is ever validated
 * against.
 *
 * No literal is withheld now: the content category is published and both
 * rules are gone, so the construction covers everything again. The category
 * stays seeded below anyway, asserted into both sets rather than out of
 * them, because a drop re-introduced to one function and not the other is
 * the failure this file exists for and no ordinary literal can catch it.
 *
 * That is an invariant two functions hold between them and neither states, so
 * nothing fails when it stops holding. This is what fails.
 *
 * **It has to be driven by a constructed bundle list, and the first version
 * of this test was not.** Asserting the containment over
 * `DEFAULT_PERMISSION_BUNDLES` is true by definition: both sets derive from
 * the same list through the same `isValidScope` filter, and the shipped
 * configuration contains no ungrammatical literal for either filter to
 * exclude. That version stayed green with the filter deleted from
 * `bundlePublishedScopes` — the exact mutation it existed to catch.
 * `stale-client-ceiling.test.ts` opens with the same warning about the same
 * shape of no-op. Seeding the violation is what makes the assertion capable
 * of failing.
 */
describe("the bundle-published set stays inside the live allowlist", () => {
  /** Grammatically invalid: `redd` is not a verb the scope grammar knows.
   *  An operator's bundle override parses arbitrary JSON, so this is a
   *  literal a real configuration can carry. */
  const MALFORMED = "core.note:redd";
  /** Grammatical, and the class that used to escape the containment
   *  argument entirely: it was withheld from both sets by a rule of each
   *  function's own, so two rules could have disagreed where one
   *  construction cannot. Both functions publish it now, and it stays in
   *  this fixture rather than leaving with the withholding — a drop
   *  re-introduced to one function and not the other is exactly what this
   *  file exists to catch, and only a seeded literal can catch it. */
  const CATEGORY = "content:read";
  /** Valid, and in no shipped bundle, so its presence proves the constructed
   *  list reached both functions rather than being ignored. */
  const WELL_FORMED = "core.note:write";

  const constructed: PermissionBundle[] = [
    {
      id: "constructed",
      label: "Constructed",
      description:
        "A bundle list carrying a literal the grammar refuses and the " +
        "content category, which no longer answers to a rule of its own.",
      scopes: [WELL_FORMED, MALFORMED, CATEGORY],
      default_on: false,
    },
  ];

  it("excludes a malformed bundle literal from both sets", () => {
    expect(isValidScope(MALFORMED)).toBe(false);
    expect(isValidScope(WELL_FORMED)).toBe(true);

    const published = bundlePublishedScopes(constructed);
    const live = new Set(buildAllowedScopes(constructed, []));

    // The fixture reached both functions: the well-formed literal is in both.
    expect(published.has(WELL_FORMED)).toBe(true);
    expect(live.has(WELL_FORMED)).toBe(true);

    // And the malformed one is in neither. In `published` because that set is
    // what a catch-up writes into a registration row, where a literal nothing
    // can enforce is a false record. In `live` because that set is what a
    // request is validated against, where it would be a grant nothing refuses.
    expect(published.has(MALFORMED)).toBe(false);
    expect(live.has(MALFORMED)).toBe(false);
  });

  it("carries the content category into both sets, not into neither", () => {
    // This case used to assert the opposite, and the change is the point.
    // Both literals of the content category were dropped by each function on
    // a rule of its own, which put them outside the containment argument:
    // that argument runs through `isValidScope`, and a withheld literal IS
    // grammatical, so nothing structural stopped the two rules disagreeing.
    // The one that would have mattered is `bundlePublishedScopes` keeping a
    // literal `buildAllowedScopes` drops, which writes a scope into a
    // client's stored ceiling that no request can be validated against.
    //
    // The rules are gone and the class is back inside the argument. It is
    // still seeded, because what would break this is a drop re-introduced to
    // one function and not the other, and that is invisible to a fixture
    // carrying only ordinary literals.
    expect(
      isValidScope(CATEGORY),
      "the seeded literal no longer parses, so this case has quietly become " +
        "the malformed one over again",
    ).toBe(true);

    const published = bundlePublishedScopes(constructed);
    const live = new Set(buildAllowedScopes(constructed, []));

    expect(published.has(WELL_FORMED)).toBe(true);
    expect(live.has(WELL_FORMED)).toBe(true);

    expect(
      published.has(CATEGORY),
      `${CATEGORY} is published, so a catch-up must write it into a ` +
        `client's stored ceiling — every reader of that row is an exact ` +
        `membership test, and a missing entry is a grant that cannot be used.`,
    ).toBe(true);
    expect(
      live.has(CATEGORY),
      `${CATEGORY} is requestable through a configured bundle.`,
    ).toBe(true);
  });

  it("holds over the shipped bundle configuration", () => {
    // Not capable of failing on its own — see the note above — but it is the
    // containment production actually depends on, and it costs one line.
    const live = new Set(buildAllowedScopes());
    const published = [...bundlePublishedScopes(DEFAULT_PERMISSION_BUNDLES)];
    expect(published.length).toBeGreaterThan(0);
    expect(published.filter((scope) => !live.has(scope))).toEqual([]);
  });
});

/**
 * The matcher reproduces a rule that lives in the vendored plugin and is not
 * exported, so both directions need coverage.
 *
 * A matcher **stricter** than the plugin's costs a stale client one more
 * sign-in before it self-heals, and shows up as a catch-up that did not
 * happen. A matcher **looser** than the plugin's admits a write on a request
 * the plugin is about to refuse, which is the defect the gate exists to
 * close, and it breaks nothing visibly. So the refusals are the half that
 * matters most, and they are asserted here rather than inferred from the
 * admissions.
 */
describe("matchesRegisteredRedirectUri", () => {
  const admits: [string, string[], string][] = [
    [
      "an exact string match",
      ["https://app.example/callback"],
      "https://app.example/callback",
    ],
    [
      "a match against any registered entry, not only the first",
      ["https://one.example/cb", "https://two.example/cb"],
      "https://two.example/cb",
    ],
    [
      "a loopback IPv4 redirect on a different port",
      ["http://127.0.0.1:8123/cb"],
      "http://127.0.0.1:54321/cb",
    ],
    [
      "a loopback address anywhere in 127.0.0.0/8",
      ["http://127.9.9.9:1/cb"],
      "http://127.9.9.9:2/cb",
    ],
    [
      "an IPv6 loopback redirect on a different port",
      ["http://[::1]:8123/cb"],
      "http://[::1]:54321/cb",
    ],
    [
      "a loopback redirect whose query matches exactly",
      ["http://127.0.0.1:1/cb?app=marfa"],
      "http://127.0.0.1:2/cb?app=marfa",
    ],
    [
      // A private-use scheme, which RFC 8252 §7.1 makes the other native-app
      // redirect shape. It parses as a non-special URL rather than failing,
      // so it reaches the loopback arm and is admitted by exact equality
      // there — not by the string-equality shortcut the first version of this
      // label claimed.
      "a private-use-scheme registration, by exact equality",
      ["com.example.app:/callback"],
      "com.example.app:/callback",
    ],
    [
      // The genuinely unparseable case, which is the one the `catch` around
      // `new URL(requested)` exists for. `new URL("::::")` throws, so nothing
      // but string equality can admit it.
      "an unparseable requested value equal to an unparseable registration",
      ["::::"],
      "::::",
    ],
    [
      // The IPv4-mapped loopback arm. WHATWG serializes
      // `[::ffff:127.0.0.1]` to `[::ffff:7f00:1]`, and the plugin's
      // classifier unmaps before classifying, so this is loopback there too.
      // Untested, this arm could be deleted with every other test still green.
      "an IPv4-mapped IPv6 loopback on a different port",
      ["http://[::ffff:127.0.0.1]:8123/cb"],
      "http://[::ffff:127.0.0.1]:54321/cb",
    ],
    [
      // The same address written the long way, to pin that the comparison
      // runs on the WHATWG-canonical form rather than on the source text.
      "a mapped loopback registered in one spelling and requested in another",
      ["http://[::ffff:7f00:1]:8123/cb"],
      "http://[::ffff:127.0.0.1]:54321/cb",
    ],
  ];

  for (const [name, registered, requested] of admits) {
    it(`admits ${name}`, () => {
      expect(matchesRegisteredRedirectUri(registered, requested)).toBe(true);
    });
  }

  const refuses: [string, string[], string][] = [
    [
      "a redirect the client never registered",
      ["https://app.example/callback"],
      "https://attacker.example/callback",
    ],
    [
      "a different path on a registered host",
      ["https://app.example/callback"],
      "https://app.example/other",
    ],
    [
      "a different port on a NON-loopback host",
      ["https://app.example:443/cb"],
      "https://app.example:8443/cb",
    ],
    [
      "the DNS name localhost, which RFC 8252 §8.3 excludes",
      ["http://localhost:8123/cb"],
      "http://localhost:54321/cb",
    ],
    [
      "a .localhost subdomain, for the same reason",
      ["http://app.localhost:8123/cb"],
      "http://app.localhost:54321/cb",
    ],
    [
      "a loopback redirect whose scheme differs",
      ["https://127.0.0.1:8123/cb"],
      "http://127.0.0.1:54321/cb",
    ],
    [
      "a loopback redirect whose path differs",
      ["http://127.0.0.1:8123/cb"],
      "http://127.0.0.1:54321/other",
    ],
    [
      "a loopback redirect whose query differs",
      ["http://127.0.0.1:1/cb?app=marfa"],
      "http://127.0.0.1:2/cb?app=other",
    ],
    [
      "an IPv4 loopback registration against an IPv6 loopback request",
      ["http://127.0.0.1:8123/cb"],
      "http://[::1]:8123/cb",
    ],
    [
      "a host that merely starts with 127",
      ["http://127.example:8123/cb"],
      "http://127.example:54321/cb",
    ],
    [
      "a near-loopback address outside the range",
      ["http://128.0.0.1:8123/cb"],
      "http://128.0.0.1:54321/cb",
    ],
    [
      "a private-use-scheme registration that is not equal",
      ["com.example.app:/callback"],
      "com.example.app:/other",
    ],
    [
      // A mapped address outside the loopback range, so the mapped arm is
      // asserted in both directions rather than only where it admits.
      "an IPv4-mapped IPv6 address that is not loopback",
      ["http://[::ffff:128.0.0.1]:8123/cb"],
      "http://[::ffff:128.0.0.1]:54321/cb",
    ],
    ["an empty registration list", [], "https://app.example/callback"],
  ];

  for (const [name, registered, requested] of refuses) {
    it(`refuses ${name}`, () => {
      expect(matchesRegisteredRedirectUri(registered, requested)).toBe(false);
    });
  }

  it("refuses an absent registration list or an absent request", () => {
    expect(matchesRegisteredRedirectUri(null, "https://app.example/cb")).toBe(
      false,
    );
    expect(
      matchesRegisteredRedirectUri(["https://app.example/cb"], undefined),
    ).toBe(false);
    expect(matchesRegisteredRedirectUri(["https://app.example/cb"], "")).toBe(
      false,
    );
  });
});

/**
 * The two rejections {@link matchesRegisteredRedirectUri} cannot reach.
 *
 * Every hostname the matcher classifies has already been through WHATWG
 * parsing, which canonicalizes `127.000.000.001` and `[0:0:0:0:0:0:0:1]` and
 * refuses `127.0.0.999` and `[1:2:3:4:5:6:7:8::]` outright. So an end-to-end
 * case for either of these passes because `new URL` threw, not because the
 * branch fired — a green test measuring nothing, which is the shape this
 * whole file has already been caught on once.
 *
 * Asserted against the predicate directly instead. Each input is chosen so
 * that deleting the branch flips the answer to `true`, which is the only
 * version of this worth having.
 */
describe("isLoopbackIpLiteral", () => {
  it("rejects a dotted quad whose octet is out of range", () => {
    // Without the bounds check the shape alone matches and the leading `127`
    // reads as loopback, relaxing the port on a host that is not one.
    expect(isLoopbackIpLiteral("127.0.0.999")).toBe(false);
    expect(isLoopbackIpLiteral("127.0.0.1")).toBe(true);
  });

  it("rejects an IPv6 literal that fills all eight groups and still elides", () => {
    // `elided < 1`. Chosen so the groups spell `::1` once the elision is
    // ignored: drop the check and this expands to eight groups ending in 1
    // and classifies as loopback, on a literal no parser accepts.
    expect(isLoopbackIpLiteral("[0:0:0:0:0:0:0:1::]")).toBe(false);
    expect(isLoopbackIpLiteral("[::1]")).toBe(true);
  });

  it("rejects an IPv6 literal with more than one elision", () => {
    expect(isLoopbackIpLiteral("[::1::]")).toBe(false);
  });

  it("rejects a group that is not hex", () => {
    expect(isLoopbackIpLiteral("[::zz1]")).toBe(false);
  });

  it("classifies the IPv4-mapped loopback range and nothing beside it", () => {
    expect(isLoopbackIpLiteral("[::ffff:7f00:1]")).toBe(true);
    expect(isLoopbackIpLiteral("[::ffff:7fff:ffff]")).toBe(true);
    expect(isLoopbackIpLiteral("[::ffff:8000:1]")).toBe(false);
  });

  it("rejects an unbracketed IPv6 literal, which URL.hostname never produces", () => {
    expect(isLoopbackIpLiteral("::1")).toBe(false);
  });
});
