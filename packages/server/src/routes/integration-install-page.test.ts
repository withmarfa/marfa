import { describe, it, expect } from "vitest";
import { renderInstallConsentScreen } from "./integration-install-page.js";

/**
 * Shape-asserting smoke for `renderInstallConsentScreen`. The load-bearing
 * assertions are the POST contract (field names + decision values +
 * credential_ref gating) and the manifest → human-name vs type-identifier
 * mapping — the renderer is restyled freely above these, so they're what
 * the test pins.
 */

const BASE_MANIFEST: Record<string, unknown> = {
  target_types: ["core.event", "google.calendar.event"],
  triggers: [{ type: "schedule", config: { cron: "*/5 * * * *" } }],
  permissions: {
    extension: { "connection.runtime": "write" },
    edge: { about: "read" },
  },
};

const BASE_PARAMS = {
  integrationId: "intg_123",
  manifestName: "Google Calendar",
  manifestVersion: "1.0.0",
  publisher: "marfa",
  summary: "Keep your events in sync.",
  direction: "both" as const,
  manifest: BASE_MANIFEST,
};

describe("renderInstallConsentScreen — POST contract", () => {
  const html = renderInstallConsentScreen(BASE_PARAMS);

  it("posts to the same install path with method POST", () => {
    expect(html).toContain(
      `<form method="POST" action="/integrations/intg_123/install">`,
    );
  });

  it("emits the approve and deny decision buttons with exact field name + values", () => {
    expect(html).toContain(`name="decision" value="approve"`);
    expect(html).toContain(`name="decision" value="deny"`);
  });

  it("omits the hidden credential_ref input when no pre-arm hint", () => {
    expect(html).not.toContain(`name="credential_ref"`);
    expect(html).not.toContain("Reusing existing OAuth credential");
  });

  it("emits the hidden credential_ref input and hint note when pre-armed", () => {
    const armed = renderInstallConsentScreen({
      ...BASE_PARAMS,
      credentialRefHint: "sysc_cred_42",
      credentialRefLabel: "Google (calendar)",
    });
    expect(armed).toContain(
      `<input type="hidden" name="credential_ref" value="sysc_cred_42">`,
    );
    expect(armed).toContain("Reusing existing OAuth credential");
    expect(armed).toContain("Google (calendar)");
  });

  it("falls back to the credential id as label when none supplied", () => {
    const armed = renderInstallConsentScreen({
      ...BASE_PARAMS,
      credentialRefHint: "sysc_cred_42",
    });
    expect(armed).toContain(
      `<input type="hidden" name="credential_ref" value="sysc_cred_42">`,
    );
    expect(armed).toContain("sysc_cred_42");
  });
});

describe("renderInstallConsentScreen — the retired label field", () => {
  const html = renderInstallConsentScreen(BASE_PARAMS);

  // The screen used to render an editable "Connection label" input.
  // Nothing stored what a person typed into it: its only consumer was the
  // seed runtime credential's label, and the install stopped minting one.
  // A `system.connection` declares no label field, so there was nowhere
  // left to put the value. An input whose value is discarded is worse
  // than a missing one, because a person reads it as a thing they get to
  // name.
  // The removed input's prefilled value was the only place the version
  // appeared, so taking it out took the version off the screen with it.
  // A person approving an install is consenting to a specific version:
  // the upgrade-consent flow exists precisely because a later one can ask
  // for more. The version is text now rather than an editable field.
  it("still names the version being approved", () => {
    expect(html).toContain("Marfa integration, version 1.0.0, by @marfa");
  });

  it("renders no label input", () => {
    expect(html).not.toContain('name="label"');
    expect(html).not.toContain("Connection label");
  });
});

describe("renderInstallConsentScreen — data mapping", () => {
  const html = renderInstallConsentScreen(BASE_PARAMS);

  it("shows a human data-type name in the capability tile, not the raw identifier", () => {
    // `core.event` → "Events", `google.calendar.event` → "Calendar events".
    expect(html).toContain("Calendar events");
    expect(html).toMatch(/captile__t[^>]*>Events, Calendar events</);
  });

  it("shows the raw type identifiers behind the details disclosure", () => {
    expect(html).toContain("Details</summary>");
    expect(html).toContain("core.event");
    expect(html).toContain("google.calendar.event");
  });

  it("renders the minted authority: write on every target type", () => {
    // The credential holds write on every declared type whatever the
    // direction — an inbound integration writes what it pulls — so the
    // consent pills say write and never claim a read-only reach the
    // permission model does not back.
    expect(html).toContain("core.event:write");
    expect(html).toContain("google.calendar.event:write");
    expect(html).not.toContain("core.event:read");
    expect(html).not.toContain("google.calendar.event:read");
  });

  it("uses the manifest summary as the subtitle", () => {
    expect(html).toContain("Keep your events in sync.");
  });
});

