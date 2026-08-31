import { describe, it, expect, afterEach } from "vitest";
import type { ParsedScope } from "@withmarfa/shared";
import { parseScope } from "@withmarfa/shared";
import { renderConsentScreen, SCOPE_LABELS, humanizeType } from "./consent.js";
import { OIDC_LABELS, OIDC_SHORT } from "./oidc-labels.js";
import { DEFAULT_PERMISSION_BUNDLES } from "../config.js";
import {
  CAPABILITY_LABELS,
  CAPABILITY_SHORT,
  capabilityLabel,
} from "./capability-labels.js";
import {
  CAPABILITY_SCOPES,
  EDGE_TYPE_REGISTRY,
  GLOBAL_TYPE_WILDCARD,
  grantCoversScope,
  INTEGRATION_TYPE_IDS,
  scopesToMetadataPermissions,
  seedPlatformTypes,
  shippedPlatformTypes,
  subtreeWildcardRoot,
  TYPE_REGISTRY,
} from "@withmarfa/shared";
import {
  buildScopeDescriptions,
  CONSENT_SCOPE_DESCRIPTIONS,
} from "./auth-consent.js";
import { renderDeviceConsentScreen } from "./device-pages.js";
import { deriveWildcardDescription } from "./wildcard-copy.js";
import {
  OPEN_ENDED_EXPANSION_TAIL,
  OPEN_ENDED_LINE,
  OPEN_ENDED_SENTENCE,
} from "./scope-openness.js";
import { buildAllowedScopes } from "../auth/oauth-provider.js";

afterEach(() => {
  // `TYPE_REGISTRY` is a module-level binding every suite in this process
  // shares, and one case below seeds a retired platform row into it.
  seedPlatformTypes(shippedPlatformTypes());
});

/**
 * Shape-asserting smoke for `renderConsentScreen`. Covers:
 *
 * - Layout / contract: shared stylesheet link, no inline `<style>`, the form
 *   posts to `/auth/authorize/decision` with the signed `oauth_query`
 *   round-tripped verbatim, per-type checkboxes named `scopes` carrying the
 *   concrete literal as `value`, Allow/Deny buttons with `name="accept"`.
 *
 * - Soft-tile grouping: requested scopes group by capability (Read / Write /
 *   Your profile) into collapsed `<details class="grp">` tiles with a master
 *   toggle and per-type member toggles; the cascade script ships.
 *
 * - Re-consent diff: New / Already allowed / No longer needed sections.
 *
 * - Unverified app: one boxed callout, no inline badge.
 *
 * - Error banner + XSS escaping.
 */

const SCOPES: ParsedScope[] = [
  { kind: "type", typePattern: "core.note", operation: "read" },
  { kind: "type", typePattern: "core.note", operation: "write" },
  { kind: "type", typePattern: "core.task", operation: "read" },
];

const SIGNED_OAUTH_QUERY =
  "response_type=code&client_id=client-abc&redirect_uri=http%3A%2F%2Flocalhost%2Fcallback&scope=core.note%3Aread&state=abc&code_challenge=def&code_challenge_method=S256&exp=1778957000&sig=somesignaturehash";

const PARAMS = {
  clientName: "Test CLI",
  scopes: SCOPES,
  clientId: "client-abc",
  oauthQuery: SIGNED_OAUTH_QUERY,
  descriptions: {
    "core.note": "Text content you created.",
    "core.task": "Tasks and todos.",
  },
};

