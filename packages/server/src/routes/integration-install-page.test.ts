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
  publisher: "withmarfa",
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

  it("carries the label override input", () => {
    expect(html).toContain(`name="label"`);
    // Default value is "<name> <version>".
    expect(html).toContain(`value="Google Calendar 1.0.0"`);
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

describe("renderInstallConsentScreen — data mapping", () => {
  const html = renderInstallConsentScreen(BASE_PARAMS);

  it("shows a human data-type name in the capability tile, not the raw identifier", () => {
    // `core.event` → "Events", `google.calendar.event` → "Calendar events".
    expect(html).toContain("Calendar events");
    expect(html).toMatch(/captile__t[^>]*>Events, Calendar events</);
  });

  it("shows the raw type identifiers in the Technical details disclosure", () => {
    expect(html).toContain("Technical details");
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