describe("renderInstallConsentScreen — neutral tile", () => {
  const html = renderInstallConsentScreen(BASE_PARAMS);

  it("renders a neutral glyph tile (shared --tile fill, first-letter glyph)", () => {
    expect(html).toContain(`class="logo"`);
    expect(html).toMatch(/class="logo"[^>]*>G</);
    // No inline brand color — the tile fill comes from the shared sheet.
    expect(html).not.toMatch(/background:\s*#(?!fff|f5f5f5)/i);
  });

  it("labels the tile as a Marfa integration", () => {
    expect(html).toContain("Marfa integration");
  });
});

describe("renderInstallConsentScreen — escaping", () => {
  it("escapes the manifest name and summary", () => {
    const html = renderInstallConsentScreen({
      ...BASE_PARAMS,
      manifestName: `<script>alert(1)</script>`,
      summary: `a & b "c"`,
    });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("a &amp; b");
  });
});

describe("renderInstallConsentScreen — empty manifest", () => {
  it("renders a stable lead row and scopes when target_types is absent", () => {
    const html = renderInstallConsentScreen({
      ...BASE_PARAMS,
      direction: "read",
      manifest: {},
    });
    expect(html).toContain("Your data");
    // No target types → bare verb in the scopes field.
    expect(html).toContain("read");
    // Still a well-formed install form.
    expect(html).toContain(`name="decision" value="approve"`);
  });
});

describe("renderInstallConsentScreen — configuration fields", () => {
  const manifestWithConfig = {
    ...BASE_MANIFEST,
    configuration_schema: {
      feed_url: {
        type: "string",
        description: "The Atom or RSS feed to poll.",
        required: true,
      },
    },
  };

  it("renders declared configuration as prefixed form fields", () => {
    const html = renderInstallConsentScreen({
      ...BASE_PARAMS,
      manifest: manifestWithConfig,
    });
    // The prefix is what keeps a manifest key from colliding with the
    // form's own decision / credential_ref fields.
    expect(html).toContain('name="config_feed_url"');
    expect(html).toContain("The Atom or RSS feed to poll.");
    expect(html).toContain("Configuration");
  });

  it("omits the configuration section when the manifest declares none", () => {
    const html = renderInstallConsentScreen(BASE_PARAMS);
    expect(html).not.toContain("config_");
  });

  it("threads a refusal and the submitted values back into the form", () => {
    const html = renderInstallConsentScreen({
      ...BASE_PARAMS,
      manifest: manifestWithConfig,
      configurationValues: { feed_url: "https://example.com/feed.xml" },
      errorMessage: '"feed_url" is required',
    });
    expect(html).toContain("banner--error");
    expect(html).toContain("&quot;feed_url&quot; is required");
    expect(html).toContain('value="https://example.com/feed.xml"');
  });
});

/**
 * The heading name. `display_name` is publisher-authored manifest metadata,
 * so the screen reads it off the manifest rather than taking it from anyone
 * approving the install. A manifest that declares none keeps rendering under
 * its identifier, which is what every manifest registered before the field
 * existed does.
 */
describe("renderInstallConsentScreen — display name", () => {
  const IDENTIFIER_PARAMS = {
    ...BASE_PARAMS,
    manifestName: "acme/calendar-sync",
  };

  it("renders the manifest display_name as the heading when declared", () => {
    const html = renderInstallConsentScreen({
      ...IDENTIFIER_PARAMS,
      manifest: { ...BASE_MANIFEST, display_name: "Calendar Sync" },
    });
    expect(html).toContain(`<div class="row__title">Calendar Sync</div>`);
    expect(html).not.toContain(
      `<div class="row__title">acme/calendar-sync</div>`,
    );
  });

  it("renders the identifier unchanged when the manifest declares none", () => {
    const html = renderInstallConsentScreen(IDENTIFIER_PARAMS);
    expect(html).toContain(`<div class="row__title">acme/calendar-sync</div>`);
  });

  it("falls back to the identifier for a non-string or blank display_name", () => {
    for (const value of [42, null, "", "   "]) {
      const html = renderInstallConsentScreen({
        ...IDENTIFIER_PARAMS,
        manifest: { ...BASE_MANIFEST, display_name: value },
      });
      expect(html).toContain(
        `<div class="row__title">acme/calendar-sync</div>`,
      );
    }
  });

  it("escapes a display_name", () => {
    const html = renderInstallConsentScreen({
      ...IDENTIFIER_PARAMS,
      manifest: {
        ...BASE_MANIFEST,
        display_name: `<script>alert(1)</script>`,
      },
    });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  /**
   * The load-bearing one. Every other line above the Install button is free
   * text its publisher wrote, and that button grants write on every declared
   * target type. If a label could replace the identifier outright, a
   * manifest registered as `mallory/calendar-sync` declaring itself "Google
   * Calendar" would render a screen a space admin could not tell from the
   * real one.
   */
  it("keeps the identifier on the page when a display_name is shown", () => {
    const html = renderInstallConsentScreen({
      ...IDENTIFIER_PARAMS,
      manifest: { ...BASE_MANIFEST, display_name: "Definitely Not A Fake" },
    });
    expect(html).toContain("Definitely Not A Fake");
    expect(html).toContain("acme/calendar-sync");
  });

  it("puts the identifier in the meta line beside the version", () => {
    const html = renderInstallConsentScreen({
      ...IDENTIFIER_PARAMS,
      manifest: { ...BASE_MANIFEST, display_name: "Calendar Sync" },
    });
    expect(html).toContain(
      `<div class="row__meta">Marfa integration acme/calendar-sync, version 1.0.0, by @marfa</div>`,
    );
  });

  /**
   * Showing the identifier is not enough on its own. `display_name` carries
   * no character class, so a publisher may declare one shaped exactly like
   * an identifier: a manifest actually named `mallory/sync` can call itself
   * `google/calendar`. The screen then holds two identifier-shaped strings,
   * and without a lead-in the authoritative one is merely the smaller and
   * lower of the two.
   */
  it("names the identifier line, so two identifier-shaped names cannot be confused", () => {
    const html = renderInstallConsentScreen({
      ...IDENTIFIER_PARAMS,
      manifestName: "mallory/sync",
      manifest: { ...BASE_MANIFEST, display_name: "google/calendar" },
    });
    expect(html).toContain(`<div class="row__title">google/calendar</div>`);
    expect(html).toContain(
      `<div class="row__meta">Marfa integration mallory/sync, version 1.0.0, by @marfa</div>`,
    );
  });

  // A blank-looking label the schema's length check cannot refuse still
  // leaves the identifier on the page. That is the guarantee, rather than
  // any claim that a declared label always renders as something.
  it("still shows the identifier for a zero-width display_name", () => {
    const html = renderInstallConsentScreen({
      ...IDENTIFIER_PARAMS,
      manifest: { ...BASE_MANIFEST, display_name: "\u200b" },
    });
    expect(html).toContain("acme/calendar-sync");
  });

  // The version line answers which version is being approved. Only the
  // lead-in beside it moves, and only when there is a label to disambiguate.
  it("leaves the meta line exactly as it was when no display_name is declared", () => {
    const html = renderInstallConsentScreen(IDENTIFIER_PARAMS);
    expect(html).toContain(
      `<div class="row__meta">Marfa integration, version 1.0.0, by @marfa</div>`,
    );
    // The exact match above is the "not twice" check: with no label there
    // is nothing to tell apart, so the identifier stays out of this line.
  });

  it("takes the tile glyph and the document title from the shown name", () => {
    const html = renderInstallConsentScreen({
      ...IDENTIFIER_PARAMS,
      manifest: { ...BASE_MANIFEST, display_name: "Zephyr Sync" },
    });
    expect(html).toMatch(/class="logo"[^>]*>Z</);
    expect(html).toContain("Install Zephyr Sync");
  });

  // `charAt(0)` was safe only while the identifier grammar was the sole
  // input. A label has no character class, and several of the characters a
  // label opens with are more than one codepoint each.
  it.each([
    ["an astral character", "\u{1F600} Calendar Sync", "\u{1F600}"],
    [
      "a flag, which is two regional indicators",
      "\u{1F1EC}\u{1F1E7} Sync",
      "\u{1F1EC}\u{1F1E7}",
    ],
    [
      "a family, joined by zero-width joiners",
      "\u{1F468}\u200D\u{1F469}\u200D\u{1F467} Team",
      "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}",
    ],
    ["a skin-tone modifier", "\u{1F44D}\u{1F3FF} Sync", "\u{1F44D}\u{1F3FF}"],
    ["a decomposed accent", "e\u0301co Sync", "E\u0301"],
    ["a character that lengthens when upper-cased", "\u00DFeta", "S"],
  ])("renders one whole character for %s", (_label, name, expected) => {
    const html = renderInstallConsentScreen({
      ...IDENTIFIER_PARAMS,
      manifest: { ...BASE_MANIFEST, display_name: name },
    });
    expect(html).toContain(
      `<span class="logo" aria-hidden="true">${expected}</span>`,
    );
  });
});

describe("who published it", () => {
  const PARAMS = {
    ...BASE_PARAMS,
    manifestName: "acme/calendar-sync",
  };

  it("attributes the integration to its publisher", () => {
    // The field has been on this interface and rendered nowhere, so a
    // person approving an integration was told what it does and never
    // told whose it is.
    const html = renderInstallConsentScreen({
      ...PARAMS,
      publisher: "acme",
    });
    expect(html).toContain("by @acme");
  });

  it("attributes a first-party integration to the platform's own handle", () => {
    const html = renderInstallConsentScreen({ ...PARAMS, publisher: "marfa" });
    expect(html).toContain("by @marfa");
  });

  it("says nothing rather than saying `by @` when the field is empty", () => {
    // A manifest predating the validator can hold anything. An attribution
    // that reads `by @` is worse than none: it asserts the line exists and
    // then says nothing, which reads as a rendering fault on the one screen
    // that must not look broken.
    const html = renderInstallConsentScreen({ ...PARAMS, publisher: "   " });
    expect(html).toContain("version 1.0.0</div>");
    expect(html).not.toContain("by @");
  });

  it("escapes a publisher that predates the validator", () => {
    const html = renderInstallConsentScreen({
      ...PARAMS,
      publisher: "<script>alert(1)</script>",
    });
    expect(html).not.toContain("<script>alert(1)</script>");
  });
});