describe("renderConsentScreen — layout + form contract", () => {
  it("links to the shared stylesheet and carries no inline <style> block", () => {
    const html = renderConsentScreen(PARAMS);
    expect(html).toContain(
      '<link rel="stylesheet" href="/auth/static/auth.css">',
    );
    expect(html).not.toContain("<style>");
  });

  it("escapes the client name in the body", () => {
    const html = renderConsentScreen({
      ...PARAMS,
      clientName: "<script>alert(1)</script>",
    });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("threads each concrete scope literal into a checkbox value", () => {
    const html = renderConsentScreen(PARAMS);
    expect(html).toContain('value="core.note:read"');
    expect(html).toContain('value="core.note:write"');
    expect(html).toContain('value="core.task:read"');
  });

  it("POSTs to the Marfa decision handler with oauth_query + client_id hidden", () => {
    const html = renderConsentScreen(PARAMS);
    expect(html).toContain(
      '<form method="POST" action="/auth/authorize/decision"',
    );
    expect(html).toContain('name="client_id" value="client-abc"');
    expect(html).toContain('name="oauth_query"');
    expect(html).toContain("response_type=code");
    expect(html).toContain("sig=somesignaturehash");
    // PKCE / state / redirect_uri are inside oauth_query, not separate fields.
    expect(html).not.toContain('name="code"');
    expect(html).not.toContain('name="redirect_uri"');
    expect(html).not.toContain('name="code_challenge"');
    expect(html).not.toContain('name="state"');
    expect(html).not.toContain('name="response_type"');
  });

  it("renders Allow + Deny buttons with accept=true|false (plugin contract)", () => {
    const html = renderConsentScreen(PARAMS);
    expect(html).toMatch(
      /<button[^>]*name="accept"[^>]*value="true"[^>]*>Allow access<\/button>/,
    );
    expect(html).toMatch(
      /<button[^>]*name="accept"[^>]*value="false"[^>]*>Deny<\/button>/,
    );
    // Stacked: primary "Allow access" before the ghost "Deny".
    expect(html).toContain("btn--ghost");
    expect(html.indexOf("Allow access")).toBeLessThan(html.indexOf(">Deny<"));
  });

  it("uses the standard card width (consent is a dialog, not a management page)", () => {
    const html = renderConsentScreen(PARAMS);
    expect(html).toContain('class="card"');
    expect(html).not.toContain("card--wide");
  });

  it("renders a .title heading and a .sub subtitle carrying the change-anytime line", () => {
    const html = renderConsentScreen(PARAMS);
    expect(html).toContain('<h1 class="title">Allow access</h1>');
    expect(html).toContain('<p class="sub">');
    expect(html).toContain("<b>Test CLI</b>");
    expect(html).toContain("change this anytime in settings");
  });
});

describe("renderConsentScreen — soft-tile groups", () => {
  it("groups scopes into collapsed soft-tile groups by capability", () => {
    const html = renderConsentScreen(PARAMS);
    expect(html).toContain('class="t-soft"');
    expect(html).toContain('<details class="grp">');
    // Collapsed by default — no open attribute on any group.
    expect(html).not.toMatch(/<details class="grp"[^>]*\sopen/);
    expect(html).toContain("Read your content");
    expect(html).toContain("Write your content");
  });

  it("derives group labels from the configured bundles, not a renderer copy", () => {
    // The screen and the discovery document must describe the same
    // bundles, so the renderer reads the same operator-overridable
    // config instead of carrying its own taxonomy.
    const prior = process.env.MARFA_PERMISSION_BUNDLES;
    process.env.MARFA_PERMISSION_BUNDLES = JSON.stringify([
      {
        id: "read",
        label: "Peruse your things",
        description: "Custom operator copy.",
        scopes: ["core.note:read", "core.task:read"],
        default_on: true,
      },
    ]);
    try {
      const html = renderConsentScreen(PARAMS);
      expect(html).toContain("Peruse your things");
      expect(html).not.toContain("Read your content");
      // core.note:write is outside every configured bundle — it still
      // renders, in the fallback write bucket.
      expect(html).toContain('value="core.note:write"');
      expect(html).toContain("Other write access");
    } finally {
      if (prior === undefined) delete process.env.MARFA_PERMISSION_BUNDLES;
      else process.env.MARFA_PERMISSION_BUNDLES = prior;
    }
  });

  it("every default-bundle scope resolves to a human toggle label", () => {
    // The bundles derive from the registry now, so requiring a CURATED
    // label per scope would just recreate the hand list the derivation
    // deleted. What must hold instead: every derived scope resolves to
    // some human label through the same chain the renderer uses —
    // curated map first, humanized type name as the floor. The curated
    // map stays as better copy for the shipped set; this pins that the
    // chain never leaves a scope unlabeled.
    for (const bundle of DEFAULT_PERMISSION_BUNDLES) {
      for (const literal of bundle.scopes) {
        const parsed = parseScope(literal);
        expect(parsed, `unparseable bundle scope: ${literal}`).not.toBeNull();
        if (!parsed) continue;
        // The capability arm has to be here or the guard stops guarding:
        // without it a capability resolves through `humanizeType` to a
        // truthy "Webhooks" and the case passes while green-lighting the
        // exact collision `CAPABILITY_LABELS` exists to prevent.
        const label =
          parsed.kind === "oidc"
            ? OIDC_LABELS[
                (parsed.oidcScope ??
                  parsed.typePattern) as keyof typeof OIDC_LABELS
              ]
            : parsed.kind === "capability"
              ? capabilityLabel(parsed.typePattern)
              : (SCOPE_LABELS[parsed.typePattern] ??
                humanizeType(parsed.typePattern));
        expect(label, `no label resolves for ${literal}`).toBeTruthy();
      }
    }
  });

  it("lists a wildcard's matched types beneath its toggle, checkbox unchanged", () => {
    const html = renderConsentScreen({
      ...PARAMS,
      scopes: [
        ...SCOPES,
        { kind: "type", typePattern: "user.*", operation: "read" },
      ],
      wildcardExpansions: { "user.*": ["Recipes", "Training log"] },
    });
    // Informative line names what the pattern matches today and says the
    // grant covers later types too; the submitted value stays the wildcard.
    expect(html).toContain("Today this covers Recipes, Training log");
    expect(html).toContain("plus any you add later");
    expect(html).toContain('value="user.*:read"');
    expect(html).not.toContain('value="user.recipes:read"');
  });

  it("renders per-type toggles with human labels, not raw scope strings", () => {
    const html = renderConsentScreen(PARAMS);
    expect(html).toContain('class="subrow"');
    // The name, then what the grant permits. `PARAMS` asks for both halves
    // of `core.note`, and a row that named the type alone rendered the same
    // word twice; `consent-operation.test.ts` holds that apart.
    expect(html).toContain("<span>Notes (read only)</span>");
    expect(html).toContain("<span>Notes (read and write)</span>");
    expect(html).toContain("<span>Tasks (read only)</span>");
    expect(html).toContain('class="sw"');
  });

  it("each per-type toggle is a real checkbox submitter, checked by default", () => {
    const html = renderConsentScreen(PARAMS);
    expect(html).toMatch(
      /<input type="checkbox" name="scopes" value="core\.note:read" checked>/,
    );
  });

  it("omits a group with no scopes (no empty Write tile when only reads)", () => {
    const html = renderConsentScreen({
      ...PARAMS,
      scopes: [{ kind: "type", typePattern: "core.note", operation: "read" }],
    });
    expect(html).toContain("Read your content");
    expect(html).not.toContain("Write your content");
  });

  it("renders a Your profile group; openid rides along as a hidden member", () => {
    const html = renderConsentScreen({
      ...PARAMS,
      scopes: [
        {
          kind: "oidc",
          typePattern: "openid",
          operation: "none",
          oidcScope: "openid",
        },
        {
          kind: "oidc",
          typePattern: "profile",
          operation: "none",
          oidcScope: "profile",
        },
        {
          kind: "oidc",
          typePattern: "email",
          operation: "none",
          oidcScope: "email",
        },
      ],
    });
    expect(html).toContain("Your profile");
    // "Your name and picture", not "Your name". Changed deliberately: the
    // `profile` scope returns `name` AND `picture`, so this label
    // understated what was being granted. A different map overstated it as
    // a username and a bio, on a path nothing rendered. Both are one entry
    // now, matching what `customUserInfoClaims` actually returns.
    expect(html).toContain("<span>Your name and picture</span>");
    expect(html).toContain("<span>Your email address</span>");
    // openid is submitted but not shown as a row.
    expect(html).toMatch(
      /<input type="checkbox" name="scopes" value="openid" checked hidden>/,
    );
    expect(html).not.toContain("<span>Confirm your identity</span>");
  });

  it("ships the master-toggle cascade enhancement script", () => {
    const html = renderConsentScreen(PARAMS);
    expect(html).toMatch(
      /<script>[\s\S]*querySelectorAll\('\.grp'\)[\s\S]*<\/script>/,
    );
    expect(html).toContain("indeterminate");
  });
});

describe("renderConsentScreen — re-consent diff", () => {
  it("renders New / Already allowed / No longer needed sections", () => {
    const html = renderConsentScreen({
      ...PARAMS,
      priorScopes: ["core.note:read", "core.task:write"],
    });
    expect(html).toContain(">New<");
    expect(html).toContain(">Already allowed<");
    expect(html).toContain(">No longer needed<");
    // Re-consent reads as a continuation. "wants to change what it can
    // access" was accurate and misleading at once: the usual cause is Marfa's
    // own registry gaining a type since the last grant, so framing it as the
    // app changing its mind invites a refusal the situation does not warrant.
    expect(html).toContain("One more thing");
    expect(html).toContain("You have used");
    expect(html).toContain("asking for a little more");
    expect(html).not.toContain("wants to change what it can access");
  });

  it("places newly-requested scopes under New and shared scopes under Already allowed", () => {
    const html = renderConsentScreen({
      ...PARAMS,
      priorScopes: ["core.note:read"],
    });
    // New: core.note:write + core.task:read; Already allowed: core.note:read.
    expect(html).toMatch(/>New<[\s\S]*?value="core\.note:write"/);
    expect(html).toMatch(/>New<[\s\S]*?value="core\.task:read"/);
    expect(html).toMatch(/>Already allowed<[\s\S]*?value="core\.note:read"/);
  });

  it("lists no-longer-needed scopes by label, with no toggle", () => {
    const html = renderConsentScreen({
      ...PARAMS,
      priorScopes: ["core.note:read", "core.task:write"],
    });
    // Removed: core.task:write → "Tasks (read and write)", as quiet text
    // not a checkbox. The operation is on this line for the reason it is on
    // every other: dropping the write half of a grant while keeping the read
    // half is an ordinary narrowing, and the type alone cannot say which
    // half went.
    expect(html).toContain(">No longer needed<");
    expect(html).toMatch(
      /No longer needed<\/p>\s*<p class="rmeta"[^>]*>Tasks \(read and write\)</,
    );
  });

  /**
   * The one place an OIDC literal still reached `humanizeType`.
   *
   * "No longer needed" resolved its labels through capabilities, then
   * `SCOPE_LABELS`, then the last-dotted-segment fallback — never through
   * the OIDC copy. So a client that dropped `profile` rendered "Profile"
   * here while the granted row above it said "Your name and picture", and
   * dropping `offline_access` rendered "Offline access". The raw-literal
   * class this whole change exists to remove, surviving in the same file.
   */
  it("resolves a dropped OIDC literal to its label, not its dotted segment", () => {
    const html = renderConsentScreen({
      ...PARAMS,
      scopes: [{ kind: "type", typePattern: "core.note", operation: "read" }],
      priorScopes: ["core.note:read", "profile"],
    });
    expect(html).toContain(">No longer needed<");
    expect(html).toMatch(
      /No longer needed<\/p>\s*<p class="rmeta"[^>]*>Your name and picture</,
    );
    expect(html).not.toContain(">Profile<");
  });

  it("omits a diff section when its set is empty", () => {
    // Identical prev + next → only "Already allowed" renders.
    const html = renderConsentScreen({
      ...PARAMS,
      priorScopes: ["core.note:read", "core.note:write", "core.task:read"],
    });
    expect(html).toContain(">Already allowed<");
    expect(html).not.toContain(">New<");
    expect(html).not.toContain(">No longer needed<");
  });
});

describe("renderConsentScreen — unverified app", () => {
  it("renders one boxed callout (no inline badge) for a public/DCR client", () => {
    const html = renderConsentScreen({ ...PARAMS, unverified: true });
    expect(html).toContain('class="callout"');
    expect(html).toContain("Marfa hasn't verified this app");
    expect(html).not.toContain("unverified-badge");
  });

  it("omits the callout when unverified is false or absent", () => {
    expect(renderConsentScreen({ ...PARAMS, unverified: false })).not.toContain(
      'class="callout"',
    );
    expect(renderConsentScreen(PARAMS)).not.toContain('class="callout"');
  });

  it("still escapes a hostile client name when the callout is shown", () => {
    const html = renderConsentScreen({
      ...PARAMS,
      clientName: "<script>alert(1)</script>",
      unverified: true,
    });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain('class="callout"');
  });
});

describe("renderConsentScreen — error banner", () => {
  it("omits the alert div when errorMessage is undefined", () => {
    expect(renderConsentScreen(PARAMS)).not.toContain("banner--error");
  });

  it("renders an alert banner when errorMessage is set", () => {
    const html = renderConsentScreen({
      ...PARAMS,
      errorMessage: "Tick at least one permission, or click Deny.",
    });
    expect(html).toContain('class="banner banner--error"');
    expect(html).toContain('role="alert"');
    expect(html).toContain("Tick at least one permission, or click Deny.");
  });

  it("escapes HTML in errorMessage (XSS guard)", () => {
    const html = renderConsentScreen({
      ...PARAMS,
      errorMessage: "<img src=x onerror=alert(1)>",
    });
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img");
  });
});

/**
 * A group's summary describes what is in that group.
 *
 * The groups are collapsed by default, so that sentence is what most people
 * read and act on. A fixed per-bundle description would give a request for
 * three scopes and a request for every type the same copy, "Your notes,
 * tasks, bookmarks, files, media, and more," naming things the app never
 * asked for.
 *
 * The failure is symmetric, which is why it matters: a cautious person
 * refuses an app that wanted very little, and a trusting one learns the copy
 * does not track the request, which makes the screen worthless as a signal
 * for the app that really does want everything.
 */
describe("group summaries describe the request", () => {
  const scope = (
    typePattern: string,
    operation: "read" | "write",
  ): ParsedScope => ({ kind: "type", typePattern, operation });

  const summariesOf = (html: string): string[] =>
    [...html.matchAll(/<span class="gdesc">([^<]*)<\/span>/g)].map(
      (m) => m[1] ?? "",
    );

  const render = (scopes: ParsedScope[]) =>
    renderConsentScreen({
      clientName: "Test App",
      clientId: "test-app",
      oauthQuery: "sig=x",
      scopes,
    });

  // The summary and the toggle list must describe the same request. The
  // summary stopped at the curated label map while the list below fell
  // through to a humanized type name, so an uncurated scope was rendered in
  // one and silently absent from the other, and absent from the "and N more"
  // count that is meant to catch exactly that.
  it("counts a scope with no curated label, as the list below does", () => {
    const html = render([
      scope("core.note", "read"),
      scope("acme.widget", "read"),
    ]);
    const joined = summariesOf(html).join(" ");
    expect(joined).toContain("Notes");
    expect(joined).toContain("Widget");
  });

  it("names only what a narrow request asked for", () => {
    const html = render([
      scope("core.note", "read"),
      scope("core.task", "read"),
    ]);
    const summaries = summariesOf(html);
    expect(summaries.length).toBeGreaterThan(0);
    const joined = summaries.join(" ");
    expect(joined).toContain("Notes");
    expect(joined).toContain("Tasks");
    // The exact things a fixed per-bundle description would name and this
    // request does not ask for.
    expect(joined).not.toContain("Bookmarks");
    expect(joined).not.toContain("Files");
  });

  it("cannot render a narrow and a wide request identically", () => {
    const narrow = summariesOf(render([scope("core.note", "read")])).join(" ");
    const wide = summariesOf(
      render([
        scope("core.note", "read"),
        scope("core.task", "read"),
        scope("core.bookmark", "read"),
        scope("core.file", "read"),
        scope("core.media", "read"),
      ]),
    ).join(" ");
    expect(narrow).not.toBe(wide);
  });

  it("keeps an open ending only where the grant really is open", () => {
    // A wildcard genuinely extends to types that do not exist yet, so
    // saying so is honest here and was not honest on a concrete request.
    const concrete = summariesOf(render([scope("core.note", "read")])).join(
      " ",
    );
    expect(concrete).not.toContain("anything else");

    const wildcard = summariesOf(render([scope("user.*", "read")])).join(" ");
    expect(wildcard).toContain("anything else");

    // And the open-ended shape that carries no wildcard character. This
    // heading is the one that needed the clause most and was the only one
    // never to get it, because the summary decided open-endedness by looking
    // for a `*` while the row beside it asked the grammar. Two derivations
    // of one property is the defect this file keeps finding, so the case is
    // written against the shape they disagreed about rather than against the
    // shape they already agreed on.
    const metadata = parseScope("metadata:read");
    if (!metadata) throw new Error("unparseable");
    const bare = summariesOf(render([metadata])).join(" ");
    expect(bare).toContain("anything else");
  });
});

// ---------------------------------------------------------------------------
// Open-ended grants
//
// A wildcard reaches types nobody has registered yet, and the bare `metadata`
// root reaches sub-resources nobody has written yet. That property is the
// whole difference between such a grant and the list of things it covers
// today, and it is the part a person needs in order to weigh it.
//
// Pinned as a rule rather than as the strings that broke, because the strings
// were a symptom. `labelFor` resolves a curated label ahead of the
// description, so a curated label is the only thing this screen says about
// its grant, while the device screen has no toggle labels and reads the
// description out whole. Two labels named less than their scope that way, and
// asserting those two would pass again the moment a third arrived.
// ---------------------------------------------------------------------------

describe("a grant that reaches things not yet created says so", () => {
  /** The same two shapes {@link isOpenEnded} asks about, derived here the
   *  same way rather than imported, so the test fails if the renderer's
   *  answer stops matching the grammar's. */
  const openEnded = (scope: ParsedScope): boolean => {
    if (scope.kind === "oidc" || scope.kind === "capability") return false;
    if (scope.typePattern === GLOBAL_TYPE_WILDCARD) return true;
    if (subtreeWildcardRoot(scope.typePattern) !== null) return true;
    return (
      scopesToMetadataPermissions([`${scope.typePattern}:${scope.operation}`])[
        "*"
      ] !== undefined
    );
  };

  /**
   * The words a reader takes as "and whatever comes next".
   *
   * **The list lives here and nowhere else.** Both renderers derive open
   * endedness from the grammar and hold no vocabulary at all, which is the
   * whole point of the shape they were given: a case whose subject is a
   * predicate the code under test also holds cannot disagree with it, and
   * the row case below structurally could not. It counted the word "later"
   * while `statesOpenEndedness` suppressed the line on the word "later", so
   * the row supplied exactly one occurrence either way, the label's when the
   * line was suppressed and the line's when it was not. Both failure
   * directions passed for the whole time it was watching them.
   *
   * **What it catches.** A second statement of futurity anywhere on a row,
   * in whichever of these words it is phrased, and a futurity word in any
   * curated string, where the renderers no longer read for meaning and so
   * would simply say the thing twice.
   *
   * **What it cannot catch.** Futurity phrased entirely outside the list.
   * "Covering whatever the app decides to invent" means the same thing and
   * matches nothing here, and no word list closes that gap, because the ways
   * English says "and more to come" are unbounded. The gap is narrowed
   * rather than closed, and the direction it is narrowed in is what matters:
   * the failure that can no longer happen is silence, because nothing in the
   * copy can stop a renderer stating the property. What is left is a row
   * saying it twice, a defect a reader can see, rather than a grant whose
   * size a reader is never told.
   *
   * **It reads vocabulary rather than meaning, so it has false positives,
   * and they are wanted.** A description noting that removed items stay
   * recoverable "later" is caught here even though the row it produces is
   * correct. These words are reserved for the composed clause, so copy
   * borrowing one is copy somebody should look at before it ships.
   */
  const FUTURITY_VOCABULARY =
    /\b(?:later|future|yet|upcoming|forthcoming|henceforth|subsequently)\b|\badd(?:s|ed|ing)?\b|\bfrom now on\b|\bgoing forward\b|\bnew (?:ones|types|kinds|members)\b/i;

  /** The sentences the renderers compose, which are the only statements of
   *  the property either screen is allowed to make. */
  const COMPOSED = [
    OPEN_ENDED_LINE,
    OPEN_ENDED_EXPANSION_TAIL,
    OPEN_ENDED_SENTENCE,
  ];

  /** Strip every composed sentence out of `text`, returning how many came
   *  out and what was left behind. */
  const withoutComposed = (
    text: string,
  ): { stated: number; residue: string } => {
    let residue = text;
    let stated = 0;
    for (const sentence of COMPOSED) {
      const parts = residue.split(sentence);
      stated += parts.length - 1;
      residue = parts.join(" ");
    }
    return { stated, residue };
  };

  /** `text` states the property exactly once, and the statement is the
   *  renderer's rather than something the copy happened to say. */
  const statesFuturityOnce = (text: string, what: string): void => {
    const { stated, residue } = withoutComposed(text);
    expect(
      stated,
      `${what} composes its open ending ${String(stated)} times, not once`,
    ).toBe(1);
    expect(
      residue,
      `${what} states its open ending a second time, in copy`,
    ).not.toMatch(FUTURITY_VOCABULARY);
  };

  /** `text` says nothing of the kind, by either route. */
  const statesNoFuturity = (text: string, what: string): void => {
    const { stated, residue } = withoutComposed(text);
    expect(
      stated,
      `${what} carries a composed open-ended sentence on a closed grant`,
    ).toBe(0);
    expect(residue, `${what} reads as an open-ended grant`).not.toMatch(
      FUTURITY_VOCABULARY,
    );
  };

  /** Every open-ended literal the server will accept, from the allowlist
   *  rather than from a list kept here: a new open-ended pattern joins this
   *  case by being requestable, which is the point at which it can reach a
   *  person. */
  const openEndedLiterals = (): string[] =>
    buildAllowedScopes().filter((literal) => {
      const parsed = parseScope(literal);
      return parsed !== null && openEnded(parsed);
    });

  const render = (literal: string): string => {
    const parsed = parseScope(literal);
    if (!parsed) throw new Error(`unparseable: ${literal}`);
    return renderConsentScreen({
      clientName: "Test App",
      clientId: "test-app",
      oauthQuery: "sig=x",
      scopes: [parsed],
      descriptions: buildScopeDescriptions([parsed]),
    });
  };

  /** One toggle row, by the literal its checkbox carries. Scoped to the row
   *  because the group heading above it has an open ending of its own, and a
   *  whole-document match would read that one and call the row covered. */
  const rowFor = (html: string, literal: string): string => {
    for (const row of html.match(
      /<div class="subrow">[\s\S]*?<\/label><\/div>/g,
    ) ?? []) {
      if (row.includes(`value="${literal}"`)) return row;
    }
    return "";
  };

  it("finds open-ended literals in the allowlist at all", () => {
    // A derivation that silently returns nothing makes the case below
    // vacuous, and it would: every assertion in it is inside the loop.
    const literals = openEndedLiterals();
    expect(literals.length).toBeGreaterThan(3);
    // The two shapes, named so a derivation that quietly stops recognizing
    // one of them fails here rather than passing over it.
    expect(literals).toContain("user.*:read");
    expect(literals).toContain("metadata:read");
  });

  it("states it on the row, for every open-ended scope offered", () => {
    for (const literal of openEndedLiterals()) {
      const row = rowFor(render(literal), literal);
      expect(row, `no toggle row rendered for ${literal}`).not.toBe("");
      // Once, and once said by the renderer rather than once said by
      // anybody. What this replaces counted the word "later" on the row,
      // which is the word the suppression it was watching also turned on,
      // so the row carried exactly one occurrence whether the line fired or
      // not: the label's when it was suppressed, the line's when it was
      // not. The count came out at one in both failure directions and in the
      // correct case alike, which left the only reachable failure a label
      // holding the word twice.
      statesFuturityOnce(row, literal);
    }
  });

  it("says nothing of the kind on a concrete scope", () => {
    // The discriminator. Without it the case above passes on a renderer that
    // puts the line under every row, which would say a grant on one type
    // grows, and would also mean the case above never observed anything.
    const row = rowFor(render("core.note:read"), "core.note:read");
    expect(row).toContain("Notes");
    statesNoFuturity(row, "core.note:read");
  });

  it("does not repeat itself where the row already lists what it matches", () => {
    // Two things can have said it by the time the row's second line is
    // built: an expansion line, which ends "plus any you add later", and the
    // label, which for a pattern outside the curated map is the description
    // and carries the clause the device screen needs. This case pinned one
    // pattern with an expansion, which is the half that was already right,
    // and the half that broke was the label: `core.*` doubled the sentence
    // the commit that added this was written in, and `app.*` doubled it one
    // commit later. So it runs over every open-ended pattern, and the
    // no-expansion arm is the case above.
    //
    // The expansion map is keyed by type pattern and supplied for every
    // pattern here, including ones the resolver does not enumerate today.
    // The row's contract is not conditioned on which roots that resolver
    // fills, and narrowing the fixture to today's two would put this case
    // back where it started: pinning the arrangement that happens to work.
    const literals = openEndedLiterals();
    expect(literals.length).toBeGreaterThan(3);
    for (const literal of literals) {
      const parsed = parseScope(literal);
      if (!parsed) throw new Error(`unparseable: ${literal}`);
      const html = renderConsentScreen({
        clientName: "Test App",
        clientId: "test-app",
        oauthQuery: "sig=x",
        scopes: [parsed],
        descriptions: buildScopeDescriptions([parsed]),
        wildcardExpansions: {
          [parsed.typePattern]: ["Recipes", "Training log"],
        },
      });
      const row = rowFor(html, literal);
      expect(row, `no toggle row rendered for ${literal}`).not.toBe("");
      expect(
        row,
        `${literal} stopped naming the members it can name`,
      ).toContain("Today this covers Recipes, Training log");
      statesFuturityOnce(row, `${literal} with an expansion`);
    }
  });

  /**
   * One capability row from the device screen, which carries no toggles and
   * no scope literals. Rendered a scope at a time so the row is the only
   * one, since there is nothing in the markup to key a lookup on.
   */
  const deviceRow = (literal: string): string => {
    const parsed = parseScope(literal);
    if (!parsed) throw new Error(`unparseable: ${literal}`);
    const html = renderDeviceConsentScreen({
      clientName: "Test App",
      scopes: [parsed],
      userCode: "ABCD-EFGH",
      descriptions: buildScopeDescriptions([parsed]),
    });
    const rows = html.match(/<div class="crow">[\s\S]*?<\/div>/g) ?? [];
    expect(
      rows,
      `device screen rendered ${String(rows.length)} rows for ${literal}, not one`,
    ).toHaveLength(1);
    return rows[0] ?? "";
  };

  it("states it once on the screen that has no rows", () => {
    // The same rule on the other surface, asserted against what that screen
    // renders rather than against the map behind it.
    //
    // What this replaces asserted that every open-ended *description*
    // contained the word "later", and it held the wrong thing twice over. It
    // held a map rather than a screen, and it held a word rather than a
    // statement: "Ones you remove later stay recoverable." satisfied it
    // while saying nothing whatever about how far the grant reaches. The
    // clause is composed now, by `describeCapabilities` from the same
    // `isOpenEnded` the toggle row asks, so what is worth holding is that it
    // arrives, exactly once, on the surface a person actually reads.
    //
    // The global wildcard runs in this loop like everything else. It used to
    // be exempted, on the argument that "Everything in your space." cannot
    // be falsified by a type registered tomorrow and that this was all the
    // device screen needed, since the device screen had no second line to
    // state the property on. The device screen composes its own sentence
    // now, so the exemption has nothing left to buy and is gone rather than
    // overridden.
    const literals = openEndedLiterals();
    // Every assertion is inside the loop, and the pattern that carried the
    // defect is named, so a derivation that quietly stops finding it fails
    // here rather than emptying the case.
    expect(literals.length).toBeGreaterThan(3);
    expect(literals).toContain("app.*:read");
    expect(literals).toContain("*:read");
    for (const literal of literals) {
      statesFuturityOnce(deviceRow(literal), `${literal} on the device screen`);
    }
  });

  it("leaves a concrete grant's device row saying nothing of the kind", () => {
    // The discriminator for the case above, the same one the toggle row
    // gets. Without it that case passes on a screen appending the clause to
    // every row, which tells somebody granting one type that the grant
    // grows, and would also mean the case above never observed anything.
    statesNoFuturity(
      deviceRow("core.note:read"),
      "core.note:read on the device screen",
    );
  });

  it("keeps futurity out of every curated string", () => {
    // The rule that makes composing safe, and the one place a word list is
    // the right instrument rather than the wrong one. Neither renderer reads
    // these strings for meaning any more, so a futurity clause written into
    // one is not suppressed, not reconciled and not noticed. It is simply
    // said twice, once by the copy and once by the sentence composed beneath
    // it.
    //
    // Both maps, because `labelFor` falls through to a description wherever
    // nothing curated names the pattern. That fall-through is how a sentence
    // written for the device screen became an authorize-screen toggle label
    // in the first place, and it is still there: what has changed is that
    // the sentence it hands over no longer states anything the row is about
    // to state as well.
    const entries: [string, string][] = [
      ...Object.entries(SCOPE_LABELS).map(
        ([k, v]) => [`SCOPE_LABELS[${k}]`, v] as [string, string],
      ),
      ...Object.entries(CONSENT_SCOPE_DESCRIPTIONS).map(
        ([k, v]) => [`CONSENT_SCOPE_DESCRIPTIONS[${k}]`, v] as [string, string],
      ),
    ];
    expect(entries.length).toBeGreaterThan(20);
    for (const [where, copy] of entries) {
      expect(
        copy,
        `${where} states an open ending the renderers compose for it`,
      ).not.toMatch(FUTURITY_VOCABULARY);
    }
  });

  it("composes sentences a reader would take as futurity", () => {
    // The floor under `statesFuturityOnce`, which strips these before it
    // looks for a second statement. A constant rewritten into something that
    // no longer says anything of the kind would leave every case above
    // green and observing nothing.
    expect(COMPOSED.length).toBeGreaterThan(2);
    for (const sentence of COMPOSED) {
      expect(sentence, sentence).toMatch(FUTURITY_VOCABULARY);
    }
  });

  it("leaves a concrete scope's description saying nothing of the kind", () => {
    // The discriminator for the case above, which is otherwise satisfied by
    // a map whose every line ends "and any added later", copy that would
    // tell somebody granting one type that the grant grows. Two of these are
    // the parents of open-ended neighbors, so they are the lines a blanket
    // rewrite would take with it.
    const out = buildScopeDescriptions(
      ["core.note:read", "core.entity:read", "metadata.types:write"].map(
        (literal) => {
          const parsed = parseScope(literal);
          if (!parsed) throw new Error(`unparseable: ${literal}`);
          return parsed;
        },
      ),
    );
    expect(Object.keys(out)).toHaveLength(3);
    for (const [pattern, copy] of Object.entries(out)) {
      statesNoFuturity(copy, pattern);
    }
  });

  it("keeps every curated label out of the summary's punctuation", () => {
    // `summarize` joins these into a sentence, so a label carrying its own
    // comma arrives there as two items. This is also why the open-endedness
    // above is on the row and not in the label: saying it needs an "and",
    // and an "and" breaks the same list a comma does.
    //
    // The conjunction is asserted here where `CAPABILITY_SHORT` deliberately
    // leaves it alone, and the difference is what the two maps hold. A
    // capability's short form is a verb phrase, where "connect and
    // disconnect services" is one item and reads correctly in a list. Every
    // entry here is the name of a thing, and a name joined by a conjunction
    // is two names: "Notes, People and places and Files" is what this one
    // rendered.
    // The separators are the ones a joined sentence breaks on, not the one
    // that broke first. Two were guarded because two were what `summarize`
    // literally writes, and that is the wrong question: the reader is
    // parsing a list, so anything that reads as an item boundary splits the
    // label whether or not this file produced it. "Files & folders" passed,
    // and would have rendered as "Bookmarks, Files & folders and
    // Organizations", which is the exact sentence this case exists to stop.
    // Lowercased, so a capitalized "And" is caught too.
    const SEPARATORS = [",", ";", "/", "&", " and ", " or ", " plus "];
    for (const [pattern, label] of Object.entries(SCOPE_LABELS)) {
      for (const separator of SEPARATORS) {
        expect(
          label.toLowerCase(),
          `${pattern} carries ${JSON.stringify(separator)}, which reads as an item boundary once the summary joins it into a list`,
        ).not.toContain(separator);
      }
    }
  });

  /**
   * A crude singular form, applied to both sides so the comparison is
   * consistent rather than linguistically correct. "Individuals" and "an
   * individual" have to meet somewhere, and a real stemmer is more machinery
   * than a label check earns. It maps "series" to "sery", which is wrong and
   * harmless: both sides go through it.
   */
  const singular = (word: string): string => {
    const w = word.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (w.length > 4 && w.endsWith("ies")) return `${w.slice(0, -3)}y`;
    if (w.length > 4 && /(?:s|x|z|ch|sh)es$/.test(w)) return w.slice(0, -2);
    if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss"))
      return w.slice(0, -1);
    return w;
  };

  /** Function words, which name nothing and would match on any label
   *  unlucky enough to contain one. */
  const NOT_A_NAME = new Set([
    "the",
    "and",
    "for",
    "its",
    "this",
    "that",
    "any",
    "all",
    "one",
    "some",
    "your",
    "you",
    "from",
    "with",
    "other",
    "own",
    "can",
    "never",
    "part",
  ]);

  /**
   * The stoplist is applied before `singular`, not after, and the order is
   * the whole of what it does. `singular("this")` is "thi", which is in no
   * stoplist, so the one entry above that `singular` rewrites was the one
   * entry that escaped it. It is the only one of the nineteen: the rule only
   * fires on a word longer than three characters ending in a lone "s".
   */
  const normalizeWords = (text: string): string[] =>
    text
      .split(/[^A-Za-z0-9]+/)
      .filter(Boolean)
      .filter((w) => !NOT_A_NAME.has(w.toLowerCase()))
      .map(singular)
      .filter((w) => w.length > 2);

  const containsSequence = (haystack: string[], needle: string[]): boolean => {
    if (needle.length === 0) return false;
    return haystack.some((_, i) =>
      needle.every((word, j) => haystack[i + j] === word),
    );
  };

  it("drops every function word, including the one singular rewrites", () => {
    // The stoplist runs before `singular`, and this is what the order costs
    // when it is the other way round. `singular("this")` is "thi", which is
    // in no stoplist, so "this" was the one entry of the nineteen that
    // survived being stopped. It is the only one the rule can reach: nothing
    // else here is longer than three characters and ends in a lone "s".
    //
    // Not reachable from today's copy, and it fails loudly rather than
    // quietly when it is, since a stray "thi" can only add a needle or a
    // haystack word. Held anyway, because the cost of the wrong order is a
    // silent hole in a stoplist and the whole point of the stoplist is that
    // nobody looks at it again.
    for (const word of NOT_A_NAME) {
      expect(normalizeWords(word), word).toEqual([]);
    }
    expect(normalizeWords("Notes about this and that")).toEqual([
      "note",
      "about",
    ]);
  });

  /**
   * The mechanical forms of a child type's name, as normalized word
   * sequences.
   *
   * Four sources, each a place the product itself says what that child is:
   * its curated toggle label, the humanized form of its type id, the
   * registry's label, and the content words of the two sentences written
   * about it. The registry's description is cut at its first sentence,
   * because the convention there is one defining sentence followed by
   * inheritance boilerplate, and "Inherits all core.file fields." names
   * nothing.
   *
   * Words matching a segment of the parent's own type id are dropped. A
   * child's copy routinely contains its parent's name, and "Audio files"
   * under `core.file` is ordinary qualification rather than the parent
   * claiming the child. The filter reads the parent's **type id**, never its
   * label, or a bad label would be the thing that excused itself.
   */
  const namesOf = (child: string, parent: string): string[][] => {
    const ownSegments = new Set(parent.split(".").map(singular));
    const registry = TYPE_REGISTRY.get(child);
    const firstSentence = (registry?.description ?? "").split(/(?<=\.)\s/)[0];
    const phrases = [
      SCOPE_LABELS[child],
      humanizeType(child),
      registry?.label,
    ].filter((p): p is string => p !== undefined);
    const words = [
      ...normalizeWords(CONSENT_SCOPE_DESCRIPTIONS[child] ?? ""),
      ...normalizeWords(firstSentence ?? ""),
    ].filter((w) => !ownSegments.has(w));
    return [
      ...phrases.map(normalizeWords).filter((p) => p.length > 0),
      ...words.map((w) => [w]),
    ];
  };

  /**
   * The two maps a scope's copy reaches a person through, and the reason the
   * rule below runs over both rather than over the toggles alone.
   *
   * A label wins on the authorize screen, so it is the whole of what that
   * screen says about a grant. The device screen has no toggles and no
   * second line: it prints the description and stops. Neither surface is the
   * lenient one, and the description is if anything the surface where a
   * wrong sentence does more damage, because nothing beside it qualifies
   * what it says.
   *
   * `verb` is the word the failure message needs to read correctly about
   * whichever map it caught.
   */
  const COPY_SURFACES = [
    { name: "SCOPE_LABELS", verb: "labeled", copy: SCOPE_LABELS },
    {
      name: "CONSENT_SCOPE_DESCRIPTIONS",
      verb: "described as",
      copy: CONSENT_SCOPE_DESCRIPTIONS,
    },
  ] as const;

  for (const surface of COPY_SURFACES) {
    it(`never names a type its own scope does not reach, in ${surface.name}`, () => {
      // The other half of the rule the labels run on, and the half a curated
      // string cannot be trusted with. A pattern's descendants are separately
      // requestable and carry rows of their own, while a bare grant on the
      // parent is exact: `grantCoversScope` answers false for every child. So
      // a parent naming one of them puts a type on the row that ticking it
      // does not grant. `core.entity` was "People and places" above
      // "Contacts" and "Places", neither of which it reaches.
      //
      // Asked of `grantCoversScope` rather than of a list, so the assertion
      // relaxes on its own if coverage ever changes, and scoped to the
      // ancestor naming a descendant rather than the reverse. The reverse is
      // ordinary qualification: "Audio files" sits under `Files` and does not
      // claim to be it.
      //
      // **What this can see, and what it cannot.** It compared the parent's
      // label against the child's label verbatim, which is a much narrower
      // question than the one it is asking: "Photos" over `core.file` names
      // `core.file.image` and passed, "Individuals" over `core.entity` names
      // `core.entity.person` and passed, and the real defect it did catch,
      // "People and places", was caught on the "Places" half alone, because
      // "Places" happened to be a child's label letter for letter. The
      // "People" half, which named `core.entity.person`, was never seen.
      // `namesOf` now gathers every mechanical form of a child's name, and
      // that is still all it can do: the forms are the words the product
      // itself uses for that child, plural-folded and matched as whole words.
      //
      // **It reads words, never polarity.** A sentence saying a grant does
      // *not* reach a book still holds the word "book" and is caught here.
      // That is deliberate rather than a limitation worked around: a copy
      // decision phrased as a list of exclusions puts those names on the row
      // of a grant that does not reach them, which is the failure the case
      // exists for, and separating the two readings would mean parsing
      // negation scope. Say what a grant does reach.
      //
      // **A synonym nobody wrote down is invisible to it and always will
      // be.** "Pictures" over `core.file` is a real violation this returns
      // green on, because no copy anywhere in the repository calls an image a
      // picture. The set of words meaning the same thing as a type is
      // unbounded, so this narrows the gap rather than closing it, and copy
      // that reads as if it covers a child still wants a human to look at it.
      // Do not read a pass here as the question having been answered.
      const entries = Object.entries(surface.copy);
      const pairs: { parent: string; child: string }[] = [];
      for (const [parent] of entries) {
        for (const [child] of entries) {
          if (!child.startsWith(`${parent}.`)) continue;
          if (grantCoversScope([`${parent}:read`], `${child}:read`)) continue;
          pairs.push({ parent, child });
        }
      }
      // A derivation that finds no pairs asserts nothing, and every assertion
      // below is inside the loop. The named pair is the one that had the
      // defect, so a rename that moves it out of the map fails here rather
      // than quietly emptying the case.
      expect(pairs.length).toBeGreaterThan(3);
      expect(pairs).toContainEqual({
        parent: "core.entity",
        child: "core.entity.place",
      });

      for (const { parent, child } of pairs) {
        const parentWords = normalizeWords(surface.copy[parent] ?? "");
        const names = namesOf(child, parent);
        // Every assertion below is two loops deep, so a child that yields no
        // forms at all is checked against nothing and passes.
        //
        // The route to that is narrower than it looks, and naming the wrong
        // one would put the floor's justification on a mechanism that cannot
        // occur. The own-segment filter is not it: it applies only to the
        // description-derived `words`, while `phrases` is unfiltered, so a
        // child described entirely in its parent's words still yields its
        // curated label, its humanized id and its registry label. What is
        // reachable is a child whose last id segment normalizes away, which
        // is any segment of two characters or fewer or one that is a
        // function word, leaving `humanizeType` contributing nothing, with
        // neither a curated nor a registry label behind it to take its
        // place.
        expect(
          names.length,
          `no mechanical form of ${child}'s name, so nothing is checked for it`,
        ).toBeGreaterThan(0);
        for (const name of names) {
          expect(
            containsSequence(parentWords, name),
            `${parent} is ${surface.verb} "${surface.copy[parent] ?? ""}", which names ${child} as "${name.join(" ")}": a type this grant does not reach`,
          ).toBe(false);
        }
      }
    });
  }

  it("says one thing about an entity grant, on both screens", () => {
    // A label wins over a description on this screen and the device screen
    // has no labels, so the two strings are what the two screens say about
    // one grant and they have to agree. `core.entity` was labeled
    // "Organizations" and described as "Organizations and other entities.",
    // which is the branch's own defect surviving at reduced size: the
    // description reached past the label without saying how far, and the
    // narrower of the two answers was the one above the toggles. Both
    // literals are in the default bundle, so the row is on every consent
    // screen that renders at all.
    //
    // Pinned as the pair rather than derived, because what was decided here
    // is a copy question rather than a property. The registry lists a brand
    // among the things this type holds and no conjunction-free word covers a
    // brand as well as a school, while a conjunction is what the summary's
    // list-join forbids; so the label stops at "Organizations", the
    // description stops in the same place, and the residue is stated at
    // `SCOPE_LABELS` instead of being papered over. Moving either string
    // means making that argument again.
    expect(SCOPE_LABELS["core.entity"]).toBe("Organizations");
    expect(CONSENT_SCOPE_DESCRIPTIONS["core.entity"]).toBe(
      "Companies, teams, schools, and other organizations.",
    );

    // The general form of this is on now, over both maps. It was held back
    // while `core.media` still read "Media: books, films, music, podcasts.",
    // naming four types a bare `core.media` grant reaches none of, because
    // turning the check on before that sentence was rewritten would only
    // have invited an exemption for the one case it catches. The sentence is
    // rewritten, the exception is gone, and the case above runs over the
    // descriptions unqualified. What stays pinned here is this pair, which
    // is a copy decision rather than a property and so cannot be derived.
  });
});

// ---------------------------------------------------------------------------
// The label maps, which exist for one reason.
//
// `humanizeType` takes the last dotted segment, so an unnamed
// `capability.webhooks` renders as "Webhooks" — byte-identical to what
// `system.webhook:read` gets from the same fallback. One grant is sight of a
// webhook row and the other is the power to point a new webhook anywhere.
// ---------------------------------------------------------------------------

describe("capability labels", () => {
  it("names every capability in both shapes", () => {
    // The docstrings claim a test pins this. It is this one.
    expect(CAPABILITY_SCOPES.length).toBeGreaterThan(0);
    for (const literal of CAPABILITY_SCOPES) {
      expect(
        CAPABILITY_LABELS[literal],
        `no toggle label: ${literal}`,
      ).toBeTruthy();
      expect(
        CAPABILITY_SHORT[literal],
        `no short label: ${literal}`,
      ).toBeTruthy();
    }
  });

  it("never collides with the humanized fallback it replaces", () => {
    for (const literal of CAPABILITY_SCOPES) {
      expect(capabilityLabel(literal)).not.toBe(humanizeType(literal));
    }
    // The specific pair that motivated the map.
    expect(capabilityLabel("capability.webhooks")).not.toBe(
      SCOPE_LABELS["system.webhook"],
    );
  });

  it("keeps the inline forms comma-free, since they are joined into a list", () => {
    // A label carrying its own comma turns one item into two when the
    // security page lists several in a sentence.
    for (const literal of CAPABILITY_SCOPES) {
      expect(CAPABILITY_SHORT[literal]).not.toContain(",");
    }
  });
});

// ---------------------------------------------------------------------------
// `default_on`
//
// These cases are written against the form's own submission rather than
// against attribute strings, because what matters is not that a `checked` is
// absent but that an untouched form grants nothing from the bundle.
// ---------------------------------------------------------------------------

/** The scope literals an untouched form submits: every `name="scopes"` input
 *  the renderer marked checked, hidden mechanisms included. */
function defaultSubmission(html: string): string[] {
  const out: string[] = [];
  for (const tag of html.match(/<input[^>]*name="scopes"[^>]*>/g) ?? []) {
    if (!/\schecked(\s|>)/.test(tag)) continue;
    const value = /value="([^"]*)"/.exec(tag)?.[1];
    if (value !== undefined) out.push(value);
  }
  return out.sort();
}

