import { describe, it, expect } from "vitest";
import {
  IntegrationManifestSchema,
  validateWriteFamilies,
} from "@withmarfa/shared";
import {
  DEFAULT_WRITE_FAMILY,
  GOOGLE_CONTACTS_MANIFEST,
  FAMILY_DEFINITIONS,
} from "./manifest.js";

describe("Google Contacts manifest", () => {
  it("validates against IntegrationManifestSchema", () => {
    const result = IntegrationManifestSchema.safeParse(
      GOOGLE_CONTACTS_MANIFEST,
    );
    if (!result.success) {
      throw new Error(
        `manifest failed schema validation: ${JSON.stringify(result.error.issues, null, 2)}`,
      );
    }
    expect(result.success).toBe(true);
  });

  it("declares schedule + item-event triggers but NO webhook (People API has no push surface)", () => {
    const types = GOOGLE_CONTACTS_MANIFEST.triggers.map((t) => t.type);
    expect(types).toContain("schedule");
    expect(types).toContain("item-event");
    expect(types).not.toContain("webhook");
  });

  it("declares full bidirectional handling block matching Calendar's defaults", () => {
    const bidi = GOOGLE_CONTACTS_MANIFEST.bidirectional_handling;
    expect(bidi.echo_ttl_seconds).toBe(120);
    expect(bidi.lag_window_seconds).toBe(600);
    expect(bidi.tombstone_mapping).toBe("state-trashed");
    expect(bidi.partial_write_mode).toBe("accept-partial");
  });

  it("requires the contacts capability via OAuth proxy", () => {
    expect(GOOGLE_CONTACTS_MANIFEST.oauth_requirements).toEqual({
      contacts: "proxy",
    });
  });

  it("targets both core.entity.person and google.contacts.contact; direction is both", () => {
    expect(GOOGLE_CONTACTS_MANIFEST.target_types).toEqual([
      "core.entity.person",
      "google.contacts.contact",
    ]);
    expect(GOOGLE_CONTACTS_MANIFEST.direction).toBe("both");
  });

  it("declares coherent write families with a family chooser", () => {
    expect(validateWriteFamilies(GOOGLE_CONTACTS_MANIFEST)).toEqual([]);
    expect(
      GOOGLE_CONTACTS_MANIFEST.configuration_schema?.write_family
        ?.from_write_families,
    ).toBe(true);
    expect(
      GOOGLE_CONTACTS_MANIFEST.configuration_schema?.write_family?.default,
    ).toBe(DEFAULT_WRITE_FAMILY);
    expect(GOOGLE_CONTACTS_MANIFEST.write_families?.default).toBe(
      DEFAULT_WRITE_FAMILY,
    );
  });

  it("defaults to the upstream-fidelity family", () => {
    expect(DEFAULT_WRITE_FAMILY).toBe("google");
    expect(FAMILY_DEFINITIONS.google.types.contact).toBe(
      "google.contacts.contact",
    );
    expect(FAMILY_DEFINITIONS.core.types.contact).toBe("core.entity.person");
  });

  it("publisher namespace is shared with google.calendar / google.tasks", () => {
    expect(GOOGLE_CONTACTS_MANIFEST.publisher).toBe("google");
    expect(GOOGLE_CONTACTS_MANIFEST.name.startsWith("google.")).toBe(true);
  });
});
