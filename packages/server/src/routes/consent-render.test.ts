import { describe, it, expect } from "vitest";
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
import { CAPABILITY_SCOPES, TYPE_REGISTRY } from "@withmarfa/shared";
import {
  buildScopeDescriptions,
  CONSENT_SCOPE_DESCRIPTIONS,
} from "./auth-consent.js";
import { renderDeviceConsentScreen } from "./device-pages.js";
import { buildAllowedScopes } from "../auth/oauth-provider.js";

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
    expect(html).toContain("<span>Notes</span>");
    expect(html).toContain("<span>Tasks</span>");
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
    // Removed: core.task:write → label "Tasks", as quiet text not a checkbox.
    expect(html).toContain(">No longer needed<");
    expect(html).toMatch(
      /No longer needed<\/p>\s*<p class="rmeta"[^>]*>Tasks</,
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
    expect(out["metadata.types"]).toBe(
      "Register and update custom data types in your space.",
    );
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
    // A wildcard nobody curated gets nothing, rather than one matched type's
    // copy standing in for a whole namespace.
    expect(describeAll("readwise.*:read")).toEqual({});
  });

  it("cannot get a wildcard's copy from the type registry", () => {
    // The premise the wildcard arm does not rely on, pinned so that a
    // registry which started answering patterns fails here and points at the
    // arm rather than shipping one type's sentence as a namespace's.
    for (const pattern of ["*", "core.*", "user.*", "app.*"]) {
      expect(TYPE_REGISTRY.get(pattern), pattern).toBeUndefined();
    }
  });

  it("resolves a capability through the labels the other screens read", () => {
    expect(CAPABILITY_SCOPES.length).toBeGreaterThan(0);
    const out = describeAll(...CAPABILITY_SCOPES);
    for (const literal of CAPABILITY_SCOPES) {
      expect(out[literal], literal).toBe(CAPABILITY_LABELS[literal]);
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
    const out = describeAll("core.note:read", "google.calendar.event:read");
    // The registry's own sentence is written for a developer reading API
    // docs. Both screens show the curated one now; the device screen used to
    // show this.
    expect(out["core.note"]).toBe("Your notes.");
    expect(out["core.note"]).not.toBe(
      TYPE_REGISTRY.get("core.note")?.description,
    );
    // The fallback is what serves a type registered at runtime, where the
    // operator wrote the description and nobody curated one here.
    expect(CONSENT_SCOPE_DESCRIPTIONS["google.calendar.event"]).toBeUndefined();
    expect(out["google.calendar.event"]).toBe(
      TYPE_REGISTRY.get("google.calendar.event")?.description,
    );
    expect(out["google.calendar.event"]).toMatch(/\S/);
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
    expect(out["edge.*"]).toBeUndefined();
    expect(out["edge.metadata"]).toBeUndefined();
    // The curated edge copy still resolves, keyed on the pattern.
    expect(describeAll("edge.parent-of:write")["edge.parent-of"]).toMatch(/\S/);
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
  const UNLABELED = [
    "metadata.types:write",
    "core.*:read",
    "app.*:read",
    "*:read",
  ];

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