/** The scope literals offered inside one named group, whatever their state:
 *  what the user submits if they tick that group and touch nothing else. */
function offeredIn(html: string, label: string): string[] {
  const out: string[] = [];
  for (const block of html.match(/<details class="grp">[\s\S]*?<\/details>/g) ??
    []) {
    if (!block.includes(`<span class="glabel">${label}</span>`)) continue;
    const body = /<div class="gsub">([\s\S]*)<\/div>/.exec(block)?.[1] ?? "";
    for (const tag of body.match(/<input[^>]*name="scopes"[^>]*>/g) ?? []) {
      const value = /value="([^"]*)"/.exec(tag)?.[1];
      if (value !== undefined) out.push(value);
    }
  }
  return out.sort();
}

/** Whether a named group's master toggle starts ticked. */
function masterChecked(html: string, label: string): boolean | undefined {
  for (const block of html.match(/<details class="grp">[\s\S]*?<\/details>/g) ??
    []) {
    if (!block.includes(`<span class="glabel">${label}</span>`)) continue;
    const summary = /<summary>([\s\S]*?)<\/summary>/.exec(block)?.[1] ?? "";
    const master = /<input[^>]*type="checkbox"[^>]*>/.exec(summary)?.[0] ?? "";
    return /\schecked(\s|>)/.test(master);
  }
  return undefined;
}

