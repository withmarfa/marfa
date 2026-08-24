import { describe, it, expect } from "vitest";
import type { ParsedScope } from "@withmarfa/shared";
import { parseScope } from "@withmarfa/shared";
import {
  renderConsentScreen,
  SCOPE_LABELS,
  OIDC_LABELS,
  humanizeType,
} from "./consent.js";
import { DEFAULT_PERMISSION_BUNDLES } from "../config.js";

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
        const label =
          parsed.kind === "oidc"
            ? OIDC_LABELS[parsed.oidcScope ?? parsed.typePattern]
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
    expect(html).toContain("<span>Your name</span>");
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
 * Every group used to render its bundle's fixed description, so a request
 * for three scopes and a request for every type produced identical copy:
 * "Your notes, tasks, bookmarks, files, media, and more." The groups are
 * collapsed by default, so that sentence is what most people read and act
 * on, and it named things the app had never asked for.
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
    // The exact things the old fixed copy promised and this request did not
    // ask for.
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