describe("renderConsentScreen — default_on", () => {
  const ON_BUNDLE = {
    id: "read",
    label: "Read your content",
    description: "",
    scopes: ["core.note:read", "core.task:read"],
    default_on: true,
  };
  const OFF_BUNDLE = {
    id: "manage",
    label: "Manage your space",
    description: "",
    scopes: ["core.note:write"],
    default_on: false,
  };
  const REQUESTED: ParsedScope[] = [
    { kind: "type", typePattern: "core.note", operation: "read" },
    { kind: "type", typePattern: "core.task", operation: "read" },
    { kind: "type", typePattern: "core.note", operation: "write" },
  ];
  const render = (): string =>
    renderConsentScreen({
      ...PARAMS,
      scopes: REQUESTED,
      bundles: [ON_BUNDLE, OFF_BUNDLE],
    });

  it("renders an off-by-default bundle unticked, rows and master alike", () => {
    const html = render();
    expect(masterChecked(html, "Manage your space")).toBe(false);
    expect(html).toContain('value="core.note:write"');
    // Stated as the whole submission rather than as a `not.toContain`, which
    // passes on an empty match and so would survive a renderer that emitted
    // no checkboxes at all.
    expect(defaultSubmission(html)).toEqual([
      "core.note:read",
      "core.task:read",
    ]);
  });

  it("keeps an already-granted off-by-default scope ticked on re-consent", () => {
    // `default_on` is the initial-offer default. A scope the user granted
    // last time is being shown, not offered, so the flag does not apply.
    //
    // Rendering it unticked is worse than cosmetic: the tile is collapsed
    // and sits below "New", so nobody sees the choice, and the decision
    // route reads the resulting submission as a narrowing. A narrowing is
    // treated as a promise that the removed access stops working, so it
    // revokes the client's live tokens. An untouched Continue killed a
    // working integration.
    const html = renderConsentScreen({
      ...PARAMS,
      scopes: REQUESTED,
      bundles: [ON_BUNDLE, OFF_BUNDLE],
      priorScopes: ["core.note:read", "core.note:write"],
    });
    expect(defaultSubmission(html)).toEqual([
      "core.note:read",
      "core.note:write",
      "core.task:read",
    ]);
  });

  it("still offers a newly-requested off-by-default scope unticked", () => {
    // The discriminating half of the case above: forcing every diff section
    // ticked would pass it and defeat the feature on re-consent.
    const html = renderConsentScreen({
      ...PARAMS,
      scopes: REQUESTED,
      bundles: [ON_BUNDLE, OFF_BUNDLE],
      priorScopes: ["core.note:read"],
    });
    expect(defaultSubmission(html)).toEqual([
      "core.note:read",
      "core.task:read",
    ]);
  });

  it("grants nothing from it when the user leaves it alone", () => {
    // The whole property, stated as the form states it: an untouched submit
    // carries the on-by-default bundle's scopes and none of the off one's.
    expect(defaultSubmission(render())).toEqual([
      "core.note:read",
      "core.task:read",
    ]);
  });

  it("grants exactly its scopes when the user ticks it", () => {
    // Ticking a group submits the literals its rows carry, so the property
    // the renderer owns is that those rows are exactly the bundle's scopes:
    // no neighbor's literal rides along, and none of its own is missing.
    expect(offeredIn(render(), "Manage your space")).toEqual([
      "core.note:write",
    ]);
    expect(offeredIn(render(), "Read your content")).toEqual([
      "core.note:read",
      "core.task:read",
    ]);
  });

  it("leaves an on-by-default bundle ticked", () => {
    // The discriminating half: a renderer that unticked everything would
    // pass all three cases above.
    const html = render();
    expect(masterChecked(html, "Read your content")).toBe(true);
  });

  it("keeps the hidden mechanisms on whatever a bundle says", () => {
    // `openid` and `offline_access` are submitted by hidden fields a person
    // cannot see, so they cannot be said to have declined one. A bundle that
    // means to withhold a mechanism stops requesting it.
    const html = renderConsentScreen({
      ...PARAMS,
      scopes: [
        {
          kind: "oidc",
          typePattern: "openid",
          operation: "none",
          oidcScope: "openid",
        },
      ],
      bundles: [
        {
          id: "profile",
          label: "Your profile",
          description: "",
          scopes: ["openid"],
          default_on: false,
        },
      ],
    });
    expect(defaultSubmission(html)).toEqual(["openid"]);
  });

  it("ticks a scope no bundle claims", () => {
    // `default_on` is a property of a bundle. A scope an app named that no
    // bundle describes lands in a fallback bucket, where there is no
    // declaration to honor and unticking would be a policy this screen
    // invented.
    const html = renderConsentScreen({
      ...PARAMS,
      scopes: [
        { kind: "type", typePattern: "core.bookmark", operation: "read" },
      ],
      bundles: [OFF_BUNDLE],
    });
    expect(defaultSubmission(html)).toEqual(["core.bookmark:read"]);
  });
});

describe("renderConsentScreen — a scope in two bundles", () => {
  it("ticks it when any on-by-default bundle offers it", () => {
    // The two readers of a bundle overlap have to agree. This renderer used
    // first-bundle-wins and `scopesOfferedOffByDefaultOnly` uses
    // any-on-by-default-wins, so with the off bundle listed first the same
    // configuration rendered the scope unticked here while the device flow
    // treated it as on-by-default and granted it on one approval. The
    // stricter surface was the one with the toggle, which is backwards.
    const html = renderConsentScreen({
      ...PARAMS,
      scopes: [{ kind: "type", typePattern: "core.note", operation: "write" }],
      bundles: [
        {
          id: "manage",
          label: "Manage your space",
          description: "",
          scopes: ["core.note:write"],
          default_on: false,
        },
        {
          id: "write",
          label: "Write your content",
          description: "",
          scopes: ["core.note:write"],
          default_on: true,
        },
      ],
    });
    expect(defaultSubmission(html)).toEqual(["core.note:write"]);
  });

  it("ticks a scope an on-by-default bundle's wildcard reaches", () => {
    // The same agreement one step wider, and the half a literal tie-break
    // cannot see. `core.*:write` is ticked by default, so the user already
    // gets `core.task:write` by leaving it alone and the device flow no
    // longer withholds that literal. Letting the off-by-default bundle claim
    // it here would untick a scope the other surface grants on one click,
    // which is exactly the disagreement the tie-break exists to stop.
    //
    // It lands in a fallback bucket rather than under either bundle's
    // heading: no on-by-default bundle named it, and an off-by-default one
    // may not claim something it cannot withhold.
    const html = renderConsentScreen({
      ...PARAMS,
      scopes: [{ kind: "type", typePattern: "core.task", operation: "write" }],
      bundles: [
        {
          id: "manage",
          label: "Manage your space",
          description: "",
          scopes: ["core.task:write"],
          default_on: false,
        },
        {
          id: "write",
          label: "Write your content",
          description: "",
          scopes: ["core.*:write"],
          default_on: true,
        },
      ],
    });
    expect(defaultSubmission(html)).toEqual(["core.task:write"]);
    expect(offeredIn(html, "Manage your space")).toEqual([]);
  });

  it("still unticks a scope no on-by-default bundle reaches", () => {
    // The control. The wildcard covers its own subtree and nothing else, so
    // an off-by-default bundle keeps its scope and keeps it unticked.
    const html = renderConsentScreen({
      ...PARAMS,
      scopes: [
        { kind: "type", typePattern: "user.secret", operation: "write" },
      ],
      bundles: [
        {
          id: "manage",
          label: "Manage your space",
          description: "",
          scopes: ["user.secret:write"],
          default_on: false,
        },
        {
          id: "write",
          label: "Write your content",
          description: "",
          scopes: ["core.*:write"],
          default_on: true,
        },
      ],
    });
    expect(defaultSubmission(html)).toEqual([]);
    expect(offeredIn(html, "Manage your space")).toEqual(["user.secret:write"]);
  });
});

/**
 * Every label that reaches a joined sentence needs a sentence form.
 *
 * `summarize` resolves OIDC scopes through `OIDC_SHORT` and capabilities
 * through `CAPABILITY_SHORT`, both separate maps from the toggle labels.
 * Two maps with the same keys and no compile-time link is exactly how the
 * capitalization bug this replaced got in: adding a toggle label without
 * its sentence form breaks nothing that anything notices.
 *
 * The four OIDC literals are now keyed on their union, so the compiler
 * holds that half. The check stays as the thing that would fail if the
 * union link were ever loosened back to `string`.
 */
describe("sentence forms cover every label that can be joined into one", () => {
  it("has a short form for every OIDC literal", () => {
    for (const literal of Object.keys(OIDC_LABELS)) {
      const key = literal as keyof typeof OIDC_LABELS;
      expect(OIDC_SHORT[key], `no short form for ${literal}`).toBeDefined();
    }
  });

  it("keeps every inline-list form lowercase and comma-free", () => {
    // summarize capitalizes whichever one lands first and nothing else, so a
    // capitalized entry landing second reproduces exactly the defect these
    // maps exist to prevent. A label carrying its own comma turns one list
    // item into two fragments. CAPABILITY_SHORT is checked here rather than
    // only for commas, because it is the larger map and the one whose toggle
    // labels are full sentences.
    for (const value of [
      ...Object.values(OIDC_SHORT),
      ...Object.values(CAPABILITY_SHORT),
    ]) {
      expect(value).not.toMatch(/,/);
      // A conjunction is NOT checked here, deliberately. It looked like the
      // same hazard as a comma — the joiner puts "and" between the last two
      // items, so "your name and picture and your email address" reads as
      // three things. But no regex separates that from "connect and
      // disconnect services", where the conjunction is inside one verb
      // phrase and reads correctly in a list. Two `CAPABILITY_SHORT` entries
      // are of that shape and are right as they stand. The rendered
      // snapshots are what caught the real instance and are the guard that
      // can tell the two apart, because a person reads them.
      expect(value[0]).toBe(value[0]?.toLowerCase());
    }
  });
});

// ---------------------------------------------------------------------------
// The description axis: one answer per scope, whichever screen asks.
//
// Distinct from the label maps above, and the distinction is what the
// renderer runs on. A label is the short name on a toggle row; a description
// is the plain-English line, and `labelFor` falls back from the first to the
// second. Three maps used to hold descriptions and two of them contradicted
// each other about whether a metadata scope or a wildcard gets one at all.
// ---------------------------------------------------------------------------

/** Throws rather than filtering, so a fixture typo cannot leave an empty
 *  scope list and quietly satisfy an assertion about what is absent. */
const parse = (literal: string): ParsedScope => {
  const parsed = parseScope(literal);
  if (!parsed) throw new Error(`unparseable scope literal: ${literal}`);
  return parsed;
};

const describeAll = (...literals: string[]): Record<string, string> =>
  buildScopeDescriptions(literals.map(parse));

describe("buildScopeDescriptions covers every kind a person can be shown", () => {
  it("describes the metadata scopes instead of skipping them", () => {
    // The skip rested on these being self-explanatory to whoever requests
    // them. Whoever requests them is not who reads the screen.
    const out = describeAll("metadata:read", "metadata.types:write");
    expect(out.metadata).toMatch(/\S/);
    expect(out["metadata.types"]).toBe("Custom data types in your space.");
  });

  it("names what a metadata scope reaches rather than what it permits", () => {
    // One entry serves both operations, because `typePattern` carries no
    // verb: `metadata.types:read` and `metadata.types:write` read the same
    // line. All three lines opened "Register and update", so a person
    // approving a read was shown a sentence about writing, which is the
    // direction that matters on the screen where they decide whether to
    // trust an app.
    //
    // Asked of the allowlist for the same reason the test below is: the
    // fourth sub-resource has to arrive here rather than on a screen.
    //
    // Scoped to the metadata entries deliberately, and the reason is about
    // this family rather than about the rest of the map. Every metadata line
    // is a plain noun phrase, so the leading word settles the question on its
    // own. Elsewhere the map is written to no such rule, and a leading-word
    // check applied across it would be testing a convention nothing else
    // holds — passing or failing on how an entry happens to open rather than
    // on whether it names an act.
    const metadata = buildAllowedScopes()
      .map(parse)
      .filter((s) => s.kind === "metadata");
    const out = buildScopeDescriptions(metadata);
    expect(Object.keys(out)).toHaveLength(
      new Set(metadata.map((s) => s.typePattern)).size,
    );
    for (const [pattern, copy] of Object.entries(out)) {
      expect(copy, `${pattern} opens with an act`).not.toMatch(
        /^(?:register|update|create|add|change|edit|delete|remove|manage|set|read|write)\b/i,
      );
    }
  });

  it("describes every metadata scope a client can actually request", () => {
    // Asked of the allowlist rather than a list beside it, so a third
    // sub-resource added to the grammar arrives here without copy and fails,
    // rather than reaching a screen as its own literal. `metadata.edge_types`
    // is why: it has been requestable as long as `metadata.types` has, and
    // the map that described one had never heard of the other.
    const metadata = buildAllowedScopes()
      .map(parse)
      .filter((s) => s.kind === "metadata");
    expect(metadata.length).toBeGreaterThan(2);
    const out = buildScopeDescriptions(metadata);
    for (const scope of metadata) {
      expect(out[scope.typePattern], scope.typePattern).toMatch(/\S/);
    }
  });

  it("describes every edge type a client can actually request", () => {
    // The axis that actually had the gap. `in-collection` is a shipping core
    // edge, `buildAllowedScopes` publishes `edge.in-collection:read|write`,
    // and nothing curated described it, so the builder fell through to the
    // registry and roughly 700 characters of schema rationale rendered as a
    // row on the device approval screen.
    //
    // Derived from `EDGE_TYPE_REGISTRY` rather than from a list beside it,
    // so a tenth edge type fails here rather than shipping a paragraph. And
    // held to being the curated line rather than to being non-empty: the
    // fallback is non-empty too, which is the whole defect, so a presence
    // check would have admitted the very thing it was meant to catch.
    const edges = [...EDGE_TYPE_REGISTRY.keys()];
    expect(edges.length).toBeGreaterThan(4);
    const out = buildScopeDescriptions(
      edges.map((edgeType) => parse(`edge.${edgeType}:read`)),
    );
    for (const edgeType of edges) {
      const registry = EDGE_TYPE_REGISTRY.get(edgeType)?.description;
      expect(
        registry,
        `fixture assumes the registry describes ${edgeType}`,
      ).toMatch(/\S/);
      expect(out[`edge.${edgeType}`], edgeType).toMatch(/\S/);
      expect(out[`edge.${edgeType}`], edgeType).not.toBe(registry);
    }
  });

  it("describes every type it ships without reaching the registry", () => {
    // The other half of the claim the map's docstring makes, asked of
    // `TYPE_REGISTRY` rather than read off the map. One sentence covered
    // both axes and was false on the edge one, so this half is pinned rather
    // than trusted.
    //
    // **This used to exempt the integration namespaces, and the exemption
    // was the defect.** It read that they "fall back to the registry by
    // design" — but nobody designed that, and the sixteen types it excused
    // were reaching a person as up to 796 characters of schema rationale on
    // the screen where they decide whether to trust an application. An
    // exemption is what let them accumulate unseen, so the filter is gone
    // and this asks the whole registry.
    //
    // Which makes it the check that stops the next sixteen: a type added to
    // the shipped set with no curated sentence fails here, and it cannot be
    // waved through from `consent-copy-coverage.test.ts`, because that
    // file's known-uncovered list is not read here.
    const shipped = [...TYPE_REGISTRY.keys()];
    expect(shipped.length).toBeGreaterThan(20);
    // The precondition that matters, because the defect was an exemption
    // rather than an absence. Re-introduce a filter on the line above and
    // every assertion below still passes on whatever survived it, which is
    // exactly how sixteen types sat outside this check. Named against
    // `INTEGRATION_TYPE_IDS` rather than a literal, so a seventeenth is
    // covered without anybody remembering to add it here.
    expect(INTEGRATION_TYPE_IDS.size).toBeGreaterThan(0);
    expect(shipped).toEqual(expect.arrayContaining([...INTEGRATION_TYPE_IDS]));
    const out = buildScopeDescriptions(
      shipped.map((id) => parse(`${id}:read`)),
    );
    for (const typeId of shipped) {
      const registry = TYPE_REGISTRY.get(typeId)?.description;
      expect(
        registry,
        `fixture assumes the registry describes ${typeId}`,
      ).toMatch(/\S/);
      expect(out[typeId], typeId).toMatch(/\S/);
      expect(out[typeId], typeId).not.toBe(registry);
    }
  });

  it("describes a wildcard, which nothing else can", () => {
    const out = describeAll(
      "*:read",
      "core.*:read",
      "user.*:read",
      "app.*:read",
    );
    expect(Object.keys(out).sort()).toEqual(["*", "app.*", "core.*", "user.*"]);
    for (const [pattern, copy] of Object.entries(out)) {
      expect(copy, pattern).toMatch(/\S/);
    }
    // A publisher wildcard is derived from its root rather than curated,
    // which is the only shape that reaches a root installed at boot. Held
    // to naming the service and to NOT being any concrete type's copy: the
    // failure this replaces would be one matched type's sentence standing
    // in for a whole namespace, and a bare non-empty check admits that.
    const derived = describeAll("readwise.*:read")["readwise.*"];
    expect(derived).toContain("Readwise");
    for (const id of TYPE_REGISTRY.keys()) {
      expect(derived, id).not.toBe(TYPE_REGISTRY.get(id)?.description);
    }
  });

  it("derives a wildcard for a root this build has never heard of", () => {
    // The property that makes the rule a rule. `buildAllowedScopes` folds in
    // publisher roots boot installs from the `custom_types` table, so a
    // wildcard can reach a consent screen on a running instance that no list
    // written here could name. A table closes today's set and reopens on the
    // next integration; this is the case that tells the two apart.
    //
    // The root is deliberately hyphenated, because the display name is the
    // half a person reads.
    const out = describeAll("acme-corp.*:read", "edge.acme-corp.*:read");
    expect(out["acme-corp.*"]).toBe(
      "Everything Acme Corp saves in your space.",
    );
    expect(out["edge.acme-corp.*"]).toBe("How Acme Corp connects your items.");

    // The precondition, because both assertions pass vacuously against a
    // build that happened to ship this root: it must be unknown here.
    expect(TYPE_REGISTRY.has("acme-corp")).toBe(false);
    expect(
      [...TYPE_REGISTRY.keys()].some((id) => id.startsWith("acme-corp.")),
    ).toBe(false);
  });

  it("declines to derive a sentence for a structural root", () => {
    // The arm that keeps the rule off the roots the map curates. Without it
    // a deleted curated entry does not go missing, it goes wrong: `core.*`
    // would read as a service called "Core" rather than as the standard
    // content types, and nothing else in this file would notice.
    for (const pattern of ["core.*", "user.*", "app.*", "marfa.*", "*"]) {
      expect(deriveWildcardDescription(pattern), pattern).toBeUndefined();
    }
    // A subtree of a root is not a root. Not requestable today, and a
    // sentence that becomes nonsense the moment it is would be worse than
    // none.
    expect(deriveWildcardDescription("core.media.*")).toBeUndefined();
  });

  it("cannot get a wildcard's copy from the type registry", () => {
    // The premise the wildcard arm does not rely on, pinned so that a
    // registry which started answering patterns fails here and points at the
    // arm rather than shipping one type's sentence as a namespace's.
    for (const pattern of ["*", "core.*", "user.*", "app.*"]) {
      expect(TYPE_REGISTRY.get(pattern), pattern).toBeUndefined();
    }
  });

  it("leaves a capability out, because both screens name one without it", () => {
    // `labelFor` here and `describeCapabilities` on the device screen both
    // resolve a capability through `capability-labels.ts` and return before
    // they reach this map, so an entry would be computed and discarded on
    // every render. That is the whole reason the map has nothing for one.
    //
    // Held by rendering with no map at all rather than by asserting what the
    // map holds. The absence is only safe while both screens still name a
    // capability unaided, and asserting the absence alone would pass equally
    // well on a screen that had started needing an entry and lost the words.
    expect(CAPABILITY_SCOPES.length).toBeGreaterThan(0);
    const scopes = CAPABILITY_SCOPES.map(parse);
    expect(buildScopeDescriptions(scopes)).toEqual({});

    const authorize = renderConsentScreen({
      clientName: "Test CLI",
      clientId: "client-abc",
      oauthQuery: SIGNED_OAUTH_QUERY,
      scopes,
    });
    const device = renderDeviceConsentScreen({
      clientName: "Test CLI",
      scopes,
      userCode: "ABCD-EFGH",
    });

    for (const literal of CAPABILITY_SCOPES) {
      expect(authorize, literal).toContain(CAPABILITY_LABELS[literal]);
      expect(device, literal).toContain(CAPABILITY_LABELS[literal]);
      // The device screen's floor when nothing names a scope. Reached by the
      // same arm, so a capability arriving here as its own literal is the
      // shape a lost label takes rather than a second failure.
      expect(device, literal).not.toContain(`<span>${literal}</span>`);
    }
  });

  it("answers nothing for an OIDC literal", () => {
    // `labelFor` here and `describeCapabilities` on the device screen both
    // resolve one through `oidc-labels.ts` and return before they reach this
    // map, so an entry would be computed and discarded on every render.
    expect(describeAll("openid", "profile", "email", "offline_access")).toEqual(
      {},
    );
  });

  it("prefers curated copy to the registry's, and falls back to it", () => {
    // **The fixture used to be `google.calendar.event`, and the comment
    // beside it said the fallback serves a type registered at runtime.**
    // Neither half survived a check. A runtime registration goes to a
    // per-space overlay that `TYPE_REGISTRY` does not expose, so it cannot
    // reach this lookup at all; and a custom type is not requestable as a
    // row of its own anyway, only through its namespace wildcard. The
    // fallback's entire population was shipped types nobody had curated,
    // which is what the sixteen integration entries just closed — so a
    // fixture drawn from the shipped set now proves the opposite of what it
    // was written to prove.
    //
    // The population that remains is a platform row this build no longer
    // ships. `seedPlatformTypes` refills the registry at boot from the rows
    // the instance holds, so an instance carrying a retired type resolves
    // it here, and no curated sentence can ever exist for it. That is what
    // this seeds.
    const retired = {
      schema: {
        id: "acme.retired_widget",
        version: 1,
        fields: {},
        description:
          "A widget shape a previous build shipped and this one does not.",
      },
      family: "integration" as const,
    };
    seedPlatformTypes([...shippedPlatformTypes(), retired]);

    // Preconditions, because every assertion below passes vacuously without
    // them: the seed has to have taken, and the row has to be uncurated.
    expect(TYPE_REGISTRY.get(retired.schema.id)?.description).toBe(
      retired.schema.description,
    );
    expect(CONSENT_SCOPE_DESCRIPTIONS[retired.schema.id]).toBeUndefined();

    const out = describeAll("core.note:read", `${retired.schema.id}:read`);
    // The registry's own sentence is written for a developer reading API
    // docs. Both screens show the curated one now; the device screen used to
    // show this.
    expect(out["core.note"]).toBe("Notes.");
    expect(out["core.note"]).not.toBe(
      TYPE_REGISTRY.get("core.note")?.description,
    );
    expect(out[retired.schema.id]).toBe(retired.schema.description);
  });

  it("does not let one kind read another kind's copy off the flat map", () => {
    // `typePattern` carries a different namespace per kind, so one map across
    // four kinds is only sound while no two can produce the same key. The
    // edge entries were keyed on the bare edge type id, where `*` is an edge
    // type the scope allowlist publishes and `metadata` is a name an edge
    // type can be registered under. Both would have read the type axis's copy
    // the moment the wildcard entries landed beside them.
    const out = describeAll("*:read", "edge.*:read", "edge.metadata:read");
    expect(out["*"]).toBe("Everything in your space.");
    // `edge.*` has copy of its own now, which makes this check sharper
    // rather than weaker: the failure it guards is `edge.*` resolving the
    // TYPE axis's sentence off the flat map, and an undefined could never
    // have told that apart from the entry simply not existing yet. Now it
    // can, so the assertion is inequality against the string it must not be.
    expect(out["edge.*"]).toBe("How everything in your space is connected.");
    expect(out["edge.*"]).not.toBe(out["*"]);
    expect(out["edge.metadata"]).toBeUndefined();
    // The curated edge copy still resolves, keyed on the pattern. Held
    // against the registry's line rather than against emptiness: revert the
    // `edge.` prefix on these keys and the lookup falls through to
    // `EDGE_TYPE_REGISTRY`, whose description is also non-empty, so a
    // `toMatch(/\S/)` here admitted the broken keying it was written to
    // pin.
    const registry = EDGE_TYPE_REGISTRY.get("parent-of")?.description;
    expect(
      registry,
      "fixture assumes the registry describes parent-of",
    ).toMatch(/\S/);
    const curated = describeAll("edge.parent-of:write")["edge.parent-of"];
    expect(curated).toMatch(/\S/);
    expect(curated).not.toBe(registry);
  });

  it("keeps an edge type's schema rationale off both screens", () => {
    // `in-collection` is the instance the derived test above generalizes,
    // and this is what it looked like where a person met it: a paragraph
    // about containment models, cardinality and cascade behavior, rendered
    // as one row of a consent decision.
    //
    // Asserted on a leading fragment rather than on the whole registry
    // string, because both renderers escape what they print and the
    // description carries an apostrophe. Matching the raw string would pass
    // on a screen that was showing the paragraph in full, which is the
    // failure this is here to see.
    const registry = EDGE_TYPE_REGISTRY.get("in-collection")?.description ?? "";
    const fragment = registry.split(/["'&<>]/)[0] ?? "";
    expect(
      fragment.length,
      "fixture assumes a long unescaped run of registry copy",
    ).toBeGreaterThan(40);

    const scopes = [parse("edge.in-collection:read")];
    const descriptions = buildScopeDescriptions(scopes);
    const curated = descriptions["edge.in-collection"];
    expect(curated).toMatch(/\S/);
    expect(curated).not.toBe(registry);

    const authorize = renderConsentScreen({ ...PARAMS, scopes, descriptions });
    const device = renderDeviceConsentScreen({
      clientName: "Test CLI",
      scopes,
      userCode: "ABCD-EFGH",
      descriptions,
    });
    for (const html of [authorize, device]) {
      expect(html).toContain(curated);
      expect(html).not.toContain(fragment);
    }
  });
});

/**
 * The two screens a person meets a scope on say the same thing about it.
 *
 * Worth more than two tests each checking one screen, because the defect was
 * never that either screen was wrong on its own: each was internally
 * consistent and they disagreed with each other, so which answer somebody got
 * depended on which screen the flow had put them on.
 *
 * Only the description field is held to this. The label field is deliberately
 * free to differ: `SCOPE_LABELS` gives the authorize screen a short toggle
 * name where the device screen, which has no toggles, shows the sentence. So
 * the literals below are ones with no label entry, where the authorize screen
 * renders the description itself and a disagreement would be visible.
 *
 * This holds the renderers to one source. That the device *route* still reads
 * that source rather than rebuilding a map of its own is held by
 * `device-grant.test.ts`, which drives the real request.
 */
describe("the authorize screen and the device screen describe a scope alike", () => {
  // Literals with no `SCOPE_LABELS` entry, which is the population this
  // describes. `metadata.types:write` used to sit here and no longer
  // qualifies: it gained a curated label, so the authorize screen now renders
  // the label where this fixture needs it to render the description.
  // `edge.about:read` replaces it as a member of the family that still has no
  // labels at all, so the case keeps the same reach.
  const UNLABELED = ["edge.about:read", "core.*:read", "app.*:read", "*:read"];

  it("renders the same copy on both, from the one map", () => {
    const scopes = UNLABELED.map(parse);
    const descriptions = buildScopeDescriptions(scopes);
    // Every literal described, or the loop below asserts over less than it
    // reads as asserting over.
    expect(Object.keys(descriptions)).toHaveLength(UNLABELED.length);

    const authorize = renderConsentScreen({ ...PARAMS, scopes, descriptions });
    const device = renderDeviceConsentScreen({
      clientName: "Test CLI",
      scopes,
      userCode: "ABCD-EFGH",
      descriptions,
    });

    for (const [pattern, copy] of Object.entries(descriptions)) {
      expect(authorize, pattern).toContain(copy);
      expect(device, pattern).toContain(copy);
    }
  });

  it("shows no scope on either screen as its bare literal", () => {
    // The floor both screens fall to when nothing describes a scope. It is
    // what a metadata row and a wildcard row rendered on one of them.
    const scopes = UNLABELED.map(parse);
    const descriptions = buildScopeDescriptions(scopes);
    const device = renderDeviceConsentScreen({
      clientName: "Test CLI",
      scopes,
      userCode: "ABCD-EFGH",
      descriptions,
    });
    for (const literal of UNLABELED) {
      expect(device, literal).not.toContain(`<span>${literal}</span>`);
    }
  });
});
